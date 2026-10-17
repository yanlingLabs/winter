/** Shared by the N2 S6 tests: a real `CoworkAdmissionLedger` on a disposable path, plus the home port the probes leave injected. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkAdmissionLedger, type AdmissionProbes, type HostPreparedHomeBinding, type ResourceObservation } from "../../../src/cowork/admission";

export function ledgerFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-n2-ledger-")));
  const path = join(root, "coordination/cowork-admission.sqlite"), persisted = new Map<string, HostPreparedHomeBinding>(), handles: CoworkAdmissionLedger[] = [];
  const homeIdentity: AdmissionProbes["homeIdentity"] = atPath => {
    try { const canonicalPath = realpathSync(atPath), stat = statSync(canonicalPath), binding = persisted.get(canonicalPath); return binding ? { canonicalPath, volumeId: `dev-${stat.dev}`, directoryId: `inode-${stat.ino}`, canonicalDbBinding: { ...binding } } : null; } catch { return null; }
  };
  const makeHome = (homeId: string, machine: string, installation: string): HostPreparedHomeBinding => {
    const canonicalPath = join(root, "homes", homeId); mkdirSync(canonicalPath, { recursive: true });
    const stat = statSync(canonicalPath), binding = { homeId, canonicalPath, volumeId: `dev-${stat.dev}`, directoryId: `inode-${stat.ino}`, originMachineId: machine, originInstallationId: installation };
    persisted.set(canonicalPath, binding); return binding;
  };
  const open = (probes: AdmissionProbes, observeResources: () => ResourceObservation | null, now: () => number) => {
    const ledger = new CoworkAdmissionLedger({ path, domainId: "n2-pressure-domain", probes, observeResources, now, heartbeatTimeoutMs: 60_000 });
    handles.push(ledger); return ledger;
  };
  return { root, path, homeIdentity, makeHome, open, dispose() { for (const handle of handles.splice(0)) handle.close(); rmSync(root, { recursive: true, force: true }); } };
}
