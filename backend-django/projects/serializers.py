"""
Serializers for Project models
"""
from rest_framework import serializers
from .models import Project, ProjectPage
from tenants.serializers import TenantSerializer


class ProjectPageSerializer(serializers.ModelSerializer):
    """Serializer for ProjectPage"""
    
    class Meta:
        model = ProjectPage
        fields = [
            'id', 'project', 'page_slug', 'page_type', 
            'order', 'is_active', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class ProjectSerializer(serializers.ModelSerializer):
    """Serializer for Project"""
    tenant = TenantSerializer(read_only=True)
    tenant_id = serializers.SerializerMethodField()
    tenant_domain = serializers.SerializerMethodField()
    pages_count = serializers.SerializerMethodField()
    available_pages_count = serializers.SerializerMethodField()
    
    def get_tenant_id(self, obj):
        """Get tenant ID from tenant object"""
        return obj.tenant.id if obj.tenant else None
    
    def get_tenant_domain(self, obj):
        """Get primary domain for tenant"""
        if obj.tenant:
            try:
                from tenants.models import Domain
                domain = Domain.objects.filter(tenant=obj.tenant, is_primary=True).first()
                if domain:
                    return domain.domain
            except Exception:
                pass
        return None
    
    class Meta:
        model = Project
        fields = [
            'id', 'name', 'slug', 'uuid', 'description', 'tenant', 'tenant_id', 'tenant_domain',
            'is_system_project', 'status', 'domain', 'metadata',
            'is_deleted', 'deleted_at',
            'pages_count', 'available_pages_count', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'slug', 'uuid', 'created_at', 'updated_at']
    
    def get_pages_count(self, obj):
        """Get count of pages linked to this project"""
        # Utiliser len() si les pages sont déjà préchargées, sinon count()
        if hasattr(obj, '_prefetched_objects_cache') and 'pages' in obj._prefetched_objects_cache:
            return len(obj.pages.all())
        return obj.pages.count()
    
    def get_available_pages_count(self, obj):
        """Get count of available public pages (for system projects only)"""
        if obj.is_system_project:
            try:
                from settings_app.models import SystemSettings
                settings = SystemSettings.objects.first()
                if settings:
                    # Count homepage + public_pages
                    count = 0
                    if hasattr(settings, 'public_homepage_blocks') and settings.public_homepage_blocks:
                        count += 1
                    if hasattr(settings, 'public_pages') and settings.public_pages:
                        count += len(settings.public_pages)
                    return count
            except Exception:
                pass
        return None
    
    def _lock_landing_domain(self, validated_data, instance=None):
        """Une landing Hubera garde le domaine du catalogue."""
        from projects.hubera_publish import catalogue_domain

        slug = validated_data.get("slug") or (instance.slug if instance is not None else None)
        expected = catalogue_domain(slug) if slug else None
        if not expected:
            return validated_data
        validated_data["domain"] = expected
        current = {}
        if instance is not None and isinstance(instance.metadata, dict):
            current.update(instance.metadata)
        incoming = validated_data.get("metadata")
        if isinstance(incoming, dict):
            current.update(incoming)
        current["kind"] = "hubera-product-landing"
        current["host"] = expected
        validated_data["metadata"] = current
        return validated_data

    def create(self, validated_data):
        """Create project with tenant_id handling"""
        # Récupérer tenant_id depuis initial_data (avant validation)
        tenant_id = self.initial_data.get('tenant_id')
        if tenant_id:
            from tenants.models import Tenant
            validated_data['tenant'] = Tenant.objects.get(id=tenant_id)
        self._lock_landing_domain(validated_data)
        return super().create(validated_data)
    
    def update(self, instance, validated_data):
        """Update project with tenant_id handling"""
        # Récupérer tenant_id depuis initial_data (avant validation)
        tenant_id = self.initial_data.get('tenant_id')
        if tenant_id is not None:
            if tenant_id:
                from tenants.models import Tenant
                validated_data['tenant'] = Tenant.objects.get(id=tenant_id)
            else:
                validated_data['tenant'] = None
        self._lock_landing_domain(validated_data, instance)
        return super().update(instance, validated_data)


class ProjectDetailSerializer(ProjectSerializer):
    """Detailed serializer with pages"""
    pages = ProjectPageSerializer(many=True, read_only=True)
    
    class Meta(ProjectSerializer.Meta):
        fields = ProjectSerializer.Meta.fields + ['pages']

