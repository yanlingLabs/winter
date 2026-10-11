# Output-only package and Core integration evidence

On 2026-10-11, the output-only builder produced
`out/output-63bpefw4/bundle` on arm64 macOS26 with Bun1.3.14. Its only dynamic
load is `/usr/lib/libSystem.B.dylib`. No VZ/Containerization/controller dylib,
network parser, SDK runtime, provider or VM is required by the addon. The three
C sources and four Node-API headers were snapshotted before compilation;
`build-evidence.json` records their hashes, compiler identity and exact command.

| Material | SHA256 |
| --- | --- |
| Aggregate C source identity | `f47f3e547cd1f88974e9d30b56a981dcf63d3ac4fb916a6745429d6668baeaf7` |
| `winter-host-output.node` | `3c1149122c70b7f7a616c88d4caa971aeac74e6ebf16b08659e1583dc1555f65` |
| `manifest.json` | `09bf76775a2a37da0eb356a2ec0363423c68190d3d586a72b34337f76f547645` |

`validation-evidence.json` retains three actual JSON execution receipts and
hashes of their copied logs under `validation-logs/`. A zero exit alone was not
used as evidence. The reviewed raw transport smoke loaded these output-only
bytes under a fixture filename and passed exact10MiB, native pause/backpressure,
12streams,140 extra host descriptors with `/dev/fd` child enumeration, bothEOF,
callback/disposal errors and exit without dispose. It made no VM call.

Ordinary and compiled Bun each loaded the same standalone artifact through
Core's fixed-layout fixture loader and real local SDK registration. They verified
exact stdout/stderr,2MiB of acknowledged output, denied writes to a private
mandatory-floor directory, and confirmed owned-process drain. The runtime
envelope was a test double; shell tools and the SDK host broker were real.
Local SDK source HEAD was `5e74c8e01166a0d353944848649d674561d28362`;
Winter's installed dependency pin was not changed.

Core constructor/loader tests passed35 tests/110 assertions, including swapped
manifest+addon and in-place modifications during signature verification.
Core typecheck passed. Packaging passed16 tests, including fixed-layout staging,
artifact tampering, symlink/hardlink refusal and shared-source identity changes.
The historical adapter compiled using the shared C files and passed its raw
output smoke; the descriptor-creation fixture passed32 fork/exec children plus
its leak positive control. Unchanged Swift, network and KeyBroker suites were
not rerun for this extraction.

Reproduce from the repository root:

```sh
python3 apple/Cowork/packaging/build-output.py
bun test packages/core/test/runtime-sdk/create.test.ts \
  packages/core/test/runtime-sdk/host-output-loader.test.ts
./node_modules/.bin/tsc -p packages/core/tsconfig.json --noEmit
python3 -m unittest discover -s apple/Cowork/packaging -p 'test*.py'
bun run --no-env-file --config=/dev/null \
  apple/Cowork/WinterHostOutput/fixtures/sdk-output-smoke.ts /absolute/BUNDLE
bun build apple/Cowork/WinterHostOutput/fixtures/sdk-output-smoke.ts \
  --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  --outfile /private/FIXTURE/compiled-sdk-smoke
/private/FIXTURE/compiled-sdk-smoke /absolute/BUNDLE
```

Root-verifiable logs remain at `/tmp/winter-output-only-build-final.log`,
`/tmp/winter-output-only-transport-smoke.log`,
`/tmp/winter-output-only-sdk-smoke-final.log`,
`/tmp/winter-output-only-sdk-compiled-smoke-final.log`,
`/tmp/winter-host-output-core-tests.log`,
`/tmp/winter-host-output-core-typecheck.log`,
`/tmp/winter-host-output-packaging-tests.log`,
`/tmp/winter-host-output-legacy-smoke.log` and
`/tmp/winter-host-output-fork-smoke.log`; copies are retained with the artifact.

This is unsigned/ad-hoc fixture evidence with explicit signature-verifier DI.
Actual Winter Team signing, nested staging/final hash/resource-seal composition,
production hardened/library-validation loading, release embedding, installed
SDK capability/pin and Workflow worker authority remain separate gates. The
Core constructor now supplies the protected output factory when that bundle is
available, and required floors refuse when it is unavailable. This checkpoint
does not activate Cowork, prove disk encryption, or close active RAM return.
No real Keychain, live app/daemon/home, provider, public connection or VM was used.
