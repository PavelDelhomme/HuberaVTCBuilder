#!/usr/bin/env python3
"""Crée un projet HuberaPress par produit (landing éditable, style WordPress)."""
from django.core.management.base import BaseCommand
from django_tenants.utils import schema_context
from projects.hubera_landings import SITES
from projects.models import Project, ProjectPage
from tenants.models import Tenant


class Command(BaseCommand):
    help = "Initialise les projets landing Hubera (un site Press par app web)"

    def handle(self, *args, **options):
        public = Tenant.objects.filter(schema_name="public").first()
        if not public:
            self.stderr.write("Tenant public introuvable")
            return
        created = 0
        with schema_context("public"):
            for site in SITES:
                proj, was = Project.objects.get_or_create(
                    slug=site["slug"],
                    defaults={
                        "name": site["name"],
                        "description": f"Landing {site['name']} — {site['domain']}",
                        "is_system_project": True,
                        "tenant": public,
                        "status": "active",
                        "domain": site["domain"],
                        "metadata": {
                            "kind": "hubera-product-landing",
                            "login": site["login"],
                            "admin": site["admin"],
                            "host": site["domain"],
                        },
                    },
                )
                if not was:
                    proj.domain = site["domain"]
                    proj.metadata = {**(proj.metadata or {}), **{
                        "kind": "hubera-product-landing",
                        "login": site["login"],
                        "admin": site["admin"],
                        "host": site["domain"],
                    }}
                    proj.save(update_fields=["domain", "metadata", "updated_at"])
                else:
                    created += 1
                ProjectPage.objects.get_or_create(
                    project=proj,
                    page_slug="home",
                    page_type="public",
                    defaults={"order": 1},
                )
                self.stdout.write(f"{'créé' if was else 'ok'} {proj.slug} → {site['domain']}")
        self.stdout.write(self.style.SUCCESS(f"Landings HuberaPress prêtes ({created} nouveaux)"))
