# Immutable ARM64 guest payload builder

This builds a readonly root tree, canonical newc cpio and deterministic gzip companion. It does not install anything, invoke maintainer scripts, mount/format a disk, launch a guest or enable Cowork. The only startup program it carries is the pinned `/init` built from `apple/Cowork/WinterCoworkGuest` (N2 slice S5); every other startup path is still refused, and nothing here executes it. Frozen source/payload receipts are prerequisites for native integration, not authority or readiness.

Requirements: existing Python 3 with xz/tar/gzip support, gpg/gpgv, rsync, Git and Bun 1.3.14. No dependency installation is performed. The caller supplies the pinned SDK checkout (`sdkCommit` in `pins.json`, currently SDK main at `093fb3ea`; the expected artifact digests are unpinned until a reviewed rebuild, so the build ends non-zero by design after writing every output), canonical builder correction checkout at `180d3effd7ddbb9406aeea0912f76c78ef20cf75`, verified Zig 0.14.1 archive and verified official Linux ARM64 Bun base. Source is exported from the exact Git commit; provisioned SDK dependency bytes are copied without executing package scripts. The final runtime hash is also pinned, so a changed dependency/compiler result refuses rather than silently updating the image.

```sh
python3 scripts/cowork-guest-artifact/packages.py --out out/cowork-guest-artifact
python3 scripts/cowork-guest-artifact/image.py \
  --out out/cowork-guest-artifact/build-fresh \
  --sdk "$SDK_CHECKOUT" --builder "$BUILDER_CHECKOUT" \
  --zig-archive "$ZIG_ARCHIVE" --bun-base "$BUN_LINUX_BASE"
python3 scripts/cowork-guest-artifact/verify.py out/cowork-guest-artifact/build-fresh
python3 -m unittest discover -s scripts/cowork-guest-artifact -p 'test_*.py'
```

Every image output must be fresh. The package lock and official public signing keys are tracked; downloaded .debs are verified before safe payload extraction. No apt/dpkg maintainer/triggers scripts run. Preserved package copyright/docs/locales are an explicit full-payload policy. Archive hardlinks become independent readonly bytes; newc records have nlink 1. Root aliases refer to a disjoint `/opt/winter/environment/base` subtree suitable for the reviewed supervisor environment-root boundary; private SDK runtime/helpers/supervisor remain outside it. The local materialized tree is owned by the unprivileged builder; root UID/GID authority is encoded and independently checked in the actual cpio, never fabricated by a local chown.

Bun runtime compile calls the corrected canonical SDK builder through a thin wrapper, retaining separate empty staging and no-autoload flags. Native C helpers are exact SDK source compiled as static ARM64-musl with strict warnings, stripped debug sections and no build ID. This packaging profile needs actual Linux execution/native admission before production use; it is not claimed equivalent to a CI binary merely because source matches.

`receipt.json`, `root.manifest.json`, `elf-dependencies.json`, `size-breakdown.json` and independent `cpio-verification.json` are retained beside actual binaries. ELF checks include ARM64/little-endian type, interpreter presence, DT_NEEDED closure, required symbol versions, writable/executable segment and executable-stack refusal. Metadata checks read back packed uid/gid/mode/type/nlink/mtime/content, not just declared manifest fields.

The gzip companion uses empty filename, mtime 0, level 9 and records the zlib version. Its decompressed hash must equal canonical cpio. Both companions repeated here; cross-zlib compressed reproducibility is not assumed. Inspected pinned-kernel configs include CONFIG_RD_GZIP=y, but this payload has no boot/admission proof. Compression does not remove the expanded root's guest RAM cost. Runtime/root/helpers remain immutable candidate inputs, separate from future writable data/environment disks; no backend device was changed or added.

Updating the SDK/provider source, compiler, distro snapshot, packages or helpers requires an explicit new artifact/pin/receipt review. The unchanged SDK package semver is never a substitute for source and binary identity. No release/consumer SDK pin is performed here.
