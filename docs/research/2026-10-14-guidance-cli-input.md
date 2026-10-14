# Shared-guidance CLI inputs

The production `workspace instructions update` CLI accepts exactly one of:

- `--content TEXT` for the existing inline form;
- `--content-file FILE` for a regular file, resolved relative to the caller's cwd;
- `--stdin` for raw bytes read until EOF.

File/stdin modes keep guidance text out of process argv. Resolved content is never
rewritten into argv or printed in input errors. The input is bounded by the existing
protocol limit of 65536 UTF-8 bytes, preserves BOM/text bytes (CRLF included) and
rejects invalid UTF-8 or NUL. File type/size and actual descriptor reads are checked
(a symlink to a regular file reads; FIFOs, devices and directories, directly or through
a link, refuse); stdin capture uses a fixed-size buffer. Source selection and all
revision/digest/request-ID/extra argument validation finish before any daemon connection.

```sh
winter workspace instructions update WORKSPACE --instruction-revision CURRENT_REVISION --digest CURRENT_SHA256 --request-id STABLE_REQUEST_ID --content-file ./WINTER.md
cat ./WINTER.md | winter workspace instructions update WORKSPACE --instruction-revision CURRENT_REVISION --digest CURRENT_SHA256 --request-id STABLE_REQUEST_ID --stdin
```

Revision and digest refer to the current canonical guidance being replaced, not the
new input. The CLI preserves the caller's explicit stable request ID and sends the
unchanged canonical `workspace.instructions.update` RPC. Replaying a different body
under that ID remains subject to the existing server conflict checks.

Empty input. A zero-byte `--stdin` or `--content-file` is refused with a fixed message:
a failed producer (`false | winter ... --stdin`, a missing build step that left an empty
file) would otherwise replace the guidance with nothing. `--allow-empty` (valid only with
`--stdin` or `--content-file`) makes the clear deliberate; `--content ""` remains the
inline way to clear. Whitespace-only input is content, not empty.

Diagnostics. When stdin is a terminal the CLI prints one line to stderr (reading
guidance from stdin; end with Ctrl-D) so a silent prompt is not mistaken for a hang; it
never echoes input. An unreadable `--content-file` reports a fixed message plus the errno
code only (for example `(ENOENT)`), never the path or any content.

This convenience does not create/provision a workspace, seed instructions, change
authority/availability or enable a guest runtime. Normal argv content and other CLI
commands retain their existing behavior.
