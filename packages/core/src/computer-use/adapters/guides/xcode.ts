// The guide for Xcode (id `xcode@1`), shown with the app's extras block. Winter's own reviewed prose: every claim
// is about an extra Winter implements or a behaviour the ComputerV2 description already states — checked against the
// app's dictionary and, at the live gate, the app itself. A content change bumps the rev (`xcode@2`). ≤ 2,000 bytes.
export const XCODE_GUIDE = `Xcode's extras work on its open workspaces without bringing Xcode forward:
- schemes() lists each open workspace with its schemes and its active scheme;
- build() builds the front workspace's ACTIVE scheme for its active run destination (as Product › Build does), waits for it within the script's time, and returns its status (succeeded, failed, error occurred, cancelled, or still running) with the first build errors; { workspace: "Name" } picks another open workspace, { waitMs } waits less;
- buildStatus() reads the last build's result again later.
To build another scheme, the user (or you, in Xcode's scheme menu) must make it the active one first — build() never changes it. A long build: pass a larger timeoutMs to the script, or call buildStatus() in a later call.`;
