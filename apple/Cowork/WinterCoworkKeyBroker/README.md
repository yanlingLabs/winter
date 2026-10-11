# Key broker fixture — draft checkpoint

This package compiles with Swift6.2/macOS26 and no external dependency. The
process fixture has **not been executed or security-validated**: work paused to
address the production-used output adapter review. No Keychain item/API, VM,
daemon, live home or signing operation was used.

The synthetic native vault holds a random in-memory master and constructs
length-prefixed domain-separated HKDF/HMAC contexts covering canonical home,
workspace, volume, creation, purpose, format and key-version identities. The
ordinary runtime-state DB is outside this package. There is no decrypt RPC or
Keychain provider; ProductionKeyBroker.launch always throws productionBlocked.

Draft fixture executables model launcher-owned one-shot channels, strict launch
fields, broker-created suspended workers, executed-code validation, readiness,
one target key over an inherited pipe and sandbox-denial/descriptor checks.
They are proposals awaiting actual process evidence, not passed gates. The
ad-hoc CodeDirectory fixture is not production team/hardened/library-validation
admission. The deprecated Seatbelt API is fixture-only.

Required before claiming this slice: add/run focused integrity/derivation tests;
keep the client alive through peer-identity/ACK observation; validate the exact
kernel/executed-image binding and swapped-image regression; exercise actual
worker sandbox denials, key routing, cross-worker denial, closed bootstrap and
high-FD inheritance. Darwin LOCAL_PEERPID is a last-sender observation, not a
per-message nondelegable identity; its limits require explicit review. Validate
freshness/recovery rather than relying on this volatile fixture's current map.
Master durability, actual signed bundles, production sandbox, authenticated
native app/Core launch, canonical authority and disk format remain unimplemented.

Compile check:

```
swift build --package-path apple/Cowork/WinterCoworkKeyBroker --jobs 4
```

Evidence: /tmp/cowork-keybroker-draft-build.log. Do not run this fixture as a
production launcher or infer that the key/storage gate passed.
