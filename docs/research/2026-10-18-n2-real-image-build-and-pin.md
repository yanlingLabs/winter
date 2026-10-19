# N2 guest: the real image build and pin (kernel D6, initramfs), and the scripted stand-in image

Status: authored, NOT run. Nothing in this slice built a kernel, an image, a VM or a workflow run. The one-run workflow `.github/workflows/cowork-guest-image-build.yml` exists but cannot start until the owner arms it (section 4). The stand-in test image is STOPPED (section 6).

Stacked on #81 (`cowork/n2-guest-trusted-config-reader`), because #81 changed `pins.json` (the init binary, the expected cpio). Retarget this PR to `cowork/output-integration` when #81 merges.

## 1. What a "pin" is here

The worker recomputes `runtimeImageDigest = SHA-256( SHA-256(kernel) || SHA-256(initramfs.cpio) )` (raw 32-byte digests; `RuntimeImage.h`, pinned by `runtime-image.json`) from `<worker dir>/cowork-guest/kernel` and `.../initramfs.cpio`, and refuses a different value (exit 71 / `code_identity_mismatch`). The daemon never hashes files; it learns the value from the workspace's image pin (`CoworkImagePins`, `bindCoworkImagePins`). Three digests make a pin: the kernel `Image`, the cpio, and their combination.

**There is no ext4 root filesystem to build.** The root is the immutable cpio (`image.py`). The two ext4 volumes are the workspace's data and environment disks: the host allocates them blank and the guest's own helper formats them with `mke2fs` at first boot (`docs/cowork-native-worker.md` sections 8 and 10: two virtio-blk disks, one console port, no network device, no vsock). The runtime image digest does not cover them. So "kernel, initramfs, ext4 rootfs" is two build outputs, not three.

## 2. Audit: what existed, what was missing

| Input | State before this PR | Gap |
| --- | --- | --- |
| Initramfs cpio | `image.py` builds it reproducibly (two passes inside the script; two whole builds compared by hand in scratch, byte-identical; pinned in `pins.json` `expectedArtifact`). | Built only on a developer Mac. The pinned Zig was the **macOS** archive, so the build could not run on a Linux runner. The SDK's `node_modules` are assumed to be "already provisioned" (`source_snapshot` copies them) with no recorded provisioning. |
| Kernel | `kernel/pins.json`: source, signatures, keys, LLVM 20.1.8, base config, one-symbol fragment, make commands, required symbols. `expectedOutputs` all null. | The builder is a saved Docker image identified by a local image ID; the recipe forbids a fresh rebuild; the builder scripts live at `9a588735` on the hvf fixture lineage and need three changes. **Nothing CI can fetch holds that image.** `SOURCE_DATE_EPOCH` and `KBUILD_BUILD_TIMESTAMP` were open. |
| Digest rule | C in the worker, golden vectors in two copies. | No publisher: nothing computed the pair's digest outside the worker. |
| Production vs test separation | Nothing. | No test tied the production pin to the exclusion of a second image. |

## 3. What this PR adds

* `kernel/native_build.py` + `kernel/ci-build.json` (**decision D6-native, owner to confirm**): the pinned recipe run natively on a GitHub-hosted Linux ARM64 runner instead of in the saved container. The pins in `pins.json` are used unchanged (sources, signatures, keys, base config, fragment, commands, required symbols); `ci-build.json` fixes what the recipe left open (`SOURCE_DATE_EPOCH` 1792281600 = 2026-10-18T00:00:00Z, the matching `KBUILD_BUILD_TIMESTAMP`, `-j4`, the host build tools). It checks every digest and signature, merges base + fragment, runs `olddefconfig`, **refuses** unless the resolved `.config` holds every required symbol (a silently dropped symbol is a failure) and no disk-encryption symbol, then builds `Image vmlinux`. 28 offline tests (fake gpg and a real throwaway key including a signing subkey, command rewrite, config merge, the flow order).
* `pins.json`: the **Linux** Zig archive next to the macOS one (both are the official ziglang.org archives and equal `index.json`), and the standalone pnpm 10.34.6 binary (its digest equals the one GitHub publishes for the asset). `image.py` accepts either Zig archive (`zig_archive_ok`, tested); nothing else in it changed.
* `unpack_bun.py`, `image_build_report.py` (report / collect / assert), `runtime_image_digest.py`: small, tested tools. `report` compares two builds of each artifact, computes the `runtimeImageDigest`, and records which `pins.json` entries hold. `assert` is a separate step so the artifacts and `digests.json` are **uploaded before the run turns red**: a mismatch against the local pins costs only the colour, and `digests.json` is then the input of the re-pin.
* The workflow, and `guest-image-build-gates.test.ts` (95 tests, 88 named mutations, each must be caught by its own message).
* `guest-image-pin-separation.test.ts` and `test_runtime_image_digest.py`: section 5.
* `native-wiring.ts`: `readOnlyImagePins` is now `export`ed (one word) so the separation test uses production's real view rather than a copy.

Production bytes did not move: a full local rebuild from this tree gives cpio `90ac299e8dfbc023af1e02999d9fb30b10555fbd57f37da30a67020501f9a241`, init `dede7fd9ddc9eb954c29cb989b689e059f6f3b223618c4f66a392f13aee6f498`, runtime `c13918b4…2217`, `reproducibilityPinned` true, and the cpio is `cmp`-identical to the previous build.

## 4. The one run, and the exact approval to ask for

**Gate.** `on: push` of the single branch `cowork/guest-image-build`; every job-level condition: repository `yanlingLabs/winter`, event `push`, ref exactly that branch, `github.event.created == true` (first creation only), `run_attempt == '1'`. No `pull_request`, `workflow_dispatch`, `schedule` or any other trigger. `permissions: contents: read`, no secrets, no write-back. The first steps refuse unless `REVIEWED_HEAD` is non-zero, an ancestor of the pushed commit, and the **whole** diff between them is the one `REVIEWED_HEAD` line of this workflow file (single file, numstat `1 1`, exact one-line diff); only then is the reviewed commit checked out and anything else used. The branch name is consumed by the run: a second run needs a reviewed change to the workflow (a new name), which is intended.

**The run approval to ask the owner for (verbatim):**

> Approve ONE run of `cowork-guest-image-build.yml` on `yanlingLabs/winter`. It builds the guest kernel (Linux 6.18.35, LLVM 20.1.8, native on a GitHub ARM64 runner) and the production initramfs, each twice, compares the two builds, and uploads the kernel `Image`, the cpio and `digests.json` (14 days) — nothing boots, no VM, no provider, no network device in the guest. It reads github.com, ziglang.org, cdn.kernel.org, kernel.org (keys), snapshot.debian.org and the npm registry, using only digest-checked downloads and `pnpm install --frozen-lockfile --ignore-scripts`. Free on a public repo; at most 210 minutes; no secrets.
> The arming push: after this PR is merged into `cowork/output-integration` at commit **R**, create ONE commit on top of R that changes exactly one line of `.github/workflows/cowork-guest-image-build.yml`:
> `-  REVIEWED_HEAD: '0000000000000000000000000000000000000000'` / `+  REVIEWED_HEAD: '<R>'`
> and push it as the NEW branch `cowork/guest-image-build`. The run may only start that way; a re-run is refused by the gate.

I will not create the branch or push it.

**What the run can still get wrong** (each is a recorded finding, not a silent pass; none touches a pin file):

1. Zig on Linux vs the macOS-made pins: byte-identical output is expected of a self-hosted compiler but unproven. A difference shows as `pinsHold` false and `image.py` exit 3; the files are still uploaded.
2. SDK dependency bytes: pnpm on Linux (and its optional platform packages) vs the developer's provisioning. Same symptom, on `runtimeSha256`.
3. Runner assumptions: `rsync`, `gpgv`, `cc` present; `apt-get install flex bison bc libelf-dev libssl-dev` succeeds (host build tools only, versions recorded, not pinned); the slim LLVM bundle has every tool the arm64 kernel build calls; 4 jobs fit the runner's memory.
4. Kernel determinism: two builds at the same absolute paths. Path independence is not claimed (vmlinux carries DWARF paths).
5. `snapshot.debian.org` availability for the lock's `.deb`s.

## 5. Production refuses the test image

The test image is a **different cpio under the same kernel**, so its `runtimeImageDigest` differs by construction. Held three ways:

* `guest-image-pin-separation.test.ts` (7 tests, against the real mechanisms): a workspace pinned to the production digest is launched with that digest (`bindCoworkImagePins`) and the test digest is refused (`image_digest_mismatch`); production's real read-only pin view (`readOnlyImagePins`) cannot pin or begin an update to it; even the owner path cannot quietly re-pin; a pending update to it is not the live pin; no pin refuses (`image_unpinned`); the launch digest is returned only after `assertPinned` accepts it.
* `test_runtime_image_digest.py` (11 tests): the digest rule reproduces the worker's golden vectors (so the publisher cannot drift from the worker that does the real refusal at launch); shared kernel + different cpio gives different digests in both argument orders; the inner digests are raw bytes.
* **The test digests are never in any production pin file.** `standin-pins.json` (null digests, `testOnly`) reserves where they will live. The test scans an explicit list of ten production files plus two source trees for those values; while they are null it asserts the list exists and the scanner works (it finds a planted digest), and it goes live on its own the day they are filled, together with consistency checks (the pair must reproduce the digest, and differ from production's).

Mutation results for this slice: 54 mutants over `native_build.py`, `runtime_image_digest.py`, `image_build_report.py`, `unpack_bun.py`, `image.py` (`zig_archive_ok`), `images.ts` and `native-wiring.ts`; the first run had three survivors (an equivalent lowercase check, which I removed; a gpg exit-status check that needed a fake gpg; a tautological `assertPinned` in `bindCoworkImagePins`, which needed a refusing fake) and each now has a test that kills it. The workflow gate has its own 88 mutations.

## 6. The scripted stand-in image: STOPPED, with the reasons

The owner chose a scripted stand-in provider with no network, and DOOR (`2026-10-18-cowork-session-door-design.md` section 5) concluded the canned answers must live in the guest. I checked that against the stub (`runtime-sdk` `scripts/guest-guided-provider/stub.ts`) and the supervisor. It is **not makeable in this slice**, and I did not ship a dormant job for it. What I found:

1. **The stub is an in-process `GuestProviderPort`, not a socket server.** The guest runtime opens a **new connection per exchange** to `<home>/.control/provider.sock` (`createLinuxProviderPort`). A runner must listen there, keep **one stub port alive per conversation** across connections, and frame 4-byte-length requests and replies. The stub's README calls the runner "a later, separately reviewed slice"; it does not exist.
2. **The script bakes the per-conversation scope.** `version`, `scope` (homeId … modelRevision, 11 fields), `selection` and `steps` are verified against an independently chosen SHA-256, and every request's scope must equal it. A script baked into the image cannot match; the runner must compose it from the conversation's admitted record at start (and self-attest the hash, acceptable only in a test image), or the stub needs a scope parameter.
3. **Fixed selection.** `SELECTION` (`openai/gpt-5.6`, line 6), the `script.selection` equality (line 39) and `turn.model !== SELECTION.providerModelId` (line 71) all pin it.
4. **Markers are not optional.** `markers(step.system)` and `markers(step.user)` refuse an empty list (only `absentSystem`/`absentUser` may be empty; line 43), and `messages[0]` must be a `role: "user", isMeta: true` user-context message (line 89). **The answer to DOOR's question is no: empty markers are not accepted.** Whether a host-query turn even has such a message 0 is unverified (`buildRequestMessages` prepends one only when a user context text exists).
5. **Limits as merged:** exactly two serial `begin`s per port, ever; text only; no tool events; a refusal or a cancel closes the port for good. So the first session is at most two canned model turns per conversation, with no tool call from the model.
6. **The protocol sources match the image's SDK.** `protocol-source.json` pins `provider-client.ts` and `types.ts` at SDK `92b87080`; both files are byte-identical at `7e71929d` (the image's SDK). That is not the blocker.
7. **Nothing launches a provider server in the guest, and the supervisor does not.** `<home>/.control` is the supervisor's private conversation directory: `mkdir(mode=0o750)` then `chown root:<runtime uid>`, created when the conversation is configured and **refused if it already exists**. A runner would have to be started by something (PID 1 is the only candidate), wait for the directory, bind `provider.sock` in it, and make it connectable by the runtime uid. That is a new privileged process in PID 1's start-up and a decision about what, in a test image, PID 1 may start. The requirement is a **separate init build**, never a file-presence or flag switch in the production init, and `refuse_provider_bridge`/`verify.py` stay unconditional for production.
8. Per the standing rule I designed nothing that gives the guest a NIC, vsock or egress; this is an in-guest Unix socket only.

**Owner decision (recommendation):** approve the stand-in as its own slice after this one, in this order: (a) runtime-sdk stub change below, merged there; (b) a runner (Bun, compiled through the same canonical builder), owned by the N2 guest lane; (c) a separate `init-standin` build that starts it per conversation as root after the supervisor's directory exists; (d) a second `image.py` profile and a second workflow arming, with its own digests in `standin-pins.json`. Do not combine it with the production run: the production pin should not wait for it.

### NEEDS FROM OTHER LANE (runtime-sdk, do not edit from here)

A small change to `scripts/guest-guided-provider/stub.ts`, so the stub can also serve a reserved selection that no catalog row has, and accept empty markers only for it:

```diff
@@ line 6
 export const SELECTION = Object.freeze({ providerId: "openai", modelKey: "openai/gpt-5.6", ... });
+export const STANDIN_SELECTION = Object.freeze({ providerId: "winter-standin", modelKey: "winter-standin/scripted", providerModelId: "scripted", family: "winter-standin", protocol: "openai-responses", continuationDomain: "winter-standin/scripted", capabilities: Object.freeze({ toolCalling: "native", readableState: "summary" }) });
@@ readScript (line 35-43)
-function readScript(bytes: Uint8Array, expectedHash: string): Script {
+function readScript(bytes: Uint8Array, expectedHash: string, selection: typeof SELECTION | typeof STANDIN_SELECTION): Script {
@@ line 39
-  if (script.version !== 1 || canonical(script.selection) !== canonical(SELECTION)) refuse();
+  if (script.version !== 1 || canonical(script.selection) !== canonical(selection)) refuse();
@@ line 43 (system/user markers)
-... system: markers(step.system), user: markers(step.user), ...
+... system: markers(step.system, selection === STANDIN_SELECTION), user: markers(step.user, selection === STANDIN_SELECTION), ...
@@ validateTurn (line 71)
-  if (turn.model !== SELECTION.providerModelId || ...
+  if (turn.model !== selection.providerModelId || ...
@@ line 89
-  if (current.role !== "user" || current.isMeta !== true) refuse();
+  if (current.role !== "user" || (selection !== STANDIN_SELECTION && current.isMeta !== true)) refuse();
@@ createGuidedFixturePort
-export function createGuidedFixturePort(scriptBytes: Uint8Array, expectedScriptSha256: string): GuidedFixturePort {
+export function createGuidedFixturePort(scriptBytes: Uint8Array, expectedScriptSha256: string, selection: typeof SELECTION | typeof STANDIN_SELECTION = SELECTION): GuidedFixturePort {
+  if (selection !== SELECTION && selection !== STANDIN_SELECTION) refuse();
```

`validateTurn` must receive `selection` through its call site (`validateTurn(request.turn, step, selection)`). The default argument keeps every existing caller and test byte-for-byte. The `isMeta` relaxation is needed only if G1 shows the host-query runtime sends no meta message 0; if it does send one, drop that hunk. No scope change is required if the runner composes the script.

Other lanes: **DOOR/S7B** — whoever sets the workspace image pin at provisioning must take the production `runtimeImageDigest` from the reviewed pin (the published `digests.json` via a pin PR), never from a constant or from the bundle's own files at install time; a stand-in workspace is pinned only through a test-only door port. **S7B** — the app-bundle packaging (release scripts are theirs) must install the published `kernel` and `initramfs.cpio` byte-identical under those names in `cowork-guest/`. **SDK lane** — the image's SDK pin is still `7e71929d` (older than the guided shape of #81); moving it is a separate rebuild and re-pin.

## 7. After the run: the pin PR (not part of this slice)

From `digests.json` and the receipts: fill `kernel/pins.json` `expectedOutputs` (`Image`, `vmlinux`, `resolvedConfig`) and flip `status`; re-pin `pins.json` `expectedArtifact` only if `pinsHold` says it differs (and say why: Zig host or pnpm); record `runtimeImageDigest` for the production workspace pin; add a test that the pinned kernel digest feeds the combined digest. Then the installed bundle gets `kernel` and `initramfs.cpio`.

## 8. What gate G1 would later boot-verify

On the first real boot of exactly these two files (nothing here has booted):

1. The kernel brings up **exactly one** virtio-console port with `VIRTIO_F_VERSION_1` and `MULTIPORT` (PID 1 insists on both).
2. **Two** virtio-blk disks, with the expected serials.
3. **No network device and no vsock** appear in the guest (`/sys` and `/proc`).
4. The worker's **recomputed** `runtimeImageDigest` equals the pin in the daemon's record.
5. The **production worker refuses the stand-in digest** at a real launch (`bad_scope`, exit 71) and the stand-in launches only with a stand-in-pinned workspace.
6. (Stand-in only, once it exists) it serves **exactly two** canned answers per conversation and then refuses a third.
7. `provider.sock` is **absent** in the production guest (nothing serves it; a model call fails at the socket).
8. Cross-checks that cannot be settled from source: `CONFIG_BLK_DEV_WRITE_MOUNTED` behaviour on journal replay, the kernel's `Image` format accepted as `KRUN_KERNEL_FORMAT_RAW`, and whether the compartment makes `<home>/.control` visible to a root-created socket.

## 8a. Review folds (after #81 merged as 22bb8ae2)

* **The `-I` import error (blocker, fixed).** `python3 -I` leaves a script's own directory off `sys.path`, so `image.py` (`packages`, `verify`, and the lazy `metrics`) and `image_build_report.py` (`runtime_image_digest`) would have failed with `ModuleNotFoundError` after both kernel builds. Fix: each inserts its own directory (`sys.path.insert(0, str(Path(__file__).resolve().parent))`) before its sibling imports. I chose this over dropping `-I` because it keeps every other protection of `-I` (the interpreter ignores `PYTHON*` variables, the user site and the current directory) and changes nothing the workflow pins. New test `test_workflow_commands_run.py` extracts every `python3` command from the workflow and runs each script (and each `image_build_report.py` subcommand) with `--help` from an empty temporary directory with a minimal environment, and checks that any script importing a sibling puts its own directory on the path first, including `image.py`'s lazy import. Removing the insert from `image.py` makes three of its five tests fail. The gate test pins the same `-I -S -B` command lines, and a mutation (a script run without `-I`) is caught.
* **Uploads.** A kernel upload (the first kernel's `Image`, its receipt and resolved config, and the second receipt; 14 days) now follows the kernel builds, so a later failure cannot lose the kernel. The gate pins three uploads in order.
* **`sdkCommit` bump prepared as one move.** `bump_sdk_commit.py NEW --supervisor-sha256 SHA` edits `sdkCommit`, `sdkPin.mainAt`, `sdkPin.supervisorSha256` and the workflow's `AGENT_SDK_HEAD` together or not at all (tested). `expectedArtifact` deliberately stays and is stale after the bump; the next build reports which digests changed. The head to use is agent-sdk main after the #37 holder patch (it changes `linux-session-owner.c`); it will be set when the coordinator sends it.
* **Duplicate-key guard in `jp_object`** (a #81 LOW): the object `{"artifacts":A,"artifacts":A}` (right number of members, no `reader`) and an artifacts object that repeats `launcher` instead of `ownerLibrary` are refused; a mutant that drops the `seen` mask is killed.

### Two wording corrections to #81 (its note and PR text said otherwise)

1. PID 1 does not **write** the reader block. It **validates** it (`wg_runtime_block_valid`) and splices it unchanged in `wg_build_trusted_config`. `guidanceDirectory` is **written by `guest_bootstrap.py`** (`supervisor_items`); PID 1 only **checks** it (`wg_guidance_members_ok`).
2. Guided is off because of this chain, and only this chain: the image's profile gate (`op_read_runtime_artifacts` refuses profile 2), the image having no guided source (no reader launcher, loader or guided executable, and `image.py` writes no `reader`), the old image supervisor pin (7e71929d, which refuses any runtime block but `{artifacts}`), and the `session.create` refusal. The validator is deliberately **stricter** than the supervisor (reader uid 65534 or 65535 only, canonical artifact and dependency paths). That it matches the supervisor otherwise "line for line" is enforced by a drift test against vectors derived from the real 68e57c64 supervisor, not by construction.

## 9. Docs owed

`docs/claude/cowork.md` and the ledgers must say, once this merges: the guest contract reserves reader uid 65534 and 65535 (outside the host's 1000 to 65533 range) and PID 1 accepts only those for the guided reader;  the real image has a one-run build (not run) and a pin flow through a reviewed PR; the kernel recipe is native (D6-native), pending the owner's confirmation; there is no ext4 rootfs build; production refuses a second image by digest; and the stand-in image is stopped with the five-step plan above.
