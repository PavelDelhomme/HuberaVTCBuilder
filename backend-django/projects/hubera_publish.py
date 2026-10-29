"""Publication des landings HuberaPress.

L’éditeur reste le tronc VTCBuilder. Une landing ne copie pas l’application
métier : elle ne porte que le domaine du catalogue, servi sur le tenant public.
"""

from projects.hubera_landings import SITES

PUBLIC_TENANT = "public"
PUBLISH_ROLES = frozenset({"super-admin", "tenant-admin"})
DEFAULT_ADMIN_EMAIL = "paul@delhomme.ovh"


class PublishDenied(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def admin_email(configured=None):
    raw = DEFAULT_ADMIN_EMAIL if configured is None else str(configured)
    email = raw.strip().lower()
    return email or DEFAULT_ADMIN_EMAIL


def paul_actor(email=None):
    """Compte administrateur Paul, rattaché au tenant public."""
    return {
        "name": "Paul",
        "email": admin_email(email),
        "role": "super-admin",
        "tenant_schema": PUBLIC_TENANT,
        "active": True,
    }


def actor_can_publish(actor, admin=None):
    if not isinstance(actor, dict) or not actor.get("active"):
        return False
    if (actor.get("tenant_schema") or "") != PUBLIC_TENANT:
        return False
    if (actor.get("role") or "") not in PUBLISH_ROLES:
        return False
    email = (actor.get("email") or "").strip().lower()
    return bool(email) and email == admin_email(admin)


def site_by_slug(slug):
    if not slug:
        return None
    for site in SITES:
        if site["slug"] == slug:
            return site
    return None


def catalogue_domain(slug):
    site = site_by_slug(slug)
    return site["domain"] if site else None


def create_landing_page(site_slug, title, page_slug="home"):
    """Brouillon sur le tenant public. Le domaine vient du catalogue."""
    site = site_by_slug(site_slug)
    if site is None:
        raise ValueError(f"site inconnu: {site_slug}")
    return {
        "site_slug": site["slug"],
        "title": title,
        "slug": page_slug or "home",
        "status": "draft",
        "tenant": PUBLIC_TENANT,
        "domain": site["domain"],
    }


def publish_landing(page, actor, admin=None):
    """Publie une copie. Refuse sans modifier le brouillon si le compte n’a pas le droit."""
    if not isinstance(page, dict):
        raise PublishDenied("page invalide")
    if not actor_can_publish(actor, admin=admin):
        raise PublishDenied("publication refusée")
    if page.get("tenant") != PUBLIC_TENANT:
        raise PublishDenied("hors tenant public")
    site = site_by_slug(page.get("site_slug"))
    if site is None:
        raise PublishDenied("site inconnu")
    published = {
        "site_slug": site["slug"],
        "title": page.get("title") or site["name"],
        "slug": page.get("slug") or "home",
        "status": "published",
        "tenant": PUBLIC_TENANT,
        "domain": site["domain"],
    }
    return published


def public_url(page):
    domain = (page or {}).get("domain") or ""
    slug = ((page or {}).get("slug") or "home").strip("/")
    path = "/" if slug in ("", "home", "accueil") else f"/{slug}"
    return f"https://{domain}{path}"


def gate_public_publish(actor, site_slug=None, admin=None):
    """Décision HTTP pour le tronc Django. N’écrit rien en base."""
    site = None
    if site_slug:
        site = site_by_slug(site_slug)
        if site is None:
            return {
                "allowed": False,
                "status": 400,
                "error": "Site de landing inconnu",
                "domain": None,
            }
    if not actor_can_publish(actor, admin=admin):
        return {
            "allowed": False,
            "status": 403,
            "error": "Publication refusée",
            "domain": None,
        }
    return {
        "allowed": True,
        "status": 200,
        "error": None,
        "domain": site["domain"] if site else None,
    }
