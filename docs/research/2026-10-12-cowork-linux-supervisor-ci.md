# Native Linux supervisor verification

SDK PR #5 at `39ba77ec` passed the actual guest tool service job on both native architectures in GitHub run [38240915881](https://github.com/yanlingLabs/winter-agent-sdk/actions/runs/38240915881). ARM64 job 114783008480 and x64 job 114783008810 each exercised the compiled actual SDK registry client through the unmodified Python service and native compartment launcher. Adjacent selected log lines retain architecture, page size, service result and protocol test count.

Both jobs passed Read/Edit/Write/Bash, distinct runtime UIDs, plan/read-only mounts, protected view exclusions, cancellation/revocation and descendant cleanup. All 11 framing/authority/FD protocol tests passed on each architecture. The admitted directory was renamed and its former pathname replaced before namespace construction; operations preserved that replacement and used the held directory identity.

The initial Linux failure was a real implementation defect: legacy bind mounting inherited directory descriptors after changing mount namespaces returned EINVAL. Cloning detached mount objects from those descriptors before unsharing and attaching the objects afterward fixes that sequence. Strict mount flags and source identity remain enforced; no unconfined fallback was introduced. Temporary diagnostics were removed before the successful final runs.

This proves the Linux process service, not a macOS VM launch, packaged immutable guest image, SDK conversation startup, provider broker, cold continuation or production availability. The broader PR suite and designated review are separate gates. No release or Winter SDK pin occurred.
