# N2 guest: the supervisor's trusted config for a guided conversation (agent-sdk #35, main 68e57c64)

Status: source and CI only. No VM, no PID 1 execution, no supervisor run. Guided stays OFF in the first session (decision D10).

## What agent-sdk #35 requires

`docs/guided-reader-service.md` (68e57c64) lists, as owed, "PID 1's `wg_build_trusted_config` writing the new `reader` block and `guidanceDirectory` (it does not today)". Read from the supervisor itself (`ToolService.__init__`, `_open_reader`, `_configure_runtime`):

| Where | Shape the supervisor reads | Refusal if wrong |
| --- | --- | --- |
| `hostQueryGuidedRuntime` (top level) | exactly `{artifacts, reader}`; `artifacts` exactly `{launcher, executable, ownerLibrary}` | `runtime_artifacts` |
| `hostQueryRuntime` (top level) | exactly `{artifacts}` (so NO `reader`) | `runtime_artifacts` |
| `reader` | exactly `{artifacts:{launcher,executable}, dependencies:[...], uid}`; `dependencies` PRESENT (0 to 32 entries, may be empty) | `guided_reader_config` |
| dependency | exactly `{path, sha256, guestPath}`; `guestPath` under `/lib/`, `/lib64/`, `/usr/lib/`, printable ASCII, no empty, `.` or `..` part, 2 to 1024 bytes, none equal to or inside another | `guided_reader_config` |
| `reader.uid` | integer 1000 to 65535, different from every runtime uid, tool uid and workspace gid of the set | `guided_reader_identity` |
| every pin | exactly `{path, sha256}`, sha256 64 lowercase hex | `artifact_pin` |
| each guided conversation's `hostQueryGuidedRuntime` member | `guidanceDirectory` REQUIRED (a Root path) | `guided_guidance_required` |
| each host-query conversation's `hostQueryRuntime` member | `guidanceDirectory` ABSENT | `runtime_config` |

## What PID 1 writes, and where each piece comes from

* **`reader` block**: part of the image's runtime object for the guided profile (the same place the three runtime artifact pins come from). `wg_build_trusted_config` splices it unchanged under `hostQueryGuidedRuntime`, but now only after `wg_runtime_block_valid` has checked the object against the table above (compact JSON, no escapes, no duplicate or unknown key, digests lowercase hex, paths canonical). A bad object is the image's defect: the set is answered `supervisor_failed` (`runtime-artifacts-invalid`) and nothing starts. The host-query object is held to `{artifacts}` the same way, and may not carry a `reader`. The object's bound is one constant, 16384 bytes (the old 4096 could not hold 32 dependencies).
* **`guidanceDirectory`**: written PER CONVERSATION by the bootstrap helper (`supervisor_items`), exactly like `storeDirectory` and `runhomeDirectory`, because the helper is the one place that builds the items. PID 1 checks it (`wg_guidance_members_ok`): a guided set must name `/run/winter/shared-instructions` once per conversation and nothing else; any other profile names none. **This departs from the literal "`wg_build_trusted_config` writes it".** The alternative, inserting a member into canonical JSON in C, is brittle for no gain; PID 1 still refuses a config in which the member is wrong or missing. Recommendation: keep this split.
* **The path**: `/run/winter/shared-instructions`, the directory the skeleton already makes (root, 0755) and the tool view's mount point name. The supervisor needs no owner or mode for it (`docs/guided-guidance-view-matrix.md` item 4), only that it be a canonical directory not overlapping a protected path or tool root: it is a sibling of `/run/winter/control`. In the first session it is empty (no host-backed shares, D10).
* **The reader uid**: the supervisor refuses a uid equal to any runtime uid, tool uid or workspace gid, and those are chosen by the host in 1000 to 65533. PID 1 therefore accepts only 65534 or 65535 for `reader.uid`: inside the supervisor's range, outside anything the host may assign, so a collision is impossible by construction. No contract change is needed; S1 may want to record that 65534 is the reader's.

## How guided stays off

1. `op_read_runtime_artifacts` still refuses profile 2 (hygiene-pinned, and the reviewer of #59 asked to keep it): the image carries no guided object, and no reader launcher, loader or guided executable exists in it. A guided set therefore still ends in `supervisor_failed` before any directory is made or supervisor started.
2. Everything new is reachable only through fakes in the tests (a guided object handed to `wg_build_trusted_config`); `image.py` writes no `reader` (hygiene test) and `verify.py` still demands exactly `{artifacts}` of the one file the image holds.
3. Writing the block changes no behaviour of the host-query path except that its object is now validated, and the host cannot make a Cowork session at all (`session.create {mode:"cowork"}` is still `unsupported_topology`).

## The image's supervisor is older than 68e57c64

The image ships the supervisor pinned at SDK `7e71929d` (`sdkPin.supervisorSha256`), which accepts only `{artifacts}` under the runtime key and does not know `reader` or `guidanceDirectory`. The shape written here matches 68e57c64, not the supervisor the image runs. That is harmless today (guided is refused at boot) but must be said: before any guided activation the SDK pin has to move to a commit at or after 68e57c64 and the image be rebuilt and re-pinned. That is deliberately NOT done here; it belongs with the image work. Owner decision, recommendation: do it with the real-image build, not in this slice.

## Drift vector

`vectors/sdk-guided-config.json` (pinned in `vectors/PINS.json`) holds the SUPERVISOR's verdict on 97 objects and 8 member-key sets, derived by `tests/derive_guided_config_fixture.py` by importing the 68e57c64 supervisor non-root and running its real functions (`_open_reader`, `pinned_artifact` against a stand-in file, the key checks at the top of `_configure_runtime`); the inline `__init__` condition that needs root is restated as a predicate with its source line recorded and checked. `tests/test_guided_config.py` holds the guest to it: PID 1's validator never accepts what the supervisor refuses, refuses what it accepts only for two named reasons (the reader uid must be outside the host's range; artifact and dependency paths must be canonical), the helper's member keys are exactly the keys the supervisor accepts, and the three places the directory is spelled agree. With `WINTER_SDK_CHECKOUT` set the test re-derives the fixture from the SDK checkout and fails on any difference.

## Tests and mutation

102 mutants are listed (55 before, 47 new); the new mutants in `tests/test_mutants.py` run in both CI jobs; the new C guards (the parser, the path and uid rules, the dependency overlap rule, the guidance count) each have a mutant that the suite kills.
