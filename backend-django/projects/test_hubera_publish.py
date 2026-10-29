import unittest

from projects.hubera_publish import (
    PublishDenied,
    actor_can_publish,
    create_landing_page,
    gate_public_publish,
    paul_actor,
    public_url,
    publish_landing,
)


class HuberaPublishTests(unittest.TestCase):
    def test_paul_creates_and_publishes_on_catalogue_domain(self):
        paul = paul_actor()
        draft = create_landing_page("hubera-www", "Accueil Hubera", "home")
        self.assertEqual(draft["status"], "draft")
        self.assertEqual(draft["tenant"], "public")
        self.assertNotIn("repo", draft)

        published = publish_landing(draft, paul)
        self.assertEqual(draft["status"], "draft")
        self.assertEqual(published["status"], "published")
        self.assertEqual(published["domain"], "hubera.cloud")
        self.assertEqual(public_url(published), "https://hubera.cloud/")

        music = create_landing_page("hubera-music", "Hubera Music", "tarifs")
        music["domain"] = "evil.example"
        live = publish_landing(music, paul)
        self.assertEqual(live["domain"], "music.hubera.cloud")
        self.assertEqual(public_url(live), "https://music.hubera.cloud/tarifs")
        self.assertEqual(music["status"], "draft")

    def test_account_without_rights_does_not_publish(self):
        draft = create_landing_page("hubera-drive", "Hubera Drive")
        denied = [
            None,
            {"email": "paul@delhomme.ovh", "role": "operator", "tenant_schema": "public", "active": True},
            {"email": "paul@delhomme.ovh", "role": "driver", "tenant_schema": "public", "active": True},
            {"email": "paul@delhomme.ovh", "role": "super-admin", "tenant_schema": "autre", "active": True},
            {"email": "autre@example.com", "role": "super-admin", "tenant_schema": "public", "active": True},
            {"email": "paul@delhomme.ovh", "role": "super-admin", "tenant_schema": "public", "active": False},
        ]
        for actor in denied:
            self.assertFalse(actor_can_publish(actor))
            with self.assertRaises(PublishDenied):
                publish_landing(draft, actor)
            self.assertEqual(draft["status"], "draft")
            decision = gate_public_publish(actor, site_slug="hubera-drive")
            self.assertFalse(decision["allowed"])
            self.assertEqual(decision["status"], 403)
            self.assertIsNone(decision["domain"])

    def test_unknown_site_is_rejected_before_publish(self):
        with self.assertRaises(ValueError):
            create_landing_page("pas-une-app", "Nope")
        decision = gate_public_publish(paul_actor(), site_slug="pas-une-app")
        self.assertEqual(decision["status"], 400)
        self.assertFalse(decision["allowed"])


if __name__ == "__main__":
    unittest.main()
