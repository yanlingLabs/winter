# Cowork content-out: feature-branch publish and the `.winterworkspace` export

Status: source only, behind ports production does not supply. Cowork stays unavailable: `session.create {mode: "cowork"}` still answers `unsupported_topology`, no RPC, setting or door is added, and every verb below refuses `integration_unavailable` or has no caller until the owner approves the flip.

Stacked on the session-door spine (PR #88, which defines `cowork/session-ports.ts`). Revised after review of ddf0234d: the fixes are listed in section 6.

## 1. Publishing a feature branch

### What exists, and what this adds

`cowork/git/*` already holds the pieces of a host-side publication boundary: `CoworkGitPublicationBroker` (single-ref, full SHA-1 v2 bundle, strict `fsck`, exact-lease push through an injected transport), `CurrentCoworkPublicationAuthority`, `CanonicalPublicationJournal` (claims, receipts and outbox events in one transaction), `IsolatedGitExecutor` (fixed argv, scrubbed environment) and `checkPackBudget`. Nothing composed them for a session, and nothing said how the commits reach the host.

`git/publish-service.ts` composes them; `git/publish-intake.ts` is the N2 transport. Neither loosens a guard: the broker keeps its `isolatedFixture` requirement and its always-false `availability()`.

### How the commits get from the guest to the host in N2

N2 has no virtio-fs, no vsock and no guest network (design note G1/G11, `docs/cowork-native-worker.md` section 8). The one channel is the guest file channel, and it is **host-initiated**: the host asks, the guest answers bounded bytes. So:

1. The guest-side publish step writes a **full** git bundle (no prerequisite lines, one ref) to `/…/.winter-publish/<requestId>.bundle` in the session's location. The host, not the guest, chooses that path: it is derived from the request id alone (`publishBundlePath`).
2. The host pulls it with `stat` and sequential `readRange` calls (256 KiB chunks), bound to the workspace and session from the session's binding, the incarnation the host believes is running, and the **current** canonical source revision. The size budget (8 MiB, the broker's own) is judged from `stat` before a byte is read. Reads pin the generation token; offsets must be contiguous; every reply is exactly as long as asked (so the number of calls is fixed by the size and a one-byte-at-a-time guest is refused at the first short reply); EOF must fall exactly at the stat'ed size; a closing `stat` must show the same generation. Any change is `bundle_stale`.
3. The bytes go to the broker, which re-verifies everything (header equals the named ref and new OID, pack budget, `unbundle`, object budget, strict `fsck`, commit type, ancestry for an update, an exact lease).
4. The push is the injected `PublicationTransport`, on the host, with host-held credentials. The guest never sees a remote, a URL or a token. Nothing in the new modules opens a socket or spawns a process (a pin test checks it).

The intake depends on the file channel through a structural port (`stat`, `readRange`) that the real `CoworkGuestFileClient` satisfies (proved in `publish-service.test.ts` by type and by running the real client). It does not import `guest-file-channel.ts`, whose own pin forbids that.

### Remote push is host-side only

The spec allows it: "Keep provider/Git credentials on the host", "a host Git smart-HTTP gateway that validates actual ref updates", and "No reusable Git token or unrestricted credential helper is passed to guest Git". The bundle path is a deliberate N2 deviation from the specified receive-pack gateway: with no network there is no endpoint to put one on. Recommendation: keep bundles for N2 and add the receive-pack gateway when a host-owned network endpoint exists. The credential-owning `PublicationTransport` (GitHub account and repository selection, Keychain storage, refresh and revocation) remains new product work and is a port here.

### What the service does

- Derives the workspace from the session's binding (never from the request), reads the current source and publication revisions, refuses an archived or plan-mode conversation before touching the guest.
- Budgets: one publish at a time per workspace (`publication_busy`), a rolling attempt cap per workspace (`publication_budget`, in memory, reset by a restart), the 8 MiB bundle cap.
- Claims, journal and events are the existing journal's: a replayed request id returns the stored receipt and never pushes twice; the outbox carries `prepared`, `dispatched` and the terminal status.
- `status()` reads a prior receipt and is scoped to the principal and the session's workspace. `recover()` retires an unsent preparation of a dead host owner and needs the host's termination proof.
- Production builds it as `createCoworkPublishService(undefined)`, which refuses every verb.

### What stays out

Read-side git (clone and fetch into the guest) has no caller: it needs a guest-inbound bytes channel that does not exist. `read-transport.ts` and its siblings stay unwired. Per the design note, "no guest Git transport exists in `host-query-v1` and no clone can run", so no source can honestly be `ready` in N2 and the publish path has no live caller from a session yet.

## 2. The `.winterworkspace` bundle

### Format

A folder (owner decision 2026-10-16), plaintext:

```
<name>.winterworkspace/
  manifest.json      the recorded manifest, byte for byte (its sha256 is cowork_exports.manifest_digest)
  integrity.json     canonical JSON: exportId, manifestDigest, {path, bytes, sha256} for every other file, sorted bytewise
  data.ext4  env.ext4
  shared/{instructions,memory,outputs}/**    regular files only
```

The contents are a whitelist. Nothing else in the workspace folder or the Winter home is read into a bundle: no authority database, bookmark, credential or Keychain item. The manifest stays the closed v1 shape; the per-file digests live in the sidecar index.

### Writer (`export-writer.ts`)

`prepare` (records the generation) → copy into a sibling `.<uuid>.partial` folder → two-pass shared snapshot → manifest bytes → index → fsync → `complete()` (refuses when canonical state moved) → exclusive atomic rename (`renamex_np` `RENAME_EXCL`) to the final name. Any failure marks the generation failed and removes only its own partial folder.

- **Pinned descriptors.** Images are read only through `CoworkExportImageDoor`, a read-only opener of a stopped, unowned workspace's image on a descriptor the volume layer has verified (identity, `0600`, one link, recorded size, sticky exclusion). Production supplies none (section 4).
- **Clone, else sparse.** `fclonefileat` from the pinned descriptor where the volume allows; otherwise a sparse copy that skips zero pages and sets the final length with a positioned write (no `ftruncate`). A clone carries the source's xattrs, which would give the export the image's sticky Time Machine exclusion and defeat "export is the backup path", so every xattr is stripped from the copy and a test asserts it.
- **Consistency.** A change stamp of the pinned descriptor (identity, size, mtime and ctime in nanoseconds) before and after the copy, and a stamp of the canonical rows (workspace state, power, incarnation, lease epoch, both volumes' owner, last stop id, identity) before and after the whole export. `complete()` alone only re-derives the manifest, which a claim, run and release would not change.
- **Shared files.** No-follow opens; symlinks, hard links, FIFOs, sockets and devices refuse the whole export (`bundle_unsafe`); a second full pass re-lists and re-hashes the source and must agree, else `generation_stale`.
- **Destination.** An existing absolute folder, owned by the user, not group or world writable, outside Cowork's own storage tree; a plain name. An existing target is never overwritten or merged.
- **Cancellation and the event loop.** Copies and hashes yield to the loop every 16 MiB and honour an `AbortSignal`.
- **Stuck generation.** A crash after `prepare` leaves `export_in_progress` for ever. `abandonInterrupted()` fails it, only when this exporter is not the one working on it, and needs the lifecycle proof. (`CoworkExports.inFlight()` is the one read added to `exports.ts`.)

### Restore (`restore-bundle.ts`)

An in-place replacement of a stopped workspace's two images by an earlier verified generation of the **same** workspace in the **same** home. It is neither a cross-home import (`validateImport` only passes for the same home, an existing workspace and identical volume ids and UUIDs, and the host protocol forbids copied ids from creating a second owner) nor the `workspace.restore` un-archive operation.

Conflict rules, each with a failing test when removed:

1. Verify the whole bundle first (closed top-level set, only regular files, canonical index, every path whitelisted, the file set exactly the index's, every sha256).
2. `validateImport` must pass, and is judged again after the confirmation, which awaits a human.
3. An older generation than the latest completed one needs `allowOlderGeneration`.
4. The confirmation port must answer exactly `true`; there is no default. A missing live image is reported to it.
5. Nothing is deleted. Replaced images move to `restore-aside-<exportId>/`; the bundle's shared files are placed in `restored-shared-<exportId>/` and **never merged** into the live shared folders, whose file identities are recorded by the instruction and output layers.
6. The replacement is an atomic exchange (`RENAME_SWAP`), after the staged image carries the sticky exclusion, verified.
7. The identity is re-recorded through a port. A crash or failure between the exchange and the record leaves the recorded identity different from the file, which `CoworkVolumes` already refuses as `recovery_required`: it fails closed, and the old images stay in the staging folder.

### What the filesystem journal revealed

`CoworkVolumes.record()` binds the **ready history** in `filesystem_journal_json` to the file's identity (`historyTarget.identity`). Re-recording `device`/`inode` alone is not enough: every volume call fails until the history is rebound or the image is re-probed. The test-side identity port rebinds the identity inside the journal so the real volume layer accepts the restored files. Recommendation for the real method: **do not rebind**. A restored image is untrusted state on this boot; force a fresh full read-only probe (`prepareFilesystems` in `full-read-only` mode) and keep it unlaunchable until that confirms.

## 3. What the integrity index is not

It detects corruption and truncation. It does not detect a deliberate rewrite of the whole bundle, because nothing in the database binds the index. A `content_digest` column on `cowork_exports` (the digest of `integrity.json`, written by `complete()` and compared by `validateImport`) would close that. It needs a migration (DOOR owns migrations).

## 4. Seams production must supply (not built here)

- `CoworkExportImageDoor` — a read-only, descriptor-pinned opener on `CoworkVolumes`: like `open()` but requiring **no** owner, state `retained` or `archived`, power `stopped`, an `"export"` authority action, `O_RDONLY` (`openImageAt` currently hard-codes `O_RDWR`), and without burning `format_eligible`.
- `CoworkRestoreIdentityPort` — `CoworkVolumes.reidentifyRestored(...)`: stopped and unowned, compare-and-swap on the old identity, update `device/inode/uid/mode`, and settle the filesystem history as described above.
- `CoworkRestoreApproval` — an ApprovalBroker card (APPROVALS owns the bridge) showing the summary the restorer passes: workspace, generation, whether it is the latest, each image's presence and whether it is the recorded file, the shared file count and where the old images are kept.
- Publish ports — `PublicationTransport` (host-side GitHub with Keychain credentials), the host owner incarnation and termination proof for the journal, the live-guest locator, and the guest-side step that writes the full bundle.

## 5. Gaps and recommendations

1. **Index not bound in the database** (section 3). Add `content_digest`.
2. **Output directory names carry session ids.** `shared/outputs/<sessionId>/…` names are in the bundle's paths while the manifest deliberately omits session ids. Owner decision: keep (restore needs the layout) or map them to opaque ids at export and back at restore.
3. **Empty directories are not preserved** (only regular files are listed). Recreate the three roots on restore, or record directories in the index.
4. **Shared restore is a side folder, not in place** (rule 5). In-place needs the instruction and output layers to expose an adopt step.
5. **Cross-home transfer** needs its own authorized operation (explicit relocation versus clone).
6. **Rate budget is in memory.** A durable window needs a table (DOOR).
7. **Receive-pack gateway** replaces the bundle path once a network endpoint exists.

## 6. Review fixes (after ddf0234d was rejected)

- **Restore holds the workspace.** `validateImport` and the live-image inspection are repeated synchronously right before the first exchange, and the exchanges and identity records run with no `await` between them. The lock is a module-level set keyed by home and workspace, so two restorer instances cannot both run (a reviewer probe had both succeed). Volume owner NEED: an exclusive restore claim, so that `claim()` refuses from the first exchange until the identity is re-recorded (today the window is closed only inside this process).
- **A rewritten bundle is refused.** Restore requires the digest of `integrity.json` to equal the one the database bound to that generation (`CoworkExportContentBinding`). Until DOOR adds the columns nothing can supply it, so `createCoworkWorkspaceRestorer(undefined)`, the only shape production can build, refuses every restore (`integration_unavailable`), and a ports object without the binding cannot be built.
- **Authority and sizes before hashing.** `inspectBundle` reads structure only; `validateImport`, the binding and the manifest's capacities are judged before `hashBundleFiles` reads a byte of an image.
- **No phantom `complete` generation.** The writer renames the bundle into place first and calls `complete()` after; a refusal there takes the bundle back and marks the generation failed. A named target that already exists is refused before a generation is prepared.
- **Descriptor-relative walks.** The shared tree, the bundle root and every file under them are walked and opened with `openat` on held directory descriptors and no-follow, so a swapped intermediate directory cannot redirect them. Listing re-opens `.` of the held descriptor (a `dup` shares the read offset and would list nothing the second time).
- **Destination ACL.** A destination whose ACL allows writes, adding files or deleting children is refused (`acl_get_file`/`acl_to_text`), whatever its mode bits.
- **Raw xattr names.** Names are passed back to `fremovexattr` as the raw bytes `flistxattr` returned, and `hasExtendedAttributes` is re-checked after the strip. APFS refuses to create a non-UTF-8 name, so the splitter is tested directly.
- **Opaque output ids (gap 3, decided).** The bundle names each session folder `s<n>` and each file directly under `outputs/` `f/<name>`; the reverse table is kept in the `cowork_exports` row. Restore maps back and refuses an id the record does not hold.
- **Pins.** Imports are resolved to files (extensionless, `.js`, dynamic, `require`, re-export, multi-line); the exact `dlopen` symbol table of `export-io.ts` is pinned; the `cowork/git/` exemption is replaced by the exact internal edge list.

### NEEDS FROM DOOR (migration), definitions

```sql
ALTER TABLE cowork_exports ADD COLUMN content_digest TEXT CHECK(content_digest IS NULL OR length(content_digest)=64);
ALTER TABLE cowork_exports ADD COLUMN output_map_json TEXT CHECK(output_map_json IS NULL OR json_valid(output_map_json));
```

`CoworkExportContentBinding.record(exportId, { contentDigest, outputIds })` writes both columns on the prepared row (before `complete()`), and `read(exportId)` returns them (null while NULL). `output_map_json` is `{ "s1": "<sessionId>", ... }`.
