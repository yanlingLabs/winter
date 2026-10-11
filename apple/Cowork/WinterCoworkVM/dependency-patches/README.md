# Verified Containerization output-completion build profile

Pinned Containerization revision:
`bc994b88df46207fad7775b0eabc51947e315881`.

The patch adds an independent, bounded EOF/error/callback tracker. It records
actual stdout/stderr EOF from the readability handler, retains writer errors,
and exposes cancellation-responsive `waitForOutputCompletion`. It preserves
legacy `wait()` behavior and does not classify descriptor deletion as EOF.
`Writer.close` is not EOF evidence in the upstream implementation. The native
verified profile awaits this new proof **after wait and before delete**, and a
failure remains typed `output_completion_unproven`, even when cleanup succeeds.

```
python3 apple/Cowork/WinterCoworkVM/dependency-patches/prepare-containerization.py
WINTER_COWORK_NATIVE_PROFILE=verified-eof swift test --package-path apple/Cowork/WinterCoworkVM --jobs 4
```

The helper downloads only the exact public archive into the package's ignored
`out/dependencies`; no .git checkout is needed. `--offline` requires its archive
already present. `--verify-only --offline` hashes the entire prepared tree and
archive and refuses mutations. It never edits `.build/checkouts`. The source,
archive and original Apache2 license/notices must be included in distribution
source material. The first tree computation requires review of the recorded pin;
it is not automatic approval of arbitrary source. The committed expected tree
pin now exists and every later preparation/manifest verifies it.

The build-only environment selector accepts exactly `upstream` or `verified-eof`.
It cannot choose an arbitrary source path. Swift manifests verify the full tree
at the **fixed relative** `out/dependencies/containerization` before allowing the
profile. It works in a private source snapshot with the same relative layout.
No compiled runtime reads this selector. Default native/legacy builds retain the
unmodified upstream revision; real production launch refuses that default profile.

Pinned archive SHA256:
`94a9deedeaa8cf50869ea86b995e1c3cf133d9787c0733b140938ea992a1343e`.
Patch SHA256:
`35c1aa41927e138ca30e68458fa76aa6e6f1fa93972f2e0a29262d4e8f37f061`.
Patched full tree SHA256:
`812a8b6c38acfc87f1abb1ff6f96110de912d09a769f27f73bd86ef228f680dc`.
Tree hashing sorts relative paths lexically and hashes concatenated
`path + NUL + fileSHA256 + newline`, refusing symlinks and excluding only generated
`.build`, `.swiftpm`, `.git` directories. File content paths and hashes, not
filesystem timestamps, define the pin. Packaging must separately pin the resolved
transitive graph and compiled artifact hashes/signatures.

`NativeCompiledGraph.identity` embeds revision/patch/tree and real launch requires
an identical HostLaunchDescriptor.compiledGraph. Host admission additionally
verifies actual installed native artifacts; JSON is not graph authenticity.

No-VM evidence: patched profile compiles and37 native tests pass in a private
package snapshot; seven patched upstream tracker tests pass (both EOFs, active
callbacks, writer errors, zero-output case, unconfigured state, duplicate EOF,
cancellation). Helper mutation rejection was exercised on a disposable source
copy and restored. Legacy15 tests pass on its default upstream profile. These
prove the selected API/state transitions, not real guest transport. Large
concurrent guest output, delayed EOF, malicious floods and real cancellation
still need the coordinated fixture VM/backend gate before lossless output can
be claimed. Active-work RAM return remains separately open.
