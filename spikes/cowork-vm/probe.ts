import { existsSync, readFileSync, writeFileSync, lstatSync, mkdirSync, rmdirSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { validateConfinement, validateDirect, memoryObservation } from "./evidence";
import { assertOrchestrator } from "./claims";
import { parseGuestMemoryDiagnostics } from "./kernel/profiles";
import { NativeClient } from "./client";
import { footprint, hostMetrics, memoryCategories } from "./metrics";

const argv = process.argv.slice(2);
function option(name: string): string {
  const index = argv.indexOf(name), value = argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const library = option("--library"), fixtureRoot = option("--fixture"), phase = option("--phase");
  const canonical = realpathSync(fixtureRoot), temp = realpathSync(tmpdir());
  check(canonical === fixtureRoot && canonical.startsWith(temp + "/") && basename(canonical).startsWith("winter-cowork-vm-"), "disposable canonical temp fixture required");
  const marker = join(fixtureRoot, ".winter-cowork-vm-fixture");
  check(lstatSync(marker).isFile() && !lstatSync(marker).isSymbolicLink() && readFileSync(marker, "utf8") === "winter-cowork-vm-disposable-v1\n", "invalid fixture marker");
  assertOrchestrator(fixtureRoot, process.env.WINTER_COWORK_PROBE_CLAIM);
  const claim = join(fixtureRoot, ".probe-claim");
  mkdirSync(claim); // Exclusive across phases/processes. Crash leaves claim for inspection, never PID-based reuse.
  const config = JSON.parse(readFileSync(join(fixtureRoot, "config.json"), "utf8"));
  for (const [name, expected] of Object.entries(config.payloadDigests ?? {})) {
    const file = join(fixtureRoot, "payload", name);
    check(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), "payload file must be regular");
    check(createHash("sha256").update(readFileSync(file)).digest("hex") === expected, "immutable fixture payload digest mismatch");
  }
  if (existsSync(join(fixtureRoot, "owner.json"))) check(JSON.parse(readFileSync(join(fixtureRoot, "owner.json"), "utf8")).stopped === true, "previous guest termination unproven; refusing fixture reuse");
  check(["prepare", "smoke", "resume", "direct", "memory", "memory-compact"].includes(phase), "unknown phase");
  check(process.env.WINTER_COWORK_VM_TESTS === "1" || phase === "prepare", "explicit VM opt-in required");
  const report: Record<string, any> = { schema: 1, phase, pid: process.pid, startedAt: new Date().toISOString(), embedding: "compiled Bun + Swift C ABI (FFI feasibility only)", gate1Passed: false, checks: [], samples: [], limitations: ["No network interface: not network enforcement validation", "Ad-hoc signature: not release/TCC validation", "Fixture supervisor exec is trusted, not a production agent tool", "Full daemon integration/admission/authentication not implemented"] };
  const client = new NativeClient(library);
  let created = false, stopped = false;
  let memoryRun: Promise<Record<string, unknown>> | undefined;
  let maxHeartbeatDelayMs = 0, lastBeat = performance.now();
  const heartbeat = setInterval(() => { const now = performance.now(); maxHeartbeatDelayMs = Math.max(maxHeartbeatDelayMs, now - lastBeat - 20); lastBeat = now; }, 20);
  const mark = (name: string, detail: unknown) => { report.checks.push({ name, detail }); console.log(JSON.stringify({ type: "check", phase, name, detail })); };
  const exec = async (args: string[], timeoutSeconds = 30) => {
    const result = await client.request({ method: "exec", id: "probe", args, timeoutSeconds }, (timeoutSeconds + 15) * 1000);
    check(result.exitCode === 0, `guest exit ${result.exitCode}: ${String(result.stderr)}\n${String(result.stdout)}`);
    check(!result.stdoutTruncated && !result.stderrTruncated, "guest output truncated");
    return String(result.stdout);
  };
  const sample = async (label: string) => {
    const start = performance.now();
    const ownedCandidates = report.newBackingServiceCandidates ?? [];
    const singleCandidate = ownedCandidates.length === 1 ? ownedCandidates[0].pid : undefined;
    const value = { label, host: await hostMetrics(), guest: await exec(["/bin/sh", "-c", "cat /proc/meminfo; cat /proc/vmstat | grep -E 'balloon|pswp|pgscan|pgsteal|compact_' || true"]), native: await client.request({ method: "stats", id: "probe" }), footprint: await Promise.all([process.pid, ...(singleCandidate ? [singleCandidate] : [])].map(pid => footprint(pid))), categories: singleCandidate ? await memoryCategories(singleCandidate) : { unavailable: "ambiguous backing-service ownership" } };
    report.samples.push(value);
    mark("sample", { label, durationMs: performance.now() - start });
  };
  try {
    report.capabilities = await client.request({ method: "capabilities" });
    if (phase === "prepare") {
      for (const [name, imageReference] of [["initfs", config.initImage], ["rootfs", config.rootImage]]) {
        const outputPath = join(fixtureRoot, `${name}.ext4`);
        if (existsSync(outputPath)) throw new Error(`refusing to overwrite ${name}`);
        const result = await client.request({ method: "prepareRootfs", fixtureRoot, imageReference, outputPath }, 300_000);
        mark(`prepare-${name}`, result);
      }
    } else {
      report.before = await hostMetrics();
      writeFileSync(join(fixtureRoot, "owner.json"), JSON.stringify({ pid: process.pid, stopped: false, phase }));
      created = true; // A failed create can still own a VZ instance and disk lease.
      const started = performance.now();
      const result = await client.request({ method: "create", id: "probe", fixtureRoot, kernelPath: join(fixtureRoot, "vmlinux"), initfsPath: join(fixtureRoot, "initfs.ext4"), rootfsPath: join(fixtureRoot, "rootfs.ext4"), sourcePath: join(fixtureRoot, "source"), payloadPath: join(fixtureRoot, "payload"), sharedReadOnlyPath: join(fixtureRoot, "shared-ro"), sharedReadWritePath: join(fixtureRoot, "shared-rw"), memoryBytes: 1024 * 1024 * 1024 });
      report.readyMs = performance.now() - started;
      mark("guest-ready", { ...result, elapsedMs: report.readyMs });
      report.bootId = (await exec(["cat", "/proc/sys/kernel/random/boot_id"])).trim();
      mark("guest-kernel", (await exec(["uname", "-a"])).trim());
      report.online = await hostMetrics();
      report.newBackingServiceCandidates = report.online.processes.filter((row: any) => row.pid !== process.pid && !report.before.processes.some((before: any) => before.pid === row.pid));
      if (phase === "smoke") {
        const fixture = await client.request({ method: "exec", id: "probe", args: ["/bin/sh", "/opt/cowork-fixture/run.sh"], timeoutSeconds: 120 }, 135_000);
        report.confinement = fixture;
        report.confinementRecords = validateConfinement(fixture);
        for (const share of ["shared-ro", "shared-rw"]) {
          for (const [name, content] of [["instructions/WINTER.md", "host-shared-instruction\n"], ["memory/seed.txt", "host-shared-memory\n"]]) {
            const path = join(fixtureRoot, share, name!), metadata = lstatSync(path);
            check(metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o644 && readFileSync(path, "utf8") === content, "host-backed guidance/memory changed");
          }
        }
        check(readFileSync(join(fixtureRoot, "shared-rw/writable-memory/seed.txt"), "utf8") === "tool-host-memory", "host memory auto-write/plan-preservation missing");
        mark("host-backed-protected-state", "host-ro and rw-to-tool-ro fixture guidance/memory remain unchanged");
        mark("confinement", { records: report.confinementRecords.length, summaries: report.confinementRecords.filter((row: any) => row.kind === "summary") });
        for (const uid of [10001, 10002]) {
          const file = join(fixtureRoot, `source/.cowork-gate1-${uid}-auto-share.txt`);
          check(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), "host marker must be a regular file");
          check(readFileSync(file, "utf8") === `guest-${uid}-auto\n`, `direct host share content mismatch for ${uid}`);
        }
        mark("direct-share", "both guest tool identities wrote fixture files visible on host");
        await exec(["/bin/sh", "-c", "printf '%s' winter-cold-state-v1 > /root/cowork-cold-state; sync"]);
        writeFileSync(join(fixtureRoot, "first-boot.json"), JSON.stringify({ bootId: report.bootId, pid: process.pid }));
        mark("state-written", "winter-cold-state-v1");
      } else if (phase === "resume") {
        const first = JSON.parse(readFileSync(join(fixtureRoot, "first-boot.json"), "utf8"));
        check(first.pid !== process.pid && first.bootId !== report.bootId, "cold resume must use a new process and kernel boot identity");
        check(await exec(["cat", "/root/cowork-cold-state"]) === "winter-cold-state-v1", "retained guest file mismatch");
        mark("cold-persistence", { previousPid: first.pid, previousBootId: first.bootId, bootId: report.bootId });
      } else if (phase === "direct") {
        const strict = join(fixtureRoot, "source/strict-source");
        const metadata = (path: string) => { const st = lstatSync(path); check(!st.isSymbolicLink(), "strict host metadata path cannot be symlink"); return { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 }; };
        const before = { source: metadata(strict), seed: metadata(join(strict, "seed.txt")) };
        const result = await client.request({ method: "exec", id: "probe", args: ["/bin/sh", "/opt/cowork-fixture/run-direct.sh"], timeoutSeconds: 120 }, 135_000);
        report.direct = result;
        const records = validateDirect(result);
        report.directRecords = records;
        const after = { source: metadata(strict), seed: metadata(join(strict, "seed.txt")) };
        check(JSON.stringify(before) === JSON.stringify(after), "host strict source ownership/modes changed");
        check(readFileSync(join(strict, "seed.txt"), "utf8") === "direct-seed-10002\n", "strict source edit missing");
        for (const uid of [10001, 10002]) {
          const path = join(strict, `direct-created-${uid}.txt`), st = metadata(path);
          check(st.uid === before.source.uid && st.gid === before.source.gid && st.mode === 0o644, "created host file ownership/mode mismatch");
          check(readFileSync(path, "utf8") === `direct-created-${uid}\n`, "created host file content mismatch");
        }
        check(readFileSync(join(strict, "direct-shared-existing.txt"), "utf8") === "direct-shared-10002\n", "cross-identity existing-file edit missing");
        check(!existsSync(join(strict, "direct-plan-created.txt")) && !existsSync(join(strict, "direct-seed-moved.txt")), "plan mutated source");
        report.directMetadata = { before, after };
        mark("direct-strict-source", { records: records.length, before, after, limitation: "owner-only fixture, not mixed ownership/ACL/TCC proof" });
      } else {
        report.memoryDiagnostics = parseGuestMemoryDiagnostics(await exec(["/bin/sh", "/opt/cowork-fixture/guest-memory-diagnostics.sh"]));
        report.kernelProfile = config.kernelProfile;
        mark("guest-balloon-features", report.memoryDiagnostics);
        await sample("baseline");
        const pageGroups = async (operation: "baseline" | "compare") => {
          const result = JSON.parse(await exec(["/opt/cowork-fixture/page-groups", operation, "--dir", "/var/lib/cowork-fixture/page-groups", "--file", `${phase}.bin`, "--ram-mib", "1024"]));
          check(result.ok === true && result.coverageValidated === true, "page-group diagnostic coverage unproven");
          return result;
        };
        if (config.pageGroups) {
          await exec(["/bin/sh", "-c", "mkdir -p /var/lib/cowork-fixture/page-groups; chmod 0700 /var/lib/cowork-fixture/page-groups"]);
          report.pageGroupBaseline = await pageGroups("baseline");
        }
        await exec(["/bin/sh", "-c", "rm -f /tmp/cowork-memprobe.log /tmp/cowork-memprobe.pid"]);
        memoryRun = client.request({ method: "exec", id: "probe", args: ["/bin/sh", "-c", "echo $$ > /tmp/cowork-memprobe.pid; exec /opt/cowork-fixture/memprobe 384 180 > /tmp/cowork-memprobe.log 2>&1"], timeoutSeconds: 300 }, 315_000);
        memoryRun.catch(() => {}); // Retain explicit await/cleanup below; no detached untracked child.
        for (let i = 0; i < 40; i++) { if ((await exec(["/bin/sh", "-c", "cat /tmp/cowork-memprobe.log 2>/dev/null || true"])).includes('"phase":"allocated"')) break; await sleep(250); }
        report.allocationLog = await exec(["/bin/sh", "-c", "cat /tmp/cowork-memprobe.log 2>/dev/null || true"]);
        check(report.allocationLog.includes('"phase":"allocated"'), "memory pages were not confirmed touched");
        await sample("allocated");
        await exec(["/bin/sh", "-c", "kill -USR1 $(cat /tmp/cowork-memprobe.pid)"]);
        for (let i = 0; i < 40; i++) { if ((await exec(["/bin/sh", "-c", "cat /tmp/cowork-memprobe.log 2>/dev/null || true"])).includes('"phase":"freed"')) break; await sleep(250); }
        report.freeLog = await exec(["/bin/sh", "-c", "cat /tmp/cowork-memprobe.log 2>/dev/null || true"]);
        check(report.freeLog.includes('"phase":"freed"'), "allocation was not confirmed freed");
        await sleep(2000); await sample("freed-without-balloon");
        if (phase === "memory-compact") {
          await exec(["/bin/sh", "-c", "mkdir -p /tmp/cowork-proc; mount -t proc proc /tmp/cowork-proc; trap 'umount /tmp/cowork-proc' EXIT; echo 1 > /tmp/cowork-proc/sys/vm/compact_memory"]);
          await sample("compacted-before-balloon");
        }
        if (config.pageGroups) {
          mark("balloon-before-ack-witness", await client.request({ method: "balloon", id: "probe", targetBytes: 257 * 1024 * 1024 }));
          report.pageGroupBeforeWitness = [];
          for (let attempt = 0; attempt < 20; attempt++) {
            await sleep(250);
            const observed = { groups: await pageGroups("compare"), counters: await exec(["/bin/sh", "-c", "grep '^balloon_' /proc/vmstat"]) };
            report.pageGroupBeforeWitness.push(observed);
            const recent = report.pageGroupBeforeWitness.slice(-3);
            if (recent.length === 3 && recent.every((value: any) => value.groups.currentBitmapDigest === recent[0].groups.currentBitmapDigest && value.counters === recent[0].counters) && /balloon_inflate 196352(?:\n|$)/.test(observed.counters)) break;
          }
          const recent = report.pageGroupBeforeWitness.slice(-3);
          check(recent.length === 3 && recent.every((value: any) => value.groups.currentBitmapDigest === recent[0].groups.currentBitmapDigest && value.counters === recent[0].counters) && /balloon_inflate 196352(?:\n|$)/.test(recent[0].counters) && /balloon_deflate 0(?:\n|$)/.test(recent[0].counters), "page-group observations did not stabilize before ACK witness");
        }
        mark("balloon-request", await client.request({ method: "balloon", id: "probe", targetBytes: 256 * 1024 * 1024 }));
        for (let i = 0; i < 4; i++) { await sleep(2000); await sample(`balloon-${i}`); }
        if (config.pageGroups) {
          const counters = await exec(["/bin/sh", "-c", "grep '^balloon_' /proc/vmstat"]);
          check(/balloon_inflate 196608(?:\n|$)/.test(counters) && /balloon_deflate 0(?:\n|$)/.test(counters), "additional balloon inflation ACK witness missing");
          const before = report.pageGroupBeforeWitness.at(-1).groups;
          report.pageGroupAcknowledgmentWitness = { previousInflatePages: 196352, subsequentInflatePages: 196608, noDeflation: true, observedGroups: before.newlyFullOffline16KiBGroups, observedGroupBytes: before.newlyFullOfflineBytes, touchedOverlapLowerBoundBytes: Math.max(0, before.newlyFullOfflineBytes + 384 * 1024 ** 2 - 1024 ** 3), hostReclaimVerified: false, counters };
          report.pageGroupAfterWitness = await pageGroups("compare");
          mark("page-group-ack-witness", report.pageGroupAcknowledgmentWitness);
        }
        mark("balloon-deflate", await client.request({ method: "balloon", id: "probe", targetBytes: 1024 * 1024 * 1024 }));
        await sleep(1000);
        await exec(["/bin/sh", "-c", "kill -TERM $(cat /tmp/cowork-memprobe.pid)"]);
        check((await memoryRun).exitCode === 0, "memory workload did not exit cleanly");
        memoryRun = undefined;
        await exec(["/opt/cowork-fixture/memprobe", "384", "1"], 20);
        await sample("reallocated-after-deflation");
        report.memoryObservation = memoryObservation(report);
        mark("memory-observation", report.memoryObservation);
        report.memoryConclusion = "Measurements only: target readback is not proof of reclaim; inspect backing-service footprint, compression/swap and successful reallocation.";
      }
      report.beforeStop = await hostMetrics();
    }
    report.status = "passed-selected-checks";
  } catch (error) {
    report.status = "failed";
    report.error = String(error);
    console.error(report.error);
  } finally {
    if (memoryRun) {
      try { await exec(["/bin/sh", "-c", "kill -TERM $(cat /tmp/cowork-memprobe.pid) 2>/dev/null || true"]); await memoryRun; }
      catch (error) { report.memoryCleanupError = String(error); }
    }
    if (created) {
      try {
        const stop = await client.request({ method: "stop", id: "probe" }, 30_000);
        report.stop = stop;
        stopped = stop.stopped === true && (stop.vzStoppedObserved === true || stop.vmWasCreated === false);
        if (!stopped || stop.flushSucceeded !== true) { report.status = "failed"; report.stopUncertain = true; }
      } catch (error) { report.status = "failed"; report.stopError = String(error); }
    }
    clearInterval(heartbeat);
    report.maxHeartbeatDelayMs = maxHeartbeatDelayMs;
    report.events = client.events;
    report.after = await hostMetrics();
    report.completedAt = new Date().toISOString();
    report.fixtureRetained = true;
    writeFileSync(join(fixtureRoot, `${phase}-report.json`), JSON.stringify(report, null, 2));
    writeFileSync(join(fixtureRoot, "owner.json"), JSON.stringify({ pid: process.pid, stopped: !created || stopped, phase, status: report.status }));
    client.close();
    if (!created || stopped) rmdirSync(claim); // Uncertain termination deliberately retains exclusive claim.
  }
  console.log(JSON.stringify({ type: "result", phase, status: report.status, report: join(fixtureRoot, `${phase}-report.json`), gate1Passed: false }));
  process.exit(report.status === "passed-selected-checks" ? 0 : 1);
}
main().catch(error => { console.error(String(error)); process.exit(1); });
