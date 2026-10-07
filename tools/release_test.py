"""Release-tool tests use temporary fixtures; never stamp the dev checkout."""
import json
from pathlib import Path
import shutil
import os
import tempfile
import unittest

from release_stamp import stamp, version_from_tag
from release_verify import verify


class StampTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        source = Path(__file__).resolve().parents[1]
        for name in ("agent/Cargo.toml", "agent/Cargo.lock", "server/Cargo.toml", "Cargo.lock",
                     "agent/tauri.conf.json", "agent/ui-src/package.json",
                     "frontend/package.json", "package-lock.json"):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, target)

    def test_stamp_and_repeat_preserves_dependency_versions(self):
        import tomllib
        locks = {name: tomllib.loads((self.root / name).read_text())
                 for name in ("Cargo.lock", "agent/Cargo.lock")}
        stamp(self.root, "v0.2.0", stable=True)
        self.assertEqual(stamp(self.root, "v0.2.0", stable=True), [])
        stamp(self.root, "v0.2.0", check=True, stable=True)
        for name, before in locks.items():
            after = tomllib.loads((self.root / name).read_text())
            for old, new in zip(before["package"], after["package"], strict=True):
                if old["name"] in ("vantyr-agent", "vantyr-server"):
                    self.assertEqual(new["version"], "0.2.0")
                    old["version"] = "0.2.0"
                self.assertEqual(old, new)
        for name in ("agent/Cargo.toml", "server/Cargo.toml"):
            self.assertEqual(tomllib.loads((self.root / name).read_text())["package"]["version"], "0.2.0")
        self.assertEqual(json.loads((self.root / "agent/tauri.conf.json").read_text())["version"], "0.2.0")
        for name in ("agent/ui-src", "frontend"):
            self.assertEqual(json.loads((self.root / name / "package.json").read_text())["version"], "0.2.0")
            lock = json.loads((self.root / "package-lock.json").read_text())
            self.assertEqual(lock["packages"][name]["version"], "0.2.0")

    def test_bad_tag_never_writes(self):
        path = self.root / "agent/Cargo.toml"
        original = path.read_bytes()
        for tag in ("0.2.0", "v01.2.0", "vv1.2.3", "v1.2", "v1.2.3-01", "v1.2.3\n", "v1.2.3;echo bad"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                stamp(self.root, tag)
        self.assertEqual(path.read_bytes(), original)

    def test_validation_before_any_writes(self):
        path = self.root / "agent/Cargo.toml"
        original = path.read_bytes()
        (self.root / "package-lock.json").write_text('{}')
        with self.assertRaises(KeyError):
            stamp(self.root, "v0.2.0")
        self.assertEqual(path.read_bytes(), original)

    def test_check_detects_mismatch_without_writing(self):
        stamp(self.root, "v0.2.0")
        with self.assertRaises(ValueError):
            stamp(self.root, "v0.2.1", check=True)
        stamp(self.root, "v0.2.0", check=True)

    def test_stable_and_msi_boundaries(self):
        self.assertEqual(version_from_tag("v255.255.65535", stable=True), "255.255.65535")
        for tag in ("v256.0.0", "v1.256.0", "v1.2.65536", "v1.2.3-rc.1", "v1.2.3+build.1"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                version_from_tag(tag, stable=True)
        self.assertEqual(version_from_tag("v1.2.3-rc.1+build.2"), "1.2.3-rc.1+build.2")


class AssetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.metadata = {"version": "0.2.0", "platforms": {"windows-x86_64": {
            "url": "https://github.com/gladsonsam/Vantyr/releases/download/v0.2.0/Vantyr%20Agent_0.2.0_x64_en-US.msi",
            "signature": "test-signature"}}}
        for name in ("Vantyr Agent_0.2.0_x64_en-US.msi", "vantyr-agent-linux-x86_64.tar.gz"):
            (self.root / name).write_bytes(b"test payload")
        (self.root / "Vantyr Agent_0.2.0_x64_en-US.msi.sig").write_text("test-signature\n")
        self.write_metadata()

    def write_metadata(self):
        (self.root / "latest.json").write_text(json.dumps(self.metadata))

    def test_checksums_are_deterministic_and_exclude_readiness(self):
        sums = verify(self.root, "v0.2.0", "gladsonsam/Vantyr")
        (self.root / "RELEASE_READY.json").write_text('{}')
        self.assertEqual(verify(self.root, "v0.2.0", "gladsonsam/Vantyr"), sums)
        self.assertEqual(len(sums.splitlines()), 4)

    @unittest.skipUnless(shutil.which("minisign") or os.environ.get("RELEASE_TEST_MINISIGN"),
                         "minisign unavailable; run with RELEASE_TEST_MINISIGN or install minisign")
    def test_real_tauri_signature_and_tampered_payload(self):
        public_key = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQyNDA1Q0ZFMkUwMkIwNQpSV1FGSytEaXp3VWtCSCtwdWQ5WW12bVNzL1JTVi9iQWJBWUpwU3J6MTJsZkpNbnBtZ0c2YjNiSwo='
        signature = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRRksrRGl6d1VrQk1VZTAycVNqZUY1Rkl4R1RLaldxTXcrdXdYNFc5QjIydjY4YjhZUEd1TVlVdVAvcFZFS051TkVtUGl5T2huQk1wdTBRRmRwV091QnRLb2JxdVBuS1FrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxMTEyMTA4CWZpbGU6dGVzdC5tc2kKRTB3RVh0MXJ3K2lVQ2RrRDhJZGMxTlRSc0JTOXVSb0QyaWJXSXRaTGtqcFVuZENNNUdUd3gzU012UXJHTlZ2OUdwaWtTMzZGUHRTNWxJWjRCQ1VSQ2c9PQo='
        self.metadata["platforms"]["windows-x86_64"]["signature"] = signature
        (self.root / "Vantyr Agent_0.2.0_x64_en-US.msi.sig").write_text(signature)
        self.write_metadata()
        binary = os.environ.get("RELEASE_TEST_MINISIGN", "minisign")
        verify(self.root, "v0.2.0", "gladsonsam/Vantyr", public_key, binary)
        (self.root / "Vantyr Agent_0.2.0_x64_en-US.msi").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "signature verification failed"):
            verify(self.root, "v0.2.0", "gladsonsam/Vantyr", public_key, binary)

    def test_missing_or_mismatched_signature_rejected(self):
        path = self.root / "Vantyr Agent_0.2.0_x64_en-US.msi.sig"
        path.write_text("wrong signature")
        with self.assertRaisesRegex(ValueError, "signature differs"):
            verify(self.root, "v0.2.0", "gladsonsam/Vantyr")
        path.unlink()
        with self.assertRaisesRegex(ValueError, "payload/signature"):
            verify(self.root, "v0.2.0", "gladsonsam/Vantyr")

    def test_wrong_release_version_or_mutable_url_rejected(self):
        self.metadata["version"] = "0.1.0"
        self.write_metadata()
        with self.assertRaisesRegex(ValueError, "version"):
            verify(self.root, "v0.2.0", "gladsonsam/Vantyr")
        self.metadata["version"] = "0.2.0"
        self.metadata["platforms"]["windows-x86_64"]["url"] = "https://github.com/gladsonsam/Vantyr/releases/latest/download/Vantyr%20Agent_0.2.0_x64_en-US.msi"
        self.write_metadata()
        with self.assertRaisesRegex(ValueError, "pinned"):
            verify(self.root, "v0.2.0", "gladsonsam/Vantyr")

    def test_stray_or_wrong_version_msi_rejected(self):
        stray = self.root / "Vantyr Agent_0.1.0_x64_en-US.msi"
        stray.write_bytes(b"old payload")
        with self.assertRaisesRegex(ValueError, "exactly one Windows MSI"):
            verify(self.root, "v0.2.0", "gladsonsam/Vantyr")
        stray.unlink()
        with self.assertRaisesRegex(ValueError, "does not match version"):
            verify(self.root, "v0.3.0", "gladsonsam/Vantyr")
        (self.root / "Vantyr Agent_0.2.0_x64_en-US.msi").unlink()
        with self.assertRaisesRegex(ValueError, "found 0"):
            verify(self.root, "v0.2.0", "gladsonsam/Vantyr")

    def test_missing_installer_rejected(self):
        (self.root / "vantyr-agent-linux-x86_64.tar.gz").unlink()
        with self.assertRaisesRegex(ValueError, "Missing"):
            verify(self.root, "v0.2.0", "gladsonsam/Vantyr")


if __name__ == "__main__":
    unittest.main()
