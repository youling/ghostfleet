"""Read-only packaged prerequisites: optional tools never block basic enrollment."""
import json
import subprocess
import sys
from ghostfleet_runtime.resource_paths import resource_path

BASE = "fleet/10_platforms/linux/common/operations/environment/"
SCRIPT = resource_path(BASE+"prereq_check.py")
MANIFEST = resource_path(BASE+"host-prerequisites.yaml")


def cli(*args):
    return subprocess.run([sys.executable,str(SCRIPT),"--manifest",str(MANIFEST),"--json",*args],
                          capture_output=True,text=True,timeout=15)


def test_enrollment_only_default_has_no_docker_backup_or_ansible_gates():
    result=cli()
    assert result.returncode in (0,3),result.stderr
    body=json.loads(result.stdout)
    assert body["read_only"] is True and body["host_mutation"] is False
    assert body["groups"]==["enrollment"]
    ids={x["id"] for x in body["results"]}
    assert not {"cmd-docker","cmd-ansible","cmd-zstd"} & ids


def test_optional_control_and_all_groups_require_explicit_choice():
    control=cli("--group","management-automation")
    assert control.returncode in (0,3),control.stderr
    items=json.loads(control.stdout)
    assert items["groups"]==["management-automation"]
    assert any(x["id"]=="cmd-ansible" for x in items["results"])
    all_groups=cli("--all-groups")
    assert all_groups.returncode in (0,3),all_groups.stderr
    values=json.loads(all_groups.stdout)
    assert len(values["groups"])==4
    assert any(x["id"]=="cmd-docker" for x in values["results"])
    assert any(x["id"]=="cmd-zstd" for x in values["results"])


def test_manifest_canonical_refs_are_public_and_not_stale():
    import yaml
    manifest=yaml.safe_load(MANIFEST.read_text())
    assert manifest["status"]=="source-preview"
    assert len(manifest["groups"])==4
    for item in manifest["groups"].values():
        path=item["canonical_ref"]
        assert path in {"docs/PLATFORMS.md","docs/RECOVERY.md","docs/OPERATIONS.md"}
