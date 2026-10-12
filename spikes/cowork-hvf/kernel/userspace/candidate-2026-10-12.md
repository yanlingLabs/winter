# Authenticated LUKS2 candidates for independent review

Status: proposed isolated validation profile only. Root authorized the format-neutral toolset build, not disk format/unlock, PID 1 key handling, broker-record changes or a VM run. The comparison kernel at `b68cc581` remains unbooted and BTF-off. No production format is selected.

## Documented source facts

Upstream identifies cryptsetup **2.8.8** as the latest stable release. It includes fixes for header-restore TOCTOU and metadata parsing/memory corruption. Its current authenticated-encryption manual still marks this feature experimental. The 2.8.8 release specifically directs cryptographic-integrity users to LUKS2/AEAD rather than standalone integrity mode; authenticated LUKS2 does not support discards. [Tagged README](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/README.md), [2.8.8 release notes](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/docs/v2.8.8-ReleaseNotes), [authenticated-encryption manual](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/man/cryptsetup.8.adoc)

For `aes` / `gcm-random` with integrity `aead`, source accounting uses a 12-byte stored IV plus a 16-byte authentication tag, and **zero additional integrity-key bytes**. Thus the existing random 32-byte broker volume material can be the actual AES-256 volume key. It is not a LUKS passphrase or a seed silently expanded into another disk key. [Pinned integrity implementation](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/lib/integrity/integrity.c)

`crypt_format` takes a caller-provided raw volume key and does not create a keyslot; keyslot creation is a separate API. A keyslot-free LUKS2 profile can therefore retain direct volume-key activation with no separate unlock secret. Header generation still stores a volume-key verification digest. With `CRYPT_PBKDF_NO_BENCHMARK`, its PBKDF2 digest uses the source minimum, **1000 iterations**, with the selected SHA-256 hash; this is a digest of a random 256-bit key, not a password KDF recommendation. The proposed toolset disables Argon2 and adaptive benchmark use in the future narrow helper. [Public API](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/lib/libcryptsetup.h), [digest implementation](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/lib/luks2/luks2_digest_pbkdf2.c), [PBKDF limits](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/lib/crypto_backend/pbkdf_check.c)

Linux dm-crypt authenticates the sector number and IV as AEAD associated data and generates random IVs for writes. dm-integrity journal mode coordinates data/tag updates. These source mechanisms support testing ciphertext/IV/tag changes and cross-sector substitution; they do not authenticate arbitrary LUKS header/geometry changes or ensure freshness against replay of valid old sectors. [Linux dm-crypt](https://docs.kernel.org/admin-guide/device-mapper/dm-crypt.html), [Linux dm-integrity](https://docs.kernel.org/admin-guide/device-mapper/dm-integrity.html); exact Linux 6.18.35 source evidence is retained under `out/kernel-crypto/userspace-inputs/source-evidence/linux-6.18.35`.

Upstream LUKS2 code explicitly rejects non-null journal encryption/MAC algorithms, and its segment metadata stores both as `none`. Thus this candidate has an atomicity journal containing encrypted sector payloads and tags, **not a keyed authenticated journal**. Journal location/commit metadata, header control data and replay need their own evidence and policy. [Parameter validation](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/lib/setup.c), [segment construction](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/lib/luks2/luks2_segment.c)

## AES-XTS plus HMAC alternative requested by root

The upstream-supported alternative is `aes` / `xts-random` with integrity `hmac(sha256)`, translated to the dm-crypt transform `capi:authenc(hmac(sha256),xts(aes))-random`. It requires **96 raw volume-key bytes**: 64 for XTS-AES-256 (two independent 32-byte AES keys), followed by 32 for HMAC-SHA256. The raw volume-key layout is `[AES data key:32][AES tweak key:32][HMAC key:32]`. Linux `crypt_copy_authenckey` internally reorders this into its authenc parameter header, HMAC key and AES keys; callers must supply the original encryption-first volume layout. The CLI's `--key-size 512` denotes the 64 encryption bytes; its adjustment function adds the 32 HMAC bytes, producing 96 total. A future direct `crypt_format` / `crypt_activate_by_volume_key` caller passes **96 bytes**, not 64 or 32. [Cryptsetup transform/key handling](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/lib/libdevmapper.c), [CLI key sizing](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/src/utils_luks.c); exact Linux 6.18.35 `dm-crypt.c:2443-2487` is retained in source evidence.

Source tag accounting gives **48 bytes per sector**: a 16-byte persisted random IV plus a 32-byte HMAC tag. The existing built kernel includes AES/XTS/authenc/HMAC/SHA256, but actual transform availability and I/O have not been boot-tested. The same keyslot-free direct-key semantics, PBKDF2 volume-key digest, sector/IV AAD, journal atomicity, unsupported journal MAC/encryption, header/geometry binding and replay/crash limits apply. This remains experimental authenticated LUKS2. [Integrity key/tag accounting](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/lib/integrity/integrity.c)

| Difference | AES-256-GCM candidate | XTS-AES-256 + HMAC-SHA256 candidate |
| --- | --- | --- |
| Random native volume material | 32 bytes | 96 bytes, independent component keys |
| Stored authentication / IV | 16 / 12 bytes | 32 / 16 bytes |
| Particular GCM random-IV bound | Applies: 2^32 encryptions globally per key | Does not use GCM; that specific bound and catastrophic GCM IV-reuse failure do not apply |
| Broker compatibility | Current 32-byte seal/frame size fits | Explicit key-length/layout/format extension required before any real volume |
| Other limits | RNG independence, invocation accounting, data-key retirement | XTS key separation, key-scope/data-unit limits, RNG and confidentiality analysis; no unlimited-write claim |
| Shared unresolved limits | Experimental integration, journal/header tamper, replay/freshness, crash/flush recovery, guest key transport and confinement | Same |

The XTS/HMAC alternative avoids that **particular GCM** write-lifetime problem; it does not establish unlimited data/key lifetime. The current final NIST XTS publication treats XTS as confidentiality-only; the independent HMAC is the authentication mechanism in this composition. A September 2026 **initial public draft**, not a final standard, additionally specifies data-unit/key-scope limits: at most 2^20 AES blocks per data unit and 2^44 blocks per key scope, recommending at most 2^36 for optimum security, plus unequal AES keys. The draft defines key scope as data an adversary might reasonably access, so repeated writes/retained snapshots need explicit analysis rather than treating capacity alone as the bound. Neither candidate is a claimed NIST-conformant complete construction. [Final SP 800-38E](https://csrc.nist.gov/pubs/sp/800/38/e/final), [September 2026 draft](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-38Er1.ipd.pdf)

**Proposed broker/spec extension if XTS/HMAC is accepted:** generate 96 random bytes natively; retain 32-byte KEK wrapping and wrap the entire 96-byte volume key. Bind explicit format/version, key length/layout, volume/header/geometry identities in the authenticated record and admitted worker/guest packet. Extend the current hardcoded 32-byte material guards and frame parser through a versioned, bounded protocol. Require independent review and key-separation/size/cross-format tests; preserve DEK bytes across relocation and KEK rotation. Do not repurpose existing 32-byte keys as passphrases/seeds or silently derive/reprovision replacement keys. No broker/record/frame implementation is changed here.

## Proposed GCM fixture geometry and semantics

| Parameter | Candidate default |
| --- | --- |
| Backing | Newly created disposable raw 128 MiB block device; no probing/format autodetection |
| LUKS format | LUKS2, fixed UUID admitted for one workspace/volume; no active keyslots/tokens |
| Disk key | Exactly 32 random bytes from the native broker, used directly as AES-256 key |
| Data cipher / IV | `aes` / `gcm-random`, AEAD integrity `aead` |
| Encryption sector / metadata | 4096 bytes; 28 integrity bytes per sector (16 tag + 12 IV) |
| Payload offset | 16 MiB (32768 device-mapper 512-byte sectors) |
| Journal mode | Journal enabled; no bitmap/direct/no-journal mode |
| Journal size / watermark / commit | 4 MiB requested / 50 percent / 1000 ms |
| Interleave / buffer | 32768 / 128 sectors in device-mapper 512-byte units |
| Metadata sizes | 16 KiB per LUKS2 header copy; keyslot area unused, exact area bounds to verify before sealing |
| KDF | Direct-key profile: no password/keyslot KDF. PBKDF2-SHA256 volume-key digest at 1000 iterations without benchmarking |
| Prohibited fixture options | Discards, inline hardware tags, no-wipe, external tokens, online reencryption, automatic repair/fallback |

These are requested inputs for review, not observed device values. Cryptsetup/kernel rounding may change usable size, journal sections and metadata allocation; the fixture must inspect and bind the actual resolved geometry and reject any unexplained variation. Fully initialize authenticated sectors before filesystem access; do not skip initialization to speed the test.

## Review blockers before format/unlock or production selection

1. **Random-IV lifetime:** NIST SP 800-38D section 8.3 limits RBG-based GCM to 2^32 encryption invocations across all instances using a given key. Linux's random-IV generator has no per-volume lifetime counter. At 4096-byte sectors this nominally corresponds to 16 TiB of encryptions, including rewrites, rather than volume capacity. A durable, conservative invocation bound, entropy independence across cold boots/clones, and a data-key retirement/re-encryption policy are required before a production choice. KEK wrapping-key rotation does not reset this DEK lifetime. This counter/policy is not implemented. [NIST SP 800-38D](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf)
2. **Header/geometry binding:** propose binding the immutable LUKS header-area SHA-256, LUKS UUID, cipher, sector/tag sizes, payload bounds, backing length and dm-integrity structural geometry into the broker-authenticated format/control record. Existing broker seals do not include this complete structure. This is a record/spec extension requiring independent review, not an edit made here. Check the admitted record before parsing/unlocking attacker-modifiable media; bound parser allocations/work and reject unexpected keyslots/tokens/segments/requirements/digests. Header checksum and successful volume-key digest verification alone are insufficient authority.
3. **Journal tampering and replay:** test ciphertext/tag/IV corruption, journal location/commit corruption, cross-sector substitution, torn writes and flush/crash recovery. Sector AEAD does not establish a keyed journal or anti-replay guarantee. Do not convert errors into repair or plaintext fallback. Decide the explicit rollback/freshness/recovery boundary, including valid old whole-volume snapshots and journal-only restoration.
4. **Key transport/confinement:** a reviewed worker-to-trusted-guest inherited/scoped FD transport is absent. No raw key bytes may enter argv, environment, files, logs or generic stdin. Trusted unlock memory must be locked/wiped; close the capability before tool execution. The guest's protected runtime/config/store boundaries and raw disk/mapper/transport denial remain separate enforcement gates.
5. **Real integration:** boot the exact crypto kernel/toolset only after the block access/reclaim review. Then verify synthetic-key creation, wrong/missing/cross-volume keys, ciphertext backing reads, cold restore and I/O in flight during active reclaim. Current kernel build/resource evidence cannot substitute for this.

## Build scope proceeding independently

The offline increment compiles pinned cryptsetup/libcryptsetup with OpenSSL and bundles the exact dynamic loader/library closure. It disables external token plugins, SSH token support, online reencryption, OPAL, udev synchronization, blkid scanning, NLS and Argon2; these are toolset build choices, not a new product format policy. A no-secret capability executable can report the linked API/defaults and validate explicit bounded PBKDF settings with no device path. The resulting immutable file manifest/archive is a userspace toolset, not a bootable/unlock-ready initramfs. PID 1 and key handling remain unimplemented until reviewed scope exists.
