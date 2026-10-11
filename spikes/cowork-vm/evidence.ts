// Required security properties, independent of the fixture's claimed check count.
const COMMON = ["identity", "group_identity", "nonroot", "pid_namespace", "mount_namespace", "no_new_privs", "zero_effective_caps", "zero_bounding_caps", "syscall_filter_installed", "control_view_hidden", "sdk_view_hidden", "supervisor_executable_hidden", "supervisor_process_hidden", "sanitized_environment", "inherited_fd_closed", "instructions_direct", "instructions_indirect", "instructions_chmod", "instructions_unlink", "instruction_parent_rename", "workspace_parent_rename", "control_direct", "sdk_metadata_direct", "instructions_symlink", "instructions_hardlink", "control_symlink", "instructions_replace", "instruction_alias_create", "root_write", "syscall_vsock", "syscall_mount", "syscall_ptrace", "syscall_unshare"];
const AUTO = ["source_write", "memory_write", "source_instruction_alias", "repository_instruction_write"];
const PLAN = ["source_read", "source_direct", "source_indirect", "source_symlink", "source_rename", "source_unlink", "source_create", "source_parent_rename", "source_chmod", "memory_direct", "memory_rename", "source_scratch_alias"];

export function validateConfinement(result: Record<string, unknown>) {
  if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) throw new Error(`confinement incomplete: exit=${result.exitCode}, truncated=${result.stdoutTruncated || result.stderrTruncated}`);
  const lines = String(result.stdout).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  if (lines.some(line => line.status === "fail" || (line.status === "unsupported" && !(line.kind === "observation" && line.id === "landlock_abi" && line.required === false)))) throw new Error("guest reported failed/unsupported assertion");
  const suites = lines.filter(line => line.kind === "summary" && line.id === "guest_suite");
  if (suites.length !== 1 || suites[0].status !== "pass" || suites[0].exitCode !== 0) throw new Error("missing successful guest suite summary");
  for (const [policy, uid] of [["auto", 10001], ["auto", 10002], ["plan", 10001]]) {
    const summaries = lines.filter(line => line.kind === "summary" && line.policy === policy && line.uid === uid);
    const checks = lines.filter(line => line.kind === "check" && line.policy === policy && line.uid === uid);
    const ids = new Set(checks.map(row => row.id));
    if ([...COMMON, ...(policy === "auto" ? AUTO : PLAN)].some(id => !ids.has(id))) throw new Error("required security evidence missing");
    if (checks.some(row => row.status !== "pass") || new Set(checks.map(row => row.id)).size !== checks.length) throw new Error("invalid or duplicated check evidence");
    if (summaries.length !== 1 || summaries[0].status !== "pass" || summaries[0].failures !== 0 || !(summaries[0].checks > 0) || summaries[0].checks !== checks.length) throw new Error(`missing successful ${policy}/${uid} tool summary`);
  }
  return lines;
}

/** Observations, not an automatic reclamation or production-readiness verdict. */
export function memoryObservation(report: { newBackingServiceCandidates?: { pid: number }[]; samples?: any[] }) {
  const candidates = report.newBackingServiceCandidates ?? [];
  const unknown = { backingFootprintDecreaseObserved: null, reclaimVerified: false, reason: "missing or ambiguous backing-service measurements" };
  if (candidates.length !== 1) return unknown;
  const pid = candidates[0]!.pid;
  const value = (sample: any): number | undefined => {
    const lines = sample?.footprint?.find((row: any) => row.pid === pid)?.summary ?? [];
    for (const line of lines) {
      const match = String(line).match(/^\s*phys_footprint:\s*([\d.]+)\s*(KB|MB|GB)\s*$/);
      if (match) return Number(match[1]) * (match[2] === "GB" ? 1024 : match[2] === "KB" ? 1 / 1024 : 1);
    }
  };
  const samples = report.samples ?? [];
  const before = value(samples.find(row => row.label === "freed-without-balloon"));
  const after = samples.filter(row => /^balloon-\d+$/.test(row.label)).map(value);
  if (before === undefined || after.length < 2 || after.some(row => row === undefined)) return unknown;
  const values = after as number[];
  return {
    backingPid: pid, beforeFootprintMB: before, afterFootprintMB: values,
    backingFootprintDecreaseObserved: values.every(row => before - row >= 16),
    thresholdMB: 16, reclaimVerified: false,
    reason: "Compare sustained owned footprint, guest compliance, compaction and host compression/swap; this metric alone is not full gate-1 proof.",
  };
}
