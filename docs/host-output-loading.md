# Protected host output loading

Core constructs a cheap lazy output factory beside `winter-core` in a Release
app's fixed `Contents/Resources/native/host-output` directory. Creating a runtime
SDK performs no loader filesystem or signature operation. Ordinary daemon boot
therefore does not run codesign or load the output addon. Source Bun and standalone
`dist`/`dev` binaries remain unsupported; no environment, setting, home path or
runtime frame can select native code.

On first protected host-code output use, the SDK awaits the factory before
spawning its command. The loader uses asynchronous filesystem operations and
bounded asynchronous `execFile` calls to `/usr/bin/codesign`. Each call has a
five-second deadline, SIGKILL escalation and a256KiB output limit; the five
successful verification steps run sequentially. Only the final `process.dlopen`
leaf remains synchronous. Concurrent first callers share one verification,
then obtain distinct output transports from the authenticated native factory.
A loader refusal rejects the command admission; there is no unprotected output
or execution fallback.

The loader pins manifest and image descriptors before verifying signatures,
checks Core hardening and library-validation entitlements, the fixed Team and
addon identifier, then checks the enclosing app seal last. It revalidates path
identities, descriptor metadata/bytes, the manifest's artifact digest and the
native ABI/source identity. Mapped `FileHandle` objects are retained for process
lifetime, including failed initialization after mapping began, so GC cannot
close and reuse a `/dev/fd` name or unload registered native atfork callbacks.
This is not a claim of general same-user filesystem immutability.

Success and deterministic layout, alias, access, integrity, hardening and ABI
refusals are cached until process restart. Timeouts, spawn failures and
unclassified codesign nonzero exits remain fail-closed and retryable: codesign
CLI status cannot reliably classify every bad signature versus transient tool
failure. Later protected calls may retry after cooldowns of1,2,4,8,16 and then
30 seconds. The cooldown stays capped at30 seconds even after prolonged failure;
there is no automatic timer/retry loop and no permanent transient-failure cutoff.
Each operation triggers at most one attempt, with one shared attempt in flight.
A sanitized refusal reason is logged once per reason, bounded by the fixed
reason inventory; raw process stderr, paths and exception text are not logged.
Output-transport allocation failures do not invalidate a successful mapping.

`loadFixtureHostOutputFactory` now returns a Promise and must be awaited.
`createFixtureLazyHostOutputFactory` is explicitly fixture-only clock/verifier
injection into the same lazy state machine; it is not connected to production
settings or RPC. Tests use private fixture trees to verify deferred loading,
single-flight responsiveness/success caching, permanent refusals, transient
cooldown/recovery, no mapping on refusal, sanitized logging and preserved
manifest/image-swap protection. One test runs real read-only codesign against an
unsigned fixture, verifying a retryable asynchronous refusal without accessing
any real app or Keychain.

Release embedding, Team signing, final nested-artifact hash/resource seal,
production hardened loading and the installed SDK release/pin remain unperformed
integration gates. Async loader tests and explicit local SDK/native fixtures do
not establish those gates or activate Cowork/Workflow worker authority.
