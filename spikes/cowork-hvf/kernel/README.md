# Crypto kernel input preparation

`crypto-inputs.json` pins Linux 6.18.35, the cached Apple/Kata feasibility base config, the built-in crypto fragment, the public developer key/signature and an LLVM 20.1.8 Linux ARM64 toolchain candidate. Linux source SHA-256 and the detached developer signature over the decompressed tar were verified locally. The public key was retrieved through kernel.org WKD/TLS and matched the developer fingerprint published by kernel.org. No real GPG home or Keychain was accessed. [Kernel signature procedure](https://www.kernel.org/signature.html)

```sh
python3 spikes/cowork-hvf/kernel/prepare_crypto.py
python3 spikes/cowork-hvf/kernel/test_prepare.py
```

The source archive must already exist under `out/kernel-crypto`; these commands never download, launch a builder/VM, install packages or provision keys. `--extract` is explicit and refuses to overwrite an existing source. `--verify-config PATH` checks every requested symbol after `olddefconfig` and rejects modules where built-in unlock support was requested. Tests reject the actual cached baseline, disabled MD and modular integrity support.

`build_crypto.py --builder-receipt PATH` is an offline build entry point for a separately admitted isolated Linux arm64 builder. It verifies every pinned input, requires an image digest and host-tool hashes, extracts fresh source and the exact toolchain archive, merges the fragment, runs `olddefconfig`, checks all required symbols and builds Image/vmlinux with two jobs. It fixes build time/user/host, uses private HOME/TMPDIR and writes full config/artifact/tool hashes and commands. It does not create or launch that builder. Kernel Makefile checks resolved paths for spaces/colons; use a private Linux namespace such as `/fixture/cowork-hvf`, not the literal macOS workspace path.

The LLVM archive pin comes from the project release asset's API digest. Its 1.86 GB archive was not downloaded or executed; the project identifies release binaries as volunteer builds. This is a reproducible comparison input, not production toolchain/security acceptance. [LLVM 20.1.8 release](https://github.com/llvm/llvm-project/releases/tag/llvmorg-20.1.8)

**No crypto kernel or initramfs has been built.** The Linux builder image and complete dependency/license receipt are unselected. A builder receipt must include `imageDigest` and `tools` entries for `make`, `bison`, `flex`, `bc`, `perl`, `openssl`, `sh`, `awk`, `sed`, `find`, `pahole`, each containing its absolute `path` and SHA-256. The image/dependency receipt requires independent review; caller-provided hashes alone do not establish isolation or a hermetic build. Normal tool-directory PATH lookup can access other image executables, so the image digest and dependency inventory matter.

Pinned cryptsetup/libcryptsetup, its complete userspace dependencies, trusted PID1/key receiver and an immutable initramfs file manifest remain required. There is no placeholder unlock implementation, plaintext fallback, key injection or encrypted-disk claim. Kernel compilation alone will not satisfy that bootstrap. Keep the existing authenticated-format maturity, header/freshness/recovery and broker/worker/guest key-delivery questions in `../production-prerequisites.md` open. Boot and remeasure the selected crypto profile before inheriting any A6 resource conclusion.
