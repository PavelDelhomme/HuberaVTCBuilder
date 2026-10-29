"""
API views for page models
"""
from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response
from django.utils import timezone
from api.mixins import CORSMixin
from api.utils import add_cors_headers
from .models import Page
from .serializers import PageSerializer, PageListSerializer, PageContentSerializer


def _hubera_publish_decision(user, request):
    """Contrôle HuberaPress sur le tenant public. None si la requête n’est pas concernée."""
    import os

    from projects.hubera_publish import PUBLIC_TENANT, gate_public_publish

    tenant = getattr(user, "tenant", None)
    schema = getattr(tenant, "schema_name", "") or ""
    site_slug = ""
    data = getattr(request, "data", None)
    if data is not None and hasattr(data, "get"):
        site_slug = str(data.get("site_slug") or "").strip()
    if schema != PUBLIC_TENANT and not site_slug:
        return None
    return gate_public_publish(
        {
            "email": getattr(user, "email", "") or "",
            "role": getattr(user, "role", "") or "",
            "tenant_schema": schema,
            "active": getattr(user, "status", "") == "active",
        },
        site_slug=site_slug or None,
        admin=os.environ.get("CMS_ADMIN_EMAIL"),
    )


class PageViewSet(CORSMixin, viewsets.ModelViewSet):
    """ViewSet for managing pages"""
    permission_classes = [AllowAny]  # Allow unauthenticated access for list, but check in methods

    def get_queryset(self):
        """Return empty queryset - actual querying done in tenant_context in methods"""
        # We can't return a QuerySet created in tenant_context here because
        # the context ends before serialization. Each method must handle tenant_context.
        from django.db import models
        return models.QuerySet().none()

    def get_serializer_class(self):
        """Return appropriate serializer based on action"""
        if self.action == 'list':
            return PageListSerializer
        elif self.action in ['create', 'update', 'partial_update']:
            return PageSerializer
        return PageSerializer

    def list(self, request, *args, **kwargs):
        """List pages with error handling"""
        from django_tenants.utils import tenant_context
        from tenants.models import Tenant
        
        user = request.user
        
        # Allow unauthenticated access for published pages only
        status_filter = request.query_params.get('status')
        if not user or not user.is_authenticated:
            if status_filter == 'published':
                # Return empty list for unauthenticated users requesting published pages
                # This is handled by the frontend which should use a public endpoint
                response = Response([], status=status.HTTP_200_OK)
                add_cors_headers(response, request)
                return response
            else:
                # For other status filters, require authentication
                response = Response({
                    'error': 'Authentication required',
                    'message': 'You must be authenticated to access this resource'
                }, status=status.HTTP_401_UNAUTHORIZED)
                add_cors_headers(response, request)
                return response
        
        # Tenant admin/users see only their tenant's pages
        if hasattr(user, 'tenant') and user.tenant:
            try:
                with tenant_context(user.tenant):
                    queryset = Page.objects.filter(tenant=user.tenant)
                    
                    # Apply filters from query params
                    status_filter = request.query_params.get('status')
                    if status_filter:
                        queryset = queryset.filter(status=status_filter)
                    
                    # Serialize within tenant context
                    serializer = PageListSerializer(queryset, many=True)
                    response = Response(serializer.data)
                    add_cors_headers(response, request)
                    return response
            except Exception as e:
                import logging
                logger = logging.getLogger(__name__)
                logger.error(f"Error listing pages: {e}", exc_info=True)
                response = Response([], status=status.HTTP_200_OK)
                add_cors_headers(response, request)
                return response
        
        # Super admin with tenant_id
        if user.is_super_admin():
            tenant_id = request.query_params.get('tenant_id')
            if tenant_id:
                try:
                    tenant = Tenant.objects.get(id=tenant_id)
                    with tenant_context(tenant):
                        queryset = Page.objects.all()
                        serializer = PageListSerializer(queryset, many=True)
                        response = Response(serializer.data)
                        add_cors_headers(response, request)
                        return response
                except Exception as e:
                    import logging
                    logger = logging.getLogger(__name__)
                    logger.error(f"Error listing pages: {e}", exc_info=True)
                    response = Response([], status=status.HTTP_200_OK)
                    add_cors_headers(response, request)
                    return response
        
        response = Response([], status=status.HTTP_200_OK)
        add_cors_headers(response, request)
        return response

    def get_object(self):
        """Get page object within tenant context"""
        from django_tenants.utils import tenant_context
        
        user = self.request.user
        
        if hasattr(user, 'tenant') and user.tenant:
            with tenant_context(user.tenant):
                pk = self.kwargs.get('pk')
                return Page.objects.get(pk=pk, tenant=user.tenant)
        
        # For super admin with tenant_id
        from tenants.models import Tenant
        tenant_id = self.request.query_params.get('tenant_id')
        if tenant_id:
            tenant = Tenant.objects.get(id=tenant_id)
            with tenant_context(tenant):
                pk = self.kwargs.get('pk')
                return Page.objects.get(pk=pk)
        
        from django.http import Http404
        raise Http404("Page not found")

    def create(self, request, *args, **kwargs):
        """Create a new page"""
        from django_tenants.utils import tenant_context
        from django.utils.text import slugify
        
        user = request.user
        
        # Tenant admin creates page in their tenant
        if hasattr(user, 'tenant') and user.tenant:
            try:
                # Prepare data - ensure blocks is always a list
                data = request.data.copy()
                if 'blocks' not in data or not isinstance(data.get('blocks'), list):
                    data['blocks'] = []
                
                # Validate data first using serializer (without saving)
                serializer = PageSerializer(data=data)
                
                if not serializer.is_valid():
                    import logging
                    logger = logging.getLogger(__name__)
                    logger.error(f"Validation errors: {serializer.errors}")
                    response = Response({
                        'error': 'Error de validation',
                        'details': serializer.errors
                    }, status=status.HTTP_400_BAD_REQUEST)
                    add_cors_headers(response, request)
                    return response
                
                validated_data = serializer.validated_data

                # Un compte sans droit sur le tenant public ne publie pas à la création.
                if validated_data.get("status") == "published":
                    decision = _hubera_publish_decision(user, request)
                    if decision is not None and not decision["allowed"]:
                        validated_data["status"] = "draft"
                
                # Auto-generate slug if not provided
                if not validated_data.get('slug') and validated_data.get('title'):
                    validated_data['slug'] = slugify(validated_data.get('title'))
                
                with tenant_context(user.tenant):
                    # Create page directly in tenant context
                    validated_data['tenant'] = user.tenant
                    # Ensure blocks is a list
                    if 'blocks' not in validated_data:
                        validated_data['blocks'] = []
                    elif not isinstance(validated_data.get('blocks'), list):
                        validated_data['blocks'] = []
                    
                    page = Page.objects.create(**validated_data)
                    
                    # Serialize within tenant context
                    response_serializer = PageSerializer(page)
                    response = Response(response_serializer.data, status=status.HTTP_201_CREATED)
                    add_cors_headers(response, request)
                    return response
            except Exception as e:
                import logging
                logger = logging.getLogger(__name__)
                logger.error(f"Error creating page: {e}", exc_info=True)
                
                # If serializer validation error, return validation errors with details
                if hasattr(e, 'detail'):
                    # Handle ValidationError from serializer
                    if isinstance(e.detail, dict):
                        error_messages = []
                        for field, messages in e.detail.items():
                            if isinstance(messages, list):
                                error_messages.extend([f"{field}: {msg}" for msg in messages])
                            else:
                                error_messages.append(f"{field}: {messages}")
                        response = Response({
                            'error': 'Error de validation',
                            'details': error_messages,
                            'fields': e.detail
                        }, status=status.HTTP_400_BAD_REQUEST)
                        add_cors_headers(response, request)
                        return response
                    response = Response({
                        'error': str(e.detail) if hasattr(e.detail, '__str__') else 'Error de validation'
                    }, status=status.HTTP_400_BAD_REQUEST)
                    add_cors_headers(response, request)
                    return response
                
                response = Response(
                    {'error': f'Error lors de la création: {str(e)}'},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR
                )
                add_cors_headers(response, request)
                return response
        
        response = Response(
            {'error': 'Aucun tenant associé à votre compte'},
            status=status.HTTP_400_BAD_REQUEST
        )
        add_cors_headers(response, request)
        return response

    def update(self, request, *args, **kwargs):
        """Update a page"""
        from django_tenants.utils import tenant_context
        
        user = request.user
        
        if hasattr(user, 'tenant') and user.tenant:
            try:
                wants_publish = str(request.data.get("status") or "") == "published"
                if wants_publish:
                    decision = _hubera_publish_decision(user, request)
                    if decision is not None and not decision["allowed"]:
                        response = Response(
                            {"error": decision["error"]},
                            status=decision["status"],
                        )
                        add_cors_headers(response, request)
                        return response
                with tenant_context(user.tenant):
                    partial = kwargs.pop('partial', False)
                    pk = kwargs.get('pk')
                    instance = Page.objects.get(pk=pk, tenant=user.tenant)
                    serializer = PageSerializer(instance, data=request.data, partial=partial)
                    serializer.is_valid(raise_exception=True)
                    serializer.save()
                    response = Response(serializer.data)
                    add_cors_headers(response, request)
                    return response
            except Page.DoesNotExist:
                response = Response(
                    {'error': 'Page not found'},
                    status=status.HTTP_404_NOT_FOUND
                )
                add_cors_headers(response, request)
                return response
            except Exception as e:
                import logging
                logger = logging.getLogger(__name__)
                logger.error(f"Error updating page: {e}", exc_info=True)
                response = Response(
                    {'error': f'Error lors de la mise à jour: {str(e)}'},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR
                )
                add_cors_headers(response, request)
                return response
        
        response = Response(
            {'error': 'Aucun tenant associé à votre compte'},
            status=status.HTTP_400_BAD_REQUEST
        )
        add_cors_headers(response, request)
        return response

    def destroy(self, request, *args, **kwargs):
        """Delete a page"""
        from django_tenants.utils import tenant_context
        
        user = request.user
        
        if hasattr(user, 'tenant') and user.tenant:
            try:
                with tenant_context(user.tenant):
                    pk = kwargs.get('pk')
                    instance = Page.objects.get(pk=pk, tenant=user.tenant)
                    instance.delete()
                    response = Response(status=status.HTTP_204_NO_CONTENT)
                    add_cors_headers(response, request)
                    return response
            except Page.DoesNotExist:
                response = Response(
                    {'error': 'Page not found'},
                    status=status.HTTP_404_NOT_FOUND
                )
                add_cors_headers(response, request)
                return response
            except Exception as e:
                import logging
                logger = logging.getLogger(__name__)
                logger.error(f"Error deleting page: {e}", exc_info=True)
                response = Response(
                    {'error': f'Error lors de la suppression: {str(e)}'},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR
                )
                add_cors_headers(response, request)
                return response
        
        response = Response(
            {'error': 'Aucun tenant associé à votre compte'},
            status=status.HTTP_400_BAD_REQUEST
        )
        add_cors_headers(response, request)
        return response

    @action(detail=True, methods=['post'])
    def publish(self, request, pk=None):
        """Publish a page"""
        from django_tenants.utils import tenant_context
        
        user = request.user
        if hasattr(user, 'tenant') and user.tenant:
            decision = _hubera_publish_decision(user, request)
            if decision is not None and not decision["allowed"]:
                response = Response(
                    {"error": decision["error"]},
                    status=decision["status"],
                )
                add_cors_headers(response, request)
                return response
            try:
                with tenant_context(user.tenant):
                    page = Page.objects.get(pk=pk, tenant=user.tenant)
                    page.status = 'published'
                    if not page.published_at:
                        page.published_at = timezone.now()
                    page.save()
                    body = {'status': 'Page published'}
                    if decision and decision.get("domain"):
                        body["domain"] = decision["domain"]
                    response = Response(body)
                    add_cors_headers(response, request)
                    return response
            except Page.DoesNotExist:
                response = Response(
                    {'error': 'Page not found'},
                    status=status.HTTP_404_NOT_FOUND
                )
                add_cors_headers(response, request)
                return response
            except Exception as e:
                import logging
                logger = logging.getLogger(__name__)
                logger.error(f"Error publishing page: {e}", exc_info=True)
                response = Response(
                    {'error': f'Error lors de la publication: {str(e)}'},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR
                )
                add_cors_headers(response, request)
                return response
        
        response = Response(
            {'error': 'Aucun tenant associé à votre compte'},
            status=status.HTTP_400_BAD_REQUEST
        )
        add_cors_headers(response, request)
        return response

    @action(detail=True, methods=['post'])
    def unpublish(self, request, pk=None):
        """Unpublish a page"""
        from django_tenants.utils import tenant_context
        
        user = request.user
        if hasattr(user, 'tenant') and user.tenant:
            try:
                with tenant_context(user.tenant):
                    page = Page.objects.get(pk=pk, tenant=user.tenant)
                    page.status = 'draft'
                    page.save()
                    response = Response({'status': 'Page unpublished'})
                    add_cors_headers(response, request)
                    return response
            except Page.DoesNotExist:
                response = Response(
                    {'error': 'Page not found'},
                    status=status.HTTP_404_NOT_FOUND
                )
                add_cors_headers(response, request)
                return response
            except Exception as e:
                import logging
                logger = logging.getLogger(__name__)
                logger.error(f"Error unpublishing page: {e}", exc_info=True)
                response = Response(
                    {'error': f'Error lors de la dépublication: {str(e)}'},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR
                )
                add_cors_headers(response, request)
                return response
        
        response = Response(
            {'error': 'Aucun tenant associé à votre compte'},
            status=status.HTTP_400_BAD_REQUEST
        )
        add_cors_headers(response, request)
        return response

    @action(detail=True, methods=['post'])
    def set_homepage(self, request, pk=None):
        """Set page as homepage"""
        from django_tenants.utils import tenant_context
        
        user = request.user
        if hasattr(user, 'tenant') and user.tenant:
            try:
                with tenant_context(user.tenant):
                    page = Page.objects.get(pk=pk, tenant=user.tenant)

                    # Unset other homepages for this tenant
                    Page.objects.filter(tenant=user.tenant, is_homepage=True).update(is_homepage=False)

                    # Set this page as homepage
                    page.is_homepage = True
                    page.save()

                    response = Response({'status': 'Page set as homepage'})
                    add_cors_headers(response, request)
                    return response
            except Page.DoesNotExist:
                response = Response(
                    {'error': 'Page not found'},
                    status=status.HTTP_404_NOT_FOUND
                )
                add_cors_headers(response, request)
                return response
            except Exception as e:
                import logging
                logger = logging.getLogger(__name__)
                logger.error(f"Error setting homepage: {e}", exc_info=True)
                response = Response(
                    {'error': f'Erreur: {str(e)}'},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR
                )
                add_cors_headers(response, request)
                return response
        
        response = Response(
            {'error': 'Aucun tenant associé à votre compte'},
            status=status.HTTP_400_BAD_REQUEST
        )
        add_cors_headers(response, request)
        return response

    @action(detail=False, methods=['get'])
    def published(self, request):
        """Get only published pages"""
        from django_tenants.utils import tenant_context
        
        user = request.user
        if hasattr(user, 'tenant') and user.tenant:
            try:
                with tenant_context(user.tenant):
                    queryset = Page.objects.filter(
                        tenant=user.tenant,
                        status='published',
                        published_at__lte=timezone.now()
                    )
                    serializer = PageContentSerializer(queryset, many=True)
                    response = Response(serializer.data)
                    add_cors_headers(response, request)
                    return response
            except Exception as e:
                import logging
                logger = logging.getLogger(__name__)
                logger.error(f"Error getting published pages: {e}", exc_info=True)
                response = Response([], status=status.HTTP_200_OK)
                add_cors_headers(response, request)
                return response
        
        response = Response([], status=status.HTTP_200_OK)
        add_cors_headers(response, request)
        return response

    @action(detail=False, methods=['get'])
    def homepage(self, request):
        """Get homepage for current tenant"""
        from django_tenants.utils import tenant_context
        
        user = request.user
        if hasattr(user, 'tenant') and user.tenant:
            try:
                with tenant_context(user.tenant):
                    homepage = Page.objects.get(
                        tenant=user.tenant,
                        is_homepage=True,
                        status='published'
                    )
                    serializer = PageContentSerializer(homepage)
                    response = Response(serializer.data)
                    add_cors_headers(response, request)
                    return response
            except Page.DoesNotExist:
                response = Response(
                    {'error': 'No homepage found'},
                    status=status.HTTP_404_NOT_FOUND
                )
                add_cors_headers(response, request)
                return response
            except Exception as e:
                import logging
                logger = logging.getLogger(__name__)
                logger.error(f"Error getting homepage: {e}", exc_info=True)
                response = Response(
                    {'error': 'No homepage found'},
                    status=status.HTTP_404_NOT_FOUND
                )
                add_cors_headers(response, request)
                return response
        
        response = Response(
            {'error': 'Aucun tenant associé à votre compte'},
            status=status.HTTP_400_BAD_REQUEST
        )
        add_cors_headers(response, request)
        return response
