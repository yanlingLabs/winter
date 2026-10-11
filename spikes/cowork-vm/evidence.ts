// Required security properties, independent of the fixture's claimed check count.
const COMMON = ["identity", "group_identity", "nonroot", "pid_namespace", "mount_namespace", "no_new_privs", "zero_effective_caps", "zero_permitted_caps", "zero_inheritable_caps", "zero_ambient_caps", "zero_bounding_caps", "syscall_filter_installed", "control_view_hidden", "sdk_view_hidden", "supervisor_executable_hidden", "supervisor_process_hidden", "sanitized_environment", "inherited_fd_closed", "instructions_direct", "instructions_indirect", "instructions_chmod", "instructions_unlink", "instruction_parent_rename", "workspace_parent_rename", "control_direct", "sdk_metadata_direct", "instructions_symlink", "instructions_hardlink", "control_symlink", "instructions_replace", "instruction_alias_create", "root_write", "syscall_vsock", "syscall_mount", "syscall_ptrace", "syscall_unshare"];
const AUTO = ["source_write", "memory_write", "source_instruction_alias", "repository_instruction_write"];
const HOST_SHARED = ["raw_host_ro_hidden", "raw_host_rw_hidden", "raw_virtiofs_hidden", "host_rw_writable_memory_read", ...["host-ro", "host-rw"].flatMap(backing => ["instructions_read", "memory_read", "instructions_write", "instructions_indirect", "instructions_unlink", "instructions_chmod", "instructions_symlink_setup", "instructions_symlink", "instructions_parent_rename", "memory_write", "memory_rename", "memory_chmod", "memory_create"].map(id => `${backing}_${id}`))];
const PLAN = ["source_read", "source_direct", "source_indirect", "source_symlink", "source_rename", "source_unlink", "source_create", "source_parent_rename", "source_chmod", "memory_direct", "memory_rename", "source_scratch_alias"];

const DENIAL_IDS = new Set([
  "instructions_direct", "instructions_indirect", "instructions_chmod", "instructions_unlink",
  "instruction_parent_rename", "workspace_parent_rename", "control_direct", "sdk_metadata_direct",
  "instructions_symlink", "instructions_hardlink", "control_symlink", "instructions_replace",
  "instruction_alias_create", "root_write", "source_instruction_alias", "source_direct",
  "source_indirect", "source_symlink", "source_rename", "source_unlink", "source_create",
  "source_parent_rename", "source_chmod", "memory_direct", "memory_rename", "source_scratch_alias",
  "shared_instruction_write", "protected_ancestor_rename", "plan_write", "plan_alias_write",
  "plan_create", "plan_unlink", "plan_rename", "plan_chmod",
]);
const HIDDEN_DENIALS = new Set(["control_direct", "sdk_metadata_direct", "control_symlink"]);
const MOUNT_RENAMES = new Set(["host-ro_instructions_parent_rename", "host-rw_instructions_parent_rename", "instruction_parent_rename", "workspace_parent_rename", "source_parent_rename", "memory_rename", "protected_ancestor_rename"]);

/** Expected failure classes are host-owned; guest-declared expectations cannot widen them. */
export function validateDenial(row: any) {
  const positiveDirectCreate = row.suite === "direct_strict_source" && row.policy === "auto" && row.id === "source_create";
  const required = (DENIAL_IDS.has(row.id) && !positiveDirectCreate) || /^(host-ro|host-rw)_(instructions_(write|indirect|unlink|chmod|symlink|parent_rename)|memory_(write|rename|chmod|create))$/.test(row.id) || /^host_ro_supervisor_(instructions|memory)_denied$/.test(row.id) || row.id === "host_rw_writable_memory_plan_write" || row.denial !== undefined;
  if (!required) return;
  const allowed = HIDDEN_DENIALS.has(row.id) ? ["ENOENT"]
    : row.id === "instructions_hardlink" ? ["EROFS", "EACCES", "EPERM", "EXDEV"]
    : MOUNT_RENAMES.has(row.id) ? ["EROFS", "EACCES", "EPERM", "EBUSY"]
    : ["EROFS", "EACCES", "EPERM"];
  const evidence = row.denial;
  if (!evidence || !Number.isInteger(evidence.exitCode) || evidence.exitCode <= 0 || evidence.exitCode >= 126 ||
      !allowed.includes(evidence.failureClass) || evidence.positiveControlPassed !== true || evidence.positiveControlExitCode !== 0)
    throw new Error(`invalid denial evidence: ${row.id}`);
}

function records(result: Record<string, unknown>) {
  if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) throw new Error(`confinement incomplete: exit=${result.exitCode}, truncated=${result.stdoutTruncated || result.stderrTruncated}`);
  const lines = String(result.stdout).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  if (lines.some(line => line.status === "fail" || (line.status === "unsupported" && !(line.kind === "observation" && line.id === "landlock_abi" && line.required === false)))) throw new Error("guest reported failed/unsupported assertion");
  for (const row of lines.filter(line => line.kind === "check")) validateDenial(row);
  return lines;
}
function requireCheck(lines: any[], id: string, extra: Record<string, unknown> = {}) {
  const matches = lines.filter(row => row.kind === "check" && row.id === id && Object.entries(extra).every(([key, value]) => row[key] === value));
  if (matches.length !== 1 || matches[0].status !== "pass") throw new Error(`missing successful check: ${id}`);
}
function requireSuite(lines: any[], id: string) {
  const suites = lines.filter(line => line.kind === "summary" && line.id === id);
  if (suites.length !== 1 || suites[0].status !== "pass" || suites[0].exitCode !== 0) throw new Error(`missing successful suite: ${id}`);
}
function requireView(lines: any[], policy: string, uid: number, ids: string[], summaryId?: string) {
  const summaries = lines.filter(line => line.kind === "summary" && line.policy === policy && line.uid === uid && line.id === summaryId);
  const checks = lines.filter(line => line.kind === "check" && line.policy === policy && line.uid === uid);
  const present = new Set(checks.map(row => row.id));
  if (ids.some(id => !present.has(id))) throw new Error(`required security evidence missing: ${ids.filter(id => !present.has(id)).join(", ")}`);
  if (checks.some(row => row.status !== "pass") || present.size !== checks.length) throw new Error("invalid or duplicated check evidence");
  if (summaries.length !== 1 || summaries[0].status !== "pass" || summaries[0].failures !== 0 || !(summaries[0].checks > 0) || summaries[0].checks !== checks.length) throw new Error(`missing successful ${policy}/${uid} tool summary`);
}
export function validateConfinement(result: Record<string, unknown>) {
  const lines = records(result);
  requireSuite(lines, "guest_suite");
  for (const [policy, uid] of [["auto", 10001], ["auto", 10002], ["plan", 10001]] as const) {
    requireView(lines, policy, uid, [...COMMON, ...HOST_SHARED, policy === "auto" ? "host_rw_writable_memory_write" : "host_rw_writable_memory_plan_write", "namespace_init_identity", "instruction_readable", "scratch_write", "instruction_symlink_setup", "control_symlink_setup", "replacement_seed", ...(policy === "auto" ? [...AUTO, "source_symlink_setup"] : [...PLAN, "plan_source_alias_setup"])]);
    for (const id of ["syscall_vsock", "syscall_mount", "syscall_ptrace", "syscall_unshare"]) {
      const measured = lines.filter(row => row.kind === "observation" && row.id === id && row.policy === policy && row.uid === uid);
      if (measured.length !== 1 || measured[0].result !== -1 || measured[0].errno !== 1) throw new Error(`missing measured syscall denial: ${id}`);
    }
  }
  requireCheck(lines, "trusted_integrity");
  requireCheck(lines, "trusted_host_shared_integrity");
  for (const id of ["host-ro_trusted_shared_integrity", "host-rw_trusted_shared_integrity", "host_rw_trusted_writable_memory"]) requireCheck(lines, id);
  for (const kind of ["instructions", "memory"]) {
    requireCheck(lines, `host_rw_supervisor_${kind}_writable`);
    requireCheck(lines, `host_ro_supervisor_${kind}_denied`);
  }
  for (const uid of [10001, 10002]) requireCheck(lines, "direct_share_write", { uid });
  return lines;
}
const DIRECT_COMMON = ["no_new_privs", "zero_effective_caps", "zero_bounding_caps", "zero_permitted_caps", "zero_inheritable_caps", "zero_ambient_caps", "distinct_tool_uid", "original_user_namespace", "source_mode_preserved", "seed_mode_preserved", "source_read", "control_hidden", "shared_instruction_write", "protected_ancestor_rename"];
const DIRECT_AUTO = ["seed_write", "seed_reopen", "source_create", "created_reopen", "created_mode", "shared_existing_write", "shared_existing_reopen"];
const DIRECT_PLAN = ["plan_reads_latest_seed", "plan_write", "plan_alias_write", "plan_create", "plan_unlink", "plan_rename", "plan_chmod", "plan_scratch_write"];
export function validateDirect(result: Record<string, unknown>) {
  const lines = records(result);
  requireSuite(lines, "direct_strict_source");
  for (const [policy, uid] of [["auto", 10001], ["auto", 10002], ["plan", 10001]] as const)
    requireView(lines, policy, uid, [...DIRECT_COMMON, ...(policy === "auto" ? DIRECT_AUTO : DIRECT_PLAN)], "direct_tool_view");
  requireCheck(lines, "source_modes_preserved");
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
