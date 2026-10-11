# Local packaging evidence — 2026-10-11

Implemented prerequisite, production availability remains blocked. No VM, live
Winter app/daemon/home, Keychain, credential or host-pressure workload was used.

## Verified dependency stage

```sh
python3 -m unittest discover -s apple/Cowork/packaging -p 'test_*.py'
python3 apple/Cowork/packaging/build.py --dependencies-only \
  --source-cache apple/Cowork/packaging/out/source-inspect --jobs 4
python3 apple/Cowork/packaging/closure.py \
  apple/Cowork/packaging/out/build-nzn18phm/bundle/lib
python3 apple/Cowork/packaging/build.py --dependencies-only \
  --dependency-bundle apple/Cowork/packaging/out/build-nzn18phm/bundle --jobs 4
```

Seven closure/environment/cache tests pass. The original from-source bundle is
`out/build-nzn18phm/bundle`; its manifest records exact archive pins, build
commands/options/logs, toolchain, source/notices/build-material hashes and
`components: dependencies-only`. GLib, gettext-runtime libintl and PCRE2 were
configured, compiled and installed into this invocation's private prefix.
GLib's optional fallback downloads are disabled; pkg-config sees only the
private libraries and explicit Apple SDK system metadata.

All three runtime libraries are arm64. `otool` for every library records only
`@loader_path` sibling references and Apple system libraries/frameworks. There
are no Homebrew or temporary build-prefix load commands and no rpaths.
Versioned dylib SONAMEs and the unversioned linker aliases are retained.

| Runtime dylib | SHA256 |
| --- | --- |
| `libglib-2.0.0.dylib` | `61d26721f05b546a3aefcc3363807bc3b9a7d9ad457679493a0db2554ab8e75e` |
| `libintl.8.dylib` | `74ca236469c251c7e12f6ab2e6a3bda191a2f0691cad69925d932c4e00d8f541` |
| `libpcre2-8.0.dylib` | `dfe85dcea7a1c726ff12e9e4c8000a94e8040b9541c0dd34e9bdfc39e0f64aab` |

The final from-source dependency stage completed in 154 seconds and its
relocated C smoke passed. Its log
`out/build-nzn18phm/logs/19-relocated-dependency-smoke.log` reports:

```json
{"relocatedDependencies":true,"glib":"2.90.0","libintl":"1.0","pcre2":"10.49"}
```

The smoke asserts the actual runtime versions, matches a bounded GLib regex
through the shared PCRE2 library, and calls gettext under the C locale. It loads
libraries from a copied directory with loader/search injection variables
removed; it performs no network request. Re-export modifies only fresh copies.
Verified cache import/re-export also passed using the earlier source-built
`out/build-w02gqv9w/bundle`, producing `out/build-u2lrjeqo/bundle`. The
source-built originals remain unchanged. The current source-built cache for
future packaging is `out/build-nzn18phm/bundle`.

## Verified libslirp provenance mechanism

```sh
python3 apple/Cowork/packaging/libslirp_provenance.py \
  --destination apple/Cowork/packaging/out/libslirp-provenance-initial4 \
  --upstream-checkout apple/Cowork/packaging/out/libslirp-upstream-9nc0wfan
```

The clean upstream checkout was fetched from the primary libslirp GitLab
repository at commit `390848f47391f412451b2d259d8527fabb51e5e3`; its Git tree is
`0509386ab50c032b58f5af4576f8ee5f79157c51`. The script retains a complete upstream
archive, computes per-file vendor hashes, generates a binary-capable patch and
verifies that applying it reconstructs the exact vendored tree. This initial
artifact predates ongoing network review fixes; its vendor/patch hashes are
historical and must be regenerated for the final reviewed package. The script
does not edit the vendor sources. Git identity verification does not establish
a verified publisher signature.

## Verified network package

```sh
python3 apple/Cowork/packaging/build.py --network-only --jobs 4 \
  --dependency-bundle apple/Cowork/packaging/out/build-nzn18phm/bundle \
  --libslirp-upstream-checkout apple/Cowork/packaging/out/libslirp-upstream-9nc0wfan
```

`out/build-le7dfij8/bundle` contains the release network dylib and its three
source-built shared dependencies. All 33 network/route tests and the relocated
synthetic C smoke passed. The latter reports
`{"relocatedNetwork":true,"syntheticNoOutbound":true,"realVM":false}`.
The runtime closure checker accepted all four arm64 dylibs with only relative
bundle or Apple system references. The network dylib SHA256 is
`a31920a353c0b961440f371cb02ce96dbb76762b616d9089468fd43d438866b3`.
Regenerated libslirp provenance reconstructs the exact current vendor tree;
its patch SHA256 is
`2f3b90942ef06fe6846f7bf3014d9327f45036fdcf0be530bfdf3e02e03fa116`.
The recipe/closure/environment tests now number eight.

This run caught and fixed two packaging errors before accepting an artifact:
SwiftPM needed the private pkg-config directory in `PKG_CONFIG_PATH` as well as
`PKG_CONFIG_LIBDIR`; otherwise its own parser selected Homebrew. Imported
relocated dependencies also needed temporary install IDs in their fresh build
copies so Swift test executables could load them before final relocation.
The original verified cache is unchanged. No `DYLD_*` workaround is used.

## Combined native package and independently verified execution

`out/build-3x8r74l_/bundle` was built from native checkpoint `59a67a96` with
the `verified-eof` profile. Its fixed preparer verified the upstream archive,
patch and complete patched tree. The package's 37 native and 33 network tests
passed, and the closure checker accepted the native/network libraries, addon,
and three dependency dylibs. The native dylib SHA256 is
`280aadf709e050c4144555b27b459266f38fffbe9e6a25e9c38a74ec93fd7558`;
the addon SHA256 is
`0dea894abe213a8e8a4f3886adf5fc71741a69b2b22384f9df9daa720c6169b0`.

The original recipe's two Bun smoke logs were empty despite exit zero: Bun
1.3.14 interpreted separate `--config PATH` arguments without executing the
following script. Those original smoke exits are invalid evidence. The recipe
now uses `--config=PATH` and requires typed JSON completion receipts, with a
regression test rejecting empty or wrong-typed receipts. Nine recipe tests pass.

Root reran both scripts against the unchanged relocated frozen libraries with
the corrected argument; `verified-smoke.ts.log` and
`verified-client-smoke.ts.log` under that build directory contain the actual
completion receipts. The addon proved concurrent fake execution, independent
cancellation and bounded input/output; the typed client proved ordered input
and the production-blocked factory. Both explicitly report `realVM: false`.
These supplemental logs are outside the original bundle manifest, whose source
recipe and empty smoke logs remain unchanged for audit. The next full recipe
run must retain the corrected receipts in its manifest material.

## Fresh frozen native/output package

```sh
python3 -m unittest discover -s apple/Cowork/packaging -p 'test_*.py'
python3 apple/Cowork/packaging/build.py --jobs 4 \
  --dependency-bundle apple/Cowork/packaging/out/build-nzn18phm/bundle \
  --libslirp-upstream-checkout apple/Cowork/packaging/out/libslirp-upstream-9nc0wfan
python3 apple/Cowork/packaging/closure.py \
  apple/Cowork/packaging/out/build-ycs24bpl/bundle/lib
```

The fresh combined bundle is `out/build-ycs24bpl/bundle`, built in309 seconds
from frozen native `a5cae99956d55171d4578a0b3f77ea245e450acd` and network
`02fb0e264a5630c9820fe88e7d17e4c6072ed292`. Eleven packaging regressions pass.
The network stage passes45 Swift Testing tests (its separate XCTest compatibility
footer reports0). The verified-eof native stage executes45 XCTest tests:44 pass
and1 APFS Data-firmlink fixture skips because the host does not expose that alias.
The real case-alias identity test passes. Exact logs are retained as
`build-logs/10-network-tests.log` and `build-logs/14-native-tests.log`.

Both relocated addon/client smokes produce their required actual JSON receipts.
Ordinary and compiled Bun output smokes also load the relocated protected addon
and produce nonempty identical receipts in
`build-logs/35-relocated-output-smoke.log` and
`build-logs/37-relocated-compiled-output-smoke.log`:

```json
{"nativeOutputTransport":true,"pressureBytes":10485760,"pauseStopsNativeReads":true,"exactStdoutStderr":true,"maxChunkBytes":65536,"sharedReadiness":true,"concurrentStreams":12,"callbackFailureVisible":true,"noChunksAfterDispose":true,"pauseInsideCallback":true,"bothEOFRequired":true,"extraInheritedDescriptors":false,"descriptorEnumeration":"/dev/fd","highFixtureDescriptors":140,"realVM":false}
```

The recipe uses `--config=PATH`, disables compiled dotenv/bunfig autoload,
requires typed execution receipts, and records the actual receipts plus command
log hashes in `manifest.json`. Every receipt's retained log SHA256 was independently
checked. The compiled fixture remains outside the runtime bundle at
`out/build-ycs24bpl/relocated-smoke/compiled-output-smoke`; its SHA256 is
`94c970b0b8c98fa2edbb47032e8d80d2ab337fa3964e247f9ee2b3d8b61fbd49`.

The committed vendor pin checks all66 libslirp files before compilation. Its
content-map SHA256 is
`92b94c449a232a355c7af325db487ae3959c4740a10254bc4a15c372b3408d9f`.
A modified/extra/missing file or symlink cannot be accepted by generating a new
inventory during the build. Reconstruction additionally checks the exact
upstream commit/tree and retained pin; this is not publisher-signature evidence.
Native preparation independently verifies the pinned Containerization archive,
EOF patch and complete patched tree. The runtime closure accepts all six arm64
Mach-O files with only bundle-relative or Apple system references.

| Material | SHA256 |
| --- | --- |
| `manifest.json` | `578095e9f01cb66a4299f96209315872607b0e01303664e63168b18a19e73ecd` |
| `libWinterCoworkNative.dylib` | `ce8a98571e48e02d99ef919ef499594bd92744d586a9f584397b36683ad36218` |
| `libWinterCoworkNetwork.dylib` | `6e4e3edc673807e7a9abe187a1c87d770cea0d70c7fcf11c9856b140ba1fb693` |
| `winter-cowork-native.node` | `2fe3d43ea2b3e98d8f47be954dc74a074f2af0ef6024962fb4eeb829f1fa0d54` |

This remains an ad-hoc signed native foundation with `productionReady:false`.
The accepted per-workspace worker architecture, durable authority integration,
real guest IO/termination, active RAM return and production activation are not
proved by these no-VM checks. The dependency cache and native/network sources
were not modified. The later validation/report text is not retroactively inserted
into the source snapshot; code/test/vendor-pin hashes match the built recipe.

## Pending

The protected native output transport is packaged and fixture-verified in the
fresh bundle above. Its production host-broker/worker integration remains pending. The recipe's
`--dependency-bundle` option permits packaging a
fresh reviewed source snapshot without repeating the dependency source build.
The combined package exercises the verified-EOF fixed prepare/verify helper and
source-retention route. Production team signing, hardened
compiled-Bun loading, replacement/relinking
policy, CI provenance, notarization, app integration and all VM/authority
feasibility gates remain open. This evidence does not authorize enabling Cowork.

## Round3 source fixes — new artifact required

Twelve packaging regressions pass, including a disposable Git repository proving
that the built-commit pin is authoritative and a committed self-consistent pin
cannot falsely name unrelated reviewed vendor bytes. Dirty vendor/packaging
state is refused. No global Git configuration is changed.

The native output source now owns context per queued event, closes read admission
on first failure, preserves errno before close, refuses stale writer getters, and
throws for invalid statistics receivers. Ordinary and compiled no-VM output
receipts pass, including32 queued events during actual process exit without
dispose. EIO/enqueue failure fixtures and a32-child concurrent fork/exec fixture
with a real raw-pipe leak positive control pass. See
/tmp/cowork-output-round3-{normal,compiled}.log,
/tmp/cowork-{read-error,enqueue-error,fd-creation}-round3.log and
/tmp/cowork-packaging-round3-tests.log.

The historical build-ycs24bpl bundle above remains unchanged and predates these
fixes. The recipe now requires the expanded receipts; a fresh frozen package
must be built before claiming they passed for a new protected artifact. Native
Swift/VZ and network sources were not modified for this adapter review.
