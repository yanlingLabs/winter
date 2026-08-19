# Security Policy

Norma runs an AI agent with real access to a real Mac — the filesystem, the shell, the screen, the
keyboard, a browser, and a direct link to the owner's phone. We take reports about that surface
seriously.

## Supported versions

Only the **latest release** is supported. Norma auto-updates through Sparkle, so users are normally
within one version of `main`. Fixes ship in a new release rather than as patches to older ones.

| Version | Supported |
| --- | --- |
| Latest [release](https://github.com/yanlingLabs/norma/releases/latest) | ✅ |
| Anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue, discussion, or pull request for a security problem.**

Report it privately through GitHub:

**[→ Report a vulnerability](https://github.com/yanlingLabs/norma/security/advisories/new)**

(Repository → *Security* → *Advisories* → *Report a vulnerability*.)

Helpful things to include:

- Norma version (`norma --version`) and macOS version
- Which surface is affected — daemon, CLI, Mac app, remote/phone transport, a plugin
- What an attacker gains, and what access they need to start with
- Reproduction steps, or a proof of concept

What to expect:

- **Acknowledgement within 5 days.**
- An assessment and a rough fix timeline once we've reproduced it.
- Credit in the advisory and release notes, unless you'd rather stay anonymous.
- Please give us a reasonable window to ship a fix before disclosing publicly. We'll tell you when
  the fix is out.

This is a small project without a bug bounty. We can offer a fast fix and public credit.

## Scope

These are in scope and genuinely interesting to us:

- **Sandbox escape.** The agent's shell runs under a macOS seatbelt profile with an explicit
  writable set. Anything that writes outside it without consent — or that reaches `~/.norma`, which
  is denied to the agent unconditionally — is a real finding.
- **Approval bypass.** Norma's permission model is enforced in the daemon, not suggested in a
  prompt. Any path that performs a gated action (an out-of-root write, a dangerous-domain
  navigation, an unsandboxed command) without the policy that governs it is in scope.
- **Mode escape.** A tool reachable from a mode it isn't registered for — for example filesystem or
  shell access from Chat mode — is a vulnerability, not a quirk.
- **Daemon socket authentication.** The Unix socket at `~/.norma/run/core.sock` is token
  authenticated with roles. Anything that authenticates without a valid token, or that escalates
  from the `remote` or `plugin` role to `harness`/`admin`, is in scope.
- **The remote (phone) surface.** The remote role has a deliberately small method allowlist and a
  filtered event stream. A remote client reaching a method or an event type outside those
  allowlists — particularly raw model reasoning — is in scope.
- **Secret handling.** Any path that writes an API key, OAuth token, or provider `encrypted_content`
  to disk, a log, a session transcript the model can read, or an error message.
- **Transport.** The Mac↔phone link (iroh/QUIC, paired out of band). Anything that lets an unpaired
  party read, inject into, or hijack a session.
- **Update integrity.** Sparkle appcast/EdDSA signature handling, or anything that would let an
  attacker deliver a build.
- **Plugin isolation.** A plugin escaping the capabilities the user consented to.

### Out of scope

- **The agent doing what the user told it to do.** If a user grants `bypass` policy and the agent
  deletes their files, that's the tool working. The question we care about is whether a *gate* can
  be defeated, not whether a user can choose to remove one.
- **Prompt injection that stays inside the agent's granted permissions.** Content that steers the
  model is expected and mitigated by the permission model, not by trying to sanitize the web. A
  prompt-injection chain that reaches something the user *didn't* grant — that's the in-scope
  version, and we want it.
- Model output quality, hallucination, or cost.
- Findings that require an attacker to already have local code execution as the user, or physical
  access to an unlocked Mac.
- Issues in third-party dependencies with no Norma-specific exploit path — report those upstream.
- Missing hardening that isn't exploitable, from automated scanners with no proof of impact.
- Social engineering, and denial of service against your own machine.

## What Norma does on your behalf

Stated plainly, so you know what you're auditing:

- **Credentials never touch disk.** API keys and OAuth tokens live in the macOS Keychain
  (`Bun.secrets`, service `com.norma.core`).
- **Data stays local.** There is no Norma backend, account or telemetry. Model calls go to your
  provider; web fetching is performed locally; the phone connects to your Mac directly and
  end-to-end encrypted. When a direct path can't be established, the connection relays through an
  iroh relay we operate (`infra/relay/`) — it forwards ciphertext only, and terminates nothing.
- **Shell commands are sandboxed** under a seatbelt profile with a per-session writable set. So are
  the model-authored workflow scripts, which run in a separate confined subprocess.
- **Reads are unrestricted by design** — `read`/`glob`/`grep`/`ls` have no path fence. That is a
  deliberate decision, matching what the user themselves can read. The single denial is Norma's own
  runtime/credential directory.
- **Every release is signed and notarized by Apple**, and every update is EdDSA-signed and verified
  by Sparkle before it installs.
