# Protected host output factory

Core resolves one output addon location beside bundled `winter-core`:
`Contents/Resources/native/host-output`. It pins the manifest and image
descriptors, checks app/Core/addon signatures and Core hardening, then rechecks
file identities and bytes before loading the pinned `/dev/fd` image. Descriptor
names remain reserved to avoid dyld name reuse. No settings, environment value,
runtime frame or arbitrary file path can select a production library.

The runtime constructor supplies that factory to the existing
`HostCodeExecutionService`. The service and SDK continue to own final command
authority, sandbox floors, output acknowledgment and process cleanup. A factory
is not a process grant or a Workflow worker registration. Source Bun and invalid
bundles provide no production factory; required storage floors still refuse
without their capabilities. Fixture signature verification is explicit host DI.

The standalone producer, shared C sources and build/staging contract are in the
dependent [native foundation PR](https://github.com/yanlingLabs/winter/pull/16).
This Core PR alone does not embed that artifact or prove production loading.
Combined SDK execution fixtures and evidence live on the
`cowork/output-integration` composition branch; the initial direct service fixture
does not by itself test forwarding through `createWinterRuntimeSdk`.

Actual Team signing, final manifest/resource-seal composition, hardened
production loading, release embedding, installed SDK capability/pin, Workflow
authority and Cowork activation remain separate gates. No live Winter home,
daemon, app or Keychain is used by the tests.
