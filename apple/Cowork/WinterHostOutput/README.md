# Standalone host output transport

The output addon contains the same reviewed `output_transport.c` and
`fd_creation.c` sources included by the historical VZ adapter. Those files are
shared, not forked. The standalone adapter exports the bounded output factory
and fixed protocol/source identity and links only Apple system libraries. It
does not load Swift, Containerization, VZ, a guest packet parser or a controller.

```sh
python3 apple/Cowork/packaging/build-output.py
python3 -m unittest discover -s apple/Cowork/packaging -p 'test*.py'
```

The builder snapshots the three C files and records their aggregate SHA256,
compiler, headers and exact command. Each invocation creates a unique
`out/output-*/bundle/{winter-host-output.node,manifest.json}`. It does not sign,
use Keychain material, boot a VM or install system dependencies.

The consumer contract is protocol version 1 and implementation identity
`winter-host-output/v1`. Core's protected loader and constructor wiring are in
the dependent [host authority PR](https://github.com/yanlingLabs/winter/pull/14).
This native PR alone does not contain or prove that Core integration. The
combined SDK fixture and its scoped evidence live on the
`cowork/output-integration` composition branch.

Release composition remains unperformed: `stage-output.py --source BUNDLE
--resources APP/Contents/Resources` installs the fixed layout; the release owner
must sign the addon as `com.winter.host-output`, run
`--refresh-signed-manifest` to record the final signed bytes, and then seal the
outer app. The stager does not sign or access a Keychain. An SDK pin, Workflow
authority, Cowork activation and production signed loading are separate gates.
