# Host output-only native addon

The production byte transport is independent of the historical VZ controller.
`Sources/output_transport.c` and `fd_creation.c` are the same reviewed sources
included by the legacy probe adapter; they are shared, not copied/forked. The
standalone adapter exports only the bounded output factory and fixed ABI/source
identity. It links Apple system libraries, with no Swift, Containerization, VZ,
guest network parser or controller dylib.

```
python3 apple/Cowork/packaging/build-output.py
```

The builder snapshots the three C files, embeds their aggregate SHA256, and
emits a unique `bundle/{winter-host-output.node,manifest.json}` plus source/build
evidence, the four snapshotted Node-API input headers and compiler identity. No
global dependency installation, VM or signing key is used.

Core resolves exactly `Contents/Resources/native/host-output` beside bundled
`winter-core`. It verifies the app resource seal, Core hardening/library
validation, the native code's fixed Team/identifier, ordinary protected paths,
manifest version/source identity and final artifact hash. It pins both files
before signature verification, checks the app seal last, and rechecks file/path
identities and descriptor bytes afterward. Swapping either file during the
verification seam fails before loading. Native loading uses
the opened verified `/dev/fd` image; that descriptor name remains reserved for
the process lifetime to avoid dyld name reuse. Source Bun and missing/invalid
bundles have no path/environment fallback. Required storage floors continue to
refuse without the capability. Explicit fixture DI is a separate named API.
These checks do not establish generic same-user filesystem immutability. Actual
production acceptance also depends on the signed enclosing app and hardened
Core's library validation; those signing gates are not exercised by fixture DI.

The Core runtime constructor supplies the factory to the existing trusted
HostCodeExecutionService lifecycle. The service/SDK retain final host authority,
spawn, sandbox floors, quotas, output ACKs and owned cleanup. This factory is
neither process authority nor a Workflow worker registration. The installed SDK
pin is unchanged; local source integration is not an installed-release proof.

Release composition (not performed here): use `stage-output.py --source BUNDLE
--resources APP/Contents/Resources`, sign the nested addon with identifier
`com.winter.host-output` and Winter's Team, then run `--refresh-signed-manifest`
before signing the outer app. Updating the final hash before the resource seal
is necessary because signing changes artifact bytes. The stager never signs or
uses a Keychain itself. The release embedding owner must call this staging path;
no SDK version/release pin is changed by this slice.

`fixtures/sdk-output-smoke.ts` explicitly imports the local SDK checkout. It
loads a packaged addon through the Core fixture loader, enrolls a trusted Core
service, and runs actual SDK-brokered native shell commands with private home,
coordination and runtime-store paths. It verifies stdout/stderr,2MiB ACKed
output and an enforced mandatory floor. Its runtime-envelope process is a test
double; tool processes and the SDK registration are real. No provider, actual
Keychain, VM, daemon, live app/home or Workflow worker authority is exercised.
