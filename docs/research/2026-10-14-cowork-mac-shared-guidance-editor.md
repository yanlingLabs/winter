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
digest and content before awaiting transport. A save's failure is classified by
the host's `error.data.code`, never by guesswork. A definitive refusal
(`authority_denied`, `invalid_request`, `not_found`, `unsupported_topology`,
`request_conflict`, or a daemon without the method) means nothing was written and
that request ID can never succeed: the pending save is dropped, the draft is
kept, and a specific message is shown without offering a retry. `revision_conflict`
also drops it, fetches the version that won, and holds the draft behind an explicit
review. An unknown outcome (transport loss, an invalid receipt, `recovery_required`)
keeps that exact attempt for explicit retry through further typing, navigation and
reconnect, and also offers "Abandon unconfirmed save": the host answers
`recovery_required` forever to a failed journaled operation's request ID, so retry
alone can strand a draft. Abandon refreshes first, then forgets the attempt and
clears the draft's base, so no save can be sent until the user has reviewed the
host's current content; the draft is never discarded. A refresh that finds the host
exactly one revision past the attempt's base with the SHA-256 of the attempt's bytes
settles it as applied (no receipt is invented; its operation ID is unknown). A
matching host receipt establishes the recorded save only; it does not establish
guest adoption. A revision conflict requires explicit user selection of the current
content or a new save base for the retained draft. Reads never silently rebase a
dirty draft over concurrent edits. Byte equality, rather than Swift's canonical
Unicode string equality, governs whether a draft is dirty. A receipt banner and a
refusal message about the draft as sent are retired by the next edit or refresh. A
workspace selected while another workspace's guidance operation is in flight has
its read queued and run when that operation ends.

The draft is edited in a plain-text `NSTextView` (a private representable in
`CoworkWorkspaceView.swift`, shaped like `ComposerTextView`), not `TextEditor`, so
that quote and dash substitution, autocorrection, text replacement and completion,
link and data detection, smart insert/delete and inline predictions are all off and
no system feature can rewrite a byte the user did not type.
View bindings/actions carry their originating workspace; saves also carry the
displayed draft/revision/digest, conflict choices the reviewed revision/digest,
and retry the pending request ID. A late view action cannot edit or save another
workspace or silently apply to a later draft/version.

`CoworkGuidanceModelTests.swift` contains deterministic fake-transport source for
canonical reads, unavailable backing, malformed encoding/bounds/digest, provenance
generation mismatch, conflicts, exact lost-response retries, navigation/reconnect
reads, late read/action routing, concurrent typing while a save is parked, malformed
receipts, the byte cap, NUL refusal, BOM preservation and Unicode byte distinctions,
a `recovery_required`-forever request ID escaped by Abandon with the draft intact,
each definitive refusal clearing its pending save with its own message, refresh
settling an already-applied save (and not settling a look-alike), the receipt and
refusal-message lifetimes, and a workspace selected during another workspace's save.
The fake host and retry assertions compare sorted encoded request bytes. The existing metadata fixture explicitly
models an older daemon without instruction RPCs.

Validation in this lane is source/API inspection and `git diff --check` only.
**No Swift compiler, Swift tests, native build, test host, GUI, app, daemon, live
Winter home or Keychain was invoked.** Swift compilation, fake-test execution,
rendering and integration behavior remain unverified until separately admitted
ordinary CI. No push, release, activation or native execution is claimed.
