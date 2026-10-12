# Code-mode image input

*Read this before touching image attachments, `session.stageImage`, or `session.send`/`steer`'s `images`. Paths are under `packages/core/src/` unless stated.*

## Contract

- The MODEL gets a PATH; `text` keeps `[Image #n]` and the stored `user_message` carries `images: [{n, path}]` (`packages/protocol/src/events.ts`: 1–20 entries, path ≤ 4096 chars).
- Paths are RAW (never downscaled/re-encoded/copied by default): the runtime's Read tool prepares images itself (`tools/image-prep`: ≤ `IMAGE_MAX_INPUT_BYTES` 64 MiB, 1568 px long edge).
- **Read picks its reader by the EXTENSION the model types** (`IMAGE_MIME` in its `tools/impl/read.ts`; lowercased `extname`, no symlink followed), never by content — any other extension reads as binary text. `IMAGE_FILE_EXTENSIONS` (`packages/protocol/src/methods.ts`, nine entries) must equal that table.
- `modelTextOf` (`sessions/model-text.ts`) is the ONE substitution site: push + held queue (`runtime-sdk/winter-session.ts`), resume replay (`unconsumedUserMessages`), `runtime-sdk/import-legacy.ts`, the compactor. Everything else reads `text` as is.
- `IMAGE_PATH_GUIDANCE` (`agent/context.ts`, pushed by `ContextAssembler.assemble` whenever `basePromptOverride` is unset — never chat or a coordinator) is a static line (no session id or path, so the cached prefix never moves): a `winter-session-…/images/` path is a staged copy the model may move, any other is the user's file, read/copy only.

## Attaching

- Code sessions only: Mac `composerImageIntake` (`apple/Winter/Sources/FieldKit/FieldStateAdapter.swift`, fail-closed without a code row); TUI ctrl+v or a pasted path (`imagePathFromPaste`, `packages/cli/src/tui/images.ts`, listed extensions only). A row with `supportsImages: false` refuses at attach with exactly `The selected model doesn't support images`.
- **FILE**: the ORIGINAL absolute path when its name ends in `IMAGE_FILE_EXTENSIONS` AND its first 12 bytes are an image — never copied, staged or read further; > `IMAGE_FILE_MAX_BYTES` (64 MiB) → `IMAGE_FILE_TOO_LARGE_MESSAGE`; a non-image hands the paste back. Any OTHER image file on the Mac is read in the app and staged as DATA (`composerStagedImage`, `apple/Winter/Sources/Field/ComposerImages.swift`).
- **DATA** (clipboard): staged as RAW bytes at submit through `session.stageImage {sessionId, mediaType, dataBase64} → {path, imagesOnSend}` (a refusal sends nothing); only one over `STAGE_IMAGE_MAX_BYTES` is downscaled at attach, alone — `IMAGE_ATTACH_MAX_LONG_EDGE` 1568, PNG/JPEG kept, then JPEG 0.85 → 0.5, else `IMAGE_TOO_LARGE_MESSAGE`.
- Skew: `session.send`'s schema strips unknown keys. Send `images` only when every stage said `imagesOnSend: true` AND hello announced `features: ["image-original-paths"]` (`DAEMON_FEATURE_IMAGE_ORIGINAL_PATHS`, `WinterClient.supportsOriginalImagePaths`); else substitute the paths into the text — as a child view's `thread.send` always does.
- A refused send keeps the draft: TUI `DraftImages.snapshot`/`restore` hand the text back, a number reused meanwhile rewritten to a FRESH one; the Mac keeps the attachments and shows the daemon's sentence. On `image_file_unreadable` for a FILE the Mac (`composerSend`, with the drag's access) reads, stages and resends once per file.
- Live drill not yet run: a first drag from Desktop/Documents/Downloads may raise a TCC prompt — check which name it shows (Winter or `winter-core`) and that a denial falls back.

## Validation on send/steer

`checkedImageRefs` (`ipc/server.ts`) → `validateImageRefs` (`agent/stage-image.ts`), BEFORE any resume or append; no refusal echoes a path.

- Harness role only → `image_reference_invalid`; non-code → `image_session_not_code`; the CURRENT model must accept images (`assertModelAcceptsImages`: `image_input_unsupported` / `image_session_no_model` — a FILE's only door); `n` unique, in `text`, ≤ 20.
- Classified by SHAPE. **Staged** = directly in THIS session's `images/`, named `image_<k>.<ext>`: held to the staging rules (regular non-symlink file, root derived as staging derives it, spelled as its realpath); failing them is refused, never re-judged as original. **Original** = anything else: absolute; no `UNSAFE_PATH_CHARS` (controls, bidi) or edge whitespace — refused, never stripped (`image_reference_invalid`); extension judged AS SPELLED else `image_type_unsupported`; its realpath TARGET a regular file on an `O_NONBLOCK|O_NOFOLLOW` fd, stored as spelled; not in Read's read-deny set (`readDeniedByRuntime`, reusing `sandboxConfigFor`'s `denyRead` + `protectedReadDenial` — [tool-surface](./tool-surface.md); never the whole home, `<home>/outputs/…` works; skipped without `winterHome`, i.e. tests); 12 header bytes an image (`sniffImageMediaType`) else `image_type_unsupported`; ≤ 64 MiB else `image_too_large`. Unresolvable/unopenable → `image_file_unreadable` with `data.n`. Else `image_reference_invalid`.
- `sync.push` refuses a `user_message` with `images` (`ipc/sync.ts`).

## `session.stageImage` (`ipc/server.ts` → `agent/stage-image.ts`)

- LOCAL only, code only, the same model backstop. Length first: `STAGE_IMAGE_B64_MAX_LENGTH` (`NDJSON_MAX_LINE_BYTES` 8 MiB − `STAGE_IMAGE_LINE_HEADROOM_BYTES` 256 KiB) → `image_too_large` before decoding; decoded cap `STAGE_IMAGE_MAX_BYTES` = 6,094,848; bad base64 `image_data_invalid`; magic bytes decide (`STAGE_IMAGE_MEDIA_TYPES`) — unknown `image_type_unsupported`, declared mismatch `image_type_mismatch`; no pixel limit.
- Written UNCHANGED to `sessionTmpDir(sessionId)/images/image_<k>.<ext>`. The dir is a sandbox WRITABLE root the shell can swap, so: its own name is never resolved (root = `realpath(parent)` + basename); it and `images/` must be real directories; `O_CREAT|O_EXCL|O_NOFOLLOW` 0600; bytes only after a realpath + inode proof, else `image_stage_failed`; never logged.
- Swift budgets the ENCODED line (`JSONEncoder` escapes `/`): `WinterClient.request` uses `.withoutEscapingSlashes` and throws `RpcError` -6 past `maxRequestLineBytes`; `stageImage` refuses past `stageImageMaxBase64Length` before encoding.
