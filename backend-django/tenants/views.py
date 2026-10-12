"""
API views for tenant models
"""
from rest_framework import viewsets, status, generics
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken
from django.contrib.auth import authenticate
from django.core.mail import send_mail
from django.utils import timezone
from django.utils.crypto import get_random_string
from django.conf import settings
from datetime import timedelta
from django_tenants.utils import tenant_context
import logging
from .models import Tenant, User, PasswordResetToken, InvitationToken, Feature, UserFeature
from .serializers import (
    TenantSerializer, UserSerializer, UserRegisterSerializer,
    UserProfileSerializer, DomainSerializer, FeatureSerializer, UserFeatureSerializer
)

logger = logging.getLogger(__name__)


def add_cors_headers(response, request):
    """Helper function to add CORS headers to a response"""
    try:
        origin = request.META.get('HTTP_ORIGIN')
        if origin:
            if settings.DEBUG:
                # En développement, autoriser tous les localhost, 127.0.0.1 et 192.168.1.134
                if (origin.startswith('http://localhost') or 
                    origin.startswith('http://127.0.0.1') or
                    origin.startswith('http://192.168.1.134') or
                    origin.startswith('https://localhost') or
                    origin.startswith('https://127.0.0.1') or
                    origin.startswith('https://192.168.1.134')):
                    response['Access-Control-Allow-Origin'] = origin
                    response['Access-Control-Allow-Credentials'] = 'true'
                    response['Access-Control-Allow-Methods'] = ', '.join(settings.CORS_ALLOW_METHODS)
                    response['Access-Control-Allow-Headers'] = ', '.join(settings.CORS_ALLOW_HEADERS)
            else:
                if hasattr(settings, 'CORS_ALLOWED_ORIGINS') and origin in settings.CORS_ALLOWED_ORIGINS:
                    response['Access-Control-Allow-Origin'] = origin
                    response['Access-Control-Allow-Credentials'] = 'true'
    except Exception as e:
        logger.warning(f"Error adding CORS headers: {e}")


class TenantViewSet(viewsets.ModelViewSet):
    """ViewSet for managing tenants"""
    queryset = Tenant.objects.all()
    serializer_class = TenantSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        """Filter tenants based on user role"""
        user = self.request.user
        queryset = Tenant.objects.all()
        
        # Exclude soft deleted tenants by default
        queryset = queryset.filter(deleted_at__isnull=True)
        
        if user.is_super_admin():
            return queryset
        elif user.is_tenant_admin() and user.tenant:
            return queryset.filter(id=user.tenant.id)
        return queryset.none()
    
    def get_object(self):
        """
        Override get_object to handle cases where tenant schema might not exist
        """
        from django.http import Http404
        try:
            return super().get_object()
        except Exception as e:
            # If there's an error accessing the tenant, check if it exists in public schema
            lookup_url_kwarg = self.lookup_url_kwarg or self.lookup_field
            lookup_value = self.kwargs.get(lookup_url_kwarg)
            
            if lookup_value:
                try:
                    # Try to get tenant directly from public schema
                    tenant = Tenant.objects.get(pk=lookup_value)
                    return tenant
                except Tenant.DoesNotExist:
                    raise Http404("Tenant not found")
            raise

    def retrieve(self, request, *args, **kwargs):
        """Retrieve a tenant with error handling and CORS headers"""
        try:
            tenant = self.get_object()
            serializer = self.get_serializer(tenant)
            response = Response(serializer.data)
            add_cors_headers(response, request)
            return response
        except Exception as e:
            logger.error(f"Error retrieving tenant: {e}", exc_info=True)
            response = Response(
                {'error': f'Error lors de la récupération du tenant: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
            add_cors_headers(response, request)
            return response

    @action(detail=False, methods=['post'], permission_classes=[AllowAny])
    def check_or_create(self, request):
        """
        Vérifier si un tenant existe pour un slug/domain donné, sinon le créer automatiquement.
        Endpoint public pour permettre la création automatique de tenants depuis le frontend.
        """
        from django.utils.text import slugify
        from tenants.models import Domain
        from django.utils import timezone
        from datetime import timedelta
        
        slug = request.data.get('slug')
        domain = request.data.get('domain')
        
        if not slug:
            response = Response(
                {'error': 'slug is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
            add_cors_headers(response, request)
            return response
        
        # Normaliser le slug
        tenant_slug = slugify(slug)
        
        # Vérifier si le tenant existe déjà
        tenant = Tenant.objects.filter(slug=tenant_slug).first()
        
        if tenant:
            # Vérifier si le domaine existe
            domain_obj = Domain.objects.filter(tenant=tenant, domain=domain).first()
            if not domain_obj:
                # Créer le domaine s'il n'existe pas
                Domain.objects.get_or_create(
                    tenant=tenant,
                    domain=domain,
                    defaults={'is_primary': False}
                )
            
            serializer = TenantSerializer(tenant)
            response = Response({
                'exists': True,
                'created': False,
                'tenant': serializer.data
            })
            add_cors_headers(response, request)
            return response
        
        # Créer le tenant automatiquement
        try:
            # Générer un email par défaut
            default_email = f"admin@{tenant_slug}.vtcbuilder.local"
            
            # Créer le tenant
            tenant = Tenant.objects.create(
                name=slug.replace('-', ' ').title(),  # "test-enterprise" -> "Test Enterprise"
                slug=tenant_slug,
                email=default_email,
                plan='starter',
                status='trial',
                trial_ends_at=timezone.now() + timedelta(days=14)
            )
            
            # Créer le domaine
            Domain.objects.create(
                tenant=tenant,
                domain=domain or f"{tenant_slug}.localhost",
                is_primary=True
            )
            
            # Migrer le schéma du tenant
            try:
                from django.core.management import call_command
                call_command('migrate_schemas', schema_name=tenant.schema_name, verbosity=0, interactive=False)
            except Exception as e:
                logger.warning(f"Error migration schéma pour tenant {tenant_slug}: {e}")
            
            serializer = TenantSerializer(tenant)
            response = Response({
                'exists': False,
                'created': True,
                'tenant': serializer.data,
                'message': f'Tenant {tenant_slug} créé automatiquement'
            }, status=status.HTTP_201_CREATED)
            add_cors_headers(response, request)
            return response
            
        except Exception as e:
            logger.error(f"Error création automatique tenant {tenant_slug}: {e}", exc_info=True)
            response = Response(
                {'error': f'Error création tenant: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
            add_cors_headers(response, request)
            return response

    @action(detail=False, methods=['get'], permission_classes=[AllowAny])
    def features(self, request):
        """
        Get all available features for the current user's tenant based on their subscription plan.
        Super admin has access to all features.
        If user is not authenticated, return all active features (public access).
        """
        try:
            # Si l'utilisateur n'est pas authentifié, retourner toutes les features actives
            if not request.user or not request.user.is_authenticated:
                features = Feature.objects.filter(is_active=True)
                serializer = FeatureSerializer(features, many=True)
                response = Response(serializer.data)
                add_cors_headers(response, request)
                return response
            
            user = request.user
            
            # Super admin a accès à toutes les features
            if user.is_super_admin():
                features = Feature.objects.filter(is_active=True)
                serializer = FeatureSerializer(features, many=True)
                response = Response(serializer.data)
                add_cors_headers(response, request)
                return response
            
            # Pour les autres utilisateurs, filtrer selon leur plan
            if not user.tenant:
                # Si pas de tenant, retourner toutes les features actives (comme pour les utilisateurs non authentifiés)
                features = Feature.objects.filter(is_active=True)
                serializer = FeatureSerializer(features, many=True)
                response = Response(serializer.data)
                add_cors_headers(response, request)
                return response
            
            # Récupérer toutes les features actives
            all_features = Feature.objects.filter(is_active=True)
            available_features = []
            
            for feature in all_features:
                if user.can_use_feature(feature):
                    available_features.append(feature)
            
            serializer = FeatureSerializer(available_features, many=True)
            response = Response(serializer.data)
            add_cors_headers(response, request)
            return response
        except Exception as e:
            logger.error(f"Error in tenants/features endpoint: {e}", exc_info=True)
            response = Response(
                {'error': 'Internal server error', 'details': str(e)},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
            add_cors_headers(response, request)
            return response
    
    @action(detail=True, methods=['post'])
    def activate(self, request, pk=None):
        """Activate a tenant"""
        tenant = self.get_object()
        tenant.status = 'active'
        # Use update_fields to avoid schema creation on existing tenants
        tenant.save(update_fields=['status'])
        return Response({'status': 'Tenant activated'})

    @action(detail=True, methods=['post'])
    def suspend(self, request, pk=None):
        """Suspend a tenant"""
        tenant = self.get_object()
        tenant.status = 'suspended'
        # Use update_fields to avoid schema creation on existing tenants
        tenant.save(update_fields=['status'])
        return Response({'status': 'Tenant suspended'})
    
    @action(detail=True, methods=['post'], url_path='enable-all-features')
    def enable_all_features(self, request, pk=None):
        """
        Active toutes les fonctionnalités pour un tenant système.
        Seuls les super admins peuvent activer toutes les fonctionnalités.
        """
        if not request.user.is_super_admin():
            response = Response(
                {'error': 'Only super admin can enable all features'},
                status=status.HTTP_403_FORBIDDEN
            )
            add_cors_headers(response, request)
            return response
        
        tenant = self.get_object()
        
        from tenants.utils import is_system_tenant, enable_all_features_for_system_tenant
        
        # Vérifier si c'est un tenant système
        if not is_system_tenant(tenant):
            response = Response(
                {
                    'error': 'This action is only available for system tenants',
                    'message': f'Tenant "{tenant.name}" is not a system tenant. Only system tenants (vtcbuilder-public-website, public schema, reference-tenant) can have all features enabled.'
                },
                status=status.HTTP_400_BAD_REQUEST
            )
            add_cors_headers(response, request)
            return response
        
        try:
            result = enable_all_features_for_system_tenant(tenant)
            
            if 'error' in result:
                response = Response(
                    {'error': result['error']},
                    status=status.HTTP_400_BAD_REQUEST
                )
                add_cors_headers(response, request)
                return response
            
            response = Response({
                'status': 'success',
                'message': f'All features enabled for {tenant.name}',
                'result': result
            })
            add_cors_headers(response, request)
            return response
        except Exception as e:
            logger.error(f"Error enabling all features for tenant {tenant.id}: {e}", exc_info=True)
            response = Response(
                {'error': f'Error enabling features: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
            add_cors_headers(response, request)
            return response
    
    @action(detail=True, methods=['post'], url_path='enable-all-features')
    def enable_all_features(self, request, pk=None):
        """
        Active toutes les fonctionnalités pour un tenant système.
        Seuls les super admins peuvent activer toutes les fonctionnalités.
        """
        if not request.user.is_super_admin():
            response = Response(
                {'error': 'Only super admin can enable all features'},
                status=status.HTTP_403_FORBIDDEN
            )
            add_cors_headers(response, request)
            return response
        
        tenant = self.get_object()
        
        from tenants.utils import is_system_tenant, enable_all_features_for_system_tenant
        
        # Vérifier si c'est un tenant système
        if not is_system_tenant(tenant):
            response = Response(
                {
                    'error': 'This action is only available for system tenants',
                    'message': f'Tenant "{tenant.name}" is not a system tenant. Only system tenants (vtcbuilder-public-website, public schema, reference-tenant) can have all features enabled.'
                },
                status=status.HTTP_400_BAD_REQUEST
            )
            add_cors_headers(response, request)
            return response
        
        try:
            result = enable_all_features_for_system_tenant(tenant)
            
            if 'error' in result:
                response = Response(
                    {'error': result['error']},
                    status=status.HTTP_400_BAD_REQUEST
                )
                add_cors_headers(response, request)
                return response
            
            response = Response({
                'status': 'success',
                'message': f'All features enabled for {tenant.name}',
                'result': result
            })
            add_cors_headers(response, request)
            return response
        except Exception as e:
            logger.error(f"Error enabling all features for tenant {tenant.id}: {e}", exc_info=True)
            response = Response(
                {'error': f'Error enabling features: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
            add_cors_headers(response, request)
            return response
    
    @action(detail=True, methods=['post'])
    def reset_admin_password(self, request, pk=None):
        """
        Reset the admin user password for a tenant (for super admin debug)
        Sets password to 'admin123' by default
        """
        if not request.user.is_super_admin():
            return Response(
                {'error': 'Only super admin can reset tenant admin passwords'},
                status=status.HTTP_403_FORBIDDEN
            )
        
        tenant = self.get_object()
        
        # Get the admin user for this tenant
        admin_user = User.objects.filter(
            tenant=tenant,
            role='tenant-admin'
        ).first()
        
        if not admin_user:
            return Response(
                {'error': 'No admin user found for this tenant'},
                status=status.HTTP_404_NOT_FOUND
            )
        
        # Reset password to default
        default_password = request.data.get('password', 'admin123')
        admin_user.set_password(default_password)
        admin_user.status = 'active'
        admin_user.save(update_fields=['password', 'status'])
        
        return Response({
            'status': 'Password reset successfully',
            'email': admin_user.email,
            'password': default_password,
            'message': f'Le mot de passe de {admin_user.email} a été réinitialisé.'
        })

    @action(detail=True, methods=['get'])
    def get_admin_info(self, request, pk=None):
        """
        Get admin user information for a tenant (for super admin)
        """
        if not request.user.is_super_admin():
            return Response(
                {'error': 'Only super admin can view tenant admin info'},
                status=status.HTTP_403_FORBIDDEN
            )
        
        tenant = self.get_object()
        
        # Get the admin user for this tenant
        admin_user = User.objects.filter(
            tenant=tenant,
            role='tenant-admin'
        ).first()
        
        if not admin_user:
            return Response({
                'exists': False,
                'message': 'Aucun utilisateur admin trouvé pour ce tenant'
            })
        
        return Response({
            'exists': True,
            'email': admin_user.email,
            'username': admin_user.username,
            'status': admin_user.status,
            'created_at': admin_user.created_at.isoformat() if admin_user.created_at else None,
        })

    @action(detail=True, methods=['post', 'get'])
    def domains(self, request, pk=None):
        """
        Manage domains for a tenant
        GET: List all domains for the tenant
        POST: Add a new domain to the tenant
        """
        from tenants.models import Domain
        
        tenant = self.get_object()
        
        # Vérifier les permissions
        user = request.user
        if not user.is_super_admin() and (not user.tenant or user.tenant.id != tenant.id):
            response = Response(
                {'error': 'You do not have permission to manage domains for this tenant'},
                status=status.HTTP_403_FORBIDDEN
            )
            add_cors_headers(response, request)
            return response
        
        if request.method == 'GET':
            # Lister tous les domaines du tenant
            domains = Domain.objects.filter(tenant=tenant)
            serializer = DomainSerializer(domains, many=True)
            response = Response(serializer.data)
            add_cors_headers(response, request)
            return response
        
        elif request.method == 'POST':
            # Ajouter un nouveau domaine
            domain_name = request.data.get('domain')
            is_primary = request.data.get('is_primary', False)
            
            if not domain_name:
                response = Response(
                    {'error': 'Domain name is required'},
                    status=status.HTTP_400_BAD_REQUEST
                )
                add_cors_headers(response, request)
                return response
            
            # Vérifier si le domaine existe déjà pour un autre tenant
            existing_domain = Domain.objects.filter(domain=domain_name).exclude(tenant=tenant).first()
            if existing_domain:
                response = Response(
                    {'error': f'Domain {domain_name} is already used by another tenant'},
                    status=status.HTTP_400_BAD_REQUEST
                )
                add_cors_headers(response, request)
                return response
            
            # Si on définit ce domaine comme primaire, désactiver les autres
            if is_primary:
                Domain.objects.filter(tenant=tenant, is_primary=True).update(is_primary=False)
            
            # Créer le domaine
            domain = Domain.objects.create(
                tenant=tenant,
                domain=domain_name,
                is_primary=is_primary
            )
            
            serializer = DomainSerializer(domain)
            response = Response(serializer.data, status=status.HTTP_201_CREATED)
            add_cors_headers(response, request)
            return response
    
    @action(detail=True, methods=['delete'], url_path='domains/(?P<domain_id>[^/.]+)')
    def delete_domain(self, request, pk=None, domain_id=None):
        """
        Delete a domain from a tenant
        """
        from tenants.models import Domain
        
        tenant = self.get_object()
        
        # Vérifier les permissions
        user = request.user
        if not user.is_super_admin() and (not user.tenant or user.tenant.id != tenant.id):
            response = Response(
                {'error': 'You do not have permission to delete domains for this tenant'},
                status=status.HTTP_403_FORBIDDEN
            )
            add_cors_headers(response, request)
            return response
        
        try:
            domain = Domain.objects.get(id=domain_id, tenant=tenant)
            
            # Ne pas permettre la suppression du domaine primaire s'il n'y en a qu'un
            if domain.is_primary:
                other_domains = Domain.objects.filter(tenant=tenant).exclude(id=domain_id)
                if not other_domains.exists():
                    response = Response(
                        {'error': 'Cannot delete the only domain of a tenant'},
                        status=status.HTTP_400_BAD_REQUEST
                    )
                    add_cors_headers(response, request)
                    return response
                # Si on supprime le domaine primaire, définir le premier autre comme primaire
                first_other = other_domains.first()
                if first_other:
                    first_other.is_primary = True
                    first_other.save()
            
            domain.delete()
            response = Response({'message': 'Domain deleted successfully'})
            add_cors_headers(response, request)
            return response
        except Domain.DoesNotExist:
            response = Response(
                {'error': 'Domain not found'},
                status=status.HTTP_404_NOT_FOUND
            )
            add_cors_headers(response, request)
            return response
    
    @action(detail=True, methods=['post'])
    def restore(self, request, pk=None):
        """
        Restore a soft deleted tenant
        Only super admin can restore tenants
        """
        if not request.user.is_super_admin():
            return Response(
                {'error': 'Only super admin can restore tenants'},
                status=status.HTTP_403_FORBIDDEN
            )
        
        tenant = self.get_object()
        
        if not tenant.is_deleted():
            return Response(
                {'error': 'Tenant is not deleted and cannot be restored'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        try:
            tenant.restore()
            
            # Reactivate users if they were deactivated
            tenant_users = User.objects.filter(tenant=tenant, status='inactive')
            reactivated_count = 0
            for user in tenant_users:
                user.status = 'active'
                user.save(update_fields=['status'])
                reactivated_count += 1
            
            import logging
            logger = logging.getLogger(__name__)
            logger.info(f"Tenant {tenant.id} restored, {reactivated_count} users reactivated")
            
            return Response(
                {
                    'status': 'Tenant restored successfully',
                    'message': f'Le tenant a été restauré. {reactivated_count} utilisateur(s) réactivé(s).',
                    'tenant': TenantSerializer(tenant).data
                },
                status=status.HTTP_200_OK
            )
        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.error(f"Error restoring tenant {tenant.id}: {str(e)}", exc_info=True)
            
            return Response(
                {'error': f'Error restoring tenant: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

    def destroy(self, request, *args, **kwargs):
        """
        Soft delete a tenant (marked as deleted, can be restored)
        Only super admin can delete tenants
        
        This method performs a soft delete:
        1. Checks if tenant has active subscription - if yes, deactivates users instead of deleting
        2. Marks tenant as deleted (soft delete) with deleted_at timestamp
        3. Tenant will be permanently deleted after 1 month by purge command
        """
        if not request.user.is_super_admin():
            return Response(
                {'error': 'Only super admin can delete tenants'},
                status=status.HTTP_403_FORBIDDEN
            )

        try:
            tenant = self.get_object()
        except Tenant.DoesNotExist:
            return Response(
                {'error': 'Tenant not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.error(f"Error getting tenant: {str(e)}", exc_info=True)
            return Response(
                {'error': f'Error accessing tenant: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
        
        try:
            import logging
            from django.db import transaction, connection
            from django.utils import timezone
            logger = logging.getLogger(__name__)
            
            tenant_id = tenant.id
            tenant_name = tenant.name
            
            # Check if already deleted
            if tenant.is_deleted():
                return Response(
                    {'error': 'Tenant is already deleted'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            logger.info(f"Starting soft deletion of tenant {tenant_id} ({tenant_name})")
            
            with transaction.atomic():
                # All operations happen in public schema - no need to access tenant schema
                
                # Check if tenant has active subscription (in public schema)
                has_active_subscription = False
                try:
                    from billing.models import Subscription
                    subscription = Subscription.objects.filter(tenant_id=tenant_id).first()
                    if subscription and subscription.status == 'active':
                        has_active_subscription = True
                        logger.info(f"Tenant {tenant_id} has active subscription - deactivating users instead of deleting")
                except Exception as sub_error:
                    logger.debug(f"No subscription check: {str(sub_error)}")
                
                # Get tenant users (in public schema, safe)
                tenant_users = list(User.objects.filter(tenant_id=tenant_id).values_list('id', flat=True))
                logger.info(f"Found {len(tenant_users)} users for tenant {tenant_id}")
                
                # Delete tokens using direct SQL to avoid schema access issues
                if tenant_users:
                    try:
                        from django.db import connection
                        with connection.cursor() as cursor:
                            # Delete password reset tokens (use IN clause instead of ANY for PostgreSQL)
                            if tenant_users:
                                placeholders = ','.join(['%s'] * len(tenant_users))
                                cursor.execute(
                                    f"DELETE FROM password_reset_tokens WHERE user_id IN ({placeholders});",
                                    tenant_users
                                )
                                deleted_count = cursor.rowcount
                                logger.info(f"Deleted {deleted_count} password reset tokens")
                            
                            # Delete invitation tokens
                            if tenant_users:
                                placeholders = ','.join(['%s'] * len(tenant_users))
                                cursor.execute(
                                    f"DELETE FROM invitation_tokens WHERE user_id IN ({placeholders}) OR tenant_id = %s;",
                                    tenant_users + [tenant_id]
                                )
                                deleted_count = cursor.rowcount
                                logger.info(f"Deleted {deleted_count} invitation tokens")
                            else:
                                # Delete by tenant_id only if no users
                                cursor.execute(
                                    "DELETE FROM invitation_tokens WHERE tenant_id = %s;",
                                    [tenant_id]
                                )
                                logger.info(f"Deleted invitation tokens for tenant {tenant_id}")
                    except Exception as token_error:
                        logger.warning(f"Could not delete tokens: {str(token_error)}")
                
                if has_active_subscription:
                    # If active subscription: deactivate users instead of deleting
                    try:
                        User.objects.filter(tenant_id=tenant_id).update(status='inactive')
                        logger.info(f"Deactivated {len(tenant_users)} users")
                    except Exception as e:
                        logger.warning(f"Could not deactivate users: {str(e)}")
                
                # Soft delete the tenant (just update fields, no schema access needed)
                # Use update() to avoid triggering any schema operations
                from django.utils import timezone
                Tenant.objects.filter(id=tenant_id).update(
                    deleted_at=timezone.now(),
                    status='cancelled'
                )
                tenant.refresh_from_db()
                logger.info(f"Tenant {tenant_id} soft deleted (deleted_at: {tenant.deleted_at})")
            
            return Response(
                {
                    'status': 'Tenant soft deleted successfully',
                    'message': 'Le tenant a été marqué comme supprimé. Il sera définitivement supprimé après 1 mois. Vous pouvez le restaurer avant ce délai.',
                    'deleted_at': tenant.deleted_at.isoformat() if tenant.deleted_at else None,
                    'can_restore': True
                },
                status=status.HTTP_200_OK
            )
        except Tenant.DoesNotExist:
            return Response(
                {'error': 'Tenant not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.error(f"Error soft deleting tenant {tenant.id if 'tenant' in locals() else 'unknown'}: {str(e)}", exc_info=True)
            
            return Response(
                {'error': f'Error deleting tenant: {str(e)}. Please check server logs for details.'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class UserViewSet(viewsets.ModelViewSet):
    """ViewSet for managing users"""
    queryset = User.objects.all().order_by('-created_at')  # Fix pagination warning
    serializer_class = UserSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        """Filter users based on tenant context"""
        import logging
        logger = logging.getLogger(__name__)
        
        try:
            user = self.request.user
            queryset = User.objects.all().order_by('-created_at')
            
            # Super admin can filter by tenant_id parameter or see all users
            try:
                if user.is_super_admin():
                    tenant_id = self.request.query_params.get('tenant_id')
                    if tenant_id:
                        try:
                            tenant_id = int(tenant_id)
                            # Filter by tenant_id - only users belonging to this tenant
                            queryset = queryset.filter(tenant_id=tenant_id)
                        except (ValueError, TypeError):
                            # Invalid tenant_id, return all users
                            logger.warning(f"Invalid tenant_id parameter: {tenant_id}")
                            pass
                    # Return queryset (filtered or all)
                    return queryset
                elif hasattr(user, 'tenant') and user.tenant:
                    # Tenant admin only sees users from their tenant
                    return queryset.filter(tenant=user.tenant)
            except Exception as e:
                logger.error(f"Error checking user permissions in get_queryset: {e}", exc_info=True)
                # Return empty queryset on error
                return User.objects.none()
            
            return User.objects.none()
        except Exception as e:
            logger.error(f"Error in UserViewSet.get_queryset: {e}", exc_info=True)
            # Return empty queryset on error
            return User.objects.none()

    def list(self, request, *args, **kwargs):
        """List users with error handling"""
        import logging
        logger = logging.getLogger(__name__)
        
        try:
            return super().list(request, *args, **kwargs)
        except Exception as e:
            logger.error(f"Error in UserViewSet.list: {e}", exc_info=True)
            return Response({
                'error': 'An error occurred while fetching users',
                'message': str(e) if settings.DEBUG else 'Unable to load users'
            }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    def get_serializer_class(self):
        """Return appropriate serializer based on action"""
        if self.action == 'create':
            return UserRegisterSerializer
        return UserSerializer

    def create(self, request, *args, **kwargs):
        """Create user with quota check"""
        # Get tenant from request user or request data
        tenant = None
        if request.user.tenant:
            tenant = request.user.tenant
        elif request.data.get('tenant'):
            try:
                from .models import Tenant
                tenant = Tenant.objects.get(id=request.data.get('tenant'))
            except Tenant.DoesNotExist:
                pass
        
        # Check quota before creating user
        if tenant:
            from .quota import check_user_quota
            can_add, current_count, max_users, error_message = check_user_quota(tenant)
            
            if not can_add:
                return Response(
                    {
                        'error': error_message,
                        'quota': {
                            'current': current_count,
                            'max': max_users,
                        }
                    },
                    status=status.HTTP_400_BAD_REQUEST
                )
        
        return super().create(request, *args, **kwargs)

    def update(self, request, *args, **kwargs):
        """Update user with permission checks"""
        user = self.get_object()
        request_user = request.user
        
        # Check permissions
        if not request_user.is_super_admin():
            # Tenant admin can only update users in their tenant
            if not request_user.is_tenant_admin() or request_user.tenant != user.tenant:
                return Response(
                    {'error': 'Vous n\'avez pas la permission de modifier cet utilisateur'},
                    status=status.HTTP_403_FORBIDDEN
                )
        
        # Sécuriser les modifications de rôle : vérifier depuis le token JWT uniquement
        from api.utils import is_super_admin_from_token
        request_user_is_super_admin = is_super_admin_from_token(request)
        
        # Prevent changing super-admin role unless you're super-admin
        # Vérification sécurisée depuis le token JWT uniquement
        if 'role' in request.data:
            requested_role = request.data.get('role')
            target_user_is_super_admin = user.is_super_admin() if hasattr(user, 'is_super_admin') and callable(user.is_super_admin) else False
            
            # Si on essaie de modifier le rôle d'un super admin, seul un super admin peut le faire
            if target_user_is_super_admin and requested_role != 'super-admin':
                if not request_user_is_super_admin:
                    return Response(
                        {'error': 'Seul un super admin peut modifier le rôle d\'un super admin'},
                        status=status.HTTP_403_FORBIDDEN
                    )
            
            # Si on essaie de créer ou promouvoir un utilisateur en super admin, seul un super admin peut le faire
            if requested_role == 'super-admin' and not target_user_is_super_admin:
                if not request_user_is_super_admin:
                    return Response(
                        {'error': 'Seul un super admin peut créer ou promouvoir un utilisateur en super admin'},
                        status=status.HTTP_403_FORBIDDEN
                    )
        
        # Handle tenant assignment - check for tenant_id in data
        if 'tenant_id' in request.data or 'tenant' in request.data:
            tenant_id = request.data.get('tenant_id') or request.data.get('tenant')
            if tenant_id:
                try:
                    from .models import Tenant
                    tenant = Tenant.objects.get(id=tenant_id)
                    request.data['tenant'] = tenant.id
                except (Tenant.DoesNotExist, ValueError):
                    return Response(
                        {'error': 'Tenant non trouvé'},
                        status=status.HTTP_400_BAD_REQUEST
                    )
            elif tenant_id is None:
                # If tenant_id is explicitly null, remove tenant assignment
                request.data['tenant'] = None
            
            # Remove tenant_id if present (we use 'tenant' for the actual field)
            if 'tenant_id' in request.data:
                request.data.pop('tenant_id')
        
        # If role is super-admin, ensure tenant is None
        # Vérification sécurisée : on vérifie que l'utilisateur qui fait la requête est super admin
        if request.data.get('role') == 'super-admin':
            if not request_user_is_super_admin:
                return Response(
                    {'error': 'Seul un super admin peut définir le rôle super-admin'},
                    status=status.HTTP_403_FORBIDDEN
                )
            request.data['tenant'] = None
        
        # Use partial update to allow updating only specific fields (like password)
        kwargs['partial'] = True
        return super().update(request, *args, **kwargs)

    @action(detail=True, methods=['post'])
    def activate(self, request, pk=None):
        """Activate a user"""
        user = self.get_object()
        user.status = 'active'
        user.save(update_fields=['status'])
        return Response({'status': 'User activated', 'user': UserSerializer(user).data})

    @action(detail=True, methods=['post'])
    def deactivate(self, request, pk=None):
        """Deactivate a user"""
        user = self.get_object()
        user.status = 'inactive'
        user.save(update_fields=['status'])
        return Response({'status': 'User deactivated', 'user': UserSerializer(user).data})

    @action(detail=True, methods=['post'])
    def suspend(self, request, pk=None):
        """Suspend a user"""
        user = self.get_object()
        user.status = 'suspended'
        user.save(update_fields=['status'])
        return Response({'status': 'User suspended', 'user': UserSerializer(user).data})

    def destroy(self, request, *args, **kwargs):
        """
        Delete a user
        Cannot delete super-admin users
        """
        user = self.get_object()
        
        # Prevent deletion of super-admin
        if user.is_super_admin():
            return Response(
                {'error': 'Cannot delete super-admin user'},
                status=status.HTTP_403_FORBIDDEN
            )
        
        # Check permissions
        request_user = request.user
        if not request_user.is_super_admin():
            # Tenant admin can only delete users in their tenant
            if not request_user.is_tenant_admin() or request_user.tenant != user.tenant:
                return Response(
                    {'error': 'Vous n\'avez pas la permission de supprimer cet utilisateur'},
                    status=status.HTTP_403_FORBIDDEN
                )
        
        try:
            # Delete related tokens first
            PasswordResetToken.objects.filter(user=user).delete()
            InvitationToken.objects.filter(user=user).delete()
            
            # Delete the user
            user.delete()
            
            return Response(
                {'status': 'User deleted successfully'},
                status=status.HTTP_204_NO_CONTENT
            )
        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.error(f"Error deleting user {user.id}: {str(e)}")
            return Response(
                {'error': f'Error deleting user: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

    @action(detail=True, methods=['post'])
    def impersonate(self, request, pk=None):
        """
        Super admin action to impersonate a user
        Creates a temporary token for the target user and stores the original admin ID
        """
        if not request.user.is_super_admin():
            return Response(
                {'error': 'Seul un super admin peut impersonner un utilisateur'},
                status=status.HTTP_403_FORBIDDEN
            )
        
        target_user = self.get_object()
        
        # Cannot impersonate another super admin
        if target_user.is_super_admin():
            return Response(
                {'error': 'Impossible d\'impersonner un autre super admin'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Create JWT token for target user
        refresh = RefreshToken.for_user(target_user)
        
        # Store impersonation info in session (for backend tracking)
        request.session['impersonating_user_id'] = target_user.id
        request.session['original_admin_id'] = request.user.id
        request.session.save()
        
        return Response({
            'status': 'Impersonation started',
            'message': f'Vous êtes maintenant connecté en tant que {target_user.email}',
            'target_user': UserSerializer(target_user).data,
            'original_admin': {
                'id': request.user.id,
                'email': request.user.email,
            },
            'tokens': {
                'refresh': str(refresh),
                'access': str(refresh.access_token),
            }
        })

    @action(detail=False, methods=['post'], url_path='stop-impersonating')
    def stop_impersonating(self, request):
        """
        Stop impersonating and return to original admin account
        """
        original_admin_id = request.session.get('original_admin_id')
        if not original_admin_id:
            return Response(
                {'error': 'Vous n\'êtes pas en mode impersonnification'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Get original admin
        try:
            original_admin = User.objects.get(id=original_admin_id)
        except User.DoesNotExist:
            return Response(
                {'error': 'Admin original non trouvé'},
                status=status.HTTP_404_NOT_FOUND
            )
        
        # Clear impersonation session
        request.session.pop('impersonating_user_id', None)
        request.session.pop('original_admin_id', None)
        request.session.save()
        
        # Create new token for original admin
        refresh = RefreshToken.for_user(original_admin)
        
        return Response({
            'status': 'Impersonation stopped',
            'message': f'Retour au compte {original_admin.email}',
            'user': UserSerializer(original_admin).data,
            'tokens': {
                'refresh': str(refresh),
                'access': str(refresh.access_token),
            }
        })

    @action(detail=False, methods=['get', 'options'], url_path='impersonation-status', permission_classes=[AllowAny])
    def impersonation_status(self, request):
        """
        Check if currently impersonating a user
        """
        import logging
        logger = logging.getLogger(__name__)
        
        try:
            # Handle OPTIONS request for CORS preflight
            if request.method == 'OPTIONS':
                response = Response()
                self._add_cors_headers(response, request)
                return response
            
            # If not authenticated, return default response (not impersonating)
            if not request.user or not request.user.is_authenticated:
                response = Response({
                    'is_impersonating': False,
                    'impersonating': False,  # Alias for compatibility
                })
                self._add_cors_headers(response, request)
                return response
            
            # Safely access session
            try:
                impersonating_user_id = request.session.get('impersonating_user_id')
                original_admin_id = request.session.get('original_admin_id')
            except Exception as session_error:
                logger.warning(f"Error accessing session in impersonation_status: {session_error}")
                # Return default response if session is not available
                response = Response({
                    'is_impersonating': False,
                    'impersonating': False,  # Alias for compatibility
                })
                # Ensure CORS headers are added manually
                self._add_cors_headers(response, request)
                return response
            
            if impersonating_user_id and original_admin_id:
                try:
                    target_user = User.objects.get(id=impersonating_user_id)
                    original_admin = User.objects.get(id=original_admin_id)
                    response = Response({
                        'is_impersonating': True,
                        'impersonating': True,  # Alias for compatibility
                        'target_user': UserSerializer(target_user).data,
                        'original_admin': {
                            'id': original_admin.id,
                            'email': original_admin.email,
                        },
                        'impersonated_by': original_admin.email,  # Alias for compatibility
                    })
                    # Ensure CORS headers are added
                    self._add_cors_headers(response, request)
                    return response
                except User.DoesNotExist:
                    # Clear invalid session
                    try:
                        request.session.pop('impersonating_user_id', None)
                        request.session.pop('original_admin_id', None)
                        request.session.save()
                    except Exception:
                        pass  # Ignore session save errors
            
            response = Response({
                'is_impersonating': False,
                'impersonating': False,  # Alias for compatibility
            })
            # Ensure CORS headers are added
            self._add_cors_headers(response, request)
            return response
        except Exception as e:
            logger.error(f"Error in impersonation_status: {e}", exc_info=True)
            response = Response({
                'is_impersonating': False,
                'impersonating': False,
                'error': 'An error occurred while checking impersonation status'
            }, status=500)
            # Ensure CORS headers are added to error response
            self._add_cors_headers(response, request)
            return response
    
    def _add_cors_headers(self, response, request=None):
        """Helper method to add CORS headers to a response"""
        try:
            # Use request from parameter or self.request
            if request is None:
                request = getattr(self, 'request', None)
            if request:
                origin = request.META.get('HTTP_ORIGIN')
                if origin:
                    from django.conf import settings
                    if settings.DEBUG:
                        # En développement, autoriser tous les localhost, 127.0.0.1 et 192.168.1.134
                        if (origin.startswith('http://localhost') or 
                            origin.startswith('http://127.0.0.1') or
                            origin.startswith('http://192.168.1.134') or
                            origin.startswith('https://localhost') or
                            origin.startswith('https://127.0.0.1') or
                            origin.startswith('https://192.168.1.134')):
                            response['Access-Control-Allow-Origin'] = origin
                            response['Access-Control-Allow-Credentials'] = 'true'
                            response['Access-Control-Allow-Methods'] = ', '.join(settings.CORS_ALLOW_METHODS)
                            response['Access-Control-Allow-Headers'] = ', '.join(settings.CORS_ALLOW_HEADERS)
                    else:
                        if hasattr(settings, 'CORS_ALLOWED_ORIGINS') and origin in settings.CORS_ALLOWED_ORIGINS:
                            response['Access-Control-Allow-Origin'] = origin
                            response['Access-Control-Allow-Credentials'] = 'true'
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(f"Error adding CORS headers: {e}")

    @action(detail=True, methods=['post'])
    def send_password_reset(self, request, pk=None):
        """
        Admin action to send password reset email to a user
        Super admin OR tenant admin for their own users can do this
        """
        user_to_reset = self.get_object()
        request_user = request.user
        
        # Check permissions
        if not request_user.is_super_admin():
            # Tenant admin can only reset passwords for users in their tenant
            if not request_user.is_tenant_admin() or request_user.tenant != user_to_reset.tenant:
                return Response(
                    {'error': 'Vous n\'avez pas la permission de réinitialiser ce mot de passe'},
                    status=status.HTTP_403_FORBIDDEN
                )
        
        user = self.get_object()
        
        # Generate token
        token = get_random_string(length=64)
        expires_at = timezone.now() + timedelta(hours=24)  # Token valid for 24 hours
        
        # Create or update reset token
        reset_token, created = PasswordResetToken.objects.update_or_create(
            user=user,
            used=False,
            defaults={
                'token': token,
                'expires_at': expires_at,
                'used': False,
            }
        )
        
        # Generate reset URL
        frontend_url = getattr(settings, 'FRONTEND_URL', 'http://localhost:9494')
        reset_url = f"{frontend_url}/reset-password?token={token}&email={user.email}"
        
        # Send email
        try:
            send_mail(
                subject='Réinitialisation de votre mot de passe - VTCBuilder',
                message=f'''
Bonjour {user.get_full_name() or user.email},

Vous avez demandé à réinitialiser votre mot de passe pour votre compte VTCBuilder.

Cliquez sur le lien suivant pour réinitialiser votre mot de passe (valable 24 heures) :
{reset_url}

Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email.

Cordialement,
L'équipe VTCBuilder
                ''',
                html_message=f'''
                <html>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <h2>Réinitialisation de votre mot de passe</h2>
                    <p>Bonjour {user.get_full_name() or user.email},</p>
                    <p>Vous avez demandé à réinitialiser votre mot de passe pour votre compte VTCBuilder.</p>
                    <p>
                        <a href="{reset_url}" style="background-color: #3B82F6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                            Réinitialiser mon mot de passe
                        </a>
                    </p>
                    <p>Ou copiez ce lien dans votre navigateur :</p>
                    <p style="word-break: break-all; color: #666;">{reset_url}</p>
                    <p><small>Ce lien est valable pendant 24 heures.</small></p>
                    <p>Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email.</p>
                    <hr>
                    <p style="color: #666; font-size: 12px;">Cordialement,<br>L'équipe VTCBuilder</p>
                </body>
                </html>
                ''',
                from_email=getattr(settings, 'DEFAULT_FROM_EMAIL', 'noreply@vtcbuilder.com'),
                recipient_list=[user.email],
                fail_silently=False,
            )
            
            return Response({
                'status': 'Password reset email sent',
                'message': f'Email envoyé à {user.email}',
                'reset_url': reset_url,  # For testing/debugging
            })
        except Exception as e:
            return Response(
                {'error': f'Failed to send email: {str(e)}', 'reset_url': reset_url},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class UserProfileView(generics.RetrieveUpdateAPIView):
    """View for user profile management"""
    serializer_class = UserProfileSerializer
    permission_classes = [IsAuthenticated]

    def get_object(self):
        return self.request.user


@api_view(['POST', 'OPTIONS'])
@permission_classes([AllowAny])
def login_view(request):
    """Login endpoint"""
    # Handle OPTIONS request for CORS preflight
    if request.method == 'OPTIONS':
        response = Response({}, status=status.HTTP_200_OK)
        add_cors_headers(response, request)
        return response
    
    email = request.data.get('email')
    password = request.data.get('password')

    if not email or not password:
        error_response = Response(
            {'error': 'Email and password are required'},
            status=status.HTTP_400_BAD_REQUEST
        )
        add_cors_headers(error_response, request)
        return error_response

    user = authenticate(email=email, password=password)

    if user:
        # Check user status and provide specific error messages
        if user.status == 'suspended':
            error_response = Response(
                {
                    'error': 'Compte suspendu',
                    'detail': 'Votre compte a été suspendu. Veuillez contacter l\'administrateur.',
                    'status': 'suspended'
                },
                status=status.HTTP_403_FORBIDDEN
            )
            add_cors_headers(error_response, request)
            return error_response
        elif user.status == 'inactive':
            error_response = Response(
                {
                    'error': 'Compte désactivé',
                    'detail': 'Votre compte a été désactivé. Veuillez contacter l\'administrateur.',
                    'status': 'inactive'
                },
                status=status.HTTP_403_FORBIDDEN
            )
            add_cors_headers(error_response, request)
            return error_response
        elif not user.is_active_user():
            error_response = Response(
                {
                    'error': 'Compte non actif',
                    'detail': 'Votre compte n\'est pas actif. Veuillez contacter l\'administrateur.',
                    'status': user.status
                },
                status=status.HTTP_403_FORBIDDEN
            )
            add_cors_headers(error_response, request)
            return error_response

        refresh = RefreshToken.for_user(user)
        success_response = Response({
            'user': UserSerializer(user).data,
            'tokens': {
                'refresh': str(refresh),
                'access': str(refresh.access_token),
            }
        })
        add_cors_headers(success_response, request)
        return success_response

    error_response = Response(
        {'error': 'Invalid credentials'},
        status=status.HTTP_401_UNAUTHORIZED
    )
    add_cors_headers(error_response, request)
    return error_response


@api_view(['POST'])
@permission_classes([AllowAny])
def quick_reconnect_view(request):
    """Quick reconnect endpoint - only requires password, uses email from stored user"""
    password = request.data.get('password')
    email = request.data.get('email')  # Email from frontend (stored user)
    
    if not password:
        return Response(
            {'error': 'Mot de passe requis'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    if not email:
        return Response(
            {'error': 'Email requis'},
            status=status.HTTP_400_BAD_REQUEST
        )

    user = authenticate(email=email, password=password)

    if user:
        # Check user status
        if user.status == 'suspended':
            return Response(
                {
                    'error': 'Compte suspendu',
                    'detail': 'Votre compte a été suspendu. Veuillez contacter l\'administrateur.',
                    'status': 'suspended'
                },
                status=status.HTTP_403_FORBIDDEN
            )
        elif user.status == 'inactive':
            return Response(
                {
                    'error': 'Compte désactivé',
                    'detail': 'Votre compte a été désactivé. Veuillez contacter l\'administrateur.',
                    'status': 'inactive'
                },
                status=status.HTTP_403_FORBIDDEN
            )
        elif not user.is_active_user():
            return Response(
                {
                    'error': 'Compte non actif',
                    'detail': 'Votre compte n\'est pas actif. Veuillez contacter l\'administrateur.',
                    'status': user.status
                },
                status=status.HTTP_403_FORBIDDEN
            )

        refresh = RefreshToken.for_user(user)
        return Response({
            'user': UserSerializer(user).data,
            'tokens': {
                'refresh': str(refresh),
                'access': str(refresh.access_token),
            }
        })

    return Response(
        {'error': 'Mot de passe incorrect'},
        status=status.HTTP_401_UNAUTHORIZED
    )


def _hubera_cloud_host(request) -> bool:
    host = (request.get_host() or '').split(':')[0].lower()
    return host == 'hubera.cloud' or host.endswith('.hubera.cloud')


@api_view(['POST'])
@permission_classes([AllowAny])
def suite_bridge_view(request):
    """
    Émet des JWT Press lorsqu'un cookie suite Hubera (Cloudity) est présent.
    Ne valide pas le JWT Cloudity côté serveur — le cookie same-site suffit pour lier l'email.
    """
    if request.method == 'OPTIONS':
        response = Response({}, status=status.HTTP_200_OK)
        add_cors_headers(response, request)
        return response

    if not _hubera_cloud_host(request):
        response = Response(
            {'error': 'Suite bridge unavailable on this host'},
            status=status.HTTP_403_FORBIDDEN,
        )
        add_cors_headers(response, request)
        return response

    from tenants.hubera_suite import read_suite_auth_from_request, suite_session_usable

    suite = read_suite_auth_from_request(request)
    if not suite_session_usable(suite):
        response = Response(
            {'error': 'No usable Hubera suite session'},
            status=status.HTTP_401_UNAUTHORIZED,
        )
        add_cors_headers(response, request)
        return response

    email = (suite.get('email') or '').strip().lower()
    try:
        user = User.objects.get(email__iexact=email)
    except User.DoesNotExist:
        response = Response(
            {'error': 'No Press account for this suite email'},
            status=status.HTTP_401_UNAUTHORIZED,
        )
        add_cors_headers(response, request)
        return response

    if user.status == 'suspended':
        response = Response(
            {'error': 'Compte suspendu', 'status': 'suspended'},
            status=status.HTTP_403_FORBIDDEN,
        )
        add_cors_headers(response, request)
        return response
    if user.status == 'inactive' or not user.is_active_user():
        response = Response(
            {'error': 'Compte non actif', 'status': user.status},
            status=status.HTTP_403_FORBIDDEN,
        )
        add_cors_headers(response, request)
        return response

    refresh = RefreshToken.for_user(user)
    success_response = Response({
        'user': UserSerializer(user).data,
        'tokens': {
            'refresh': str(refresh),
            'access': str(refresh.access_token),
        },
        'source': 'hubera_suite_auth',
    })
    add_cors_headers(success_response, request)
    return success_response


@api_view(['POST'])
@permission_classes([AllowAny])
def register_view(request):
    """User registration endpoint"""
    serializer = UserRegisterSerializer(data=request.data)

    if serializer.is_valid():
        user = serializer.save()

        # Generate tokens for the new user
        refresh = RefreshToken.for_user(user)
        return Response({
            'user': UserSerializer(user).data,
            'tokens': {
                'refresh': str(refresh),
                'access': str(refresh.access_token),
            }
        }, status=status.HTTP_201_CREATED)

    return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


@api_view(['POST'])
@permission_classes([AllowAny])
def register_with_plan_view(request):
    """
    Register a new tenant with a pricing plan and create admin user
    This is the public registration endpoint for new tenants
    """
    from django.utils.text import slugify
    from billing.models import PricingPlan, Subscription
    from tenants.models import Domain
    
    # Extract data
    tenant_name = request.data.get('tenant_name')
    tenant_email = request.data.get('email')
    password = request.data.get('password')
    plan_slug = request.data.get('plan_slug')
    first_name = request.data.get('first_name', '')
    last_name = request.data.get('last_name', '')
    billing_cycle = request.data.get('billing_cycle', 'monthly')  # monthly or yearly
    
    # Validation
    if not all([tenant_name, tenant_email, password, plan_slug]):
        return Response(
            {'error': 'Missing required fields: tenant_name, email, password, plan_slug'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    # Check if email already exists
    if User.objects.filter(email=tenant_email).exists():
        return Response(
            {'error': 'Un compte avec cet email existe déjà'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    # Check if tenant name/slug already exists
    tenant_slug = slugify(tenant_name)
    if Tenant.objects.filter(slug=tenant_slug).exists():
        return Response(
            {'error': 'Un tenant avec ce nom existe déjà. Veuillez choisir un autre nom.'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    # Get pricing plan
    try:
        pricing_plan = PricingPlan.objects.get(slug=plan_slug, is_active=True)
    except PricingPlan.DoesNotExist:
        return Response(
            {'error': 'Plan tarifaire introuvable ou inactif'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    try:
        # Create tenant
        tenant = Tenant.objects.create(
            name=tenant_name,
            slug=tenant_slug,
            email=tenant_email,
            plan=plan_slug,
            status='trial',
            trial_ends_at=timezone.now() + timedelta(days=14)  # 14 days trial
        )
        
        # Create domain
        domain = Domain.objects.create(
            domain=f"{tenant_slug}.localhost",
            tenant=tenant,
            is_primary=True
        )
        
        # Create admin user for the tenant
        admin_username = f"admin_{tenant_slug}"
        admin_user = User.objects.create_user(
            username=admin_username,
            email=tenant_email,
            password=password,
            first_name=first_name or 'Admin',
            last_name=last_name or tenant_name,
            tenant=tenant,
            role='tenant-admin',
            status='active',
            is_active=True
        )
        
        # Assign permissions
        try:
            from .permissions import assign_role_permissions
            assign_role_permissions(admin_user, 'tenant-admin')
        except ImportError:
            pass
        
        # Create subscription with trial
        trial_start = timezone.now()
        trial_end = trial_start + timedelta(days=14)
        current_period_start = trial_start
        current_period_end = trial_end
        
        subscription = Subscription.objects.create(
            tenant=tenant,
            plan=pricing_plan,
            status='trial',
            billing_cycle=billing_cycle,
            trial_start=trial_start,
            trial_end=trial_end,
            current_period_start=current_period_start,
            current_period_end=current_period_end
        )
        
        # Create Stripe customer and setup intent for card registration
        setup_intent_client_secret = None
        try:
            from billing.stripe_service import StripeService
            customer_id = StripeService.create_customer(tenant, tenant_email)
            subscription.stripe_customer_id = customer_id
            subscription.save(update_fields=['stripe_customer_id'])
            
            # Create setup intent for card registration (no charge during trial)
            setup_intent = StripeService.create_setup_intent(customer_id)
            setup_intent_client_secret = setup_intent['client_secret']
        except Exception as e:
            # Log error but don't fail registration
            import logging
            logger = logging.getLogger(__name__)
            logger.error(f"Error creating Stripe customer/setup intent: {e}")
        
        # Generate tokens for the new user
        refresh = RefreshToken.for_user(admin_user)
        
        # Send welcome email
        frontend_url = getattr(settings, 'FRONTEND_URL', 'http://localhost:9494')
        tenant_url = f"http://{tenant_slug}.localhost:9494"
        admin_url = f"{tenant_url}/admin"
        
        try:
            send_mail(
                subject='Bienvenue sur VTCBuilder ! 🚀',
                message=f'''
Bonjour {admin_user.get_full_name() or admin_user.email},

Bienvenue sur VTCBuilder ! Votre compte a été créé avec succès.

Informations de votre compte :
- Nom du tenant : {tenant_name}
- Email : {tenant_email}
- Plan : {pricing_plan.name}
- Période d'essai : 14 jours (jusqu'au {trial_end.strftime("%d/%m/%Y")})

Accédez à votre administration :
{admin_url}

Votre site public sera disponible à :
{tenant_url}

Cordialement,
L'équipe VTCBuilder
                ''',
                html_message=f'''
                <html>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <h2>Bienvenue sur VTCBuilder ! 🚀</h2>
                    <p>Bonjour {admin_user.get_full_name() or admin_user.email},</p>
                    <p>Bienvenue sur VTCBuilder ! Votre compte a été créé avec succès.</p>
                    
                    <div style="background-color: #f0f9ff; padding: 20px; border-radius: 5px; margin: 20px 0;">
                        <h3>Informations de votre compte :</h3>
                        <ul>
                            <li><strong>Nom du tenant :</strong> {tenant_name}</li>
                            <li><strong>Email :</strong> {tenant_email}</li>
                            <li><strong>Plan :</strong> {pricing_plan.name}</li>
                            <li><strong>Période d'essai :</strong> 14 jours (jusqu'au {trial_end.strftime("%d/%m/%Y")})</li>
                        </ul>
                    </div>
                    
                    <p>
                        <a href="{admin_url}" style="background-color: #3B82F6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                            Accéder à mon administration
                        </a>
                    </p>
                    
                    <p>Votre site public sera disponible à : <a href="{tenant_url}">{tenant_url}</a></p>
                    
                    <p>Cordialement,<br>L'équipe VTCBuilder</p>
                </body>
                </html>
                ''',
                from_email=getattr(settings, 'DEFAULT_FROM_EMAIL', 'noreply@vtcbuilder.com'),
                recipient_list=[tenant_email],
                fail_silently=False,
            )
        except Exception as e:
            # Log error but don't fail registration
            import logging
            logger = logging.getLogger(__name__)
            logger.error(f"Error sending welcome email: {e}")
        
        return Response({
            'message': 'Inscription réussie ! Veuillez enregistrer votre carte bancaire pour continuer.',
            'user': UserSerializer(admin_user).data,
            'tenant': TenantSerializer(tenant).data,
            'subscription': {
                'id': subscription.id,
                'plan': pricing_plan.name,
                'status': 'trial',
                'trial_end': trial_end.isoformat(),
            },
            'tokens': {
                'refresh': str(refresh),
                'access': str(refresh.access_token),
            },
            'setup_intent_client_secret': setup_intent_client_secret,
            'subscription_id': subscription.id,
            'tenant_url': tenant_url,
            'admin_url': admin_url,
        }, status=status.HTTP_201_CREATED)
        
    except Exception as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"Error during tenant registration: {e}", exc_info=True)
        return Response(
            {'error': f'Error lors de la création du compte : {str(e)}'},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


@api_view(['POST'])
@permission_classes([AllowAny])
def refresh_token_view(request):
    """Refresh token endpoint"""
    import logging
    logger = logging.getLogger(__name__)
    
    try:
        refresh_token = request.data.get('refresh')
        if not refresh_token:
            logger.warning('refresh_token_view: Refresh token manquant dans la requête')
            response = Response(
                {'error': 'Refresh token is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
            add_cors_headers(response, request)
            return response
        
        logger.info(f'refresh_token_view: Tentative de rafraîchissement du token (longueur: {len(refresh_token)})')
        
        token = RefreshToken(refresh_token)
        new_access_token = token.access_token
        
        # Obtenir l'utilisateur depuis le token (RefreshToken surcharge __getitem__ pour accéder au payload)
        user_id = token.get('user_id') or token.payload.get('user_id')
        if not user_id:
            # Essayer d'obtenir depuis le access_token
            try:
                user_id = new_access_token.get('user_id') or new_access_token.payload.get('user_id')
            except Exception:
                pass
        
        if not user_id:
            logger.error('refresh_token_view: Impossible de récupérer user_id depuis le refresh token')
            response = Response(
                {'error': 'Invalid refresh token - user_id not found'},
                status=status.HTTP_401_UNAUTHORIZED
            )
            add_cors_headers(response, request)
            return response
        
        # Récupérer l'utilisateur depuis la base de données
        try:
            user = User.objects.get(id=user_id)
        except User.DoesNotExist:
            logger.error(f'refresh_token_view: Utilisateur avec ID {user_id} non trouvé')
            response = Response(
                {'error': 'User not found'},
                status=status.HTTP_401_UNAUTHORIZED
            )
            add_cors_headers(response, request)
            return response
        
        logger.info(f'refresh_token_view: Token rafraîchi avec succès pour l\'utilisateur {user.email if hasattr(user, "email") else "unknown"}')
        
        # Si ROTATE_REFRESH_TOKENS est activé, retourner aussi un nouveau refresh token
        if hasattr(token, 'blacklist'):
            # Rotation activée, créer un nouveau refresh token
            new_refresh = RefreshToken.for_user(user)
            token.blacklist()  # Blacklister l'ancien refresh token
            
            response = Response({
                'access': str(new_access_token),
                'refresh': str(new_refresh),
            })
            add_cors_headers(response, request)
            return response
        else:
            response = Response({
                'access': str(new_access_token),
            })
            add_cors_headers(response, request)
            return response
    except Exception as e:
        logger.error(f'refresh_token_view: Erreur lors du rafraîchissement du token: {e}', exc_info=True)
        response = Response(
            {'error': 'Invalid or expired refresh token', 'detail': str(e) if settings.DEBUG else None},
            status=status.HTTP_401_UNAUTHORIZED
        )
        add_cors_headers(response, request)
        return response


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def logout_view(request):
    """Logout endpoint"""
    try:
        refresh_token = request.data.get('refresh_token')
        if refresh_token:
            token = RefreshToken(refresh_token)
            token.blacklist()
        return Response({'message': 'Logged out successfully'})
    except Exception:
        return Response({'message': 'Logged out successfully'})


@api_view(['POST'])
@permission_classes([AllowAny])
def request_password_reset_view(request):
    """
    Request password reset by email (public endpoint)
    User enters their email and receives a reset link
    """
    email = request.data.get('email')
    
    if not email:
        error_response = Response(
            {'error': 'Email is required'},
            status=status.HTTP_400_BAD_REQUEST
        )
        add_cors_headers(error_response, request)
        return error_response
    
    try:
        user = User.objects.get(email=email)
        
        # Generate token
        token = get_random_string(length=64)
        expires_at = timezone.now() + timedelta(hours=24)  # Token valid for 24 hours
        
        # Create or update reset token
        reset_token, created = PasswordResetToken.objects.update_or_create(
            user=user,
            used=False,
            defaults={
                'token': token,
                'expires_at': expires_at,
                'used': False,
            }
        )
        
        # Generate reset URL
        frontend_url = getattr(settings, 'FRONTEND_URL', 'http://localhost:9494')
        reset_url = f"{frontend_url}/reset-password?token={token}&email={user.email}"
        
        # Send email
        try:
            send_mail(
                subject='Réinitialisation de votre mot de passe - VTCBuilder',
                message=f'''
Bonjour {user.get_full_name() or user.email},

Vous avez demandé à réinitialiser votre mot de passe pour votre compte VTCBuilder.

Cliquez sur le lien suivant pour réinitialiser votre mot de passe (valable 24 heures) :
{reset_url}

Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email.

Cordialement,
L'équipe VTCBuilder
                ''',
                html_message=f'''
                <html>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <h2>Réinitialisation de votre mot de passe</h2>
                    <p>Bonjour {user.get_full_name() or user.email},</p>
                    <p>Vous avez demandé à réinitialiser votre mot de passe pour votre compte VTCBuilder.</p>
                    <p>
                        <a href="{reset_url}" style="background-color: #3B82F6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                            Réinitialiser mon mot de passe
                        </a>
                    </p>
                    <p>Ou copiez ce lien dans votre navigateur :</p>
                    <p style="word-break: break-all; color: #666;">{reset_url}</p>
                    <p><small>Ce lien est valable pendant 24 heures.</small></p>
                    <p>Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email.</p>
                    <hr>
                    <p style="color: #666; font-size: 12px;">Cordialement,<br>L'équipe VTCBuilder</p>
                </body>
                </html>
                ''',
                from_email=getattr(settings, 'DEFAULT_FROM_EMAIL', 'noreply@vtcbuilder.com'),
                recipient_list=[user.email],
                fail_silently=False,
            )
            
            # Always return success (security best practice - don't reveal if email exists)
            response = Response({
                'status': 'success',
                'message': 'Si un compte existe avec cet email, vous recevrez un lien de réinitialisation.'
            })
            add_cors_headers(response, request)
            return response
        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.error(f"Error sending password reset email: {str(e)}")
            # Still return success for security
            response = Response({
                'status': 'success',
                'message': 'Si un compte existe avec cet email, vous recevrez un lien de réinitialisation.'
            })
            add_cors_headers(response, request)
            return response
            
    except User.DoesNotExist:
        # Don't reveal if email exists (security best practice)
        response = Response({
            'status': 'success',
            'message': 'Si un compte existe avec cet email, vous recevrez un lien de réinitialisation.'
        })
        add_cors_headers(response, request)
        return response
    except Exception as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"Error in request_password_reset_view: {e}", exc_info=True)
        response = Response({
            'status': 'success',
            'message': 'Si un compte existe avec cet email, vous recevrez un lien de réinitialisation.'
        })
        add_cors_headers(response, request)
        return response


@api_view(['POST'])
@permission_classes([AllowAny])
def reset_password_view(request):
    """
    Reset password using token from email
    Accepts either email or userId to find the user
    """
    try:
        token = request.data.get('token')
        email = request.data.get('email')
        userId = request.data.get('userId')
        new_password = request.data.get('password')

        if not token:
            error_response = Response(
                {'error': 'Token is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
            add_cors_headers(error_response, request)
            return error_response

        if not new_password:
            error_response = Response(
                {'error': 'Password is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
            add_cors_headers(error_response, request)
            return error_response

        user = None
        
        # Try to find user by email, userId, or token
        if email:
            try:
                user = User.objects.get(email=email)
            except User.DoesNotExist:
                error_response = Response(
                    {'error': 'User not found'},
                    status=status.HTTP_404_NOT_FOUND
                )
                add_cors_headers(error_response, request)
                return error_response
        elif userId:
            try:
                user = User.objects.get(id=userId)
            except User.DoesNotExist:
                error_response = Response(
                    {'error': 'User not found'},
                    status=status.HTTP_404_NOT_FOUND
                )
                add_cors_headers(error_response, request)
                return error_response
        else:
            # If no email or userId, try to find by token only (token is unique)
            try:
                reset_token = PasswordResetToken.objects.get(token=token, used=False)
                user = reset_token.user
            except PasswordResetToken.DoesNotExist:
                error_response = Response(
                    {'error': 'Invalid token'},
                    status=status.HTTP_400_BAD_REQUEST
                )
                add_cors_headers(error_response, request)
                return error_response

        # Verify token for this user
        try:
            reset_token = PasswordResetToken.objects.get(
                user=user,
                token=token,
                used=False
            )

            if not reset_token.is_valid():
                error_response = Response(
                    {'error': 'Token expired or already used'},
                    status=status.HTTP_400_BAD_REQUEST
                )
                add_cors_headers(error_response, request)
                return error_response

            # Validate password length
            if len(new_password) < 8:
                error_response = Response(
                    {'error': 'Password must be at least 8 characters long'},
                    status=status.HTTP_400_BAD_REQUEST
                )
                add_cors_headers(error_response, request)
                return error_response

            # Set new password
            user.set_password(new_password)
            # Activate user if status is pending (password reset implies user wants to use the account)
            if user.status == 'pending':
                user.status = 'active'
            user.save()

            # Mark token as used
            reset_token.mark_as_used()

            response = Response({
                'status': 'Password reset successfully',
                'message': 'Votre mot de passe a été réinitialisé avec succès'
            })
            add_cors_headers(response, request)
            return response

        except PasswordResetToken.DoesNotExist:
            error_response = Response(
                {'error': 'Invalid token'},
                status=status.HTTP_400_BAD_REQUEST
            )
            add_cors_headers(error_response, request)
            return error_response

    except Exception as e:
        logger.error(f"Error in reset_password_view: {e}", exc_info=True)
        error_response = Response(
            {
                'error': 'An error occurred while resetting the password',
                'message': str(e) if settings.DEBUG else None
            },
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )
        add_cors_headers(error_response, request)
        return error_response


@api_view(['POST'])
@permission_classes([AllowAny])
def verify_reset_token_view(request):
    """
    Verify if a reset token is valid (without resetting password)
    Accepts either email or userId to find the user
    """
    try:
        token = request.data.get('token')
        email = request.data.get('email')
        userId = request.data.get('userId')

        if not token:
            error_response = Response(
                {'error': 'Token is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
            add_cors_headers(error_response, request)
            return error_response

        user = None
        
        # Try to find user by email or userId
        if email:
            try:
                user = User.objects.get(email=email)
            except User.DoesNotExist:
                error_response = Response({
                    'valid': False,
                    'error': 'User not found'
                })
                add_cors_headers(error_response, request)
                return error_response
        elif userId:
            try:
                user = User.objects.get(id=userId)
                email = user.email  # Set email for response
            except User.DoesNotExist:
                error_response = Response({
                    'valid': False,
                    'error': 'User not found'
                })
                add_cors_headers(error_response, request)
                return error_response
        else:
            # If no email or userId, try to find by token only (token is unique)
            try:
                reset_token = PasswordResetToken.objects.get(token=token, used=False)
                user = reset_token.user
                email = user.email
            except PasswordResetToken.DoesNotExist:
                error_response = Response({
                    'valid': False,
                    'error': 'Invalid token'
                })
                add_cors_headers(error_response, request)
                return error_response

        # Verify token for this user
        try:
            reset_token = PasswordResetToken.objects.get(
                user=user,
                token=token,
                used=False
            )

            is_valid = reset_token.is_valid()
            response_data = {
                'valid': is_valid,
                'email': email,
            }
            if is_valid:
                response_data['expires_at'] = reset_token.expires_at.isoformat()
            
            response = Response(response_data)
            add_cors_headers(response, request)
            return response

        except PasswordResetToken.DoesNotExist:
            error_response = Response({
                'valid': False,
                'error': 'Invalid token'
            })
            add_cors_headers(error_response, request)
            return error_response

    except Exception as e:
        logger.error(f"Error in verify_reset_token_view: {e}", exc_info=True)
        error_response = Response(
            {
                'valid': False,
                'error': 'An error occurred while verifying the token',
                'message': str(e) if settings.DEBUG else None
            },
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )
        add_cors_headers(error_response, request)
        return error_response


@api_view(['POST'])
@permission_classes([AllowAny])
def verify_invitation_token_view(request):
    """
    Verify if an invitation token is valid
    """
    token = request.data.get('token')
    email = request.data.get('email')

    if not token or not email:
        return Response(
            {'error': 'Token and email are required'},
            status=status.HTTP_400_BAD_REQUEST
        )

    try:
        user = User.objects.get(email=email)
        invitation_token = InvitationToken.objects.get(
            user=user,
            token=token,
            used=False
        )

        is_valid = invitation_token.is_valid()
        return Response({
            'valid': is_valid,
            'expires_at': invitation_token.expires_at.isoformat() if is_valid else None,
            'tenant': {
                'id': invitation_token.tenant.id,
                'name': invitation_token.tenant.name,
                'slug': invitation_token.tenant.slug,
            } if is_valid else None
        })

    except (User.DoesNotExist, InvitationToken.DoesNotExist):
        return Response({'valid': False})


@api_view(['POST'])
@permission_classes([AllowAny])
def complete_invitation_view(request):
    """
    Complete invitation setup by setting password
    """
    token = request.data.get('token')
    email = request.data.get('email')
    password = request.data.get('password')
    first_name = request.data.get('first_name', '')
    last_name = request.data.get('last_name', '')

    if not token or not email or not password:
        return Response(
            {'error': 'Token, email and password are required'},
            status=status.HTTP_400_BAD_REQUEST
        )

    if len(password) < 8:
        return Response(
            {'error': 'Password must be at least 8 characters'},
            status=status.HTTP_400_BAD_REQUEST
        )

    try:
        user = User.objects.get(email=email)
        invitation_token = InvitationToken.objects.get(
            user=user,
            token=token,
            used=False
        )

        if not invitation_token.is_valid():
            return Response(
                {'error': 'Invitation expired or already used'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Set password and update user info
        user.set_password(password)
        user.first_name = first_name
        user.last_name = last_name
        user.status = 'active'  # Activate user after setup
        user.save()

        # Mark invitation as used
        invitation_token.mark_as_used()

        # Generate tokens for immediate login
        refresh = RefreshToken.for_user(user)
        
        return Response({
            'status': 'Account setup completed successfully',
            'user': UserSerializer(user).data,
            'tokens': {
                'refresh': str(refresh),
                'access': str(refresh.access_token),
            }
        })

    except User.DoesNotExist:
        return Response(
            {'error': 'User not found'},
            status=status.HTTP_404_NOT_FOUND
        )
    except InvitationToken.DoesNotExist:
        return Response(
            {'error': 'Invalid invitation token'},
            status=status.HTTP_400_BAD_REQUEST
        )


class FeatureViewSet(viewsets.ModelViewSet):
    """ViewSet for managing features"""
    queryset = Feature.objects.all()
    serializer_class = FeatureSerializer
    permission_classes = [IsAuthenticated]
    
    def get_queryset(self):
        """Filter features based on user permissions"""
        queryset = Feature.objects.all()
        
        # Super admin sees all features
        if self.request.user.is_super_admin():
            return queryset
        
        # Other users see only active features
        return queryset.filter(is_active=True)
    
    @action(detail=False, methods=['get'])
    def available(self, request):
        """Get all available features for the current user based on their subscription plan"""
        user = request.user
        features = self.get_queryset()
        
        # Filtrer les features selon le plan de l'utilisateur
        # Super admin voit toutes les features
        if user.is_super_admin():
            available_features = features
        else:
            # Pour les autres utilisateurs, filtrer selon leur plan
            available_features = []
            for feature in features:
                if user.can_use_feature(feature):
                    available_features.append(feature)
        
        serializer = self.get_serializer(available_features, many=True)
        response = Response(serializer.data)
        add_cors_headers(response, request)
        return response
    
    @action(detail=True, methods=['post'])
    def toggle(self, request, pk=None):
        """Toggle feature status (super admin only)"""
        if not request.user.is_super_admin():
            response = Response(
                {'error': 'Only super admin can toggle features'},
                status=status.HTTP_403_FORBIDDEN
            )
            add_cors_headers(response, request)
            return response
        
        feature = self.get_object()
        feature.is_active = not feature.is_active
        feature.save()
        
        serializer = self.get_serializer(feature)
        response = Response(serializer.data)
        add_cors_headers(response, request)
        return response


class UserFeatureViewSet(viewsets.ModelViewSet):
    """ViewSet for managing user features"""
    queryset = UserFeature.objects.all()
    serializer_class = UserFeatureSerializer
    permission_classes = [IsAuthenticated]
    
    def get_queryset(self):
        """Filter user features based on permissions"""
        user = self.request.user
        
        # Super admin sees all
        if user.is_super_admin():
            return UserFeature.objects.all()
        
        # Users see only their own features
        return UserFeature.objects.filter(user=user)
    
    def perform_create(self, serializer):
        """Set user to current user if not specified"""
        user = self.request.data.get('user')
        if not user or (not self.request.user.is_super_admin() and user != self.request.user.id):
            serializer.save(user=self.request.user, enabled_by=self.request.user)
        else:
            serializer.save(enabled_by=self.request.user)
    
    @action(detail=False, methods=['get'], url_path='my-features')
    def my_features(self, request):
        """Get all features for current user"""
        user_features = UserFeature.objects.filter(user=request.user, is_enabled=True)
        serializer = self.get_serializer(user_features, many=True)
        response = Response(serializer.data)
        add_cors_headers(response, request)
        return response
    
    @action(detail=True, methods=['post'], url_path='enable-all-features')
    def enable_all_features(self, request, pk=None):
        """
        Active toutes les fonctionnalités pour un tenant système.
        Seuls les super admins peuvent activer toutes les fonctionnalités.
        """
        if not request.user.is_super_admin():
            response = Response(
                {'error': 'Only super admin can enable all features'},
                status=status.HTTP_403_FORBIDDEN
            )
            add_cors_headers(response, request)
            return response
        
        tenant = self.get_object()
        
        from tenants.utils import is_system_tenant, enable_all_features_for_system_tenant
        
        # Vérifier si c'est un tenant système
        if not is_system_tenant(tenant):
            response = Response(
                {
                    'error': 'This action is only available for system tenants',
                    'message': f'Tenant "{tenant.name}" is not a system tenant. Only system tenants (vtcbuilder-public-website, public schema, reference-tenant) can have all features enabled.'
                },
                status=status.HTTP_400_BAD_REQUEST
            )
            add_cors_headers(response, request)
            return response
        
        try:
            result = enable_all_features_for_system_tenant(tenant)
            
            if 'error' in result:
                response = Response(
                    {'error': result['error']},
                    status=status.HTTP_400_BAD_REQUEST
                )
                add_cors_headers(response, request)
                return response
            
            response = Response({
                'status': 'success',
                'message': f'All features enabled for {tenant.name}',
                'result': result
            })
            add_cors_headers(response, request)
            return response
        except Exception as e:
            logger.error(f"Error enabling all features for tenant {tenant.id}: {e}", exc_info=True)
            response = Response(
                {'error': f'Error enabling features: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
            add_cors_headers(response, request)
            return response
    
    @action(detail=True, methods=['post'])
    def enable(self, request, pk=None):
        """Enable a feature for a user"""
        user_feature = self.get_object()
        
        # Check permissions
        if not request.user.is_super_admin() and user_feature.user != request.user:
            response = Response(
                {'error': 'You can only enable features for yourself'},
                status=status.HTTP_403_FORBIDDEN
            )
            add_cors_headers(response, request)
            return response
        
        user_feature.is_enabled = True
        user_feature.enabled_by = request.user
        user_feature.save()
        
        serializer = self.get_serializer(user_feature)
        response = Response(serializer.data)
        add_cors_headers(response, request)
        return response
    
    @action(detail=True, methods=['post'])
    def disable(self, request, pk=None):
        """Disable a feature for a user"""
        user_feature = self.get_object()
        
        # Check permissions
        if not request.user.is_super_admin() and user_feature.user != request.user:
            response = Response(
                {'error': 'You can only disable features for yourself'},
                status=status.HTTP_403_FORBIDDEN
            )
            add_cors_headers(response, request)
            return response
        
        user_feature.is_enabled = False
        user_feature.save()
        
        serializer = self.get_serializer(user_feature)
        response = Response(serializer.data)
        add_cors_headers(response, request)
        return response
    
    @action(detail=False, methods=['post'], url_path='enable-feature')
    def enable_feature(self, request):
        """Enable a feature for current user by feature_id"""
        feature_id = request.data.get('feature_id')
        if not feature_id:
            response = Response(
                {'error': 'feature_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
            add_cors_headers(response, request)
            return response
        
        try:
            feature = Feature.objects.get(id=feature_id, is_active=True)
        except Feature.DoesNotExist:
            response = Response(
                {'error': 'Feature not found or not available'},
                status=status.HTTP_404_NOT_FOUND
            )
            add_cors_headers(response, request)
            return response
        
        # Check if already enabled
        user_feature, created = UserFeature.objects.get_or_create(
            user=request.user,
            feature=feature,
            defaults={'is_enabled': True, 'enabled_by': request.user}
        )
        
        if not created:
            user_feature.is_enabled = True
            user_feature.enabled_by = request.user
            user_feature.save()
        
        serializer = self.get_serializer(user_feature)
        response = Response(serializer.data)
        add_cors_headers(response, request)
        return response
    
    @action(detail=False, methods=['post'], url_path='disable-feature')
    def disable_feature(self, request):
        """Disable a feature for current user by feature_id"""
        feature_id = request.data.get('feature_id')
        if not feature_id:
            response = Response(
                {'error': 'feature_id is required'},
                status=status.HTTP_400_BAD_REQUEST
            )
            add_cors_headers(response, request)
            return response
        
        try:
            user_feature = UserFeature.objects.get(
                user=request.user,
                feature_id=feature_id
            )
            user_feature.is_enabled = False
            user_feature.save()
            
            serializer = self.get_serializer(user_feature)
            response = Response(serializer.data)
            add_cors_headers(response, request)
            return response
        except UserFeature.DoesNotExist:
            response = Response(
                {'error': 'Feature not enabled for this user'},
                status=status.HTTP_404_NOT_FOUND
            )
            add_cors_headers(response, request)
            return response
