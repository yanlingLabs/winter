# WinterKit

Swift bridge to the winter-core daemon: unix-socket NDJSON JSON-RPC client, typed method
wrappers, `AsyncStream<WinterEvent>` events with reconnect + resync-from-lastSeq.

- Transport: `UnixSocketTransport` (NWConnection, `NWEndpoint.unix`); default socket
  `$WINTER_HOME/run/core.sock` (`~/.winter/run/core.sock`).
- Auth: harness role token from the Keychain (service `com.winter.core`, account
  `harness-token` — the same item the CLI reads). First read prompts once; "Always Allow".
- Transient events: `assistant_delta` is broadcast-only (never persisted/replayed) and is
  exempt from seq dedupe — its `seq` is the server's lastSeq at broadcast time.

## winter-probe

Build: `swift build` → `.build/debug/winter-probe`

    winter-probe list
    winter-probe create global --cwd /path/to/project
    winter-probe attach s_xxxx            # streams; deltas render token-by-token
    winter-probe send s_xxxx "hello"      # from a second terminal
    # --token <t> / --socket <path> override Keychain / default socket

Phase-2a live gate: `winter resume <id> "<prompt>"` in terminal A with `winter-probe attach <id>`
in terminal B — B shows deltas token-by-token BEFORE turn_completed; `winter-probe send` from B
appears in A's session. See docs/superpowers/specs/2026-07-04-phase-2-orb-harness-design.md §5.
