import unittest

from projects.hubera_landings import SITES, landing_errors


class HuberaLandingsTests(unittest.TestCase):
    def test_catalogue_publishes_main_and_apps(self):
        self.assertEqual(landing_errors(), [])
        domains = {s["domain"] for s in SITES}
        self.assertIn("hubera.cloud", domains)
        self.assertIn("music.hubera.cloud", domains)
        self.assertIn("drive.hubera.cloud", domains)

    def test_rejects_a_site_without_admin_path(self):
        bad = [{"slug": "x", "domain": "x.hubera.cloud", "admin": "admin"}]
        self.assertTrue(landing_errors(bad))


if __name__ == "__main__":
    unittest.main()
