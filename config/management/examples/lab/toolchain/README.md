# Restore the Debian 13 amd64 lab toolchain

This optional example restores the locked Node.js, TypeScript, Python, Rust, Git, and GNU binutils tools on an owner-approved Debian 13 amd64 lab target. The same lock covers native Debian and an independently registered Debian WSL2 instance. The target needs Bash, APT, dpkg, and GNU core utilities. Python can be missing on the target before restoration.

On a Debian owner preparation system with Python 3, APT, and curl, copy the approved target’s `/var/lib/dpkg/status` to a file for package resolution. Use the example directory from the reviewed source revision.

```sh
python3 -I prepare-supply.py --target-status target.status --output /path/to/new-supply
```

The preparer resolves dependencies using Debian’s signed `trixie` main archive, verifies package SHA-256 against that metadata, and checks the direct package and npm archive pins in `restore.lock.json`. It records the source index and target package-status digests and emits the `manifest_sha256` for the resulting supply. To reuse the read-only owner artifact cache, pass `--verified-cache`. To reuse a previously acquired signed APT index, pass `--index-cache`. Cached indexes are authenticated against Debian’s archive keyring and verified against the signed digest and applicable validity period. Prepare another supply if the target baseline changes or the signed archive can no longer resolve the pinned versions.

Deliver the reviewed `restore.sh`, root-owned `0700` supply directory, and approved manifest SHA-256 through the existing owner channel. Apply only to the designated fixture using the authorized root principal.

```sh
/bin/bash /path/to/approved/restore.sh /path/to/supply APPROVED_MANIFEST_SHA256
```

The restorer verifies the supplied manifest and package bytes. A pending APT transaction requires the owner-approved clean dpkg status digest and a clean `dpkg --audit` result. The plan permits the approved package versions and rejects removals. Native APT registers the Debian packages, and the archive-backed Node.js and TypeScript files are installed atomically under `/opt/ghostfleet-lab-toolchain`. The first successful run reports `APPLIED` and a repeat reports `UNCHANGED` when package versions and installed artifacts match. An interrupted or changed baseline or a changed Node.js/TypeScript prefix requires owner reconciliation. APT sources and Windows/WSL host settings are maintained by their original owner paths.

For an isolated end-to-end sample, stage `sample.ts`, `sample.py`, `sample.rs`, and `smoke.sh` in a root-owned ext4 directory readable by the authorized unprivileged fixture user. Provide root-owned read-only `in/sample.txt` under it and an `out/` directory writable by that user. Call `/bin/bash /path/to/sample/smoke.sh` through the existing runtime with the target OS, distro, user, and absolute working directory explicitly specified. The sample compiles and executes TypeScript, Python in a venv, and a Rust ELF, analyzes that ELF with readelf, and uses Git object storage to prove byte-exact input/output. Its files remain in the authorized output directory.
