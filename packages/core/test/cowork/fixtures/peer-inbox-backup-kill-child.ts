// Child for the backup kill test in peer-inbox-sqlite.test.ts: takes backups in a loop until SIGKILL. Synthetic data only.
import { openRuntimeStateDb } from "../../../src/runtime-state/db";
import { SqlitePeerInboxStore } from "../../../src/cowork/peer-inbox-sqlite";

const [home, dir] = [process.argv[2]!, process.argv[3]!];
const rs = openRuntimeStateDb(home);
const store = new SqlitePeerInboxStore(rs);
// Preload in ONE transaction (a large database makes the window between VACUUM INTO and the exclusion wide).
rs.db.transaction(() => {
  for (let n = 1; n <= 2_000; n++) {
    const body = Buffer.from(`PEER-BODY-MARKER-kill-${n}-` + "x".repeat(4_000));
    rs.db.run("INSERT INTO cowork_peer_inbox(receipt_id,sender_session_id,sender_incarnation,send_id,recipient_session_id,digest,size,body,sequence,state,attempts,accepted_at,updated_at,version) VALUES(?,'s_a','inc-1',?,'s_r',?,?,?,?,'accepted',0,1,1,1)", [`r${n}`, `m${n}`, "d".repeat(64), body.length, body, n]);
  }
})();
void store;
console.log("ready");
for (let n = 1; ; n++) { rs.backup(dir); console.log(`done ${n}`); }
