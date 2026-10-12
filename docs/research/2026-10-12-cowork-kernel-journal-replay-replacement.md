# Kernel replay replaces the failed journal-only command

The prior e2fsck `-Ejournal_only`/DEVNULL test failed in [run38256511895, job114835873624](https://github.com/yanlinglabs/winter/actions/runs/38256511895/job/114835873624). Its source and original evidence remain preserved in9d6a3a70/2d1b031d and the historical journal-only report. This correction does not add preen, automatic yes, forced interactive mode, full repair, journal recreation or reformatting.

## Implemented replacement

`kernel-journal-replay.c` takes one inherited block descriptor and expected UUID/capacity from the admitted controller. It validates actual block geometry, exact feature masks, clean state plus pending recovery and internal journal identity, then creates a private mount namespace. The only writable operation is normal kernel ext4 mount with nosuid/nodev/noexec/noatime and errors=remount-ro,noinit_itable, followed by syncfs, normal unmount and descriptor flush. Kernel mount may update ordinary mount metadata; this is not a claim that only journal bytes change. Native sync/unmount uncertainty keeps the helper alive with its namespace/device hold. A parent deadline never certifies exit or kills to invent cleanup.

`FixtureBootstrap` preflights both exact targets read-only, then admits every required replay adapter before formatting or replaying either disk. A mixed format-new/dirty-replay pair with missing or rejected adapter has no writable helper effect. An absent port refuses the consumed operation without a writable helper. Successful replay requires its kernel-mount acknowledgment, flush and a new exact read-only clean probe. The protected receipt now binds both consistent `journalReplayed` and `journalReplay:"kernel-mount"|"none"`; malformed/missing methods fail closed. Earlier boolean-only v3 observations cannot confirm current readiness. Legacy v1/v2 history remains readable. Schema stays10. Existing canonical owner, replay debt, previous-ready history, new-owner/old-writer termination and mandatory native receipt verification rules are unchanged; no new ownership ledger is added.

The fixture-only loop driver admits a Root-owned, owner-only, singly-linked regular image descriptor. It opens an independent description of that exact object before flock: dup alone would share the caller's lock and admit concurrent helpers. An unused loop is atomically configured; a race refuses rather than adopting or retrying another device. Backing device/inode, offset, capacity and RW state are checked. No caller-selected device path is used. After replay, CLR_FD is treated only as a request: the driver closes its opener and checks fresh ENXIO, and Python repeats actual kernel status after helper reap before permitting file cleanup. Failed/uncertain metadata operations retain files and descriptors, even when a failed mount detached cleanly. The fixture never uses lazy/forced unmount. [Linux loop implementation](https://github.com/torvalds/linux/blob/v6.18/drivers/block/loop.c), [ext4 mount options](https://github.com/torvalds/linux/blob/v6.18/fs/ext4/super.c).

## Stronger fixture, still not executed

`test_kernel_replay.py` prepares a real formatted image, a retained file block and a debugfs-generated committed nonempty JBD2 transaction targeting that block. It verifies the journal magic/nonzero start and original data still unchanged before replay, then requires the committed payload in the actual target block and a fresh exact clean observation. The test uses the tool's actual committed transaction/checksum generation, not just a needs_recovery toggle. A separate corrupted-journal case requires failure and preserves its files for audit. This is constructed-journal coverage; it is not a real power-loss/crash reconstruction claim. [e2fsprogs journal writer](https://github.com/tytso/e2fsprogs/blob/v1.47.3/debugfs/do_journal.c).

A no-launch builder produces both immutable native helpers and a closed source/artifact receipt. The independently hash-admitted stdlib-only parent validates the approved receipt and complete source/artifact closure before any repository code runs with privilege. This includes dynamically imported test_bootstrap.py. It stages exact Root-owned readonly copies and verifies them before starting the isolated -I-S-B runner. The README supplies a literal stdlib hash gate for admitting the parent itself. Direct privileged checkout-runner invocation is refused before its repository imports. The ordinary nonprivileged workflow continues running existing file-format/probe tests; kernel tests remain explicitly skipped without Root/isolated-Python/receipt admission. No privileged workflow/push was added. Root must independently review exact source, artifacts and isolated Linux execution scope before the README commands run.

## Local evidence

- Core filesystem/raw-volume suites:62tests/469assertions pass. New cases reject missing, unsupported and inconsistent replay methods; canonical debt/readiness regressions remain covered.
- Core typecheck passes. Schema/migrations unchanged.
- Ordinary protocol suite:11pass,9Linuxcases skipped. Kernel suite:4no-effect/retention cases pass,2privileged cases skipped. Parent staging suite:6no-effect cases pass, including full closure capture, missing/modified dynamic import, symlinks/unapproved receipt refusal before starting a runner, and actual isolated direct-runner refusal before a hostile dynamic import. Timeout test uses an explicit injected process, confirms retained handles and no kill/terminate; it is not Linux admission proof.
- Both native helpers compile with warnings as errors for Linux x86-64 and ARM64 using the existing pinned Zig compiler. ELF files are statically linked; no Linux helper ran locally.
- No mount, loop configuration, Root fixture, VM, live home, Keychain, real credentials, release or pin was used. Actual kernel replay, corrupt-journal behavior and loop cleanup remain unverified until reviewed Linux CI.

The production signed bootstrap/native device producer remains a separate gate. This fixture port cannot grant host/native authority or enable Cowork by configuration, a guest receipt or its artifact receipt alone.

The earlier771c source review identified missing dynamic-source coverage and import-before-validation, plus partial formatting for a mixed pair with no replay port. This follow-up closes those source/effect admission gaps. Old receipts remain preserved; their incomplete closure is rejected. New x86-64/ARM64 cross-build receipts are separate. No privileged execution is implied by these checks.


## Fixed staging ancestry correction

Independent re-review found that immutable staged leaves under an untrusted
TMPDIR could be renamed and substituted through their parent. The parent now
uses only direct children of fixed `/tmp`, checks both `/` and `/tmp` are real
root-owned directories, refuses writable `/`, and requires sticky protection for
any writable `/tmp`. The same ancestry check precedes every staged verification
and runner launch; arbitrary staging parents are refused. No inherited TMPDIR is
consulted. Root-owned stage directories and files retain their existing modes and
whole-closure hash verification.

Ten no-effect staging tests pass, including ignored hostile TMPDIR, unsafe owner,
nonsticky writable parent, symlink parent, and an actual rename/substitution inside
a disposable user-owned parent that never reaches runner execution. This is not
privileged staging evidence.

Both unchanged C helpers were cross-compiled again with warnings as errors; new
receipts under `out/kernel-replay-fixed-parent-review` validate the new Python
closure. x64 receipt SHA256:
`71041d761f1bf8f82c2c273445068743169720288a87604b0e231cf5dd073a91`;
ARM64: `a3e3b4b0811e098113a7e0bfb042c5097f9f5ee43dc297fe9aff32aa71341a4f`.
The revised independently admitted parent hash is
`04966aa34daedaf6184d27141568bbc01b6a22c3bc85b0a453d6dd7bea0887aa`.
Earlier artifacts and receipts remain retained. No privileged execution occurred.

A dedicated build-only Linux workflow now compiles the reviewed helpers and uploads
the exact receipt/artifacts for inspection. It runs only unprivileged admission
checks, supplies no kernel-fixture opt-in, performs no sudo/mount/loop operation,
and does not treat a successful build as permission to execute the artifacts.
