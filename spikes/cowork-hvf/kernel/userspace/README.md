# Neutral cryptsetup userspace prerequisite

Status: **built and relocation-verified**, not a bootable/unlock-ready initramfs. Root authorized this format-neutral increment while both [authenticated LUKS2 candidates](candidate-2026-10-12.md) await independent review. No format has been selected; no key, device, disk, PID 1, unlock operation or VM run was used or implemented. The kernel comparison remains unbooted and BTF-off.

Two clean source builds produced byte-identical toolset archives, and the final run exercised the checked-in compiler-hash guard and integrated post-export checks. The actual build compiles cryptsetup/libcryptsetup **2.8.8**, `integritysetup` and a no-key/no-device API capability executable. Configure/make/install exited 0/0/0. The build used 2 CPU / 2 jobs / 2 GiB with no additional swap; final cgroup peak was **122,417,152 bytes** with zero max/OOM/OOM-kill events. These are builder metrics, not Cowork VM telemetry. [Build result](build-result.json)

`out/kernel-crypto/userspace-build/toolset.tar` is a deterministic-metadata archive of **17 files / 10,270,720 bytes**, SHA-256 `30a35be0d452c9bcc8ab882027e1072ea0ce1125211a42af91b94d4dc4786671`. The dynamic loader/binaries use mode 0555, other libraries/provider files 0444; archive ownership is uid/gid 0, fixed mtime and sorted paths. [Exact file manifest](toolset-files.json)

The relocated verification runs the bundle's loader on the original kernel builder image, with the bundle mounted read-only and `OPENSSL_MODULES` fixed to the bundled module directory. Both CLIs report 2.8.8; the capability executable accepts PBKDF2-SHA256 / 1000 iterations / `CRYPT_PBKDF_NO_BENCHMARK`, without executing a benchmark or consuming a key/device. `LD_DEBUG=libs` confirms every initialized library/provider for these observed operations comes from `/bundle`, with no builder-library fallback. This covers version/API setup, not every possible cryptsetup operation, guest cipher availability, disk encryption or boot.

## Inputs and dependency provenance

Upstream identifies 2.8.8 as its current stable version; its authenticated LUKS2 extension remains experimental. The source is pinned by [inputs.json](inputs.json), SHA-256 `3acfa685f2dd7fcc832e0b77bc7093aa7da554a51ce8dafbb4138eaa854eee35`, and its detached signature over decompressed tar was verified both outside and inside the offline builder. [Tagged upstream README](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/README.md), [current authenticated-encryption manual](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/man/cryptsetup.8.adoc)

The signer fingerprint `2A2918243FDE46648D0686F9D9B0577BD93E98FC` matches tagged upstream `SECURITY.md`. Kernel.org WKD served an expired certificate; that result was rejected. The same fingerprint's updated self-certified certificate from Ubuntu's public keyserver expires in 2031. The pinned dearmored public key verifies GOODSIG/VALIDSIG with no expired/revoked/bad status. Old/refreshed keys and logs remain in the isolated input scratch; no live GPG home or Keychain was used. [Published maintainer fingerprint](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/SECURITY.md)

The compiler is the already pinned, signed LLVM 20.1.8 archive from the kernel prerequisite, mounted read-only from the retained fixture volume. The derived builder starts from the exact inspected kernel-builder image and adds pkg-config/libdevmapper/json-c/popt/uuid development packages through the same signed Ubuntu snapshot `20261011T000000Z`. The Dockerfile's local base tag is checked against its immutable ID before building. The selected derived OCI index is `sha256:44c38e1c7c5050f86c1f974925f6bbb412bc117914bef868ca19fbf773470531`.

The exact saved builder image is `out/kernel-crypto/userspace-inputs/builder-image.tar`, 302,686,208 bytes, SHA-256 `580692ed6b3d641b7b3d0ea99f53ca83f37d15aa4832b0623731ac00716d9e9c`. [176 installed binary/source versions and copyright hashes](builder-packages.json), [85 downloaded package archive hashes](builder-package-archives.json), full copyright texts, host-tool/sysroot hashes and Docker image inspection are retained. Base-inherited packages are pinned by image content rather than downloaded anew. Exact distro sources can be retrieved by source/version from the same snapshot; their source archives are not mirrored here. This is provenance evidence for review, not a completed license/security audit or a hermetic-builder claim.

Runtime dependencies include libdevmapper, json-c, popt, uuid, OpenSSL and their transitive glibc/libudev/libselinux/libcap/pcre2/libm dependencies despite disabled udev/SELinux integration in cryptsetup. The OpenSSL backend dynamically loads `legacy.so`; it was absent from initial ldd output, discovered by relocation tracing and explicitly bundled from the pinned image. Future trusted bootstrap must fix provider/config paths and reject ambient overrides. [Runtime dependency hashes](runtime-dependencies.json), [source license hashes](source-licenses.json)

Compile options disable external LUKS token plugins, SSH tokens, online reencryption, OPAL, udev synchronization, blkid scanning, NLS, veritysetup and Argon2. The library/tool default is PBKDF2; the capability check verifies explicit no-benchmark settings. These build defaults do not make the generic CLI a confined guest tool or enforce a future fixed format. Its future privileged caller must admit only the reviewed operations/parameters and protect raw disks, mapper control, trusted runtime/store paths and the key transport from tools.

## Reproduce and verify

The source archive/signature/current public key are pinned in `inputs.json`. The source archive must be present in ignored `out/kernel-crypto/userspace-inputs`; the LLVM fixture volume from the kernel build must remain available. No source/key download or system installation occurs in the offline runner.

```sh
# First inspect this local base tag and require the pinned ID from inputs.json.
docker image inspect winter-cowork-kernel-builder:20261011
docker build --platform linux/arm64 \
  --file spikes/cowork-hvf/kernel/userspace/Builder.Dockerfile \
  --tag winter-cowork-crypto-userspace-builder:20261012 \
  spikes/cowork-hvf/kernel/userspace
# Reuse the saved exact image: a recipe rebuild can have different image metadata.
docker image load --input spikes/cowork-hvf/out/kernel-crypto/userspace-inputs/builder-image.tar
python3 spikes/cowork-hvf/kernel/userspace/run_build.py
python3 spikes/cowork-hvf/kernel/userspace/verify_toolset.py \
  --output spikes/cowork-hvf/out/kernel-crypto/userspace-build
python3 spikes/cowork-hvf/kernel/userspace/test_toolset.py
```

The runner refuses to overwrite existing inputs/completed artifacts. For a clean comparison use `--output spikes/cowork-hvf/out/kernel-crypto/userspace-new-comparison`; it only accepts a private `userspace-*` directory directly beneath the owned fixture output. Its unique scratch volume contains only public source/build inputs and outputs, with a sampled 2 GiB disk abort ceiling and 8 GiB host-free floor (10 GiB required to start). The compile namespace is non-root, read-only rootfs, network-none, all caps dropped, no-new-privileges, 128 PIDs; no home, source user data, Docker socket or block-device mount. Input archives and original kernel/compiler scratch are read-only. Export alone receives the private output mount. Original kernel evidence/scratch and failed userspace attempt evidence remain preserved.

A first bundle check caught lost executable modes and triggered a rebuild. The next independent check caught dynamic `legacy.so` outside the initial closure and triggered the final provider-inclusive build. Linux archive/staging kept intended read-only modes; Docker Desktop's host export added owner-write, so the host mirror was normalized and verified separately. The checked-in runner includes that correction and post-export verification. The final archive is the unchanged artifact generated by the successful Linux build.

## Remaining authorized boundary

Neither GCM nor XTS/HMAC is selected. The candidate note identifies GCM invocation/RNG limits, XTS key-length/layout/other key-scope limits, experimental maturity, journal/header tamper and replay/crash questions, and proposed broker-authenticated header/geometry binding requiring review. There is no separate unlock secret/passphrase policy silently added here. No broker/frame/control-record code was changed.

PID 1, scoped inherited worker-to-guest key transport, guest unlock/confinement, a bootable immutable initramfs, real ciphertext/cold-restore/tamper/crash behavior and crypto I/O during active reclaim remain unimplemented/unverified. Do not call this toolset a complete encrypted bootstrap or reuse earlier restricted resource results for it.
