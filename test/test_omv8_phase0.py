"""Synthetic-only tests for the read-only OMV8 Phase 0 facts tool.

No NAS is contacted. No root, Tailscale/Cloudflare, disks or services are changed.
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "omv8_phase0_readonly.py"
SPEC = importlib.util.spec_from_file_location("omv8_phase0_readonly", SCRIPT)
phase0 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(phase0)


def good_facts():
    return {
        "os_id": "debian",
        "os_version": "13",
        "omv_version": "8.0.4-1",
        "omv_marker": True,
        "systemd_pid1": True,
        "systemd_runtime": True,
        "root_euid": True,
        "ssh_unit": "loaded",
        "tailscaled_unit": "not-found",
        "docker_unit": "loaded",
        "docker_socket": True,
        "mount_count": 17,
        "mdstat_available": True,
        "md_arrays_active": True,
    }


class AssessmentTests(unittest.TestCase):
    def test_correct_omv8_is_facts_only_never_install(self):
        report = phase0.assess(good_facts())
        self.assertEqual(report["compatibility"], "FACTS_READY")
        self.assertEqual(report["blockers"], [])
        self.assertFalse(report["installation_permitted"])
        self.assertFalse(report["bootstrap_phase0_wired"])
        self.assertFalse(report["jit_helper_in_scope"])
        self.assertEqual(report["owner_storage_attestation"], "NOT_PERFORMED")
        self.assertEqual(report["root_ceremony_authorization"], "NOT_ASSERTED")
        self.assertEqual(report["storage"]["mount_count"], 17)
        self.assertIn("MD_RAID_ACTIVE_DO_NOT_TOUCH", report["safety_hints"])
        self.assertIn("DOCKER_SOCKET_PRESENT_DO_NOT_ATTACH", report["safety_hints"])

    def test_wrong_os_omv_and_no_systemd_block(self):
        facts = good_facts()
        facts.update(os_id="ubuntu", os_version="24.04", omv_version=None,
                     omv_marker=False, systemd_pid1=False)
        report = phase0.assess(facts)
        self.assertEqual(report["compatibility"], "BLOCKED")
        self.assertIn("DEBIAN_13_NOT_PROVEN", report["blockers"])
        self.assertIn("OMV8_PACKAGE_NOT_PROVEN", report["blockers"])
        self.assertIn("OMV_MARKER_MISSING", report["blockers"])
        self.assertIn("SYSTEMD_NOT_PROVEN", report["blockers"])
        self.assertFalse(report["installation_permitted"])

    def test_missing_root_storage_and_unknown_service_block(self):
        facts = good_facts()
        facts.update(root_euid=False, mount_count=None, mdstat_available=False,
                     ssh_unit="unknown")
        report = phase0.assess(facts)
        self.assertEqual(report["compatibility"], "BLOCKED")
        self.assertIn("LOCAL_ROOT_CEREMONY_NOT_PROVEN", report["blockers"])
        self.assertIn("STORAGE_FACTS_UNAVAILABLE", report["blockers"])
        self.assertIn("UNIT_STATE_UNAVAILABLE_SSH_UNIT", report["blockers"])

    def test_tailscale_not_installed_is_readiness_hint_not_fake_join(self):
        report = phase0.assess(good_facts())
        self.assertEqual(report["compatibility"], "FACTS_READY")
        self.assertIn("TAILSCALE_NOT_YET_CONFIGURED", report["safety_hints"])
        self.assertFalse(report["installation_permitted"])

    def test_omv_major_must_be_eight_not_prefix_eighty(self):
        facts = good_facts()
        facts["omv_version"] = "80.1-1"
        self.assertEqual(phase0.assess(facts)["compatibility"], "BLOCKED")

    def test_sensitive_paths_and_usernames_are_not_in_output(self):
        facts = good_facts()
        facts["untrusted_secret"] = "never-print-this"
        encoded = json.dumps(phase0.assess(facts))
        self.assertNotIn("never-print-this", encoded)
        self.assertNotIn("authorized_keys", encoded)
        self.assertNotIn("/mnt/", encoded)

    def test_parse_os_release_does_not_evaluate_shell(self):
        data = 'ID="debian"\nVERSION_ID="13"\nBAD=$(touch /tmp/pwn)\n'
        parsed = phase0.os_release(data)
        self.assertEqual(parsed["ID"], "debian")
        self.assertEqual(parsed["VERSION_ID"], "13")
        self.assertEqual(parsed["BAD"], "$(touch /tmp/pwn)")

    def test_mutating_commands_are_not_allowed(self):
        for argv in (
            ("/usr/bin/apt-get", "update"),
            ("/usr/bin/systemctl", "restart", "ssh"),
            ("/usr/bin/systemctl", "show", "--no-pager", "-p", "LoadState", "openmediavault-engined.service"),
        ):
            with self.subTest(argv=argv), self.assertRaises(ValueError):
                phase0.readonly_command(argv)

    def test_cli_never_returns_install_success_even_when_compatible(self):
        out = io.StringIO()
        with patch.object(phase0, "collect", return_value=good_facts()):
            with contextlib.redirect_stdout(out):
                result = phase0.main(["--check"])
        self.assertEqual(result, 3)
        self.assertFalse(json.loads(out.getvalue())["installation_permitted"])
        out = io.StringIO()
        with patch.object(phase0, "collect", return_value=dict(good_facts(), os_id="ubuntu")):
            with contextlib.redirect_stdout(out):
                result = phase0.main(["--check"])
        self.assertEqual(result, 4)
        self.assertEqual(json.loads(out.getvalue())["compatibility"], "BLOCKED")


if __name__ == "__main__":
    unittest.main()
