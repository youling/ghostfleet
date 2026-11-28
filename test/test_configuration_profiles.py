import hashlib
import json
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


BASE = Path(__file__).resolve().parents[1]
MANAGEMENT = BASE / "config" / "management"
sys.path.insert(0, str(MANAGEMENT))
from compile_profiles import MATRIX, canonical_bytes, compile_target
from resource_claims import InvalidConfig

UID = "node-" + "11111111-1111-4111-8111-111111111111"
OVERRIDE_UID = "node-" + "22222222-2222-4222-8222-222222222222"
NATIVE = "debian13-amd64"
WSL = "wsl-debian13-amd64"
WINDOWS = "windows-amd64"
EXAMPLES = MANAGEMENT / "examples"
FIXTURE_HOME = str(Path("/home") / "fixture")


def resource(name, kind, key, owner="ansible", scope="host", *, observe=False, **desired):
    value = {
        "id": name, "kind": kind, "scope": scope, "key": key, "owner": owner,
        "mode": "observe" if observe else "manage", "recovery": "prior-fixture",
        "consumers": ["consumer"],
    }
    if not observe:
        value["desired"] = desired
    return value


def sha(data):
    return hashlib.sha256(data).hexdigest()


class ConfigurationProfiles(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.private = Path(temporary.name)
        self.lock = self.private / "owner.lock.json"

    def write(self, name, document):
        path = self.private / name
        path.write_bytes(canonical_bytes(document))
        return {"path": name, "sha256": sha(path.read_bytes())}

    def fixture(self, resources, *, platform=NATIVE, aliases=None):
        common = {
            "schema": "ghostfleet-config-layer/v1", "version": "1.0.0", "platforms": [platform],
        }
        baseline = self.write("base.json", {
            **common, "type": "baseline", "name": "common", "resources": resources,
        })
        profile = self.write("platform.json", {
            **common, "type": "platform", "name": "platform", "resources": [],
        })
        selection = {"profile": profile, "layers": []}
        if aliases is not None:
            selection["path_aliases"] = aliases
        self.write(self.lock.name, {
            "schema": "ghostfleet-project-lock/v1", "version": "1.0.0", "matrix_sha256": sha(MATRIX.read_bytes()),
            "baseline": baseline, "platforms": {platform: selection},
        })
        return self.lock

    def check_deny(self, code, lock, uid=UID, platform=NATIVE, expected=None):
        with self.assertRaises(InvalidConfig) as result:
            compile_target(lock, uid, platform, expected)
        self.assertEqual(str(result.exception), code)

    def run_compiler(self, path, platform=NATIVE, *extra):
        return subprocess.run([sys.executable, "-I", str(MANAGEMENT / "compile_profiles.py"), "--lock", str(path),
                               "--node-uid", UID, "--platform", platform, *extra], cwd=self.private,
                              capture_output=True, check=False, timeout=10)

    def test_all_sample_platforms_emit_canonical_deterministic_and_versioned_projection(self):
        lock = EXAMPLES / "project.lock.json"
        for platform in (NATIVE, WSL, WINDOWS):
            with self.subTest(platform=platform):
                result = self.run_compiler(lock, platform)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, b"")
                output = json.loads(result.stdout)
                self.assertEqual(result.stdout, canonical_bytes(output) + b"\n")
                digest = output.pop("projection_sha256")
                self.assertEqual(digest, sha(canonical_bytes(output)))
                self.assertEqual(self.run_compiler(lock, platform, "--expected-sha256", digest).stdout, result.stdout)
                self.assertEqual(output["schema"], "ghostfleet-target/v1")
                self.assertEqual(output["target"], {"node_uid": UID, "platform": platform})
                self.assertEqual(output["controller"], {"policy": "exclusive", "lock_key": "ghostfleet-config:" + UID})
                self.assertEqual(output["inputs"]["baseline"]["version"], "1.0.0")
                self.assertEqual(sorted(resource["id"] for resource in output["resources"]),
                                 [resource["id"] for resource in output["resources"]])
        native = compile_target(lock, UID, NATIVE)
        wsl = compile_target(lock, UID, WSL)
        windows = compile_target(lock, UID, WINDOWS)
        self.assertEqual(native["inputs"]["layers"], wsl["inputs"]["layers"])
        self.assertNotEqual(native["projection_sha256"], wsl["projection_sha256"])
        self.assertTrue(all(entry["mode"] == "observe" for entry in windows["resources"]))

    def test_override_binds_exact_target_and_changes_only_desired(self):
        for example in EXAMPLES.glob("*.json"):
            shutil.copyfile(example, self.private / example.name)
        config = json.loads((self.private / "project.lock.json").read_bytes())
        packet = json.loads((self.private / "minimal-override.example.json").read_bytes())
        packet["target"]["node_uid"] = OVERRIDE_UID
        config["overrides"] = {OVERRIDE_UID: self.write("override.json", packet)}
        self.write(self.lock.name, config)
        lock = self.lock
        baseline = compile_target(lock, UID, NATIVE)
        changed = compile_target(lock, OVERRIDE_UID, NATIVE)
        self.assertNotEqual(baseline["controller"]["lock_key"], changed["controller"]["lock_key"])
        self.assertNotEqual(baseline["projection_sha256"], changed["projection_sha256"])
        differences = [(old, new) for old, new in zip(baseline["resources"], changed["resources"]) if old != new]
        self.assertEqual(len(differences), 1)
        old, new = differences[0]
        self.assertEqual(new, {**old, "desired": {**old["desired"], "mode": "0750"}})
        self.check_deny("INVALID_OVERRIDE", lock, OVERRIDE_UID, WSL)
        self.check_deny("INVALID_TARGET", lock, "node-" + "11111111-1111-1111-1111-111111111111")

    def test_lab_locks_use_same_target_and_file_asset_across_rollback(self):
        lab = EXAMPLES / "lab"
        digest = sha((lab / "README.txt").read_bytes())
        for platform in (NATIVE, WSL):
            observed = compile_target(lab / "project.lock.json", UID, platform)
            restored = compile_target(lab / "rollback.lock.json", UID, platform)
            self.assertEqual(observed["target"], restored["target"])
            self.assertEqual(observed["controller"], restored["controller"])
            self.assertNotEqual(observed["projection_sha256"], restored["projection_sha256"])
            resources = {item["id"]: item for item in observed["resources"]}
            rollback = {item["id"]: item for item in restored["resources"]}
            self.assertEqual(resources["lab-file"]["desired"]["sha256"], digest)
            self.assertEqual(resources["lab-file"], rollback["lab-file"])
            self.assertEqual(resources["lab-directory"]["desired"]["mode"], "0755")
            self.assertEqual(rollback["lab-directory"]["desired"]["mode"], "0750")
            self.assertFalse(any(item["kind"] in ("package", "package-db") for item in observed["resources"]))
        self.assertNotEqual(compile_target(lab / "project.lock.json", OVERRIDE_UID, WSL)["controller"]["lock_key"],
                            compile_target(lab / "project.lock.json", UID, WSL)["controller"]["lock_key"])

    def test_lab_can_pin_the_actual_fixture_mount_without_copying_whole_layers(self):
        lab = EXAMPLES / "lab"
        for example in lab.glob("*.json"):
            shutil.copyfile(example, self.private / example.name)
        config = json.loads((self.private / "project.lock.json").read_bytes())
        for platform in (NATIVE, WSL):
            config["platforms"][platform]["path_aliases"] = [{
                "from": {"scope": "host", "path": "/opt/ghostfleet-fixture"},
                "to": {"scope": "host", "path": FIXTURE_HOME},
            }]
        self.write(self.lock.name, config)
        for platform in (NATIVE, WSL):
            compiled = compile_target(self.lock, UID, platform)
            entries = {item["id"]: item for item in compiled["resources"]}
            self.assertEqual(entries["lab-directory"]["key"], f"{FIXTURE_HOME}/ghostfleet-profile-sample")
            self.assertEqual(entries["lab-file"]["key"], f"{FIXTURE_HOME}/ghostfleet-profile-sample/README.txt")

    def test_committed_inputs_and_expected_projection_drift_fail_closed(self):
        lock = self.fixture([resource("fixture-directory", "path", f"{FIXTURE_HOME}/source", state="directory")])
        original = compile_target(lock, UID, NATIVE)
        self.check_deny("PROJECTION_DIGEST_MISMATCH", lock, expected="a" * 64)
        path = self.private / "base.json"
        path.write_bytes(path.read_bytes() + b"\n")
        self.check_deny("LOCK_DIGEST_MISMATCH", lock)
        result = self.run_compiler(lock)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (2, b"", b"LOCK_DIGEST_MISMATCH\n"))
        doc = json.loads(lock.read_bytes())
        doc["matrix_sha256"] = "b" * 64
        self.write(lock.name, doc)
        self.check_deny("LOCK_DIGEST_MISMATCH", lock)
        self.assertEqual(len(original["projection_sha256"]), 64)

    def test_input_links_and_malformed_json_are_rejected_without_echoing_names(self):
        lock = self.fixture([])
        self.lock.write_text('{"private-fixture-reference": 1, "private-fixture-reference": 2}')
        result = self.run_compiler(lock)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (2, b"", b"DUPLICATE_JSON_KEY\n"))
        self.fixture([])
        path = self.private / "base.json"
        path.rename(self.private / "linked.json")
        path.symlink_to("linked.json")
        self.check_deny("INVALID_LOCK_REFERENCE", lock)
        alias = self.private / "linked.lock.json"
        alias.symlink_to(lock.name)
        self.check_deny("INPUT_UNAVAILABLE", alias)
        lock.write_bytes(b'{"a":"\\ud800"}')
        self.check_deny("INVALID_JSON", lock)

    def test_override_cannot_change_resource_kind_or_extend_authority(self):
        lock = self.fixture([resource("a", "path", f"{FIXTURE_HOME}/a", state="directory")])
        config = json.loads(lock.read_bytes())
        doc = {"schema": "ghostfleet-config-override/v1", "name": "override-fixture", "version": "1.0.0",
               "target": {"node_uid": UID, "platform": NATIVE}, "changes": [{"id": "a", "desired": {"owner": "oci"}}]}
        config["overrides"] = {UID: self.write("override.json", doc)}
        self.write(lock.name, config)
        self.check_deny("INVALID_DESIRED_STATE", lock)
        doc["changes"] = [{"id": "new-resource", "desired": {"state": "directory"}}]
        config["overrides"] = {UID: self.write("override.json", doc)}
        self.write(lock.name, config)
        self.check_deny("INVALID_OVERRIDE", lock)

    def test_implicit_dpkg_writer_and_system_state_conflict_even_across_distinct_packages(self):
        git = resource("git", "package", "git:amd64", state="present", version="1:2.47.3-1")
        system = resource("system-apt", "package-db", "dpkg", state="managed")
        tailscale = resource("ts", "package", "tailscale", "converger", state="present", version="1.0.0")
        isolated = resource("fleet-apt", "package-db", "isolated-apt", "ghostfleet", state="managed")
        reporter = resource("reporter", "package", "ghostfleet-node", "ghostfleet", state="present", version="0.4.0")
        data = compile_target(self.fixture([git, system, isolated, reporter]), UID, NATIVE)
        entries = {entry["id"]: entry for entry in data["resources"]}
        self.assertEqual(entries["system-apt"]["key"], "apt/dpkg")
        self.assertEqual(entries["git"]["key"], "git:amd64")
        self.check_deny("PACKAGE_MANAGER_CONFLICT", self.fixture([git, tailscale]))
        self.check_deny("PACKAGE_MANAGER_CONFLICT", self.fixture([git, {**tailscale, "scope": "wsl"}], platform=WSL),
                        platform=WSL)
        store = resource("dpkg-shadow", "store", "/var/lib/dpkg/status", "oci", state="retained")
        self.check_deny("PACKAGE_STATE_REQUIRES_NATIVE_OWNER", self.fixture([git, store]))
        self.check_deny("RESOURCE_OWNER_MISMATCH", self.fixture([{**git, "owner": "ghostfleet"}]))
        self.check_deny("DUPLICATE_RESOURCE_WRITER", self.fixture([git, {**git, "id": "git-alias", "key": "git"}]))

    def test_package_state_paths_cannot_bypass_native_owner(self):
        entries = (("/var/lib/dpkg/status", "file"), ("/var/lib/apt", "directory"),
                   ("/var/cache/apt/archives", "directory"), ("/var/cache", "directory"))
        for path, state in entries:
            with self.subTest(path=path):
                writer = resource("package-state", "path", path, state=state)
                self.check_deny("PACKAGE_STATE_REQUIRES_NATIVE_OWNER", self.fixture([writer]))
                observed = resource("package-state", "path", path, observe=True)
                compile_target(self.fixture([observed]), UID, NATIVE)

    def test_installer_lifecycle_reserves_next_generation_reporter(self):
        installer = resource("installer", "lifecycle", "ghostfleet:installer", "ghostfleet", state="present")
        legacy = resource("legacy-timer", "unit", "ghostfleet-heartbeat.timer", "ghostfleet", state="active")
        self.check_deny("EXCLUSIVE_RUNTIME_WRITER", self.fixture([installer, legacy]))
        observed = resource("legacy-timer", "unit", "ghostfleet-heartbeat.timer", "ghostfleet", observe=True)
        compile_target(self.fixture([installer, observed]), UID, NATIVE)

    def test_paths_overlap_other_paths_units_credentials_and_stores(self):
        base = resource("a", "path", f"{FIXTURE_HOME}/aaa", state="directory")
        nested = resource("b", "path", f"/{FIXTURE_HOME}/dir/../aaa/text", state="file")
        credentials = resource("c", "credential", f"{FIXTURE_HOME}/aaa/credential", "ghostfleet", state="retained")
        store = resource("d", "store", f"{FIXTURE_HOME}/aaa/store", "oci", state="retained")
        unit = resource("e", "unit", "fixture.service", "cloudflare", state="active")
        dropin = resource("f", "path", "/etc/systemd/system/fixture.service.d/override.conf", state="file")
        result = compile_target(self.fixture([base, nested]), UID, NATIVE)
        self.assertEqual(result["resources"][1]["key"], f"{FIXTURE_HOME}/aaa/text")
        self.check_deny("RESOURCE_OVERLAP", self.fixture([base, credentials]))
        self.check_deny("RESOURCE_OVERLAP", self.fixture([base, store]))
        self.check_deny("RESOURCE_OVERLAP", self.fixture([unit, dropin]))
        self.check_deny("RESOURCE_OVERLAP", self.fixture([{**base, "desired": {"state": "absent"}}, nested]))
        self.check_deny("PROTECTED_RESOURCE", self.fixture([resource(
            "identity-path", "path", "/etc/other/../ghostfleet-nextgen/identity", state="file")]))

    def test_protected_unit_files_and_dropins_require_owner_even_without_active_unit_claim(self):
        observed = resource("reporter-readback", "unit", "ghostfleet-nextgen-report.timer", "ghostfleet", observe=True)
        blocked = [
            ("/etc/systemd/system/ghostfleet-nextgen-report.timer", "file"),
            ("/etc/systemd/system/ghostfleet-nextgen-report.timer.d", "directory"),
            ("/usr/local/lib/systemd/system/ghostfleet-nextgen-report.timer.d/20-local.conf", "file"),
            ("/run/systemd/system/tailscaled.service.d/10-settings.conf", "file"),
            ("/usr/lib/systemd/system/cloudflared-ssh.service", "file"),
            ("/etc/systemd/system/k3s-.service.d/10-common.conf", "file"),
            ("/etc/systemd/system/service.d/10-common.conf", "file"),
            ("/etc/systemd/system", "directory"),
        ]
        for key, state in blocked:
            with self.subTest(path=key):
                candidate = resource("unrelated-writer", "path", key, state=state)
                self.check_deny("PROTECTED_RESOURCE", self.fixture([observed, candidate]))
        own = resource("reporter-owner", "path", blocked[0][0], "ghostfleet", state="file")
        unrelated = resource("fixture-owner", "path", "/etc/systemd/system/fixture.service.d/local.conf", state="file")
        compile_target(self.fixture([observed, own, unrelated]), UID, NATIVE)

    def test_rc3_k3s_agent_excludes_other_active_k3s_host_units(self):
        rc3 = resource("rc3-agent", "unit", "ghostfleet-nextgen-k3s-agent.service", "ghostfleet", state="active")
        for unit in ("k3s.service", "k3s-agent.service"):
            with self.subTest(unit=unit):
                legacy = resource("previous-role", "unit", unit, "k3s", state="active")
                self.check_deny("EXCLUSIVE_RUNTIME_WRITER", self.fixture([legacy, rc3]))
                observation = resource("role-readback", "unit", unit, "k3s", observe=True)
                compile_target(self.fixture([observation, rc3]), UID, NATIVE)

    def test_declared_wsl_or_oci_mounts_collapse_to_one_physical_path(self):
        alias = {"from": {"scope": "wsl", "path": "/sample-mount/drive"},
                 "to": {"scope": "windows", "path": "C:/Synthetic"}}
        windows = resource("windows", "path", "c:/SYNTHETIC\\Folder/APP", "windows", "windows", state="directory")
        guest = resource("wsl", "path", "/sample-mount/drive/folder/app", "windows", "host", state="directory")
        self.check_deny("DUPLICATE_RESOURCE_WRITER", self.fixture([windows, guest], platform=WSL, aliases=[alias]),
                        platform=WSL)
        ancestor = resource("parent", "path", "/sample-mount", "wsl", "wsl", state="directory")
        self.check_deny("PATH_COVERS_MOUNT", self.fixture([ancestor], platform=WSL, aliases=[alias]), platform=WSL)
        self.check_deny("INVALID_PATH", self.fixture([{**windows, "key": "C:relative.txt"}]))
        self.check_deny("INVALID_PATH", self.fixture([{**windows, "key": "C:/Lab/CON.txt"}]))
        data = compile_target(self.fixture([guest], platform=WSL, aliases=[alias]), UID, WSL)
        self.assertEqual((data["resources"][0]["scope"], data["resources"][0]["key"]),
                         ("windows", "c:/synthetic/folder/app"))
        mount = {"from": {"scope": "oci", "path": "/container-volume"},
                 "to": {"scope": "host", "path": f"{FIXTURE_HOME}/shared"}}
        oci = resource("container", "store", "/container-volume/cache", "oci", "oci", state="retained")
        host = resource("host", "path", f"{FIXTURE_HOME}/shared", state="directory")
        self.check_deny("RESOURCE_OVERLAP", self.fixture([oci, host], aliases=[mount]))
        chain = {"from": {"scope": "host", "path": f"{FIXTURE_HOME}/shared"},
                 "to": {"scope": "host", "path": f"{FIXTURE_HOME}/elsewhere"}}
        self.check_deny("OVERLAPPING_PATH_ALIAS", self.fixture([], aliases=[mount, chain]))

    def test_ports_detect_wildcard_ranges_dual_stack_and_mapped_addresses(self):
        one = resource("host", "port", "TCP/0.0.0.0/30440-30450", state="reserved")
        overlapping = resource("guest", "port", "tcp/[::ffff:192.0.2.33]/30443", "oci", "oci", state="reserved")
        self.check_deny("RESOURCE_OVERLAP", self.fixture([one, overlapping]))
        ip6 = resource("ip6", "port", "tcp/[::]/443", "windows", "windows", state="reserved")
        local4 = resource("ip4", "port", "tcp/127.0.0.1/443", "k3s", "k3s", state="reserved")
        self.check_deny("RESOURCE_OVERLAP", self.fixture([ip6, local4]))
        self.check_deny("INVALID_PORT", self.fixture([{**one, "key": "tcp/65536"}]))
        separate = resource("unrelated", "port", "udp/30443", "k3s", "k3s", state="reserved")
        output = compile_target(self.fixture([one, separate]), UID, NATIVE)
        self.assertEqual(output["resources"][0]["key"], "tcp/0.0.0.0/30440-30450")

    def test_routes_canonicalize_networks_and_reject_overlapping_owners(self):
        one = resource("ts", "route", "192.0.2.53/27", "tailscale", "tailnet", state="present")
        overlapping = resource("kube", "route", "::ffff:192.0.2.54/125", "k3s", "k3s", state="present")
        self.check_deny("RESOURCE_OVERLAP", self.fixture([one, overlapping]))
        invalid = {**one, "key": "192.0.2.42/99"}
        self.check_deny("INVALID_ROUTE", self.fixture([invalid]))
        output = compile_target(self.fixture([one]), UID, NATIVE)
        self.assertEqual(output["resources"][0]["key"], "192.0.2.32/27")

    def test_only_one_active_runtime_family_and_read_only_claims_can_coexist(self):
        legacy = resource("old-timer", "unit", "ghostfleet-heartbeat.timer", "ghostfleet", state="active")
        nextgen = resource("new-timer", "unit", "ghostfleet-nextgen-report.timer", "ghostfleet", state="present", enabled=True)
        report = resource("new-service", "unit", "ghostfleet-nextgen-report.service", "ghostfleet", state="present")
        self.check_deny("EXCLUSIVE_RUNTIME_WRITER", self.fixture([legacy, nextgen]))
        observed = resource("old-observed", "unit", "ghostfleet-heartbeat.timer", "ghostfleet", observe=True)
        output = compile_target(self.fixture([observed, nextgen, report]), UID, NATIVE)
        self.assertEqual(len(output["resources"]), 3)
        stopped = {**legacy, "desired": {"state": "inactive", "enabled": False}}
        compile_target(self.fixture([stopped, nextgen, report]), UID, NATIVE)
        for owner, units in (("k3s", ("k3s.service", "k3s-agent.service")),
                             ("cloudflare", ("cloudflared.service", "cloudflared-ssh.service")),
                             ("tailscale", ("tailscaled.service", "tailscale.service"))):
            pair = [resource("runtime-" + str(i), "unit", value, owner, state="active")
                    for i, value in enumerate(units)]
            with self.subTest(owner=owner):
                self.check_deny("EXCLUSIVE_RUNTIME_WRITER", self.fixture(pair))

    def test_windows_host_automation_stays_owner_only_and_observe_cannot_carry_desired(self):
        managed = resource("native", "path", "C:/Synthetic/Foo", state="directory")
        self.check_deny("RESOURCE_OWNER_MISMATCH", self.fixture([managed], platform=WINDOWS), platform=WINDOWS)
        known = resource("wsl", "lifecycle", "wsl:fixture", "windows", "windows", state="external")
        compile_target(self.fixture([known], platform=WINDOWS), UID, WINDOWS)
        observed = {**managed, "mode": "observe"}
        self.check_deny("INVALID_DESIRED_STATE", self.fixture([observed], platform=WINDOWS), platform=WINDOWS)


if __name__ == "__main__":
    unittest.main()
