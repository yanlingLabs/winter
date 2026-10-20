// Tripwires for `.github/workflows/cowork-guest-image-build.yml`, the ONE-RUN image build (guest kernel D6 + production initramfs, each built twice, digests published).
// Its author never triggers it: the owner approves the single run, then the branch below is created once, from the exact reviewed commit, and frozen.
// The workflow that can never fire by accident and one that can look identical in a diff, so every property is asserted on the PARSED workflow. `violations()` is a pure
// function of the workflow text; the mutation table at the bottom feeds it a deliberately broken copy per gate and requires that each removal is caught by its OWN named
// violation, so a gate that silently stopped checking fails here. Modelled on the runtime SDK's guided-packet-compile-gates.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const WORKFLOW_NAME = "cowork-guest-image-build.yml";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_NAME}`;
const TRIGGER_BRANCH = "cowork/guest-image-build-4";
const REPOSITORY = "yanlingLabs/winter";
const SDK_REPOSITORY = "yanlingLabs/winter-agent-sdk";
const ARTIFACT_DIR = "scripts/cowork-guest-artifact";
const ZERO_HEAD = "0".repeat(40);
// The two actions, by the commit the repository's other workflows already use.
const ACTIONS: Record<string, string> = { "actions/checkout": "11d5960a326750d5838078e36cf38b85af677262", "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02" };
// Branches that name other workflows or work branches: never reusable as this trigger.
const USED_BRANCHES = ["cowork/guest-image-build", "cowork/guest-image-build-2", "cowork/guest-image-build-3", "cowork/n2-guest-image-build", "cowork/n2-guest-boot", "cowork/n2-guest-trusted-config-reader", "cowork/output-integration"];

/** The arming guard, line for line. It runs before any builder code is used and refuses unless REVIEWED_HEAD is an ancestor of the pushed commit AND the whole difference
 * is the one REVIEWED_HEAD line of this workflow. */
const GUARD: Array<[string, string]> = [
  ["the strict shell", "set -euo pipefail"],
  ["the unarmed refusal", `test "$REVIEWED_HEAD" != "${ZERO_HEAD}"`],
  ["the ancestor check", 'git merge-base --is-ancestor "$REVIEWED_HEAD" "$GITHUB_SHA"'],
  ["the single-file check", `test "$(git diff --name-only "$REVIEWED_HEAD" "$GITHUB_SHA")" = "${WORKFLOW_PATH}"`],
  ["the numstat check", `test "$(git diff --numstat "$REVIEWED_HEAD" "$GITHUB_SHA")" = "$(printf '1\\t1\\t%s' ${WORKFLOW_PATH})"`],
  ["the diff capture", `armed_diff=$(git diff -U0 --no-color "$REVIEWED_HEAD" "$GITHUB_SHA" | grep -E '^[-+][^-+]' || true)`],
  ["the exact one-line diff check", `test "$armed_diff" = "$(printf '%s\\n%s' "-  REVIEWED_HEAD: '${ZERO_HEAD}'" "+  REVIEWED_HEAD: '$REVIEWED_HEAD'")"`],
  ["the reviewed-head checkout", 'git checkout --detach --quiet "$REVIEWED_HEAD"'],
];

type Step = { name?: string; "continue-on-error"?: boolean; uses?: string; run?: string; if?: string; shell?: string; "working-directory"?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Doc = {
  on?: Record<string, unknown>; permissions?: Record<string, unknown>; env?: Record<string, unknown>;
  jobs?: Record<string, { if?: string; "runs-on"?: string; permissions?: unknown; env?: Record<string, unknown>; steps?: Step[]; "timeout-minutes"?: number }>;
};
const yaml = (Bun as unknown as { YAML: { parse(source: string): unknown } }).YAML;
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const readJson = (path: string) => JSON.parse(read(path)) as Record<string, any>;

function logicalLines(run: string): string[] {
  const out: string[] = [];
  let carry = "";
  for (const raw of run.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.endsWith("\\")) { carry += `${line.slice(0, -1).trim()} `; continue; }
    out.push(`${carry}${line}`);
    carry = "";
  }
  return out;
}

/** The argparse flag names a Python script declares. */
function flagsOf(script: string): string[] {
  return [...read(`${ARTIFACT_DIR}/${script}`).matchAll(/add_argument\(\s*["'](--[\w-]+)["']/g)].map((m) => m[1] as string);
}

interface Context { pins: Record<string, any>; kernel: Record<string, any>; ci: Record<string, any>; others: Record<string, string>; exists: (path: string) => boolean }
function loadContext(): Context {
  const others: Record<string, string> = {};
  for (const name of readdirSync(WORKFLOWS_DIR)) if (name !== WORKFLOW_NAME && (name.endsWith(".yml") || name.endsWith(".yaml"))) others[name] = read(`.github/workflows/${name}`);
  return { pins: readJson(`${ARTIFACT_DIR}/pins.json`), kernel: readJson(`${ARTIFACT_DIR}/kernel/pins.json`), ci: readJson(`${ARTIFACT_DIR}/kernel/ci-build.json`), others, exists: (path) => existsSync(join(ROOT, path)) };
}

/** The reviewed inputs, as the env block must mirror them. */
function wantEnv(ctx: Context): Record<string, string> {
  const { pins, kernel, ci } = ctx;
  return {
    AGENT_SDK_HEAD: pins.sdkCommit, BUILDER_HEAD: pins.builderCommit,
    BUN_ARCHIVE_URL: pins.bun.archiveUrl, BUN_ARCHIVE_SHA256: pins.bun.archiveSha256,
    ZIG_ARCHIVE_URL: pins.zig.linuxArchiveUrl, ZIG_ARCHIVE_SHA256: pins.zig.linuxArchiveSha256,
    PNPM_URL: pins.pnpm.url, PNPM_SHA256: pins.pnpm.sha256,
    KERNEL_URL: kernel.kernel.url, KERNEL_SHA256: kernel.kernel.sha256, KERNEL_SIGN_URL: ci.signatureUrls.kernel, KERNEL_SIGN_SHA256: kernel.kernel.signatureSha256,
    KERNEL_KEY_URL: kernel.kernel.publicKeySource, KERNEL_KEY_SHA256: kernel.kernel.publicKeySha256,
    LLVM_URL: kernel.toolchain.url, LLVM_SHA256: kernel.toolchain.sha256, LLVM_SIGN_URL: ci.signatureUrls.toolchain, LLVM_SIGN_SHA256: kernel.toolchain.signatureSha256,
    LLVM_KEY_URL: kernel.toolchain.publicKeySource, LLVM_KEY_SHA256: kernel.toolchain.publicKeySha256,
  };
}

/** The nine downloads, in order: [url variable, sha variable, destination under $image_work, size bound]. */
const DOWNLOADS: Array<[string, string, string, number]> = [
  ["BUN_ARCHIVE_URL", "BUN_ARCHIVE_SHA256", "downloads/bun.zip", 67108864],
  ["ZIG_ARCHIVE_URL", "ZIG_ARCHIVE_SHA256", "downloads/zig.tar.xz", 104857600],
  ["PNPM_URL", "PNPM_SHA256", "downloads/pnpm", 104857600],
  ["KERNEL_URL", "KERNEL_SHA256", "kernel-downloads/linux-6.18.35.tar.xz", 268435456],
  ["KERNEL_SIGN_URL", "KERNEL_SIGN_SHA256", "kernel-downloads/linux-6.18.35.tar.sign", 1048576],
  ["KERNEL_KEY_URL", "KERNEL_KEY_SHA256", "kernel-downloads/gregkh.key", 1048576],
  ["LLVM_URL", "LLVM_SHA256", "kernel-downloads/llvm-20.1.8-aarch64.tar.xz", 268435456],
  ["LLVM_SIGN_URL", "LLVM_SIGN_SHA256", "kernel-downloads/llvm-20.1.8-aarch64.tar.sign", 1048576],
  ["LLVM_KEY_URL", "LLVM_KEY_SHA256", "kernel-downloads/nathan.key", 1048576],
];
const curlLine = (url: string, dest: string, size: number) => `curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-time 900 --max-filesize ${size} "$${url}" --output "$image_work/${dest}"`;
const sumLine = (sha: string, dest: string) => `printf '%s  %s\\n' "$${sha}" "$image_work/${dest}" | sha256sum --check --strict -`;

const S = ARTIFACT_DIR;
const NATIVE = `python3 -I -S -B ${S}/kernel/native_build.py --downloads "$IMAGE_WORK/kernel-downloads" --work "$kernel_work"`;
const IMAGE = (n: number) => `python3 -I -S -B ${S}/image.py --out "$IMAGE_WORK/artifact/build-${n}" --sdk origins/sdk --builder origins/builder --zig-archive "$IMAGE_WORK/downloads/zig.tar.xz" --bun-base "$IMAGE_WORK/tools/bun" || image_status_${n}=$?`;
const REPORT = `python3 -I -S -B ${S}/image_build_report.py report --kernel-1 "$IMAGE_WORK/kernel-1" --kernel-2 "$IMAGE_WORK/kernel-2" --image-1 "$IMAGE_WORK/artifact/build-1" --image-2 "$IMAGE_WORK/artifact/build-2" --status-1 "$IMAGE_STATUS_1" --status-2 "$IMAGE_STATUS_2" --out "$IMAGE_WORK/digests.json"`;
const COLLECT = `python3 -I -S -B ${S}/image_build_report.py collect --kernel "$IMAGE_WORK/kernel-1" --image "$IMAGE_WORK/artifact/build-1" --out "$IMAGE_WORK/publish"`;
const ASSERT = `python3 -I -S -B ${S}/image_build_report.py assert "$IMAGE_WORK/digests.json"`;

/** Every reviewed command line that is not a download, a checksum or the arming guard. The list is closed on purpose: anything else in a run block is a violation. */
function reviewedLines(ctx: Context): Set<string> {
  const packages = (ctx.ci.hostPackages as string[]).join(" ");
  return new Set([
    "set -euo pipefail",
    "image_work=$(mktemp -d \"$RUNNER_TEMP/winter-image.XXXXXXXX\")",
    "printf 'IMAGE_WORK=%s\\n' \"$image_work\" >> \"$GITHUB_ENV\"",
    "mkdir -m 700 \"$image_work/downloads\" \"$image_work/tools\" \"$image_work/kernel-downloads\"",
    `python3 -I -S -B ${S}/unpack_bun.py "$image_work/downloads/bun.zip" "$image_work/tools/bun"`,
    "install -m 0755 \"$image_work/downloads/pnpm\" \"$image_work/tools/pnpm\"",
    "printf '%s\\n' \"$image_work/tools\" >> \"$GITHUB_PATH\"",
    "test \"$(id -u)\" -ne 0", "test \"$(uname -s)\" = Linux", "test \"$(uname -m)\" = aarch64",
    "for tool in git rsync xz tar gpg gpgv python3 cc make; do command -v \"$tool\"; done",
    "test \"$(bun --version)\" = \"1.3.14\"",
    "sudo apt-get update -qq",
    `sudo apt-get install -y --no-install-recommends ${packages}`,
    `dpkg-query -W ${packages} > "$IMAGE_WORK/host-packages.txt"`,
    "pnpm install --frozen-lockfile --ignore-scripts",
    "kernel_work=\"$RUNNER_TEMP/winter-kernel-work\"",
    `${NATIVE} --out "$IMAGE_WORK/kernel-1"`, `${NATIVE} --out "$IMAGE_WORK/kernel-2"`, "rm -rf \"$kernel_work\"",
    `python3 -I -S -B ${S}/packages.py --out "$IMAGE_WORK/artifact"`,
    "image_status_1=0", "image_status_2=0", IMAGE(1), IMAGE(2),
    "test \"$image_status_1\" = 0 || test \"$image_status_1\" = 3", "test \"$image_status_2\" = 0 || test \"$image_status_2\" = 3",
    "printf 'IMAGE_STATUS_1=%s\\nIMAGE_STATUS_2=%s\\n' \"$image_status_1\" \"$image_status_2\" >> \"$GITHUB_ENV\"",
    `python3 -I -S -B ${S}/verify.py "$IMAGE_WORK/artifact/build-1" --allow-unpinned > "$IMAGE_WORK/artifact/build-1/cpio-verification.json"`,
    `python3 -I -S -B ${S}/verify.py "$IMAGE_WORK/artifact/build-2" --allow-unpinned > "$IMAGE_WORK/artifact/build-2/cpio-verification.json"`,
    REPORT, COLLECT, "cp \"$IMAGE_WORK/digests.json\" \"$IMAGE_WORK/host-packages.txt\" \"$IMAGE_WORK/publish/\"", ASSERT,
  ]);
}

/** Every problem with this workflow text. Empty means every gate holds. */
export function violations(text: string, ctx: Context = loadContext()): string[] {
  const problems: string[] = [];
  const bad = (message: string) => problems.push(message);
  let doc: Doc;
  try { doc = yaml.parse(text) as Doc; } catch { return ["workflow does not parse"]; }

  // 1. Trigger: exactly one push of exactly one named, brand-new branch. Nothing a PR, a button, a tag or a clock can fire.
  const on = doc.on ?? {};
  if (JSON.stringify(Object.keys(on)) !== JSON.stringify(["push"])) bad(`on: must be exactly {push}, got ${Object.keys(on).join(",")}`);
  if (JSON.stringify(on.push ?? {}) !== JSON.stringify({ branches: [TRIGGER_BRANCH] })) bad("on.push must be exactly one literal branch and nothing else");
  for (const [name, other] of Object.entries(ctx.others)) if (other.includes(TRIGGER_BRANCH)) bad(`${name} names the trigger branch`);

  // 2. Least privilege, no secrets, no token, no environment override below the workflow, no sudo beyond the one reviewed install.
  if (JSON.stringify(doc.permissions) !== JSON.stringify({ contents: "read" })) bad("permissions must be exactly contents: read");
  const jobs = doc.jobs ?? {};
  if (Object.keys(jobs).length !== 1) bad("exactly one job");
  const job = Object.values(jobs)[0] ?? {};
  if (job.permissions !== undefined) bad("job must not override permissions");
  if (/secrets\.|GITHUB_TOKEN|github\.token|id-token|persist-credentials:\s*true/i.test(text)) bad("secrets/token/id-token/credential persistence");
  if (job.env !== undefined || (job.steps ?? []).some((s) => s.env !== undefined)) bad("env is only allowed at workflow level");
  if (/continue-on-error/.test(text)) bad("continue-on-error anywhere");

  // 3. The firing gate, every conjunct.
  const gate = job.if ?? "";
  for (const piece of [`github.repository == '${REPOSITORY}'`, "github.event_name == 'push'", `github.ref == 'refs/heads/${TRIGGER_BRANCH}'`, "github.event.created == true", "github.run_attempt == '1'"]) if (!gate.includes(piece)) bad(`job if lacks: ${piece}`);
  if (/\|\||\bor\b/.test(gate)) bad("job if must be a pure conjunction");
  if (job["runs-on"] !== "ubuntu-24.04-arm") bad("runs-on must be ubuntu-24.04-arm");
  if (typeof job["timeout-minutes"] !== "number" || job["timeout-minutes"] > 240) bad("bounded timeout required");

  // 4. Pinned actions only: exactly the allowed two, each the commit the repository already uses.
  const steps = job.steps ?? [];
  for (const step of steps) {
    if (!step.uses) continue;
    const [action, ref] = step.uses.split("@");
    if (!(action && action in ACTIONS)) bad(`action not allowed: ${action}`);
    else if (!/^[0-9a-f]{40}$/.test(ref ?? "")) bad(`action not pinned to a full SHA: ${step.uses}`);
    else if (ACTIONS[action] !== ref) bad(`action SHA differs from the reviewed one: ${step.uses}`);
  }
  for (const [action, ref] of Object.entries(ACTIONS)) if (!Object.values(ctx.others).some((other) => other.includes(`${action}@${ref}`))) bad(`no other workflow uses ${action}@${ref}`);
  if (/download-artifact|actions\/cache|setup-bun|setup-node|setup-python|pnpm\/action-setup/.test(text)) bad("unexpected action");

  // 5. Checkouts: three, each credential-free. The first is the pushed commit with full history (the arming guard reads it); the reviewed head is checked out by the guard itself.
  const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
  const expectedCheckouts = [
    { ref: "${{ github.sha }}", repository: undefined, path: undefined, depth: 0 },
    { ref: "${{ env.AGENT_SDK_HEAD }}", repository: SDK_REPOSITORY, path: "origins/sdk", depth: undefined },
    { ref: "${{ env.BUILDER_HEAD }}", repository: SDK_REPOSITORY, path: "origins/builder", depth: undefined },
  ];
  if (checkouts.length !== 3) bad("exactly three checkouts");
  checkouts.forEach((step, index) => {
    const want = expectedCheckouts[index];
    if (step.with?.["persist-credentials"] !== false) bad("every checkout must set persist-credentials: false");
    if (!want || step.with?.ref !== want.ref || step.with?.repository !== want.repository || step.with?.path !== want.path || step.with?.["fetch-depth"] !== want.depth) bad(`checkout ${index} is not the reviewed origin`);
    if (Object.keys(step.with ?? {}).some((key) => !["ref", "repository", "path", "fetch-depth", "persist-credentials"].includes(key))) bad("checkout has extra with: keys");
  });
  if (steps[0] !== checkouts[0] || steps[0]?.with?.["fetch-depth"] !== 0) bad("the first step must be the pushed-commit checkout with full history");
  const guardStep = steps[1];
  const guardLines = logicalLines(guardStep?.run ?? "");
  if (!guardStep || guardStep.run === undefined) bad("the arming guard must be the second step");
  for (const [label, line] of GUARD) if (!guardLines.includes(line)) bad(`arming guard lacks ${label}`);
  if (JSON.stringify(guardLines) !== JSON.stringify(GUARD.map(([, line]) => line))) bad("arming guard is not exactly the reviewed script");

  // 6. The env block is the pin files, line for line; the arming constant is the only free value.
  const env = (doc.env ?? {}) as Record<string, unknown>;
  const want = wantEnv(ctx);
  if (JSON.stringify(Object.keys(env).sort()) !== JSON.stringify([...Object.keys(want), "REVIEWED_HEAD"].sort())) bad("env keys must be exactly the reviewed pins");
  for (const [key, value] of Object.entries(want)) if (env[key] !== value) bad(`env ${key} differs from the pin files`);
  if (typeof env.REVIEWED_HEAD !== "string" || !/^[0-9a-f]{40}$/.test(env.REVIEWED_HEAD)) bad("REVIEWED_HEAD must be a 40-hex commit (all zeros while unarmed)");
  for (const key of ["AGENT_SDK_HEAD", "BUILDER_HEAD"]) if (!/^[0-9a-f]{40}$/.test(String(env[key]))) bad(`${key} must be a full commit, never a branch name`);
  for (const [key, value] of Object.entries(env)) {
    if (key.endsWith("_SHA256") && !/^[0-9a-f]{64}$/.test(String(value))) bad(`${key} must be 64 lowercase hex`);
    if (key.endsWith("_URL") && !String(value).startsWith("https://")) bad(`${key} must be https`);
  }

  // 7. The network: exactly the nine reviewed downloads, each followed at once by its strict checksum, then the two reviewed installs; nothing else reaches out.
  const runs = steps.filter((s) => s.run !== undefined);
  const lines = runs.flatMap((s) => logicalLines(s.run ?? ""));
  const commandText = lines.join("\n");
  if (/\b(wget|nc|ncat|ssh|scp|pip3?|npm|npx|yarn|corepack|bun\s+(install|add|x)|git\s+(clone|fetch|pull|push|remote|submodule)|docker|podman|gh)\b/.test(commandText.replace(/--tlsv1\.2/g, ""))) bad("a step reaches the network or installs something unreviewed");
  const curls = lines.filter((l) => /^curl\b/.test(l));
  if (curls.length !== DOWNLOADS.length) bad(`exactly ${DOWNLOADS.length} curl commands`);
  DOWNLOADS.forEach(([url, sha, dest, size], index) => {
    const at = lines.indexOf(curlLine(url, dest, size));
    if (at < 0) bad(`download of ${url} is not the reviewed command`);
    else if (lines[at + 1] !== sumLine(sha, dest)) bad(`download of ${url} is not followed at once by its strict sha256 check`);
    if (index > 0 && at >= 0 && lines.indexOf(curlLine(DOWNLOADS[index - 1]![0], DOWNLOADS[index - 1]![2], DOWNLOADS[index - 1]![3])) > at) bad("downloads out of order");
  });
  for (const curl of curls) if (!curl.includes("--fail") || !curl.includes("--proto '=https'") || !curl.includes("--proto-redir '=https'") || !curl.includes("--tlsv1.2") || !/--max-filesize \d+/.test(curl) || !/--max-time \d+/.test(curl)) bad("every curl must be --fail, https-only (also on redirects), tls1.2, size- and time-bounded");
  const sums = lines.filter((l) => /sha256sum/.test(l));
  if (sums.length !== DOWNLOADS.length || sums.some((l) => !/sha256sum --check --strict -$/.test(l))) bad("every download needs exactly one strict sha256 check");
  const apt = lines.filter((l) => /\bapt(-get)?\b/.test(l));
  if (JSON.stringify(apt) !== JSON.stringify(["sudo apt-get update -qq", `sudo apt-get install -y --no-install-recommends ${(ctx.ci.hostPackages as string[]).join(" ")}`])) bad("apt is exactly the two reviewed host-tool lines");
  if (lines.filter((l) => /\bsudo\b/.test(l)).length !== 2) bad("sudo only on the two apt lines");
  if (lines.filter((l) => /^pnpm\b/.test(l)).join("|") !== "pnpm install --frozen-lockfile --ignore-scripts") bad("pnpm is exactly install --frozen-lockfile --ignore-scripts");
  const pnpmStep = steps.find((s) => (s.run ?? "").includes("pnpm install"));
  if (pnpmStep?.["working-directory"] !== "origins/sdk") bad("pnpm runs only inside the SDK checkout");

  // 8. Every shell line is a reviewed shape. The list is closed; the compiled outputs are never named in a command that could run them.
  const reviewed = reviewedLines(ctx);
  const downloadLines = new Set(DOWNLOADS.flatMap(([url, sha, dest, size]) => [curlLine(url, dest, size), sumLine(sha, dest)]));
  for (const line of lines) if (!reviewed.has(line) && !downloadLines.has(line) && !GUARD.some(([, g]) => g === line)) bad(`unreviewed command line: ${line}`);
  if (/(^|[\s;&|(])(\.\/|bash\b|sh\s+-c|exec\b|nohup|chmod|chown|setsid|qemu|ldd\b|strace|valgrind|timeout\s|krun|hvf|hypervisor|vsock|virtiofs|chroot|unshare|nsenter)/m.test(commandText)) bad("an execution, privilege or virtualization command appears");
  if (/stand-?in|provider\.sock|provider-worker/i.test(text)) bad("the stand-in image or a provider is part of this workflow");
  for (const script of ["unpack_bun.py", "kernel/native_build.py", "packages.py", "image.py", "verify.py", "image_build_report.py"]) if (!ctx.exists(`${ARTIFACT_DIR}/${script}`)) bad(`the reviewed script must exist: ${script}`);

  // 9. Each build command has exactly the script's own flags, in the reviewed order of use.
  const flagCheck = (script: string, prefix: string, expected: string[]) => {
    const line = lines.find((l) => l.startsWith(prefix)) ?? "";
    const given = [...line.matchAll(/ (--[a-z0-9-]+)/g)].map((m) => m[1] as string);
    const declared = flagsOf(script);
    if (!expected.every((flag) => declared.includes(flag))) bad(`${script} no longer declares ${expected.join(",")}`);
    if (JSON.stringify([...given].sort()) !== JSON.stringify([...expected].sort())) bad(`${script} is run with flags ${given.join(",")} instead of ${expected.join(",")}`);
  };
  flagCheck("kernel/native_build.py", `python3 -I -S -B ${S}/kernel/native_build.py`, ["--downloads", "--work", "--out"]);
  flagCheck("image.py", `python3 -I -S -B ${S}/image.py`, ["--out", "--sdk", "--builder", "--zig-archive", "--bun-base"]);
  if (lines.filter((l) => l.includes("native_build.py")).length !== 2 || lines.filter((l) => l.includes("/image.py")).length !== 2) bad("the kernel and the image are each built exactly twice");
  if (!lines.includes("rm -rf \"$kernel_work\"") || lines.filter((l) => l === "rm -rf \"$kernel_work\"").length !== 2) bad("the kernel work folder is removed after each build so the second build starts fresh at the same path");
  const kernelAt = lines.findIndex((l) => l.includes("native_build.py")), imageAt = lines.findIndex((l) => l.includes("/image.py"));
  if (!(kernelAt >= 0 && imageAt > kernelAt)) bad("order must be kernel builds, then image builds");

  // 10. Result: exactly three uploads. The kernel is uploaded as soon as both kernel builds agree on being built (no `if`), so a later failure cannot lose it, 14 days; then the files to publish
  //     (no `if`, so only a clean build reaches it), 14 days; the diagnostics upload runs on failure only, bounded, 7 days, last.
  const uploads = steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
  if (uploads.length !== 3) bad("exactly three uploads");
  const [kernelUpload, published, diagnostics] = uploads;
  if (kernelUpload?.if !== undefined) bad("the kernel upload must run on success only (no if:)");
  if (JSON.stringify(Object.keys(kernelUpload?.with ?? {}).sort()) !== JSON.stringify(["if-no-files-found", "name", "path", "retention-days"])) bad("kernel upload keys");
  const kernelPaths = String(kernelUpload?.with?.path ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (JSON.stringify(kernelPaths) !== JSON.stringify(["${{ env.IMAGE_WORK }}/kernel-1/Image", "${{ env.IMAGE_WORK }}/kernel-1/kernel-receipt.json", "${{ env.IMAGE_WORK }}/kernel-1/resolved.config", "${{ env.IMAGE_WORK }}/kernel-2/kernel-receipt.json"])) bad("kernel upload must carry only the first kernel, its receipt and config, and the second receipt");
  if (kernelUpload?.with?.["if-no-files-found"] !== "error") bad("kernel upload must fail when files are missing");
  if (kernelUpload?.with?.["retention-days"] !== 14) bad("kernel retention must be 14 days");
  const kernelUploadAt = steps.indexOf(kernelUpload as Step), kernelBuildAt = steps.findIndex((s) => (s.run ?? "").includes("native_build.py")), imageBuildAt = steps.findIndex((s) => (s.run ?? "").includes("/image.py"));
  if (!(kernelBuildAt >= 0 && kernelBuildAt < kernelUploadAt && kernelUploadAt < imageBuildAt)) bad("the kernel upload must come after the kernel builds and before the image builds");
  if (published?.if !== undefined) bad("the publish upload must run on success only (no if:)");
  if (JSON.stringify(Object.keys(published?.with ?? {}).sort()) !== JSON.stringify(["if-no-files-found", "name", "path", "retention-days"])) bad("publish upload keys");
  if (published?.with?.path !== "${{ env.IMAGE_WORK }}/publish/") bad("publish upload must carry only the collected folder");
  if (published?.with?.["if-no-files-found"] !== "error") bad("publish upload must fail when files are missing");
  if (published?.with?.["retention-days"] !== 14) bad("publish retention must be 14 days");
  if (diagnostics?.if !== "failure() && env.IMAGE_WORK != ''") bad("diagnostics upload must run on failure only");
  const diagPaths = String(diagnostics?.with?.path ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (diagPaths.length === 0 || diagPaths.some((p) => !/^\$\{\{ env\.IMAGE_WORK \}\}\/(kernel-[12]\/(kernel-receipt\.json|build\.log)|artifact\/build-[12]\/(receipt\.json|runtime-build\.log)|host-packages\.txt|digests\.json)$/.test(p))) bad("diagnostics upload must carry only bounded records");
  if (diagnostics?.with?.["if-no-files-found"] !== "ignore") bad("diagnostics upload must tolerate absent files");
  if (diagnostics?.with?.["retention-days"] !== 7) bad("diagnostics retention must be 7 days");
  if (uploads.length === 3 && steps[steps.length - 1] !== diagnostics) bad("diagnostics upload is the last step");
  const assertAt = steps.findIndex((s) => (s.run ?? "").includes("image_build_report.py assert"));
  const reportAt = steps.findIndex((s) => (s.run ?? "").includes("image_build_report.py report"));
  const verifyAt = steps.findIndex((s) => (s.run ?? "").includes("verify.py"));
  const publishAt = steps.indexOf(published as Step);
  if (!(reportAt >= 0 && verifyAt >= 0 && verifyAt < reportAt && reportAt < publishAt && publishAt < assertAt && assertAt < steps.indexOf(diagnostics as Step))) bad("order must be verify, report, publish upload, assert, diagnostics upload");
  return problems;
}

describe("guest image build workflow gates", () => {
  const WORKFLOW = read(WORKFLOW_PATH);

  test("the committed workflow satisfies every gate", () => {
    expect(violations(WORKFLOW)).toEqual([]);
  });

  test("the trigger branch is new, and unarmed in this reviewed commit", () => {
    expect(USED_BRANCHES).not.toContain(TRIGGER_BRANCH);
    const doc = yaml.parse(WORKFLOW) as Doc;
    expect(doc.env?.REVIEWED_HEAD).toBe(ZERO_HEAD);
    expect(WORKFLOW).toContain("NEVER triggered");
  });

  test("the trigger is the exact first-creation push of one new branch, and nothing else", () => {
    const doc = yaml.parse(WORKFLOW) as Doc;
    expect(doc.on).toEqual({ push: { branches: [TRIGGER_BRANCH] } });
    for (const name of ["pull_request", "pull_request_target", "workflow_dispatch", "schedule", "workflow_run", "repository_dispatch", "release", "issue_comment"]) expect(Object.keys(doc.on ?? {})).not.toContain(name);
  });

  test("the gate test itself is picked up by normal PR CI: the artifact tests run under cowork-guest-boot.yml and this file under test · core", () => {
    const boot = loadContext().others["cowork-guest-boot.yml"] ?? "";
    expect(boot).toContain("'scripts/cowork-guest-artifact/**'");
    expect(boot).toContain("discover -s scripts/cowork-guest-artifact -p 'test_*.py'");
    expect(boot).toContain("discover -s scripts/cowork-guest-artifact/kernel -p 'test_*.py'");
  });

  test("no workflow other than this one can start a build of the image: none runs native_build.py, image.py or the arming files", () => {
    for (const [name, text] of Object.entries(loadContext().others)) {
      expect([name, /native_build\.py|cowork-guest-artifact\/image\.py/.test(text)]).toEqual([name, false]);
    }
  });

  test("the stand-in image is not built here and no production pin names it", () => {
    expect(WORKFLOW.toLowerCase()).not.toMatch(/stand-?in/);
    expect(read(`${ARTIFACT_DIR}/pins.json`).toLowerCase()).not.toMatch(/stand-?in/);
  });
});

// Each entry removes or breaks exactly one gate. Every one must make `violations` contain its own named message.
const sub = (from: string | RegExp, to: string) => (t: string) => t.replace(from, to);
const SHA_CHECKOUT = /actions\/checkout@[0-9a-f]{40}/;
const MUTATIONS: Array<[string, (text: string) => string, string]> = [
  ["add pull_request trigger", sub("on:\n  push:", "on:\n  pull_request:\n  push:"), "on: must be exactly {push}, got pull_request,push"],
  ["add pull_request_target trigger", sub("on:\n  push:", "on:\n  pull_request_target:\n  push:"), "on: must be exactly {push}, got pull_request_target,push"],
  ["add workflow_dispatch trigger", sub("on:\n  push:", "on:\n  workflow_dispatch:\n  push:"), "on: must be exactly {push}, got workflow_dispatch,push"],
  ["add schedule trigger", sub("on:\n  push:", "on:\n  schedule:\n    - cron: '0 0 * * *'\n  push:"), "on: must be exactly {push}, got schedule,push"],
  ["add workflow_run trigger", sub("on:\n  push:", "on:\n  workflow_run:\n    workflows: [ci]\n  push:"), "on: must be exactly {push}, got workflow_run,push"],
  ["widen the branch to a glob", sub(`[${TRIGGER_BRANCH}]`, "['cowork/**']"), "on.push must be exactly one literal branch and nothing else"],
  ["add a tags filter", sub("  push:\n    branches:", "  push:\n    tags: ['*']\n    branches:"), "on.push must be exactly one literal branch and nothing else"],
  ["add a paths filter", sub(`branches: [${TRIGGER_BRANCH}]`, `branches: [${TRIGGER_BRANCH}]\n    paths: ['scripts/**']`), "on.push must be exactly one literal branch and nothing else"],
  ["swap to another branch", (t) => t.replaceAll(TRIGGER_BRANCH, "cowork/n2-guest-boot"), "on.push must be exactly one literal branch and nothing else"],
  ["drop the repository gate", sub(`github.repository == '${REPOSITORY}' && `, ""), `job if lacks: github.repository == '${REPOSITORY}'`],
  ["drop the event-name gate", sub("github.event_name == 'push' && ", ""), "job if lacks: github.event_name == 'push'"],
  ["drop the exact-ref gate", sub(` && github.ref == 'refs/heads/${TRIGGER_BRANCH}'`, ""), `job if lacks: github.ref == 'refs/heads/${TRIGGER_BRANCH}'`],
  ["drop the first-creation gate", sub(" && github.event.created == true", ""), "job if lacks: github.event.created == true"],
  ["drop the run_attempt gate", sub(" && github.run_attempt == '1'", ""), "job if lacks: github.run_attempt == '1'"],
  ["turn the gate into a disjunction", sub("github.event.created == true &&", "github.event.created == true ||"), "job if must be a pure conjunction"],
  ["remove the job if entirely", sub(/    if: .*\n/, ""), `job if lacks: github.repository == '${REPOSITORY}'`],
  ["wrong runner", sub("ubuntu-24.04-arm", "ubuntu-latest"), "runs-on must be ubuntu-24.04-arm"],
  ["no timeout", sub(/    timeout-minutes: \d+\n/, ""), "bounded timeout required"],
  ["unbounded timeout", sub(/timeout-minutes: \d+/, "timeout-minutes: 360"), "bounded timeout required"],
  ["drop top-level permissions", sub("permissions:\n  contents: read\n", ""), "permissions must be exactly contents: read"],
  ["widen permissions", sub("contents: read", "contents: write"), "permissions must be exactly contents: read"],
  ["add id-token permission", sub("contents: read", "contents: read\n  id-token: write"), "permissions must be exactly contents: read"],
  ["job-level permission override", sub("    runs-on:", "    permissions:\n      contents: read\n    runs-on:"), "job must not override permissions"],
  ["a secret is read", sub("          set -euo pipefail\n          image_work", "          set -euo pipefail\n          echo ${{ secrets.X }}\n          image_work"), "secrets/token/id-token/credential persistence"],
  ["a step overrides env", sub("      - name: Fetch the pinned inputs as bounded data\n", "      - name: Fetch the pinned inputs as bounded data\n        env:\n          X: y\n"), "env is only allowed at workflow level"],
  ["continue-on-error", sub("    timeout-minutes", "    continue-on-error: true\n    timeout-minutes"), "continue-on-error anywhere"],
  ["unpin checkout", sub(SHA_CHECKOUT, "actions/checkout@v4"), "action not pinned to a full SHA: actions/checkout@v4"],
  ["unpin upload-artifact", sub(/actions\/upload-artifact@[0-9a-f]{40}/, "actions/upload-artifact@v4"), "action not pinned to a full SHA: actions/upload-artifact@v4"],
  ["pin checkout to another commit", sub(SHA_CHECKOUT, `actions/checkout@${"1".repeat(40)}`), "action SHA differs from the reviewed one"],
  ["an unlisted action", sub("      - name: Fetch", `      - uses: actions/cache@${"2".repeat(40)}\n      - name: Fetch`), "action not allowed: actions/cache"],
  ["a package-manager action", sub("      - name: Fetch", `      - uses: pnpm/action-setup@${"3".repeat(40)}\n      - name: Fetch`), "action not allowed: pnpm/action-setup"],
  ["a download-artifact action", sub("      - name: Fetch", `      - uses: actions/download-artifact@${"4".repeat(40)}\n      - name: Fetch`), "action not allowed: actions/download-artifact"],
  ["a fourth checkout", sub("      - name: Fetch", `      - uses: actions/checkout@${ACTIONS["actions/checkout"]}\n        with:\n          persist-credentials: false\n      - name: Fetch`), "exactly three checkouts"],
  ["a checkout keeps credentials", sub(/persist-credentials: false/, "persist-credentials: true"), "every checkout must set persist-credentials: false"],
  ["the SDK checkout follows a branch", sub("ref: ${{ env.AGENT_SDK_HEAD }}", "ref: main"), "checkout 1 is not the reviewed origin"],
  ["the builder checkout is the wrong repository", sub("repository: yanlingLabs/winter-agent-sdk\n          ref: ${{ env.BUILDER_HEAD }}", "repository: yanlingLabs/winter\n          ref: ${{ env.BUILDER_HEAD }}"), "checkout 2 is not the reviewed origin"],
  ["a checkout with an extra key", sub("          path: origins/sdk\n", "          path: origins/sdk\n          token: x\n"), "checkout has extra with: keys"],
  ["the first checkout is shallow", sub("fetch-depth: 0", "fetch-depth: 1"), "the first step must be the pushed-commit checkout with full history"],
  ["guard: drop the unarmed refusal", sub(`          test "$REVIEWED_HEAD" != "${ZERO_HEAD}"\n`, ""), "arming guard lacks the unarmed refusal"],
  ["guard: drop the ancestor check", sub('          git merge-base --is-ancestor "$REVIEWED_HEAD" "$GITHUB_SHA"\n', ""), "arming guard lacks the ancestor check"],
  ["guard: drop the single-file check", sub(/          test "\$\(git diff --name-only[^\n]*\n/, ""), "arming guard lacks the single-file check"],
  ["guard: drop the numstat check", sub(/          test "\$\(git diff --numstat[^\n]*\n/, ""), "arming guard lacks the numstat check"],
  ["guard: drop the exact one-line diff check", sub(/          test "\$armed_diff"[^\n]*\n/, ""), "arming guard lacks the exact one-line diff check"],
  ["guard: drop the strict shell", sub("          set -euo pipefail\n          test \"$REVIEWED_HEAD\"", "          test \"$REVIEWED_HEAD\""), "arming guard lacks the strict shell"],
  ["guard: add a line", sub('          git checkout --detach --quiet "$REVIEWED_HEAD"\n', '          git checkout --detach --quiet "$REVIEWED_HEAD"\n          echo armed\n'), "arming guard is not exactly the reviewed script"],
  ["guard is not the second step", sub("      - name: Refuse any arming commit that is not the one reviewed line, then check out the reviewed head", "      - name: Early\n        run: echo early\n      - name: Refuse any arming commit that is not the one reviewed line, then check out the reviewed head"), "arming guard lacks the strict shell"],
  ["env: an extra key", sub("jobs:\n", "  EXTRA: 'x'\njobs:\n"), "env keys must be exactly the reviewed pins"],
  ["env: the SDK head drifts from the pin", sub(/AGENT_SDK_HEAD: '[0-9a-f]{40}'/, `AGENT_SDK_HEAD: '${"5".repeat(40)}'`), "env AGENT_SDK_HEAD differs from the pin files"],
  ["env: the kernel digest drifts from the pin", sub(/KERNEL_SHA256: '[0-9a-f]{64}'/, `KERNEL_SHA256: '${"6".repeat(64)}'`), "env KERNEL_SHA256 differs from the pin files"],
  ["env: the Zig digest drifts from the pin", sub(/ZIG_ARCHIVE_SHA256: '[0-9a-f]{64}'/, `ZIG_ARCHIVE_SHA256: '${"7".repeat(64)}'`), "env ZIG_ARCHIVE_SHA256 differs from the pin files"],
  ["env: a URL downgrades to http", sub("PNPM_URL: 'https://", "PNPM_URL: 'http://"), "PNPM_URL must be https"],
  ["env: the arming constant is not a commit", sub(`REVIEWED_HEAD: '${ZERO_HEAD}'`, "REVIEWED_HEAD: 'main'"), "REVIEWED_HEAD must be a 40-hex commit (all zeros while unarmed)"],
  ["env: the builder head becomes a branch", sub(/BUILDER_HEAD: '[0-9a-f]{40}'/, "BUILDER_HEAD: 'main'"), "BUILDER_HEAD must be a full commit, never a branch name"],
  ["curl: drop the checksum after the Bun download", sub(/          printf '%s  %s\\n' "\$BUN_ARCHIVE_SHA256"[^\n]*\n/, ""), "download of BUN_ARCHIVE_URL is not followed at once by its strict sha256 check"],
  ["curl: a non-strict checksum", sub(/sha256sum --check --strict -/g, "sha256sum --check -"), "every download needs exactly one strict sha256 check"],
  ["curl: drop the https restriction", sub("--proto '=https' --proto-redir '=https' --tlsv1.2 --max-time 900 --max-filesize 67108864", "--tlsv1.2 --max-time 900 --max-filesize 67108864"), "download of BUN_ARCHIVE_URL is not the reviewed command"],
  ["curl: unbounded size", sub("--max-filesize 268435456 \"$KERNEL_URL\"", "\"$KERNEL_URL\""), "download of KERNEL_URL is not the reviewed command"],
  ["curl: an extra download", sub("          install -m 0755", "          curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-time 9 --max-filesize 9 \"$BUN_ARCHIVE_URL\" --output \"$image_work/downloads/extra\"\n          install -m 0755"), "exactly 9 curl commands"],
  ["network: wget", sub("          install -m 0755", "          wget https://example.invalid/x\n          install -m 0755"), "a step reaches the network or installs something unreviewed"],
  ["network: npm", sub("          pnpm install --frozen-lockfile --ignore-scripts", "          pnpm install --frozen-lockfile --ignore-scripts\n          npm install x"), "a step reaches the network or installs something unreviewed"],
  ["network: gh", sub("          install -m 0755", "          gh run list\n          install -m 0755"), "a step reaches the network or installs something unreviewed"],
  ["apt: an extra package", sub("libssl-dev\n          dpkg-query", "libssl-dev curl\n          dpkg-query"), "apt is exactly the two reviewed host-tool lines"],
  ["apt: dropped update", sub("          sudo apt-get update -qq\n", ""), "apt is exactly the two reviewed host-tool lines"],
  ["sudo elsewhere", sub("          install -m 0755", "          sudo install -m 0755"), "sudo only on the two apt lines"],
  ["pnpm without the frozen lockfile", sub("pnpm install --frozen-lockfile --ignore-scripts", "pnpm install"), "pnpm is exactly install --frozen-lockfile --ignore-scripts"],
  ["pnpm with lifecycle scripts", sub("--frozen-lockfile --ignore-scripts", "--frozen-lockfile"), "pnpm is exactly install --frozen-lockfile --ignore-scripts"],
  ["pnpm outside the SDK checkout", sub("        working-directory: origins/sdk\n", ""), "pnpm runs only inside the SDK checkout"],
  ["an unreviewed command", sub("          install -m 0755", "          echo hello\n          install -m 0755"), "unreviewed command line: echo hello"],
  ["a compiled output is executed", sub("          install -m 0755", "          ./out/x\n          install -m 0755"), "an execution, privilege or virtualization command appears"],
  ["chmod appears", sub("          install -m 0755", "          chmod +x x\n          install -m 0755"), "an execution, privilege or virtualization command appears"],
  ["a virtualization command appears", sub("          install -m 0755", "          krun x\n          install -m 0755"), "an execution, privilege or virtualization command appears"],
  ["the stand-in image creeps in", sub("      - name: Fetch the pinned inputs as bounded data", "      - name: Fetch the pinned inputs as bounded data (and the stand-in)"), "the stand-in image or a provider is part of this workflow"],
  ["a provider socket creeps in", sub("          install -m 0755", "          printf x > provider.sock\n          install -m 0755"), "the stand-in image or a provider is part of this workflow"],
  ["the kernel is built once", sub(/          python3 -I -S -B scripts\/cowork-guest-artifact\/kernel\/native_build\.py[^\n]*kernel-2"\n/, ""), "the kernel and the image are each built exactly twice"],
  ["the kernel work folder is not removed", sub('          rm -rf "$kernel_work"\n          python3', "          python3"), "the kernel work folder is removed after each build so the second build starts fresh at the same path"],
  ["the image is built once", sub(/          image_status_2=0\n          python3 -I -S -B scripts\/cowork-guest-artifact\/image\.py[^\n]*\n/, ""), "the kernel and the image are each built exactly twice"],
  ["image.py gets a flag it does not have", sub("--bun-base \"$IMAGE_WORK/tools/bun\" || image_status_1", "--bun-base \"$IMAGE_WORK/tools/bun\" --extra x || image_status_1"), "image.py is run with flags"],
  ["native_build gets a flag it does not have", sub("--out \"$IMAGE_WORK/kernel-1\"", "--out \"$IMAGE_WORK/kernel-1\" --network"), "native_build.py is run with flags"],
  ["the images are built before the kernel", (t) => { const k = t.match(/      - name: Build the pinned kernel twice[\s\S]*?(?=      - name: Build the production initramfs)/)![0]; return t.replace(k, "").replace("      - name: Read both cpios back", `${k}      - name: Read both cpios back`); }, "order must be kernel builds, then image builds"],
  ["the publish upload runs on failure too", sub("      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: guest-image-${{ github.run_id }}", "      - if: always()\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: guest-image-${{ github.run_id }}"), "the publish upload must run on success only (no if:)"],
  ["the publish upload carries the build tree", sub("path: ${{ env.IMAGE_WORK }}/publish/", "path: ${{ env.IMAGE_WORK }}/"), "publish upload must carry only the collected folder"],
  ["the publish upload tolerates missing files", (t) => t.replace(/(name: guest-image-\$\{\{ github\.run_id \}\}\n          path: \$\{\{ env\.IMAGE_WORK \}\}\/publish\/\n          if-no-files-found: )error/, "$1ignore"), "publish upload must fail when files are missing"],
  ["publish retention is 90 days", (t) => t.replace(/(name: guest-image-\$\{\{ github\.run_id \}\}[\s\S]*?retention-days: )14/, "$190"), "publish retention must be 14 days"],
  ["diagnostics run always", sub("if: failure() && env.IMAGE_WORK != ''", "if: always()"), "diagnostics upload must run on failure only"],
  ["diagnostics carry the cpio", sub("            ${{ env.IMAGE_WORK }}/digests.json\n", "            ${{ env.IMAGE_WORK }}/digests.json\n            ${{ env.IMAGE_WORK }}/artifact/build-1/immutable-root.cpio\n"), "diagnostics upload must carry only bounded records"],
  ["diagnostics retention is 90 days", sub("retention-days: 7", "retention-days: 90"), "diagnostics retention must be 7 days"],
  ["the kernel upload is dropped", sub(/      - uses: actions\/upload-artifact@[0-9a-f]{40}\n        with:\n          name: guest-kernel-[\s\S]*?retention-days: 14\n/, ""), "exactly three uploads"],
  ["the kernel upload runs always", sub("      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: guest-kernel-${{ github.run_id }}", "      - if: always()\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: guest-kernel-${{ github.run_id }}"), "the kernel upload must run on success only (no if:)"],
  ["the kernel upload carries the build tree", sub("            ${{ env.IMAGE_WORK }}/kernel-2/kernel-receipt.json\n          if-no-files-found: error", "            ${{ env.IMAGE_WORK }}/kernel-2/kernel-receipt.json\n            ${{ env.IMAGE_WORK }}/kernel-work/\n          if-no-files-found: error"), "kernel upload must carry only the first kernel"],
  ["the kernel upload tolerates missing files", sub("          name: guest-kernel-${{ github.run_id }}\n          path: |", "          name: guest-kernel-${{ github.run_id }}\n          x: y\n          path: |"), "kernel upload keys"],
  ["the kernel upload keeps files 90 days", (t) => t.replace(/(guest-kernel-[\s\S]*?retention-days: )14/, "$190"), "kernel retention must be 14 days"],
  ["a script runs without dash I", sub("python3 -I -S -B scripts/cowork-guest-artifact/image_build_report.py report", "python3 -S -B scripts/cowork-guest-artifact/image_build_report.py report"), "unreviewed command line"],
  ["the assert step is dropped", sub(/      - name: Turn the run red[\s\S]*?(?=      - name: Retain bounded)/, ""), "order must be verify, report, publish upload, assert, diagnostics upload"],
  ["the assert step runs before the upload", (t) => { const a = t.match(/      - name: Turn the run red[\s\S]*?(?=      - name: Retain bounded)/)![0]; return t.replace(a, "").replace("      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: guest-image-${{ github.run_id }}", `${a}      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: guest-image-\${{ github.run_id }}`); }, "order must be verify, report, publish upload, assert, diagnostics upload"],
];

describe("each gate has a named mutation that trips it", () => {
  const base = read(WORKFLOW_PATH);
  const ctx = loadContext();
  for (const [label, mutate, expected] of MUTATIONS) {
    test(label, () => {
      const mutated = mutate(base);
      expect(mutated).not.toBe(base);
      const found = violations(mutated, ctx);
      expect(found.some((message) => message.includes(expected)), `expected a violation containing "${expected}", got ${JSON.stringify(found)}`).toBe(true);
    });
  }
  test("the table covers at least 80 distinct mutations", () => {
    expect(new Set(MUTATIONS.map(([label]) => label)).size).toBe(MUTATIONS.length);
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(80);
  });
});
