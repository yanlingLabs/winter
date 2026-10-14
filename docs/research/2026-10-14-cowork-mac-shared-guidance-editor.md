# Mac shared workspace guidance editor — source checkpoint

Based on `37b68e0aa7ab1cee98c54bfd649253892e52aa81`. This adds a host metadata
consumer to `CoworkWorkspaceModel.swift` and the existing Cowork workspace view.
It does not provision a workspace, initialize a missing instruction file, start
a guest, enable conversations or change the SDK/runtime pins. Cowork availability
and repository selection remain disabled. No schedule UI changes are included.

The editor calls the existing typed `Cowork.swift` factories for
`workspace.instructions.get`, `.provenance` and `.update`. Read/provenance must
agree on workspace, instruction revision, digest, bytes and refresh state. The
single provenance entry remains `/workspace/.winter/WINTER.md`; repository
instruction discovery remains unavailable. The model mirrors the protocol's
65,536 decoded-byte / 87,384 base64-character bounds, requires canonical base64,
strict UTF-8 with a byte round trip and no NUL, and checks the actual SHA-256.
Malformed or unavailable content cannot become an editable blank seed.

Drafts are held per workspace in the existing model, not per conversation or in
a new memory store. They survive navigation and transport reconnect/refetch while
that model lives. They are not persisted across app termination. A read failure
keeps drafts and any pending save; guidance failure does not discard a complete
source/policy generation or change its pagination/retry behavior.

Save captures one immutable request ID, expected instruction revision, expected
digest and content before awaiting transport. An unknown/malformed receipt keeps
that exact attempt for explicit retry, even after refresh or further typing. A
matching host receipt establishes the recorded save only; it does not establish
guest adoption. A revision conflict requires refresh and explicit user selection
of the current content or a new save base for the retained draft. Reads never
silently rebase a dirty draft over concurrent edits. Byte equality, rather than
Swift's canonical Unicode string equality, governs whether a draft is dirty.
View bindings/actions carry their originating workspace; saves also carry the
displayed draft/revision/digest, conflict choices the reviewed revision/digest,
and retry the pending request ID. A late view action cannot edit or save another
workspace or silently apply to a later draft/version.

`CoworkGuidanceModelTests.swift` contains deterministic fake-transport source for
canonical reads, unavailable backing, malformed encoding/bounds/digest, provenance
generation mismatch, conflicts, exact lost-response retries, navigation/reconnect
reads, late read/action routing, concurrent typing while a save is parked, malformed
receipts, the byte cap, NUL refusal, BOM preservation and Unicode byte distinctions.
The fake host and retry assertions compare sorted encoded request bytes. The existing metadata fixture explicitly
models an older daemon without instruction RPCs.

Validation in this lane is source/API inspection and `git diff --check` only.
**No Swift compiler, Swift tests, native build, test host, GUI, app, daemon, live
Winter home or Keychain was invoked.** Swift compilation, fake-test execution,
rendering and integration behavior remain unverified until separately admitted
ordinary CI. No push, release, activation or native execution is claimed.
