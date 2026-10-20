# Guest kernel: pinned recipe (decision D6), unbuilt

Status: **pinned, not built, not booted.** Nothing in this directory ran a compiler, a container or a VM. The pins are inputs;
the first reviewed build records the output digests in `pins.json` (`expectedOutputs`), and gate G1 is the first time the
result may run.

## What is pinned

| Input | Pin |
| --- | --- |
| Linux | 6.18.35, `linux-6.18.35.tar.xz`, SHA-256 `f78602932219125e211c5f5bfd84edcfd4ec5ce88fc944f8248413f665bef236`, developer signature over the decompressed tar, signer `647F28654894E3BD457199BE38DBBDC86092693E` |
| Base config | `base-apple-6.18.35.config` (the cached Apple/Kata feasibility config, copied here byte for byte), SHA-256 `a5dfc1ee...c21` |
| Change from the base | `memory-fragment.config`: `CONFIG_DEBUG_INFO_BTF=n`, and nothing else |
| Crypto fragment | **none.** No dm-crypt, dm-integrity or crypto user API: there is no encrypted-disk claim in this slice |
| Compiler | kernel.org slim LLVM 20.1.8 aarch64 bundle, SHA-256 `945d2228...ba7`, detached signature over the decompressed tar |
| Builder | the isolated, offline, non-root Ubuntu 24.04 arm64 container of the crypto comparison build (image ID, base manifest, Dockerfile digest and package snapshot are in `pins.json`) |

The base config already has what the guest needs (`VIRTIO_CONSOLE`, `VIRTIO_BLK`, `VIRTIO_MMIO`, `VIRTIO_BALLOON`,
`PAGE_REPORTING`, `EXT4_FS`, namespaces, seccomp, landlock, PL011 console, `BLK_DEV_INITRD`/`RD_GZIP`) and already has
page poisoning and init-on-alloc/free off (the reclaim contract). `requiredSymbols` in `pins.json` lists every symbol the build
must end with; `test_kernel_pins.py` checks the base plus the fragment against that list without building anything.

## The build

The compiler changes the compiler-dependent symbols (GCC 11.4 in the base, LLVM 20.1.8 here); `olddefconfig` resolves them.
The two make invocations are in `pins.json` (`commands`), with `LLVM=...`, `LLVM_IAS=1`, `-j2`, `olddefconfig` first and then
`Image vmlinux`. The environment is fixed (`LC_ALL=C`, `TZ=UTC`, `KCONFIG_NOTIMESTAMP=1`, `KBUILD_BUILD_*`); `SOURCE_DATE_EPOCH`
and `KBUILD_BUILD_TIMESTAMP` are left open on purpose and must be fixed once, in the first reviewed build, and then pinned.

## What the existing builder needs (not done here)

The builder files live on the hvf fixture lineage (`builderSource` pins their digests; where they finally live is decision D7).
They are written for the crypto fragment, so a fragment-less build needs three small changes there, which this slice did not
make because those files are not on the integration branch:

1. an inputs file shaped like `crypto-inputs.json` with `fragment` pointing at `memory-fragment.config` and no `resolvedConfig`;
2. `prepare_crypto.py` / `build_crypto.py` / `run_container_build.py` reading that inputs file instead of `crypto-inputs.json`;
3. `verify_config` checking `requiredSymbols` (and `mustBeAbsentFromTheBuild`) from `pins.json` rather than the crypto fragment's symbols.

Then, from a fresh scratch directory with the two archives already downloaded and verified:

```sh
python3 <builder>/prepare_crypto.py          # verifies source and toolchain signatures; extracts nothing global
docker image load --input <saved builder image>   # the exact image ID in pins.json, never a fresh rebuild
python3 <builder>/run_container_build.py --image <imageId> --memory-gib 4
```

## Open items that are not decisions made here

* **Output digests** (`Image`, `vmlinux`, resolved config) do not exist until a reviewed build.
* **BTF** is off for memory reasons only; a build host with more memory could keep it. Changing that changes the pin.
* **Boot verification** is gate G1. Whether the kernel brings up exactly one virtio-console port with the expected feature
  bits (VERSION_1 + MULTIPORT, which PID 1 insists on) and two virtio-blk disks with serials is unverified.
* **AF_ALG**: the base config enables `CONFIG_CRYPTO_USER_API`; this slice neither adds nor removes it (see `observedInTheBase`). Whether tools may open AF_ALG sockets is a seccomp-policy question.
* **Provenance**: the base config is a cached feasibility config, not a production security selection.
* **Fallback**: the already-cached fixture kernel remains the faster alternative, with its provenance recorded separately.
