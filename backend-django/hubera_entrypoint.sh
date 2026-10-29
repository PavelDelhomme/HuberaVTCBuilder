#!/bin/bash
set -euo pipefail

echo "Hubera CMS — migrations"
python manage.py migrate_schemas --shared --noinput
python manage.py migrate_schemas --noinput || true
python manage.py collectstatic --noinput || true
python manage.py create_default_domain

python manage.py shell <<'PY'
import os
from django.contrib.auth import get_user_model
from django.utils import timezone

User = get_user_model()
email = (os.environ.get('CMS_ADMIN_EMAIL') or 'paul@delhomme.ovh').strip().lower()
password = os.environ.get('CMS_ADMIN_PASSWORD') or ''
username = email
user, created = User.objects.get_or_create(
    email=email,
    defaults={
        'username': username[:150],
        'is_superuser': True,
        'is_staff': True,
        'role': 'super-admin',
        'status': 'active',
        'email_verified_at': timezone.now(),
    },
)
user.is_superuser = True
user.is_staff = True
user.role = 'super-admin'
user.status = 'active'
if password:
    user.set_password(password)
from tenants.models import Tenant
public = Tenant.objects.filter(schema_name='public').first()
if public is not None:
    user.tenant = public
user.save()
print('admin', email, 'tenant', getattr(public, 'schema_name', 'missing'), 'created' if created else 'updated')
PY

python manage.py init_hubera_landings

echo "Hubera CMS — gunicorn"
exec gunicorn \
  --bind 0.0.0.0:8000 \
  --workers 2 \
  --threads 2 \
  --timeout 180 \
  --graceful-timeout 30 \
  --keep-alive 5 \
  --max-requests 1000 \
  --max-requests-jitter 100 \
  vtcbuilder.wsgi:application
