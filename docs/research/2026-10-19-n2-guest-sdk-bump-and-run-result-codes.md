# N2 guest: the agent-SDK pin moves to 9c980c32, and the one run says WHY it is red

Source and tests only. Nothing was built or run; the one-run image build (`cowork-guest-image-build.yml`) is still unarmed.

## 1. The pin: 7e71929d to 9c980c32

`9c980c326638489e0183d7fcddcf1a93553be0ba` is agent-sdk main after #38 (the #37 holder patch applied; holder owner-matrix run 2 passed on a real kernel). The supervisor is the one from #35: `a26dacd86b805ca47b3e4805d06af2b178eee82003ebe6c38f2aeeb85e48035d`.

`bump_sdk_commit.py NEW --supervisor-sha256 SHA --sdk CHECKOUT` now moves every constant derived from the SDK commit, all or nothing:

| file | constants |
| --- | --- |
| `pins.json` | `sdkCommit`, `sdkPin.mainAt`, `sdkPin.supervisorSha256`, `runtimeArtifacts.launcher.sourceSha256`, `runtimeArtifacts.ownerLibrary.sourceSha256` |
| `sdk-supervisor-cli.json` | `sdkCommit`, `supervisorSha256`; every recorded PID 1 command-line verdict is re-derived from the new supervisor and must be unchanged (they are) |
| the workflow | `AGENT_SDK_HEAD` |

The supervisor digest the reviewer passes must equal what the script reads from the checkout at that commit, and nothing is written unless every check passes (11 tests; 24 mutants over this script and the result codes, all killed). Between the two commits the guest sources changed in three files: `linux-session-owner.c` (its source digest moved), `linux-tool-compartment.c` (a helper binary), `linux-supervisor.py`. The runtime compartment launcher, `file-worker.c` and `process-worker.c` did not change (their source digest is unchanged).

### What goes stale, by design

`expectedArtifact` (`runtimeSha256`, `cpioSha256`, `rootManifestSha256`, `helperBinarySha256`) is NOT touched: the supervisor, the owner library, the tool compartment and the host-query bundle all change the cpio, so those digests are stale until the one run's `digests.json` is re-pinned in a reviewed PR. The two `binarySha256` entries under `runtimeArtifacts` (launcher, owner library) likewise. The guest-side pins (`guest.programs`, init `dede7fd9…`) are not SDK-derived and do not move. `previousExpectedArtifact` keeps recording the last artifact that was really built.

### Tests that assumed the old supervisor beyond the pin

* `test_image.py`: the supervisor-shape assertion now quotes the new `runtime_artifacts` line (`{'artifacts','reader'}` for the guided profile, `{'artifacts'}` otherwise); the hard-coded commit is gone (the fixture's commit is the single source). Both checkout-gated tests pass against 9c980c32.
* `sdk-guided-config.json` (PID 1 against the supervisor's reader and guidance checks) was derived at 68e57c64; the supervisor is byte-identical, so the drift test passes against the new checkout unchanged.
* The guided-off chain is unchanged: the image's profile gate still refuses profile 2, the image still has no guided source, and the Cowork door still refuses. The new supervisor does accept the guided shape, so the profile gate and the missing reader launcher are now the load-bearing parts.

**A further supervisor change is expected** (agent-sdk #39: plan stays plan and every other policy becomes default; the supervisor digest moves again). When it merges, the re-bump is the same command with the new head and digest; then rerun `test_image.py` and `test_guided_config.py` with `WINTER_SDK_CHECKOUT` at the new head. Only the two supervisor-text assertions in `test_image.py` could need an edit, and only if #39 touches those lines.

## 2. The final check of the run now has distinct exit codes

`image_build_report.py assert` returns:

| exit | label | meaning |
| --- | --- | --- |
| 0 | `OK` | both builds of each artifact are identical AND every digest matches `pins.json`. Green means exactly this. |
| 10 | `PINS_STALE` | both builds are identical, but `pins.json` no longer matches them. EXPECTED after an sdkCommit bump; `digests.json` is the re-pin input. |
| 20 | `NOT_REPRODUCIBLE` | the two kernel builds, or the two image builds, differ from each other. Pin nothing from this run. |
| 30 | `UNEXPECTED_STATUS` | `image.py` ended with a status other than 0 or 3. |

Most severe wins (20 over 30 over 10). The step also appends a Markdown summary to `$GITHUB_STEP_SUMMARY` (the label, its meaning, the kernel `Image`, `vmlinux`, `initramfs.cpio`, manifest, runtime and `runtimeImageDigest`, and which pins hold), so a pins-only red reads as expected at a glance. The workflow needed no change: the step already runs the tool and the summary variable is a default step variable. Artifacts and `digests.json` are still uploaded before this step, whatever it returns.

## 3. Docs owed

`docs/claude/cowork.md` and the ledgers: the image pin is agent-sdk 9c980c32 (to be re-bumped after #39); the run's result codes (0 / 10 / 20 / 30) and that a first run after an SDK bump is expected to be 10.
