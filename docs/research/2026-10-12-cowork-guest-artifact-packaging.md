# Reproducible immutable ARM64 guest payload

Winter base `1c1aa1a6cbb3e190a3afb1f3cd3262598f7d6c95`, branch `cowork/linux-guest-artifact`. SDK runtime/helper source is exactly `39ba77ec333293cfcaabcf7eb29b4d7a58f24990` (reviewed PR5). Canonical SDK builder correction is separately committed at `180d3effd7ddbb9406aeea0912f76c78ef20cf75`, from PR4 merge `1816df72`. Package semver remains unchanged and does not identify this artifact. No SDK consumer pin, release, push or CI was performed.

## Actual deliverable

`out/cowork-guest-artifact/candidate-a/` retains the actual readonly root, `immutable-root.cpio`, gzip companion, current compiled Winter ARM64 runtime, three native helpers, immutable supervisor Python source and full loader/dependency/metadata receipts. A second complete fresh build is retained at `candidate-b/`. Their complete receipts, runtime/helper hashes, root manifests, cpio and gzip hashes match. A third fresh `accepted-check/` build exercised the final expected-output integrity guards and matched too.

The final image has **7281 packed entries and 627 ARM64 ELFs**. The independent reader verified actual packed uid/gid 0, directories 0555, regular files 0444/0555, symlinks 0777, nlink 1, mtime 0, content hashes, exact manifest membership and no device/FIFO/socket/init records. The local root tree remains owned by the unprivileged builder; no local chown or privilege escalation was used. Root guest ownership is encoded in and read back from the artifact, not claimed from Mac file ownership.

| Artifact | SHA-256 |
| --- | --- |
| Canonical cpio | 83abcaf8807966b8ae293c10bae4059ffc450076d68d7eb871fd5faf40e522e3 |
| Root manifest | 2a14c91bd7c6cabf331dfa4fbb879a7a12939455526ad346f7d993844279d114 |
| Gzip companion | 37a5deb69bae2fbbdf534fa142b8efdcf75975fad5044160d7fdaf24ecfdd853 |
| Current Winter runtime | 4eee5d4ce741b5e6aab0e8345f067d4fb9c08cdbb1c5b0a0aef22d36b3000c08 |
| file-worker | 8fc771e368d0023ac4a15c598e746ca4ebf01d8be7c4fcb56a01645ecc7260f2 |
| process-worker | ea0cec51eafa0b8e320b8629d0e8009d9d50e83061f7e01f7dea490998baf156 |
| linux-tool-compartment | 8e25216ed26f59da65c8ac01de758631e7cc7e871994175da74ceb9cdb3bc2d1 |

The runtime was rebuilt from a Git-exported source snapshot, using verified Bun 1.3.14 Linux ARM64 base bytes and the canonical builder. Historical `winter-pinned` from SDK PR4 was never relabeled as current source. Exact helper C/header/Python source SHA-256s, binary SHA-256s, builder source hash and compile flags are recorded in [the receipt](2026-10-12-cowork-guest-artifact-receipt.json). A provider/runtime/helper source change requires an explicit new build and review, even if package version still says 0.0.53.

## Package provenance and root separation

The committed lock pins **84 official Debian ARM64/all packages**, 46,604,920 compressed bytes, from Debian/bookworm and Debian-security/bookworm-security snapshot `20261011T000000Z`. Official public key bytes and primary fingerprints are pinned. Actual GPG verification establishes InRelease signatures; authenticated Release SHA-256s bind both ARM64 Packages indices, which bind every downloaded .deb's SHA-256/size. Extracted control identity must agree with index package/version/architecture. The security snapshot also carries the active Debian 11 security signer; its separately published official fingerprint and bytes are pinned rather than bypassing the initial missing-key refusal. [Debian archive keys](https://ftp-master.debian.org/keys.html), [APT authentication model](https://manpages.debian.org/bookworm/apt/apt-secure.8.en.html), [snapshot service](https://snapshot.debian.org/).

Inputs include Python 3.11.2-6+deb12u9 and isolated stdlib, Bash 5.2.15-2+b13, Git 1:2.39.5-0+deb12u3, e2fsprogs 1.47.0-2+b2, glibc 2.36-9+deb12u14 and complete declared Pre-Depends/Depends closure (not recommendations), plus explicit CA certificates. No apt/dpkg installation, maintainer scripts, triggers, host global changes or distro program execution occurred. Package payloads are bounded safe regular/directory/symlink members; unsafe paths, conflicts, special files and corrupt cache bytes refuse. Hardlinks are resolved only to already admitted regular bytes and become independent readonly files, never host inode aliases. Public package copyrights/docs/locales are retained under an explicit full-payload policy. The CA bundle is a deterministic concatenation of verified package Mozilla certificate files.

All distro bytes appear once under `/opt/winter/environment/base`. Conventional root bin/lib/sbin/usr/etc aliases preserve loader and Python prefixes. This gives the actual reviewed supervisor a disjoint environment root: using `/` as environment would make its protected-overlap check refuse every workspace source. Private `/opt/winter/runtime`, `/opt/winter/helpers` and `/opt/winter/libexec` remain outside that subtree. The exact Python startup contract is `/usr/bin/python3 -I -S /opt/winter/libexec/linux-supervisor.py`, but no service or init was launched or generated. Writable data/environment disks remain separate future mounts; no backend profile/device was added or changed.

ELF validation checks 64-bit little-endian AArch64, interpreter presence, every DT_NEEDED resolution and actual required symbol-version availability in the selected providers. Executable stacks and writable/executable load segments refuse. The native helpers are exact SDK source compiled using verified Zig 0.14.1 as static ARM64-musl, strict C11/O2/warnings, explicit stripping and no build ID. Source-prefix mapping and artifact scanning reject private/random build paths. These binaries need actual Linux execution/admission; matching source is not a claim of equivalence to a GCC/glibc CI artifact.

## Reproducibility correction and retained failures

The original canonical builder's independently random source/staging names embedded `../winter-build-runtime-copy-<random>/...` comments. Original fresh probes differed (5b669a40… versus 96aa77d8…). A controlled same-basename repeat also differed: 1515a2f9e4b1dd34637c1e42093cc50867a57616825b9100193aa370a53563d4 versus 4cf9de054e17df0f16f40d2b0c31567a1ae1684e95d5b2b220f39bab94c70f4e. A source-copy-cwd experiment was rejected because it would weaken build-time bunfig/dotenv/preload separation; it also used different output basenames and was not accepted as reproducibility proof. Both failed probes remain private evidence.

The separate SDK correction uses one private random parent with deterministic `source/` and initially empty `stage/` children, retaining runtime no-autoload flags, base-byte copying, neutral source copying and finally cleanup. Output basename is held at `winter`, since Bun's virtual entrypoint legitimately depends on it. Two full current ARM64 rebuilds and subsequent image builds now agree. **11 SDK builder tests/24 assertions passed**, including two actual fixture compiles with a hostile source preload. Packaging calls that canonical builder through a thin wrapper; it does not fork its staging logic.

The first image privacy check correctly found Zig debug sections with local paths; helpers were rebuilt with explicit stripping. The first Mac root metadata check found symlink umask differences; local link modes are now normalized separately without following targets. Failed build logs are preserved. None was converted to a pass or hidden by replacing old native caches.

## Size and memory limits

Canonical cpio is **336,631,808 bytes (321.0 MiB)**; gzip is **117,771,928 bytes (112.3 MiB)**. The gzip uses empty filename, mtime 0, level 9 and zlib 1.2.12, and independently decompresses to the canonical hash. Both gzip builds match here; cross-zlib compressed reproducibility is not assumed. Inspected pinned-kernel `base-apple-6.18.35.config` and `resolved-6.18.35.config` contain `CONFIG_RD_GZIP=y`. This is configuration evidence, not acceptance of this new image by a native worker/kernel. Canonical uncompressed hash is preserved.

| Payload category | Bytes |
| --- | ---: |
| Winter runtime | 102344848 |
| Other distro executables/libraries/data | 123434773 |
| Perl libraries | 44632843 |
| Locales | 35036405 |
| Python stdlib | 15031970 |
| Docs/man/info including licenses | 14662929 |
| Native helpers | 131384 |
| Supervisor source | 24442 |

Repeated payloads total **16,401,978 bytes**. Largest duplicates are Git (3,756,992 bytes extra), Perl/perl5.36.0 (3,681,928), scalar (2,264,520), git-shell (2,194,176), and Git/Git-man changelog (968,990). Only two archive hardlink records occur; they are flattened to independent bytes. Other byte-identical files are intentionally retained. No cpio hardlink compression/dedup claim is made. See [full size/duplicate breakdown](2026-10-12-cowork-guest-artifact-size-breakdown.json).

**Guest RAM floor, boot high water, Linux execution, concurrent latency and readiness are unmeasured.** A roughly 321 MiB expanded initramfs can consume a material part of the current 768 MiB developer profile before runtime allocations. Gzip does not eliminate that expanded filesystem cost or prove active memory return. The profile is not the user's eventual automatic sizing contract. Future explicit trimming/dedup must retain licenses and revalidate the exact loader/runtime closure; this slice prioritizes a complete, validated artifact over unmeasured optimizations.

## Evidence and handoff

**9 host packaging regression tests passed**, including actual GPG refusal after signed metadata tampering, cached-deb corruption, traversal/symlink-parent refusal, guest-rooted link resolution, content conflict, wrong architecture/program bounds, ar bounds, dependency versions and independently read normalized cpio fields. Three fresh final-layout builds match; two complete cpio/gzip/root receipts match exactly and a third final pinned-output guard build agrees. No VM/Linux binary/privileged service execution occurred. Host byte/ELF/metadata proof is distinct from native ARM64 execution, source-level SDK supervisor CI or production boot proof.

Private raw logs, source/tool snapshots, downloaded verified packages, failed probes and final artifacts are retained under ignored `out/cowork-guest-artifact/`. Committed receipts contain no machine paths. Actual final files are `candidate-a/immutable-root.cpio`, `candidate-a/immutable-root.cpio.gz`, `candidate-a/root/`, `candidate-a/elf-dependencies.json`, and `candidate-a/receipt.json`; counterpart `candidate-b` retains independent repeat bytes. Original VM caches and historical receipts were not altered.

No init/full startup, native worker admission, filesystem mount/readiness, UID/store provisioning, provider broker, cold continuation, VM reclaim, SDK release/consumer pin or public Cowork availability is claimed. This image is a concrete reproducible prerequisite. Root owns native admission/full startup and must bind the exact new image and helpers to protected launch/runtime evidence before executing them.
