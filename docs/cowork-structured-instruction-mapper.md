# Pure structured guidance projection

`mapStructuredCoworkInstructions` projects the Runtime SDK's structured snapshot
into the parent resolver's reader DTO. It performs no file read, header parsing,
SDK configuration, transport registration or authority lookup. Its canonical
request must come from the owning host resolver; matching request IDs/paths and
this function's output do not authenticate a caller or admit a native view.

Structured input is descriptor-normalized into fresh plain data. The eight keys
are text, digest, files, skippedLinks, droppedImports, tiers, blocks and provenance.
All five array lengths are read via descriptors and bounded **before** any element
enumeration. User tier and all-tier results refuse; tiers must be admitted-only.
V1 requires both droppedImports and skippedLinks to be present empty arrays.
It refuses rather than silently discarding skipped/dropped guidance. This is a
conservative v1 behavior, not changed Runtime SDK discovery semantics.

Limits are 256 blocks/provenance occurrences/legacy file entries, 128 KiB for each
text and for the original aggregate, and 256 KiB cumulative raw-plus-expanded
occurrence text. String bounds/NUL checks precede hashing. The parent resolver
still owns the final host facts plus rendered instruction 128 KiB bound.

Before any path projection, original aggregate text is rebuilt exactly as
`# requestedPath\n\n` plus each already-rendered block body, joined by newline.
Every block includes the SDK's trailing newline. The reconstructed text must equal
input text, and its SHA-256 must equal digest. Headers inside a body remain literal
file content; they are not parsed. textSha256 fields are checked against decoded
UTF-8 text and translated explicitly to the Core DTO's sha256 field. They do not
measure original file bytes or prove that expanded blocks derive from raw files.

Legacy files and provenance must agree 1:1 in occurrence order. Legacy path is
admittedPath, imported is exactly depth>0, and tier/hash match. A requestedPath is
present only on a differing top-level alias, exactly as the SDK emits it. Imports
carry requested and admitted containing identities separately. No legacy field
or read occurrence is silently dropped or deduplicated.

There is one explicit lexical shared mapping: the first workspace block and its
first depth-zero provenance requested identity must be exactly
`/run/winter/shared-instructions/WINTER.md`, projected to
`/workspace/.winter/WINTER.md`. Only a depth-one importer reference to that active
original shared occurrence is projected with it. This is determined by the
original occurrence stack, not substring/prefix replacement. Any other reuse of
the old shared requested/importer identity refuses. All admitted identities,
source paths, nested import identities and body text remain unchanged.

The host/native integration must separately establish the registered protected
view and canonical alias. The SDK's workspace.path must lie lexically inside its
workspace.root, so a future reader should use the admitted physical guidance view;
it cannot pass the canonical workspace alias with a different root and assume it
works. Matching fixed strings here is a data contract, never native binding proof.
No broad /workspace/.winter or host-home read/import scope is introduced.

An internal pure normalizer is shared with the parent resolver to validate
projection roots, Code order, tiers, occurrence lineage and consistency. It has
no Core package-index or RPC export. The returned DTO is frozen plain data with
a normalized request echo. The owning resolver **still** normalizes the result,
renders, performs reader cleanup and runs its final current registration/plan
guard. There is no prevalidated flag or bypass of host revalidation.

Committed tests use synthetic structured output and real isolated canonical
host databases. A separate uncommitted portable producer proof runs the actual
Runtime SDK source at aa9f3e82 over disposable temp files, then makes an explicit
fixture-owner namespace projection to guest path spellings and re-renders the
aggregate/digest. That proof is not unmodified SDK guest-path output, a native
mounting/alias proof, or host authorization. It retains diamonds, import-then-local
occurrences and shared/source aliases. No external absolute source imports or
consumer pin changes are included in the committed tests.

This remains unwired. Protected reader/physical confinement, expansion, generation
binding and transport admission remain prerequisites. Personal/memory scopes,
children, guest profile activation, native/VM proof, SDK pins and release versions
are unchanged.

Verification: the mapper, parent resolver, canonical planner and guest-runtime
focused tests pass 130 tests with one existing candidate-runtime skip and 1672
assertions. Core typecheck passes. An inert Bun bundle emits 97 modules and was
not executed/admitted. Logs are retained under ignored
`out/current-context-mapper/{tests,types,build}.log`. The separate portable SDK
source proof script and its labeled JSON receipt are retained there as
`producer-proof.ts` and `producer-proof.json`, excluded from the source commit.
