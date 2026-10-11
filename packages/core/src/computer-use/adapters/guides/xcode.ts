// The guide for Xcode (id `xcode@3`), shown with the app's extras block. Winter's own reviewed prose: every claim
// is about an extra Winter implements or a behaviour the ComputerV2 description already states — checked against the
// app's dictionary and, at the live gate, the app itself. A content change bumps the rev. ≤ 2,000 bytes.
export const XCODE_GUIDE = `Xcode's extras work without bringing Xcode forward, on the BOUND window's workspace unless you name another:
- schemes() lists each open workspace with its schemes and active scheme; bound: true marks the bound window's;
- build() builds the bound window's workspace — its ACTIVE scheme, for its active run destination, as Product › Build does — waits for it within the script's time, and returns its status (succeeded, failed, error occurred, cancelled, or still running) with the first build errors; { workspace: "Name" } builds another open workspace, { waitMs } waits less;
- buildStatus({ id }) reads that build's result again later (the id build() returned); without an id, the workspace's last result.
To build another scheme, it must be made the active one first (Xcode's scheme menu) — build() never changes it. A long build: pass a larger timeoutMs to the script, or call buildStatus({ id }) in a later call.`;
