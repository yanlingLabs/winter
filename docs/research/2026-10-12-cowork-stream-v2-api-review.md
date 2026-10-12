# Guarded stream v2: ownership/API second opinion

Date: 2026-10-12. **Recommend the library-created socketpair API for v3 and no VM on v2.** Root accepted this direction during review. Preserve `020e1547` and its private-flag measurements as historical feasibility evidence. The v2 MMIO failure handling and scoped lifecycle wait are suitable to carry forward; correct the MMIO regression's ordering before claiming its intended cross-region coverage.

Reviewed v2 patch `0008-proposed-guarded-stream-reviewed-fixes.patch`, SHA-256 `43331eedec8e73f735830932b56c28cb3eb311f1c9bcbf3535f497063a369378`; composed diff `2c54f1a224d8d17be652e160d823c05b1b6bb8fc9da00f305b944a6d5eaac31b`, source `spikes/cowork-hvf/out/libkrun-stream-reclaim-v2`. No implementation files were edited.

## Choose endpoint ownership over private send ABI

The observed Darwin failure corrects my previous suggestion that public per-call `MSG_DONTWAIT` alone would resolve mutable-OFD blocking. In the pinned Apple XNU source, the capacity wait in `sosendcheck` checks socket `SS_NBIO` or private `MSG_NBIO`; public `MSG_DONTWAIT` alone does not satisfy that branch. The candidate's stronger full-buffer test was necessary and its rejected result must remain visible. [Pinned Apple `sosendcheck`](https://raw.githubusercontent.com/apple-oss-distributions/xnu/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/uipc_socket.c), [kernel-private flag definition](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/socket_private.h#L569)

An unnamed socketpair is a public interface. Apple's implementation creates two separate sockets and file objects and connects them. Returning the opposite endpoint does not give the caller an alias of the device endpoint's open-file description. Consequently, changing peer nonblocking/socket options need not change the privately retained device endpoint's nonblocking state. This is the relevant ownership improvement; duplicating a caller-supplied endpoint could not provide it. [Apple socketpair manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/socketpair.2.html), [pinned socketpair implementation](https://raw.githubusercontent.com/apple-oss-distributions/xnu/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/uipc_syscalls.c)

Prefer an explicit fixture-only create API, for example `krun_create_cowork_bootstrap_stream(ctx_id)`, returning an owned peer descriptor >=3 or a negative error. Its contract should be:

- Require the existing guarded-block opt-in and an unused, not-yet-started context. Create one unnamed AF_UNIX SOCK_STREAM pair internally; keep the device endpoint in Context/Device/Worker ownership. Reject duplicate creation without changing the existing stream.
- Set/check CLOEXEC, O_NONBLOCK and Darwin SO_NOSIGPIPE on the private device endpoint before publication. Retain public per-call flags as defense in depth; remove the private `MSG_NBIO` dependency. All internal device-end aliases must remain private and must never clear those settings.
- Return only the peer, with explicit caller-close ownership. There must be no C API to retrieve the device endpoint, replace it with a caller FD, change its status flags, or export it via generic descriptor passing. Make the old setter refuse; deprecation alone while still accepting arbitrary endpoints leaves the old failure path alive.
- On failure, close both newly owned endpoints and leave context state unchanged. Context destruction closes its endpoint copies; the caller still owns its returned peer. Peer shutdown/closure, withholding reads and malformed bytes may cause backpressure or terminal failure; they must not remove the device endpoint's nonblocking guarantee.
- Create/publish during trusted native-worker setup, before starting VM/device threads and any exec-capable untrusted work. CLOEXEC must be established before a descriptor is exposed; if creation cannot establish it atomically on the platform, the native launch contract must exclude concurrent fork/exec during that interval. Do not treat CLOEXEC as preventing fork inheritance or SCM_RIGHTS transfer.

This is more supportable than an OS-version-pinned private flag because it uses normal socket state under exclusive ownership and removes an unnecessary general FD-admission surface. It still needs a target-host full-buffer regression with **only public APIs/flags**. The design remains contingent on implementation and evidence; this review has not implemented it.

## Authority remains separate

Private ownership here is an API/lifecycle invariant, not isolation from hostile native code in the same process: such code can enumerate or manipulate the process's descriptors. The signed, hardened, sandboxed worker remains the process boundary. Ordinary Code command sandboxes are not part of this argument, consistent with the updated workspace policy.

The returned peer grants byte-stream access, not workspace, volume or key authority. Keep it in the admitted native worker/bridge, not a Core/Bun raw-key path. Any future interprocess transfer needs its own exact-process admission and closure rules. Guest packet parsing remains outside the credential daemon. Peer possession does not replace sealed launch identity, nonce/generation framing, a trusted guest receiver or authenticated key-release policy.

Reset still permits already-started bytes and retained socket backlog. The new API does not create exactly-once messages or erase stale data. Key/bootstrap work must separately choose a fresh connection per authorized generation or authenticated framing that rejects stale bytes. Same-process/running-guest plaintext and same-user availability residuals remain unchanged.

## v2 corrections reviewed

**MMIO implementation accepted within its scope.** Native `src/devices/src/virtio/mmio.rs:318–329` identifies the concrete GuardedConsole, handles activation error without the historical `.expect`, marks terminal access failure and sets FAILED after releasing the device lock. This closes the reviewed panic/poison route for that new device without silently changing historical device behavior. It does not add a production recovery or general block-reset guarantee.

**MMIO test needs correction.** `mmio.rs:1114–1130` writes queue configuration while status is INIT. `update_queue_field` at `:272–280` requires FEATURES_OK and therefore ignores those writes. The later status sequence `[1,3,11,15]` reaches activation with unready queues. The passing test proves unready-queue refusal/no poison; it does **not** prove its advertised descriptor table crossing two adjacent memory regions. For v3, first write statuses 1,3,11, configure and assert both queues, then write 15. Retain a separate unready case and assert no used-ring ACK and terminal notification in both cases. This is a test/evidence defect; the new error-handling branch itself is present.

**Scoped lifecycle timing accepted.** `src/utils/src/macos/epoll.rs:328–359` uses the requested finite timeout, preserves one absolute deadline across EINTR, and performs a readiness query even at zero timeout. `EventManager::run_cowork_lifecycle_timeout` dispatches those events; the actual libkrun loop chooses it while lifecycle work is pending. The generic historical wait remains unchanged. The former 0007 five-millisecond claim was invalid because its shim passed a fixed three-second timespec; do not inherit that timing claim.

The new shared `lifecycle_tick`, actual EventManager notify-before-finished test, short-TX/freeze/reset test and explicit RX limits address the prior review's named gaps. The event test retains old and staged ring pins, consumes the early notification, then advances after actual completion using the scoped timeout and shared tick. The short-write test observes a real short send and checks stream ordering/ACK behavior. These are no-VM lifecycle observations, not guest driver, encrypted I/O or RAM-return proof. No new lease/copy/pin/reset blocker was identified in the changed source.

## v3 evidence required before another VM

Exercise the actual public create API and prove: opt-in/duplicate/old-setter refusal; only the peer is returned; public flags alone keep private-end empty receive/full send nonblocking after peer-side flag changes; SIG_DFL closed-peer survival; exact descriptor closure on failure/context destruction; successful short-write continuation and reset; corrected MMIO cases; and the scoped EventManager deadline/lifecycle cases. Verify no private flag remains on the selected code path and freeze new source/patch hashes before review. Keep the existing deliberate in-`perform` block stall requirement and signed-worker sandbox compatibility gate distinct from these tests.

## Independent verification

Ran `python3 spikes/cowork-hvf/test_stream_v2.py` on frozen 020e1547: **71 test executions / 68 distinct tests passed**, and native `cargo check` passed. This includes the bounded helper child executions already defined by that no-VM harness. Preparation verified base/delta/composed hashes and mirror correspondence. The MMIO coverage limitation above still applies despite its passing status.

No VM, key fixture, pressure workload, live Winter state or Keychain operation ran. The preparer's ignored receipt and this report are the only intentional new outputs. The private-ABI candidate is not selected for production or the next VM; v3's create API remains unimplemented at this review boundary.
