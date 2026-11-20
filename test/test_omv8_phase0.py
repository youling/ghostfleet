"""Synthetic-only tests for the read-only OMV8 Phase 0 facts tool.

No NAS is contacted. No root, Tailscale/Cloudflare, disks or services are changed.
"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
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
        "container_context_readable": True,
        "container_environment_detected": False,
        "units": {
            "ssh": {"load": "loaded", "active": "active"},
            "tailscaled": {"load": "not-found", "active": "inactive"},
            "docker": {"load": "loaded", "active": "active"},
            "docker_socket": {"load": "not-found", "active": "inactive"},
            "containerd": {"load": "not-found", "active": "inactive"},
            "podman_socket": {"load": "not-found", "active": "inactive"},
            "omv_engine": {"load": "loaded", "active": "active"},
            "smbd": {"load": "loaded", "active": "active"},
            "nfs": {"load": "not-found", "active": "inactive"},
        },
        "groups": {
            "docker_member_count": 2,
            "ssh_member_count": 1,
            "sudo_member_count": 1,
        },
        "privilege_tools": {"sudo_available": True, "su_available": True},
        "docker_socket_present": True,
        "podman_socket_present": False,
        "mounts": {
            "mount_count": 17,
            "filesystem_types": ["ext4", "tmpfs"],
            "root_filesystem": "ext4",
            "remote_mounts_present": False,
            "btrfs_present": False,
            "zfs_present": False,
        },
        "mdstat": {
            "active_array_count": 1,
            "degraded_signal": False,
            "maintenance_in_progress": False,
        },
    }


class AssessmentTests(unittest.TestCase):
    def test_facts_ready_never_means_install_authorized(self):
        report = phase0.assess(good_facts())
        self.assertEqual(report["compatibility"], "FACTS_READY")
        self.assertEqual(report["blockers"], [])
        self.assertFalse(report["installation_permitted"])
        self.assertFalse(report["bootstrap_phase0_wired"])
        self.assertFalse(report["jit_helper_in_scope"])
        self.assertEqual(report["owner_storage_attestation"], "NOT_PERFORMED")
        self.assertEqual(report["root_ceremony_authorization"], "NOT_ASSERTED")
        self.assertEqual(report["storage"]["mount_count"], 17)
        self.assertEqual(report["storage"]["root_filesystem"], "ext4")
        self.assertIn("MD_RAID_ACTIVE_DO_NOT_TOUCH", report["safety_hints"])
        self.assertIn("DOCKER_SOCKET_PRESENT_DO_NOT_ATTACH", report["safety_hints"])
        self.assertIn("DOCKER_GROUP_MEMBERSHIP_REQUIRES_REVIEW", report["safety_hints"])
        self.assertIn("SMBD_ACTIVE_PRESERVE", report["safety_hints"])
        self.assertEqual(report["service_status"]["ssh"]["active"], "active")

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
        facts.update(root_euid=False, mounts=None, mdstat=None)
        facts["units"]["ssh"] = {"load": "unknown", "active": "unknown"}
        report = phase0.assess(facts)
        self.assertEqual(report["compatibility"], "BLOCKED")
        self.assertIn("LOCAL_ROOT_CEREMONY_NOT_PROVEN", report["blockers"])
        self.assertIn("STORAGE_FACTS_UNAVAILABLE", report["blockers"])
        self.assertIn("UNIT_STATE_UNAVAILABLE_SSH", report["blockers"])

    def test_container_environment_is_detected_from_markers_and_cgroup(self):
        self.assertTrue(phase0.detect_container_environment("0::/docker/abc", False, False, False))
        self.assertTrue(phase0.detect_container_environment("0::/lxc.payload.name", False, False, False))
        self.assertTrue(phase0.detect_container_environment(None, True, False, False))
        self.assertTrue(phase0.detect_container_environment(None, False, True, False))
        self.assertTrue(phase0.detect_container_environment("0::/", False, False, True))
        self.assertFalse(phase0.detect_container_environment("0::/", False, False, False))

    def test_container_environment_and_unknown_context_block(self):
        facts = good_facts()
        facts["container_environment_detected"] = True
        self.assertIn("OMV_CONTAINER_INSTALL_UNSUPPORTED", phase0.assess(facts)["blockers"])
        facts = good_facts()
        facts["container_context_readable"] = False
        self.assertIn("CONTAINER_CONTEXT_UNKNOWN", phase0.assess(facts)["blockers"])

    def test_unknown_container_detection_fails_closed(self):
        facts = good_facts()
        facts["container_environment_detected"] = None
        self.assertIn("CONTAINER_DETECTION_UNKNOWN", phase0.assess(facts)["blockers"])

    def test_overlay_root_filesystem_blocks_unsupported_container(self):
        facts = good_facts()
        facts["mounts"]["root_filesystem"] = "overlay"
        self.assertIn("OMV_CONTAINER_FILESYSTEM_UNSUPPORTED", phase0.assess(facts)["blockers"])

    def test_omv_engine_must_be_loaded_and_active(self):
        facts = good_facts()
        facts["units"]["omv_engine"] = {"load": "loaded", "active": "failed"}
        self.assertIn("OMV_ENGINE_NOT_ACTIVE", phase0.assess(facts)["blockers"])

    def test_tailscale_not_installed_is_readiness_hint_not_fake_join(self):
        report = phase0.assess(good_facts())
        self.assertEqual(report["compatibility"], "FACTS_READY")
        self.assertIn("TAILSCALE_NOT_YET_CONFIGURED", report["safety_hints"])
        self.assertFalse(report["installation_permitted"])

    def test_active_ssh_unknown_fails_closed(self):
        facts = good_facts()
        facts["units"]["ssh"]["active"] = "unknown"
        self.assertIn("UNIT_STATE_UNAVAILABLE_SSH", phase0.assess(facts)["blockers"])

    def test_unknown_active_state_for_absent_unit_still_blocks(self):
        facts = good_facts()
        facts["units"]["nfs"] = {"load": "not-found", "active": "unknown"}
        self.assertIn("UNIT_STATE_UNAVAILABLE_NFS", phase0.assess(facts)["blockers"])

    def test_smb_and_nfs_services_are_observed_not_modified(self):
        facts = good_facts()
        facts["units"]["nfs"] = {"load": "loaded", "active": "active"}
        report = phase0.assess(facts)
        self.assertIn("SMBD_ACTIVE_PRESERVE", report["safety_hints"])
        self.assertIn("NFS_ACTIVE_PRESERVE", report["safety_hints"])

    def test_docker_primary_gid_and_supplementary_members_are_counted(self):
        group = SimpleNamespace(gr_gid=998, gr_mem=["supplementary"])
        passwd = [
            SimpleNamespace(pw_name="primary-a", pw_gid=998),
            SimpleNamespace(pw_name="primary-b", pw_gid=998),
            SimpleNamespace(pw_name="other", pw_gid=1000),
        ]
        with patch.object(phase0.grp, "getgrnam", return_value=group), \
             patch.object(phase0.pwd, "getpwall", return_value=passwd):
            self.assertEqual(phase0.group_member_count("docker"), 3)

    def test_missing_group_is_zero_members_not_error(self):
        with patch.object(phase0.grp, "getgrnam", side_effect=KeyError):
            self.assertEqual(phase0.group_member_count("docker"), 0)

    def test_unknown_group_membership_blocks(self):
        facts = good_facts()
        facts["groups"]["docker_member_count"] = None
        self.assertIn(
            "GROUP_MEMBERSHIP_UNKNOWN_DOCKER_MEMBER_COUNT",
            phase0.assess(facts)["blockers"],
        )

    def test_degraded_or_rebuilding_md_raid_is_explicitly_flagged(self):
        mdstat = """Personalities : [raid1]
md0 : active raid1 sda1[0] sdb1[1]
      976630336 blocks super 1.2 [2/1] [U_]
      [=>...................]  recovery = 1.2% (123/10000) finish=10min
unused devices: <none>
"""
        summary = phase0.summarize_mdstat(mdstat)
        self.assertEqual(summary["active_array_count"], 1)
        self.assertTrue(summary["degraded_signal"])
        self.assertTrue(summary["maintenance_in_progress"])
        facts = good_facts()
        facts["mdstat"] = summary
        hints = phase0.assess(facts)["safety_hints"]
        self.assertIn("MD_RAID_DEGRADED_OWNER_REVIEW", hints)
        self.assertIn("MD_RAID_MAINTENANCE_IN_PROGRESS", hints)

    def test_mountinfo_reports_only_aggregate_filesystem_types(self):
        data = (
            "36 25 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n"
            "37 36 0:42 / /srv/dev-disk-by-uuid-secret rw,relatime - btrfs /dev/sdb1 rw"
        )
        summary = phase0.summarize_mountinfo(data)
        self.assertEqual(summary["mount_count"], 2)
        self.assertEqual(summary["root_filesystem"], "ext4")
        self.assertEqual(summary["filesystem_types"], ["btrfs", "ext4"])
        encoded = json.dumps(summary)
        self.assertNotIn("/srv/dev-disk-by-uuid-secret", encoded)
        self.assertNotIn("/dev/sdb1", encoded)

    def test_remote_mounts_and_zfs_btrfs_are_hints(self):
        mounts = phase0.summarize_mountinfo(
            "1 0 0:1 / / rw - ext4 /dev/root rw\n"
            "2 1 0:2 / /srv/share rw - nfs4 server:/export rw\n"
            "3 1 0:3 / /data rw - zfs tank/data rw"
        )
        facts = good_facts()
        facts["mounts"] = mounts
        hints = phase0.assess(facts)["safety_hints"]
        self.assertIn("REMOTE_MOUNTS_PRESENT_DO_NOT_TOUCH", hints)
        self.assertIn("ZFS_PRESENT_DO_NOT_TOUCH", hints)

    def test_malformed_or_missing_mountinfo_fails_closed(self):
        self.assertIsNone(phase0.summarize_mountinfo("not mountinfo"))
        facts = good_facts()
        facts["mounts"] = phase0.summarize_mountinfo("not mountinfo")
        self.assertIn("STORAGE_FACTS_UNAVAILABLE", phase0.assess(facts)["blockers"])

    def test_oversized_input_fails_closed(self):
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as stream:
            stream.write("x" * (phase0.MAX_READ + 1))
            stream.flush()
            self.assertIsNone(phase0.read_text(stream.name))

    def test_invalid_fact_shapes_fail_closed_without_exception(self):
        facts = good_facts()
        facts["units"]["ssh"] = "active"
        facts["mounts"]["filesystem_types"] = None
        report = phase0.assess(facts)
        self.assertEqual(report["compatibility"], "BLOCKED")
        self.assertIn("UNIT_STATE_INVALID_SSH", report["blockers"])
        self.assertIn("STORAGE_FACTS_MALFORMED", report["blockers"])

    def test_sensitive_names_and_paths_are_not_emitted(self):
        facts = good_facts()
        facts["groups"] = {
            "docker_member_count": 3,
            "ssh_member_count": 1,
            "sudo_member_count": 1,
            "secret_username": "never-print-this",
        }
        facts["units"]["unexpected"] = {"load": "loaded", "active": "active", "raw": "never-print-this"}
        facts["mounts"]["secret_path"] = "never-print-this"
        facts["mdstat"]["device_name"] = "never-print-this"
        facts["privilege_tools"]["secret"] = "never-print-this"
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
            ("/usr/bin/systemctl", "show", "--no-pager", "-p", "LoadState", "arbitrary.service"),
            ("/usr/bin/systemd-detect-virt", "--vm"),
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
