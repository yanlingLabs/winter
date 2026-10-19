# doctor restore keeps the raw evidence; large peer-message bodies are erased

Two fixes from the review of the main landing (areas: `runtime-state/doctor.ts`, `cowork/peer-inbox-sqlite.ts`).

## 1. `doctor restore-backup` keeps the RAW pre-restore copy

Problem: when the current store could not be opened by this build, the pre-restore copy was byte-copied, then ALWAYS scrubbed
(a VACUUM). On an index-corrupted store that replaced the evidence with a rebuilt, smaller, healthy-looking file
(606,208 to 536,576 bytes in the review's fixture) that the message still called "the replaced file".

Now: the raw byte copy (plus `-wal`/`-shm`) is taken first and is the pre-restore copy. A working copy is inspected READ-ONLY.
Only if it holds an owed peer-message BODY (`cowork_peer_inbox.body IS NOT NULL`) is it scrubbed, and the scrubbed working copy
is promoted over the snapshot by the same atomic rename as before; the message then says "a rebuilt copy of the replaced file,
without its owed Cowork peer messages (the original bytes held them and were not kept)". With no owed body (every user today:
the inbox is unwired) the copy stays byte-identical and the message says "the replaced file". Retained terminal records hold no
body and do not trigger a scrub. If the copy cannot be inspected or scrubbed, the owner decision of 2026-10-18 stands: the raw
copy is kept byte-for-byte, the restore runs, and the warning names the path.

Tests: a corrupted fixture (index root page overwritten, `quick_check` not ok) restores with the saved copy byte-identical; the
same with only terminal records; the same with an owed body that cannot be scrubbed (raw kept, warning); and the existing
scrubbed-copy tests now expect the "rebuilt copy" wording.

## 2. Large bodies are erased completely

Problem: the pinned `secure_delete = FAST` zeroes only what is cheap to zero. The overflow pages of a body larger than a page
are not, so the tail of a 20 KB body survived a delete (the earlier test passed only because its marker sat in the first 4 KB).
Re-measured here: an `UPDATE` that rewrites a large row also strands the old overflow chain, not only the final delete.

Fix and choice: the store runs every `update`, the open-time sweep and `purgeWorkspace` under `PRAGMA secure_delete = ON` for its
own connection, scoped (set before, restored after). I chose scoped ON over a zero-overwrite (`UPDATE ... SET body = zeroblob(...)`)
because the overwrite would itself be an UPDATE that may re-allocate pages instead of writing in place, while ON zeroes every
freed page by construction, including the chains freed by offer and block rewrites. It is not global (no other table pays for
it), and `runtime-state/db.ts` is untouched (its FAST pin stays as the default for every other handle).

Tests: a 40 KB body with a marker in its last page is absent from the main file and the WAL after the delivery path (including
size-changing offer and block rewrites) and a TRUNCATE checkpoint; the same for a recipient workspace purge, a refusal, and the
open-time sweep; the pragma is restored to FAST afterwards.

Known point (unchanged): until a checkpoint the WAL still holds older frames of the body; nothing here adds checkpoint calls.
