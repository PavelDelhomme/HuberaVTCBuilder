"""
Middleware to check user status and block access for suspended/inactive users
"""
from django.http import JsonResponse
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.authentication import JWTAuthentication
from django.conf import settings


class UserStatusMiddleware:
    """
    Middleware to check if authenticated user is active/suspended/inactive
    Blocks access to API endpoints for suspended or inactive users
    """
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        # Skip for non-API paths or public paths
        if not request.path.startswith('/api/'):
            return self.get_response(request)

        # Skip authentication check for public endpoints
        public_paths = [
            '/api/auth/login',
            '/api/auth/register',
            '/api/auth/register-with-plan',
            '/api/auth/logout',  # Allow logout even if suspended
            '/api/auth/refresh',  # Allow token refresh even if expired - CRITICAL: Must be public
            '/api/auth/suite-bridge',  # Cookie hubera_suite_auth → JWT Press
            '/api/auth/reset-password/request',
            '/api/auth/reset-password/reset',
            '/api/auth/reset-password/verify',
            '/api/auth/invitation/verify',
            '/api/auth/invitation/complete',
            '/api/analytics/block-usage',  # Allow analytics tracking without auth
            '/api/users/impersonation-status',  # Allow checking impersonation status without auth
            '/api/blocks/types',  # Allow viewing block types without auth
        ]

        # Check if path matches any public path (with or without trailing slash, with or without query params)
        path_without_query = request.path.split('?')[0]  # Remove query params
        path_normalized = path_without_query.rstrip('/')  # Remove trailing slash
        
        # Vérifier si le chemin correspond exactement ou commence par un chemin public
        for public_path in public_paths:
            public_path_normalized = public_path.rstrip('/')
            # Correspondance exacte ou le chemin commence par le chemin public
            if path_normalized == public_path_normalized or path_normalized.startswith(public_path_normalized + '/'):
                # Log pour debug si c'est /auth/refresh
                if 'refresh' in path_normalized:
                    import logging
                    logger = logging.getLogger(__name__)
                    logger.info(f"UserStatusMiddleware: Allowing public access to {request.path} (refresh token endpoint)")
                return self.get_response(request)
        
        # Pour /api/system-settings/, autoriser GET sans authentification mais vérifier pour les autres méthodes
        if path_normalized == '/api/system-settings' or path_normalized.startswith('/api/system-settings/'):
            import logging
            logger = logging.getLogger(__name__)
            logger.info(f"🔍 UserStatusMiddleware: Intercepté {request.method} {request.path}")
            
            if request.method == 'GET':
                # GET est public, pas besoin de vérifier l'authentification
                logger.info(f"🔍 UserStatusMiddleware: GET est public pour {request.path}")
                return self.get_response(request)
            # Pour PATCH/POST/PUT/DELETE, continuer la vérification ci-dessous
            logger.info(f"🔍 UserStatusMiddleware: {request.method} nécessite authentification pour {request.path}")

        # Check user status for authenticated requests
        import logging
        logger = logging.getLogger(__name__)
        logger.info(f"🔍 UserStatusMiddleware: Vérification authentification pour {request.method} {request.path}")
        
        try:
            jwt_auth = JWTAuthentication()
            header = jwt_auth.get_header(request)
            logger.info(f"🔍 UserStatusMiddleware: Header présent: {header is not None} pour {request.method} {request.path}")
            
            if header:
                raw_token = jwt_auth.get_raw_token(header)
                logger.info(f"🔍 UserStatusMiddleware: Raw token présent: {raw_token is not None} pour {request.method} {request.path}")
                
                if raw_token:
                    validated_token = jwt_auth.get_validated_token(raw_token)
                    logger.info(f"🔍 UserStatusMiddleware: Token validé: {validated_token is not None} pour {request.method} {request.path}")
                    
                    user = jwt_auth.get_user(validated_token)
                    logger.info(f"🔍 UserStatusMiddleware: User obtenu: {user is not None} pour {request.method} {request.path}")

                    if user:
                        # Log pour debug
                        import logging
                        logger = logging.getLogger(__name__)
                        
                        # IMPORTANT: Recharger l'utilisateur depuis la DB pour s'assurer que le rôle est à jour
                        from tenants.models import User as UserModel
                        try:
                            user = UserModel.objects.get(pk=user.pk)
                            logger.debug(f"UserStatusMiddleware: User rechargé depuis la DB: {user.email if hasattr(user, 'email') else 'unknown'}, role: {user.role if hasattr(user, 'role') else 'unknown'}")
                        except UserModel.DoesNotExist:
                            logger.error(f"UserStatusMiddleware: User {user.pk} n'existe plus dans la DB")
                            return self.get_response(request)  # Laisser passer, la permission gérera l'erreur
                        except Exception as e:
                            logger.warning(f"UserStatusMiddleware: Erreur lors du rechargement de l'utilisateur: {e}, utilisation de l'utilisateur en cache")
                        
                        is_super_admin = False
                        try:
                            is_super_admin = user.is_super_admin()
                        except Exception as e:
                            logger.warning(f"Error checking is_super_admin in UserStatusMiddleware: {e}")
                        
                        logger.info(
                            f"UserStatusMiddleware: path={request.path}, method={request.method}, "
                            f"user={user.email if hasattr(user, 'email') else 'unknown'}, "
                            f"user_id={user.pk}, role={user.role if hasattr(user, 'role') else 'unknown'}, "
                            f"is_super_admin={is_super_admin}, status={user.status if hasattr(user, 'status') else 'unknown'}"
                        )
                        
                        # Super admin can always access - IMPORTANT: Allow super admin before checking status
                        if is_super_admin:
                            logger.info(f"UserStatusMiddleware: Allowing access for super admin to {request.path} (method: {request.method})")
                            return self.get_response(request)
                        
                        # Check user status
                        if user.status == 'suspended':
                            response = JsonResponse(
                                {
                                    'error': 'Compte suspendu',
                                    'detail': 'Votre compte a été suspendu. Veuillez contacter l\'administrateur.',
                                    'status': 'suspended'
                                },
                                status=403
                            )
                            # Add CORS headers
                            origin = request.META.get('HTTP_ORIGIN')
                            if origin and settings.DEBUG:
                                if (origin.startswith('http://localhost') or 
                                    origin.startswith('http://127.0.0.1') or
                                    origin.startswith('http://192.168.1.134') or
                                    origin.startswith('https://localhost') or
                                    origin.startswith('https://127.0.0.1') or
                                    origin.startswith('https://192.168.1.134')):
                                    response['Access-Control-Allow-Origin'] = origin
                                    response['Access-Control-Allow-Credentials'] = 'true'
                            return response
                        
                        if user.status == 'inactive':
                            response = JsonResponse(
                                {
                                    'error': 'Compte désactivé',
                                    'detail': 'Votre compte a été désactivé. Veuillez contacter l\'administrateur.',
                                    'status': 'inactive'
                                },
                                status=403
                            )
                            # Add CORS headers
                            origin = request.META.get('HTTP_ORIGIN')
                            if origin and settings.DEBUG:
                                if (origin.startswith('http://localhost') or 
                                    origin.startswith('http://127.0.0.1') or
                                    origin.startswith('http://192.168.1.134') or
                                    origin.startswith('https://localhost') or
                                    origin.startswith('https://127.0.0.1') or
                                    origin.startswith('https://192.168.1.134')):
                                    response['Access-Control-Allow-Origin'] = origin
                                    response['Access-Control-Allow-Credentials'] = 'true'
                            return response

        except (InvalidToken, TokenError) as e:
            # If no valid token or user, let the normal authentication handle it
            logger.warning(f"🔍 UserStatusMiddleware: Token invalide ou erreur pour {request.method} {request.path}: {type(e).__name__}: {e}")
            pass
        except (AttributeError, TypeError, KeyError, ValueError) as e:
            logger.warning(f"🔍 UserStatusMiddleware: Erreur lors de l'authentification pour {request.method} {request.path}: {type(e).__name__}: {e}")
            pass
        except Exception as e:
            logger.error(f"🔍 UserStatusMiddleware: Exception inattendue pour {request.method} {request.path}: {type(e).__name__}: {e}", exc_info=True)
            pass

        logger.info(f"🔍 UserStatusMiddleware: Laisser passer la requête {request.method} {request.path} (pas de token valide ou utilisateur non authentifié)")
        return self.get_response(request)

