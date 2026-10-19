# N2: the stand-in test image (design, source and tests; nothing built or run)

Lane: N2 guest trusted config. Branch `cowork/n2-guest-standin-image`, stacked on the real-image-build work. Source-only: no VM, no krun, no worker run, no workflow run, nothing built in CI.

## 1. What it is for

The first real Mac Cowork session (gate G1) should be able to run a full conversation with no model provider, no network, no NIC and no vsock. The stand-in image answers a conversation's model calls from inside the guest with two scripted texts. It is a TEST image: it has its own digest, it is never pinned by a production file, and a production daemon cannot select it (section 6, owner decision O13).

## 2. The pieces

1. `init-standin`: the production PID 1 plus the stand-in lifecycle. Built only with `build.py --profile standin` (`WG_STANDIN` defined). In the production build every hook in `init/standin_hooks.h` compiles to `((void)0)`, so the production init has no stand-in code and the production binaries have zero occurrences of "provider" or "standin" (checked on a local production rebuild; the init binary is byte-unchanged by adding the hooks).
2. `init/standin.{h,c}`: the lifecycle as a pure state machine over an ops table (NONE, LISTENING, RUNNING, FAILED, STOPPED). No I/O, so every ordering and refusal is tested with a recording fake.
3. `init/standin_linux.{h,c}`: the Linux effects: write the items file (root, 0400), run the prepare script, bind `provider.sock`, locate the runtime process, hand the worker its descriptors.
4. `standin/standin_prepare.py` and `standin/profile.json`: compose the provider worker's immutable metadata for one conversation.
5. `scripts/cowork-guest-artifact/build_standin_image.py`: the second image profile, an exact overlay on the production cpio.
6. `vectors/standin-metadata.json`: golden bytes for the metadata, so the composer cannot drift from the worker's `parseMetadata`.

## 3. The second image profile

The stand-in cpio is the production cpio with EXACTLY these differences, and the builder refuses anything else: `/init` is `init-standin`; `/opt/winter/standin/winter-provider` (the runtime-sdk provider worker, 0555); `/opt/winter/standin/standin_prepare.py` and `profile.json` (0444, byte for byte the files in this tree). Nothing in the production cpio is edited, so every production file, pin and digest is unchanged. The reader proves the overlay by reading the 337 MB production cpio and rewriting it byte-identically before it adds anything. The result has its own initramfs digest and therefore its own `runtimeImageDigest = SHA256(SHA256(kernel) || SHA256(initramfs))`; the kernel is shared with production. `standin-pins.json` reserves where those digests live. It is `testOnly`, and the digest fields stay null until the image is built.

## 4. How PID 1 starts the provider, in the stand-in image only

The stub in runtime-sdk is an in-process `GuestProviderPort` whose runner contract is PR #20's providerWorker: argv `--listener-fd 3 --admission-fd 4 --owner-library-fd 5 --metadata-fd 6`, using `winter_provider_*` in `linux-session-owner.so`; admission is one SOCK_SEQPACKET message `I` plus one SCM_RIGHTS pidfd from root.

Order, once the supervisor reports ready:
1. Take the conversation items PID 1 already holds; exactly one conversation of the host-query-v1 profile is served, any other set is left unserved (`standin-unsupported-set`).
2. Write `/run/winter/standin/items.json` (root, 0400) and run the prepare script as root with `python3 -I -S -B`. It writes `metadata.json` (root, 0444, exclusive create) only if the conversation's selection IS the reserved `winter-standin` selection. A conversation naming any real provider is refused (exit 2, fixed code), so canned text can never answer a real model's call.
3. Bind `provider.sock` in `/run/winter/control/<sid>/` (root:runtimeUid, 0750, created by the supervisor and refused if it already exists). A connection from the runtime queues there.
4. Locate the runtime process of that uid and open a pidfd. More than one candidate, or a change while it is examined, is a refusal.
5. Start the worker as uid 65534 (outside the host range 1000..65533) with no new privileges, passing the listener, the admission socket, the owner library and the metadata. Deliver the pidfd over the admission socket.
6. The worker is never restarted: a restart would hand the runtime two more answers, and the stand-in's contract is exactly two per conversation.
7. Every failure leaves the guest running and the provider absent, so a model call fails at the socket and reaches nothing else. Drain stops the worker.

The stand-in image has no NIC, vsock or network of any kind; the new sockets are filesystem sockets under `/run/winter`.

## 5. Stub limits

Two answers per conversation, text only, no tool calls, one fixed selection (`winter-standin/scripted`, protocol openai-responses). It tests the host path (admission, session, UI, approvals around the runtime), not a model. It says "No model was contacted" in its own text.

## 6. Pin separation: unselectable in production (O13)

Closed in four independent ways, each held by a test:
1. No production source names it. `packages/core/test/cowork/guest-standin-unselectable.test.ts` scans the daemon, protocol, CLI, the Swift host and launcher, the workflows and the embed scripts for any stand-in token: there is nothing to call, flag or configure.
2. The files that do name it are an exact allow-list; a new reference fails the test and is a reviewed change.
3. The production image cannot contain it: no production pin file holds a stand-in digest (also `test_runtime_image_digest.py`), the build default is `production`, the hooks compile away, and no `WG_STANDIN` define exists in the production init source.
4. The launch digest has one source, the daemon's pin table. `guest-image-pin-separation.test.ts` shows the pin check refuses the stand-in digest, in both argument orders, for pin, update and re-pin, and that the worker recomputes the digest and refuses a mismatch (exit 71, `bad_scope`). No environment variable or setting chooses an image (`images.ts` and `native-wiring.ts` read none).
The test was mutation-checked (a token in `images.ts`, a flipped build default, a `WG_STANDIN` define in production init, a new file naming it, a stand-in value in `pins.json`): each is caught.
`provider.sock` is absent from the production image (the existing production scan excludes only the four stand-in sources, by exact name).

## 7. G1 checks and uncertainties (nothing here was run)

- Runtime locator criteria: matched by uid, executable and the 15-character comm; if the host-query runtime's real comm or exe differs, the locator never finds it and the failure is `FAILED` with the socket unanswered. First thing to read in the G1 log.
- `.control` visibility: whether the runtime sees `/run/winter/control/<sid>/provider.sock` under its mount namespace.
- Ordering: the runtime may connect before the worker is started; the queue absorbs that, but the supervisor's own readiness timeout is not measured against the locator's 180 s window.
- uid 65534 for the worker: the SDK's own check that the worker uid differs from the runtime uid is relied on, not re-tested.
- Whether the host-query runtime sends a meta message 0. The stub currently requires it; if G1 shows it does not, the stub relaxes `isMeta` for the reserved selection only.
- The Linux-only tests (`test_standin_linux.py`, `standin_linux_tool.c`, `fake_worker.c`) are cross-compiled clean for musl and glibc and have never run. CI is their first run.

## 8. NEEDS FROM OTHER LANE (runtime-sdk, not edited here)

A reserved `winter-standin` selection that only the stub accepts; empty system/user markers allowed only for it; `isMeta` relaxed only if G1 shows no meta message 0. The exact diff was sent to the runtime-sdk lane. The runner contract depends on PR #20's `providerWorker` and `parseMetadata`.

## 9. Docs owed

The stand-in image's build step (kernel plus overlay, one more workflow job) and its run approval are not written; they follow the production image run, and nothing here is built.
