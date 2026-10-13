# Parent current-context resolver source adapter

`CoworkCurrentContextResolver` is an unwired parent-only source component. It
constructs the accepted canonical planner from the same host-owned dependency
ports, awaits a protected instruction reader, then recomputes canonical authority.
It returns the SDK-shaped `{revision, facts, instructions}` only after all checks.
It does not register a callback, admit a Linux profile, start a runtime, read ext4
from the host, update an SDK pin, or enable child agents.

The trusted owning query identity is captured at construction. Each read carries
a fresh host read ID, a copied full owning registration (logical/backend session,
generation, workspace, authenticated boot/incarnation/epoch and admitted view),
and the exact current instruction scopes. Guest IDs/cwd are lookup hints, not
authority. The result must echo that request exactly. Both the full registration
and canonical plan are checked across the await. Returned objects are normalized,
validated and rendered before the final owning-registration/current-plan guard:
Proxy descriptor traps can execute even though accessor fields are refused. The
reader timer and normal abort cleanup are completed before that guard, including
reader-installed abort listeners. The last planner check follows external
registration callbacks, uses the upstream cancellation signal, and only the
already sanitized primitive snapshot is returned afterward. Descriptor validation
extracts fresh plain records/arrays with typed primitive fields; rejected getters
are not invoked (unlike clone-first getter behavior). Drift refuses without a
partial or cached result.
This does not create global atomicity over independent mutable authority providers
or prove detection of all concurrent/ABA changes.

The shared requested alias is exactly `/workspace/.winter/WINTER.md`. Its actual
admitted file and imports belong to the separate fixed guidance-only view
`/run/winter/shared-instructions`, as specified in the storage contract. This is
a lexical mapping contract: the protected guest reader must enforce the physical
alias and file identities, symlink containment, current native owning generation
and current admitted roots. No broad `/workspace/.winter` import root is granted.

The reader must explicitly return tiers: admitted-only; all-tier or omitted modes
refuse even if no personal file happened to exist. No block/provenance entry may
have user tier. The reader returns expanded blocks plus decoded source provenance.
Each has requestedPath, admittedPath, text, tier and SHA-256; raw entries also have
depth and both requested importerPath and actual importerAdmittedPath when imported.
SHA-256 measures decoded UTF-8 text, matching Runtime SDK textSha256 semantics,
not the original file bytes. A future mapper must translate that field explicitly.
The host checks closed fields, canonical absolute paths, text/hash equality and
byte/count bounds. Discovery uses requested guidance spellings in root-to-cwd
Code order: WINTER.md, .winter/WINTER.md, WINTER.local.md. Admitted paths must stay
within the same guidance root, preserving normal within-root aliases. Shared is
required even when empty and has workspace tier. Source top-level tier is project
for WINTER.md and .winter/WINTER.md, local for WINTER.local.md. Depth-zero provenance
links 1:1 to the expanded blocks, in exact requested/admitted/tier discovery order.

Imports follow strict depth-first pre-order. The active occurrence stack is
truncated to the new depth; requested/admitted importer identities must both
match its immediate parent. The inherited tier and top-level guidance root are
checked on every occurrence, with depth at most five and no jumps. Repeating an
active ancestor's admitted identity (or requested identity) is a cycle and refuses.
Completed branches are different: legitimate diamonds and an import subsequently
loaded as its own top-level guidance block are accepted. Consistency maps require
all reads of a requested path to agree on admitted identity and decoded text/hash,
and all reads of an admitted path to agree on decoded text/hash. Consistent aliases
may share an admitted file. A mid-walk retarget or contradictory repeated text
refuses. All read occurrences count toward the existing leaf and cumulative byte
bounds; repeats cannot bypass fan-out limits.

Expansion remains a trusted protected-reader responsibility using accepted
Runtime SDK loader semantics. SHA, linkage and ordering validate the returned
bytes/provenance; they do **not** prove that expanded blocks derive correctly from
raw files, or that the reader actually read those files. There is no reader/native
implementation or admission in this adapter. Imported files can have ordinary
non-guidance filenames inside their confined guidance root; their text is guidance,
never executable settings, hooks, MCP, plugins or authority.

The host renders once, keeping bodies verbatim. A fresh random render token,
generated after reading and distinct from the read ID, labels host-created file
headers and matching end markers. Any collision with admitted body text refuses.
A fixed preamble attributes all other headers/markers to editable file content;
shared user-edited and source repository guidance have distinct fixed labels.
This deliberately differs from the SDK loader's ordinary pretty path headings.
The token is a model attribution guardrail, not an authority boundary or an
instruction-injection-proof guarantee. Reminder-tag neutralization stays solely
in the SDK engine's requiredContextEntries; this adapter does not duplicate it.

At most 256 provenance occurrences/blocks, 128 KiB per text, and 256 KiB aggregate raw
plus expanded text are admitted. Final raw host facts plus rendered instructions
must fit the SDK's 128 KiB measurement; no truncation occurs. The SDK engine still
owns its additional rendered-context bound. Revision is `context:` plus SHA-256
of exactly those facts/instructions, raw provenance, owning registration, current
plan revision and render token. It is provenance only, never an authorization token.

The callback signal reaches the reader. A deadline of at most five seconds sits
below the engine's ordinary fifteen-second context deadline. Cancel, timeout,
malformed results, unknown children, unavailable authority and errors refuse with
closed codes, never guest error text/paths. Late read results cannot produce a
snapshot. No read handle, nonce or snapshot is cached or persisted for resume.

Only the planner's shared/source scopes are supported here. Configured personal
user guidance and memory-index guidance still require canonical scope and reader
integration. Separate persistent worktree roots and another attached source also
remain outside the planner's current bound-source cwd contract. This is not a
complete production instruction resolver or proof for every Cowork workflow.
`guest-query.ts` remains unwired and the current SDK confined-guest query/profile
continues to refuse required-context RPC. Their independently reviewed extension,
protected reader/transport/native view and durable ownership proofs remain gates.

Source verification: `bun test ./packages/core/test/cowork/current-context-resolver.test.ts ./packages/core/test/cowork/current-context.test.ts ./packages/core/test/cowork/guest-runtime.test.ts`
passes 102 tests with one existing candidate-runtime skip and 1480 assertions.
`bun run typecheck:core` passes. `bun build ./packages/core/src/cowork/current-context-resolver.ts --target=bun --outfile=out/current-context-occurrences/resolver.js`
emits an inert bundle (96 modules); the bundle was not executed or admitted.
Logs/bundle are retained under the ignored `out/current-context-occurrences` tree,
not in the source commit. Tests use isolated canonical databases and synthetic
readers; they do not read guest files or start a guest runtime/native service.

The final-boundary correction has red-to-green regressions for a valid reader
Proxy mutating publication from a descriptor trap, and a reader abort listener
mutating publication during normal cleanup. Zero-call accessor and counting-Proxy
regressions pin descriptor-only extraction (including array length) and no result
trap calls after the final guard. Their red/green logs remain in the ignored
evidence tree as `validation-race-{red,green}.log` and
`cleanup-race-{red,green}.log`. No clone-first getter execution was introduced.

Occurrence compatibility fixes the former cb94818e duplicate refusal for a diamond
(A→B→D and A→C→D) and WINTER.md importing later-discovered WINTER.local.md. It
does not implement the Runtime SDK structured-result mapper, skipped/dropped
metadata handling, protected reader or transport. Those remain independently
reviewed prerequisites before wiring. Existing normalization/render/reader cleanup
and final canonical authority ordering remain unchanged.
