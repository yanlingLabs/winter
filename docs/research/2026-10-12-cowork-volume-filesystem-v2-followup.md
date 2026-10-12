# Volume filesystem v2 product corrections

Follow-up to accepted `85d5198e`, based on `ad016d34` (which records independent
review and the original v1 Linux CI result). Existing 85d evidence and the CI
workflow remain byte-for-byte. This candidate remains preparation: no production
formatter, immutable block-device adapter, mount enforcement or native receipt
producer is enabled. Encryption stays deferred.

`volume-filesystem.ts` advances the closed command/receipt protocol to 2. It pins
exactly these supported ext4 features: `64bit,dir_index,dir_nlink,extent,
extra_isize,filetype,flex_bg,has_journal,huge_file,large_file,metadata_csum,
sparse_super`. The receipt must report the exact observed set; missing/extra
features, mount contract, provenance and full-check mismatch refuse. New sparse,
zero-guaranteed creation alone gains `virginZeroProvenance=new-sparse-creation`
and required mount option `noinit_itable`. mke2fs uses lazy_itable_init=1,
lazy_journal_init=0, nodiscard, explicit UUID, 4096-byte blocks and 256-byte inodes.
The future trusted mount adapter must enforce noinit_itable; this fixture performs
no mount and does not falsely report applied mount options.

Schema 10, UUID/file identities and the canonical owner/stop ledger are unchanged.
The versioned journal retains one last confirmed plan/receipt during a fresh probe,
never an expanding history. That history is bound to its original home/workspace,
volume/creation/UUID/file identity and geometry. Failed or interrupted READ-ONLY
probing preserves formatted/ready history, leaves current-owner readiness false,
and permits a fresh nonce/probe-only operation under current native authority.
Late old receipts cannot confirm a replacement nonce. Format-new uncertainty still
requires recovery and never restores virgin eligibility. Local handles/native
bootstrap admission must be quiescent before a new probe is issued; retryability
is not proof a prior helper stopped.

Legacy protocol 1 formatted history remains readable and keeps its data/owner/UUID.
It cannot be reinterpreted as the new feature/zero/mount contract: preparation
returns `filesystem_compatibility_required` before effects, with no automatic
feature upgrade, UUID change or reformat. Schema 9-migrated or unknown volumes
remain recovery-required/ineligible. No SQL migration, image replacement or new
ownership ledger is introduced. A future explicit compatibility/recovery workflow
must validate existing data under its actual recorded format contract.

Normal Linux probe performs bounded read-only blkid, ext4 superblock UUID/block
geometry and dumpe2fs -h feature/geometry/clean-state checks. It never forces full
filesystem checking at every launch. Only explicit trusted
`checkMode=full-read-only` (repair/uncertain shutdown) invokes e2fsck -f -n; the
protected authority and receipt bind that choice. Neither mode repairs data or
replays a journal. Dirty metadata in normal mode requests an explicit full check.
[mke2fs options](https://man7.org/linux/man-pages/man8/mke2fs.8.html),
[noinit_itable](https://www.kernel.org/doc/html/v6.6/admin-guide/ext4.html).

Verified locally: 87 host tests / 600 assertions across five suites, Core TypeScript
and diff check pass. Cases include failed/interrupted ready probe retry,
retained-history identity binding, legacy compatibility refusal, exact
feature/mount/zero-provenance receipt rejection, explicit full-check authority,
plus preserved crash/stale-receipt/ownership/schema9 migration tests. Mac Python:
4 protocol tests pass, 8 actual Linux cases skipped. New Linux cases check normal
probe avoids e2fsck, explicit full-check preserves complete digests, interrupted
probe retries without formatting, and actual superblock feature masks/lazy unused
inode-table bytes/group flags/sparse allocation. Most cases use two 16 MiB files;
the multigroup inode-table case uses one new 256 MiB data file + 16 MiB environment.
Bounds remain five-second virgin scan/image, 60-second pair service and 20-second
helper cap within the remaining budget; CI's five-minute job remains unchanged.
The new large-case scan budget and inode flags require actual Linux validation.

The earlier v1 receipt records five actual Linux formatting cases passed at 85d.
Those results do not validate this changed v2 formatter. No Linux, Docker, VM,
Mac format, live home, Keychain, credentials, SDK/release pin or production mode
was used here. Root review precedes any push/new isolated Linux CI execution.
Physical free-space admission and runtime write guards, DISCARD/punch-hole or
explicit compaction remain separate REQUIRED native v1 gates. This correction
implements none of those native mechanisms and does not call sparse logical
capacity a physical reservation. Blocking kernel I/O and fixture helper output
files retain their previously documented limitations; independent worker recovery
still applies. Normal production provisioning remains disabled.
