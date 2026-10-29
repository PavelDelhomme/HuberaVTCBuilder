"""Catalogue des landings HuberaPress.

Un seul tronc (l’éditeur VTCBuilder) sert hubera.cloud et les sous-apps.
L’application métier de chaque produit reste dans son dépôt.
"""

SITES = [
    {"slug": "hubera-www", "name": "Hubera", "domain": "hubera.cloud", "login": "/login", "admin": "/admin"},
    {"slug": "hubera-id", "name": "Hubera ID", "domain": "id.hubera.cloud", "login": "/migrate.html", "admin": "/migrate.html"},
    {"slug": "hubera-mail", "name": "Hubera Mail", "domain": "mail.hubera.cloud", "login": "/app/mail/", "admin": "/4dm1n"},
    {"slug": "hubera-drive", "name": "Hubera Drive", "domain": "drive.hubera.cloud", "login": "/app/drive/", "admin": "/4dm1n"},
    {"slug": "hubera-pass", "name": "Hubera Pass", "domain": "pass.hubera.cloud", "login": "/app/pass", "admin": "/4dm1n"},
    {"slug": "hubera-calendar", "name": "Hubera Calendar", "domain": "calendar.hubera.cloud", "login": "/app/calendar", "admin": "/4dm1n"},
    {"slug": "hubera-contacts", "name": "Hubera Contacts", "domain": "contacts.hubera.cloud", "login": "/app/contacts", "admin": "/4dm1n"},
    {"slug": "hubera-notes", "name": "Hubera Notes", "domain": "notes.hubera.cloud", "login": "/app/notes", "admin": "/4dm1n"},
    {"slug": "hubera-photos", "name": "Hubera Photos", "domain": "photos.hubera.cloud", "login": "/app/photos", "admin": "/4dm1n"},
    {"slug": "hubera-office", "name": "Hubera Office", "domain": "office.hubera.cloud", "login": "/app", "admin": "/4dm1n"},
    {"slug": "hubera-maps", "name": "Hubera Maps", "domain": "maps.hubera.cloud", "login": "/app/", "admin": "/app/"},
    {"slug": "hubera-music", "name": "Hubera Music", "domain": "music.hubera.cloud", "login": "/app", "admin": "/app"},
    {"slug": "hubera-fuel", "name": "Hubera Fuel", "domain": "fuel.hubera.cloud", "login": "/auth", "admin": "/admin"},
    {"slug": "hubera-jobs", "name": "Hubera Jobs", "domain": "jobs.hubera.cloud", "login": "/login", "admin": "/backoffice"},
    {"slug": "hubera-budget", "name": "Hubera Budget", "domain": "budget.hubera.cloud", "login": "/app/", "admin": "/app/"},
    {"slug": "hubera-tasks", "name": "Hubera Tasks", "domain": "tasks.hubera.cloud", "login": "/app/", "admin": "/app/"},
    {"slug": "hubera-stream", "name": "Hubera Stream", "domain": "stream.hubera.cloud", "login": "/app/", "admin": "/app/"},
    {"slug": "hubera-press", "name": "HuberaPress", "domain": "press.hubera.cloud", "login": "/login", "admin": "/admin/dashboard"},
    {"slug": "hubera-vtcbuilder", "name": "VTCBuilder", "domain": "vtcbuilder.hubera.cloud", "login": "/login", "admin": "/admin/dashboard"},
]


def landing_errors(sites=None):
    """Retourne les problèmes du catalogue. Liste vide = catalogue publiable."""
    rows = SITES if sites is None else sites
    errors = []
    slugs = [s.get("slug") for s in rows]
    domains = [s.get("domain") for s in rows]
    if len(slugs) != len(set(slugs)):
        errors.append("slug en double")
    if len(domains) != len(set(domains)):
        errors.append("domaine en double")
    if "hubera.cloud" not in domains:
        errors.append("hubera.cloud absent")
    for site in rows:
        if not str(site.get("admin") or "").startswith("/"):
            errors.append(f"admin invalide pour {site.get('slug')}")
        if not str(site.get("domain") or "").endswith("hubera.cloud"):
            errors.append(f"domaine hors hubera.cloud pour {site.get('slug')}")
    return errors
