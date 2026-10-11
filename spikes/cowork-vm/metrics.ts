import { spawn } from "node:child_process";

export async function command(file: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", settled = false;
    const finish = (value: string) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish("unavailable(timeout)"); }, 10_000);
    child.stdout.on("data", data => { if (output.length < 4 * 1024 * 1024) output += data.toString(); });
    child.stderr.resume();
    child.on("error", () => finish("unavailable(spawn failed)"));
    child.on("close", code => finish(code === 0 ? output.trim() : `unavailable(exit=${code})`));
  });
}
/** Executable names only, never other applications' command-line arguments. */
export async function processes() {
  return (await command("/bin/ps", ["-axo", "pid=,ppid=,rss=,comm="])).split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    const row = { pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), executable: match[4]! };
    return row.pid === process.pid || /Virtualization.*VirtualMachine|VirtualMachine.*Virtualization/.test(row.executable) ? [row] : [];
  });
}
export async function hostMetrics() {
  const [rows, vmStat, swap] = await Promise.all([processes(), command("/usr/bin/vm_stat", []), command("/usr/sbin/sysctl", ["vm.swapusage"])]);
  return { at: new Date().toISOString(), controllerPid: process.pid, processes: rows, vmStat, swap };
}
export async function footprint(pid: number) {
  const text = await command("/usr/bin/footprint", ["-p", String(pid)]);
  return { pid, summary: text.split("\n").filter(line => /footprint|phys_footprint|Physical|unavailable/i.test(line)).slice(0, 20) };
}

/** Passive diagnostics for the single newly observed probe backing service only. */
export async function memoryCategories(pid: number) {
  const [footprintCategories, vmmapSummary] = await Promise.all([
    command("/usr/bin/footprint", ["-f", "bytes", "--swapped", "--wired", "-p", String(pid)]),
    command("/usr/bin/vmmap", ["-summary", String(pid)]),
  ]);
  return { pid, footprintCategories, vmmapSummary };
}
