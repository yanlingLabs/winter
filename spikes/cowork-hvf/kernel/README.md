# Crypto-capable kernel comparison build

Status: **built and unbooted** in an isolated offline Linux container. All 33 required symbols passed after `olddefconfig`, and exported artifact hashes match the successful build receipt. Nine config/input-verification tests passed. The complete resolved config is [`resolved-6.18.35.config`](resolved-6.18.35.config); all 95 baseline differences are in [`config-changes.json`](config-changes.json), with tool commands, hashes and evidence in [`build-result.json`](build-result.json). No Cowork VM was run. The immutable initramfs, trusted PID 1/key transport, encrypted-disk behavior and production resource/security acceptance remain independent gates in [`../production-prerequisites.md`](../production-prerequisites.md).

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| arm64 Image | 21,412,352 | `6ab571a8482455d5b9ffe75aaa428613113c705144a3d479cfdcfa9e9457c862` |
| vmlinux | 302,054,888 | `13e0553cb94838b2bf75e82d0de6b544a4830d46612a27855f5574eeecb4be39` |
| resolved config | 98,830 | `f0be0fabe2ee0366a0b8dd26364aaf5b8cc9b827a4d7c0ab12b75bf6806b8afe` |

The final 4 GiB run exited 0, both make commands exited 0, and its cgroup peak was 4,041,830,400 bytes with zero `max`, `oom` or `oom_kill` events. These are builder metrics, not Cowork VM telemetry. The Image has the arm64 boot magic/4 KiB profile, and vmlinux is AArch64 with DWARF debug info. Symbol inspection confirms linked device-mapper crypt/integrity initializers and AES, XTS, GCM, authenc, HMAC and SHA-256 implementations.

## Pinned inputs and provenance

`crypto-inputs.json` pins pristine Linux 6.18.35, the cached Apple/Kata feasibility base config, the built-in crypto fragment and the selected builder/toolchain. There are no kernel patches. This is a comparison version/configuration, not production security/support selection. Switching the baseline's GCC 11.4 to LLVM 20.1.8 also changes compiler-dependent Kconfig symbols; the complete resolved configuration and symbol diff are retained.

Linux's source SHA-256 and detached developer signature over the decompressed tar were verified on the host and again inside the offline builder. Greg Kroah-Hartman's public key was obtained through kernel.org WKD/TLS and checked against the kernel.org published fingerprint. Neither a real GPG home nor Keychain was accessed. [Kernel signature procedure](https://www.kernel.org/signature.html)

The selected compiler is kernel.org's slim **LLVM 20.1.8 aarch64** bundle, 130,509,608 bytes, SHA-256 `945d22282d4bc623fd828fad50e14698fe7be070855f68f3d351a26305615ba7`. Its detached tar signature verified against signing key `7BE325C731319CCD01D8CA921D6B269171C01A96`, under primary key `2437CB76E544CB6AB3D9DFD399739260CB6CB716`, retrieved through the recorded kernel.org WKD/TLS URL. The fingerprint is a WKD identity binding, not an independently published fingerprint verification. The compiler reports source commit `87f0227cb60147a26a1eeb4fb06e3b505e9c7261` (`llvmorg-20.1.8`). Kernel.org describes these bundles as minimal PGO toolchains for building Linux kernels. [Kernel.org LLVM bundles](https://cdn.kernel.org/pub/tools/llvm/), [Linux LLVM build documentation](https://docs.kernel.org/kbuild/llvm.html)

The earlier 1.86 GB LLVM project volunteer binary remains explicitly recorded as `supersededToolchainCandidate`; it was not downloaded or used. `llvm-LICENSE.txt` is the upstream tagged source license (Apache 2.0 with LLVM exception), with pinned SHA-256. The slim binary archive has no bundled license file; complete binary-to-source/license provenance and toolchain security acceptance still require independent review.

## Isolated Linux builder

`Builder.Dockerfile` pins Ubuntu 24.04's arm64 registry manifest `sha256:08571ca13e00ca07a2a84eab83a959b4242e22cceb16486a11bef1428c9e93a7`. A signed APT bootstrap installs the exact `ca-certificates=20240203` package and APT-selected dependencies before TLS is available. Those bootstrap dependency inputs are pinned by the preserved final image/package receipt, rather than the Dockerfile initial current repository. The remaining packages use the signed Ubuntu snapshot at `20261011T000000Z`; unsigned/unavailable indexes are not accepted. [Ubuntu snapshot service](https://snapshot.ubuntu.com/)

The resulting locally preserved OCI index/image ID is `sha256:8143f5c8e71574a89a9dc0cfbfa43cc4c491f02f6a08b3f0f8910329de137de8`. The saved image is in ignored `../out/kernel-crypto/builder-image.tar`, SHA-256 `85e8c23e31fc1f58c17a445379d23693924d4b70e1b0774812001dcfb19bef19`. Docker image inspection/rootfs diffIDs, all 157 installed binary/source package versions, 66 downloaded `.deb` hashes, all 157 package copyright files and host sysroot file hashes are retained in the receipt. Packages inherited from the base are pinned by the base manifest, not newly downloaded `.deb` files. The native sysroot covers host utility headers/libraries/startup objects; there is no guest userspace sysroot or cryptsetup bundle. Exact package source versions and copyright files are evidence for review; they are not a completed license audit or a full source-archive mirror.

`receipt_builder.py` records absolute paths and SHA-256 for make, bison, flex, bc, perl, openssl, sh, awk, sed, find, pahole, Python, gpgv, xz, ldd and the native linker. The tracked [`builder-packages.json`](builder-packages.json), [`builder-package-archives.json`](builder-package-archives.json), [`toolchain-files.json`](toolchain-files.json) and [`kernel-licenses.json`](kernel-licenses.json) preserve package/source/copyright pins, downloaded package hashes, the extracted LLVM file inventory and kernel `LICENSES/` plus `COPYING` hashes. Full copyright texts and the host sysroot file inventory remain in the ignored local receipt/image, referenced by exact hashes in the result. Package source locators are versioned Launchpad URLs; exact sources can be retrieved with `apt-get source SOURCE=VERSION` after enabling `deb-src` against the same snapshot. Source package archives are not downloaded by this kernel build. Normal PATH can reach other executables from the pinned image; this dependency inventory and successful compilation do not prove a hermetic or production-trusted build.

The first attempt failed before `olddefconfig` because slim Clang's host utility link needed native `ld`/GCC startup objects. The final builder adds signed snapshot binutils and `libgcc-13-dev`; kernel target compilation/linking still use the pinned LLVM tools. `first-build-failure.log` retains that failure. Only that attempt's own disposable scratch volume was removed.

## Reproduce explicitly

From the Winter repository root, with the two pinned archives already downloaded into `spikes/cowork-hvf/out/kernel-crypto`:

```sh
python3 spikes/cowork-hvf/kernel/prepare_crypto.py
python3 spikes/cowork-hvf/kernel/test_prepare.py
docker build --platform linux/arm64 \
  --file spikes/cowork-hvf/kernel/Builder.Dockerfile \
  --tag winter-cowork-kernel-builder:20261011 spikes/cowork-hvf/kernel
docker image inspect winter-cowork-kernel-builder:20261011
# Reuse the saved exact image; a fresh Dockerfile rebuild may have different
# image timestamps/index digest even when selected packages are identical.
docker image load --input spikes/cowork-hvf/out/kernel-crypto/builder-image.tar
python3 spikes/cowork-hvf/kernel/run_container_build.py \
  --image sha256:8143f5c8e71574a89a9dc0cfbfa43cc4c491f02f6a08b3f0f8910329de137de8 \
  --memory-gib 4
```

The launcher refuses an existing completed receipt/frozen input directory. For another clean compile, set `COWORK_KERNEL_OUT` to a fresh private scratch directory and copy only the two pinned archives there. It freezes the small input files, launches a uniquely named disposable Linux container/volume, verifies both archive signatures, extracts fresh source/toolchain and invokes `build_crypto.py` at fixed `/build/src/linux-6.18.35`, `/build/output` and `/build/llvm` paths. No source/output path in Kbuild contains spaces or colons. The source/toolchain extractor refuses an existing build. `--resume-volume NAME` accepts only explicitly named failed fixture volumes and rechecks every extracted regular file, hardlink and normalized symlink against the signed archives, rejecting added files before retrying. A completed build cannot be resumed. Failed BTF attempts can be reproduced only with their retained pre-BTF-off fragment/config; they are not the current kernel profile.

Compilation starts with two jobs, two CPUs and a 2 GiB memory limit with no additional swap; an explicit `--memory-gib 4` retry remains within the authorized ceiling. All attempts use a 128 PID limit, a non-root UID, no network, read-only rootfs, all capabilities dropped and `no-new-privileges`. The checked-in launcher admits only read-only fixture input/archive host mounts during compilation; its export container alone obtains the private output mount. It never mounts a home, source user data or Docker socket. Build time/user/host/version and locale/timezone are fixed. The disk policy stops at 8 GiB scratch use or below 8 GiB host free space; this is a sampled 10-second abort guard, not a filesystem quota or adversarial-code boundary. At least 12 GiB free is required to start. Retained build volumes belong only to this fixture and are named in `container-run.json`.

The resolved configs, frozen retry scripts and Docker mount inventories are retained where produced. The first missing-linker attempt preserves its failure log rather than a complete frozen script receipt. The initial failed 2 GiB run gave the private export directory to the compile container, creating a writable alias for its frozen input copy under `/exports`; later attempts use the checked-in read-only archive/export split and reverify extracted inputs before reuse. The initial generated receipt mislabeled the Docker digest as a configuration digest; Docker inspection identifies it as an OCI index. These historical errata do not change the recorded runs. No attempt mounted source user data, a host home or Docker socket.

## Required config and remaining gates

`crypto-candidate.fragment` requires built-in MD/device mapper, crypt/integrity targets, block integrity, AES-XTS, GCM/GHASH, authenc/HMAC/SHA-256/ESSIV, AF_ALG hash/skcipher/AEAD, keys/devtmpfs/tmpfs/initrd/ext4, virtio block/MMIO/balloon and page reporting. Loadable modules are disabled. Optional BTF generation failed under 2 GiB and 4 GiB, including a serial pahole retry; Docker recorded an OOM event for the serial retry. The bounded comparison profile therefore disables `CONFIG_DEBUG_INFO_BTF` while retaining `CONFIG_DEBUG_INFO=y` and DWARF. This changes BPF/BTF introspection and CO-RE metadata availability; it is not production observability acceptance. No higher memory cap is used. `verify_config` rejects silently disabled symbols and modules substituted for essential built-ins. Page poisoning and init-on-free/init-on-alloc defaults are explicitly disabled to preserve the restricted reclaim comparison contract. A boot admission check must independently pin command-line overrides; configuration alone does not enforce that.

Pinned cryptsetup/libcryptsetup and dependencies, trusted PID 1/key receiver and an immutable initramfs file manifest remain required. There is no unlock implementation, key provisioning, plaintext fallback, disk format selection or encrypted-disk claim. Compile success cannot validate authenticated-format maturity, header freshness/recovery, broker/worker/guest key delivery, regular serial binding, real crypto I/O or active memory return. Boot and remeasure this exact profile after the device/access review gates before inheriting any restricted A6 resource conclusion.
