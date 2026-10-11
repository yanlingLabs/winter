import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, statfsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { GitPublicationError, type GitExecutor, type PublicationAuthority, type PublicationGrant, type PublicationJournal, type PublicationReceipt, type PublicationRequest, type PublicationTransport, type Publisher } from "./types";

const OID = /^[a-f0-9]{40}$/;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
export interface BrokerOptions {
  /** Already prepared host-private directory. Production must additionally fence it from host tools. */
  quarantineRoot: string; authority: PublicationAuthority; transport: PublicationTransport; journal: PublicationJournal; git: GitExecutor;
  /** Required explicit fixture opt-in; production door remains blocked in this slice. */
  isolatedFixture?: boolean;
  limits?: Partial<{ bundleBytes: number; diskBytes: number; expandedObjectBytes: number; objects: number; minimumFreeBytes: number }>;
}
function deny(code: ConstructorParameters<typeof GitPublicationError>[0]): never { throw new GitPublicationError(code); }
function sameGrant(a: PublicationGrant, b: PublicationGrant): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function branch(ref: string): boolean {
  return typeof ref === "string" && ref.startsWith("refs/heads/") && ref.length <= 240 && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(ref)
    && !ref.includes("..") && !ref.includes("@{") && !ref.endsWith(".")
    && ref.split("/").every(part => !!part && !part.startsWith(".") && !part.endsWith(".lock"));
}
/** Single-ref publication boundary; never runs guest commands/config or receives credentials. */
export class CoworkGitPublicationBroker {
  private readonly limits: { bundleBytes: number; diskBytes: number; expandedObjectBytes: number; objects: number; minimumFreeBytes: number };
  constructor(private readonly options: BrokerOptions) {
    const root = options.quarantineRoot;
    if (!root || !isAbsolute(root)) deny("invalid_request");
    let stat: ReturnType<typeof lstatSync>;
    try { if (realpathSync(root) !== root) deny("invalid_request"); stat = lstatSync(root); }
    catch { deny("invalid_request"); }
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) deny("invalid_request");
    this.limits = { bundleBytes: 8_388_608, diskBytes: 33_554_432, expandedObjectBytes: 67_108_864, objects: 10_000, minimumFreeBytes: 134_217_728, ...options.limits };
    if (Object.values(this.limits).some(n => !Number.isSafeInteger(n) || n <= 0)) deny("invalid_request");
  }
  availability(): { available: false; reason: "host_auth_and_service_integration_required" } { return { available: false, reason: "host_auth_and_service_integration_required" }; }
  async publish(publisher: Publisher, incoming: PublicationRequest, signal?: AbortSignal): Promise<PublicationReceipt> {
    if (!this.options.isolatedFixture) deny("integration_unavailable");
    if (!incoming || !(incoming.bundle instanceof Uint8Array) || incoming.bundle.length === 0 || incoming.bundle.length > this.limits.bundleBytes) deny("invalid_request");
    publisher = Object.freeze({ principalId: publisher.principalId, sessionId: publisher.sessionId, taskId: publisher.taskId });
    // Copy untrusted bytes before awaiting, so a guest transfer buffer cannot mutate after hashing.
    const request: PublicationRequest = { requestId: incoming.requestId, workspaceId: incoming.workspaceId, sourceId: incoming.sourceId,
      sourceRevision: incoming.sourceRevision, publicationRevision: incoming.publicationRevision,
      ref: incoming.ref, oldOid: incoming.oldOid, newOid: incoming.newOid, bundle: Uint8Array.from(incoming.bundle) };
    if (![publisher.principalId, publisher.sessionId, publisher.taskId, request.requestId, request.workspaceId, request.sourceId].every(v => typeof v === "string" && ID.test(v))
      || !Number.isSafeInteger(request.sourceRevision) || request.sourceRevision < 1 || !Number.isSafeInteger(request.publicationRevision) || request.publicationRevision < 1
      || !branch(request.ref) || !OID.test(request.newOid) || /^0+$/.test(request.newOid)
      || (request.oldOid !== null && (!OID.test(request.oldOid) || /^0+$/.test(request.oldOid))) || request.oldOid === request.newOid
      || request.bundle.length === 0 || request.bundle.length > this.limits.bundleBytes) deny("invalid_request");
    if (signal?.aborted) deny("cancelled");
    const grant = await this.authorize(publisher, request);
    const digest = createHash("sha256").update(JSON.stringify({ publisher, workspaceId: request.workspaceId, sourceId: request.sourceId, grant,
      sourceRevision: request.sourceRevision, publicationRevision: request.publicationRevision, ref: request.ref, oldOid: request.oldOid, newOid: request.newOid,
      bundleHash: createHash("sha256").update(request.bundle).digest("hex") })).digest("hex");
    const key = JSON.stringify([publisher.principalId, request.workspaceId, request.requestId]);
    let claimed: Awaited<ReturnType<PublicationJournal["claim"]>>;
    try { claimed = await this.options.journal.claim(key, { operationId: randomUUID(), digest, status: "prepared", repositoryId: grant.repositoryId, ref: request.ref, oldOid: request.oldOid, newOid: request.newOid }); }
    catch { return deny("command_failed"); }
    const transition = async (from: PublicationReceipt["status"], to: PublicationReceipt["status"]) => {
      try { return await this.options.journal.transition(key, from, to); } catch { return deny("command_failed"); }
    };
    if (!claimed.created) {
      if (claimed.receipt.digest !== digest) deny("request_conflict");
      // Authority is checked above even for a stored receipt. Never redispatch prepared or uncertain work.
      return claimed.receipt;
    }
    let quarantine: string | undefined, dispatched = false;
    try {
      const first = await this.options.transport.observe(grant, request.ref, signal);
      this.checkObservation(grant, request, first);
      quarantine = await mkdtemp(join(this.options.quarantineRoot, "publication-"));
      const home = join(quarantine, "home"), repo = join(quarantine, "objects.git"), bundle = join(quarantine, "input.bundle");
      await mkdir(home, { mode: 0o700 }); await writeFile(bundle, request.bundle, { mode: 0o600 });
      const withinBudget = () => this.diskBudget(quarantine!);
      const run = async (args: string[], allowNonzero = false) => {
        if (signal?.aborted) deny("cancelled"); if (!withinBudget()) deny("object_budget");
        const result = await this.options.git.run({ cwd: quarantine!, home, args, signal, withinBudget });
        if (!allowNonzero && result.code !== 0) deny("invalid_bundle");
        if (!withinBudget()) deny("object_budget"); return result;
      };
      // Initial bounded slice deliberately accepts only full SHA-1 v2 bundles, not filtered/thin packs.
      const headerEnd = Buffer.from(request.bundle).indexOf("\n\n");
      if (headerEnd < 0 || headerEnd > 4096 || Buffer.from(request.bundle).subarray(0, headerEnd).toString() !== `# v2 git bundle\n${request.newOid} ${request.ref}`) deny("invalid_bundle");
      await run(["init", "--bare", "--template=", repo]);
      const git = (...args: string[]) => ["--git-dir", repo, ...args];
      if ((await run(git("bundle", "list-heads", bundle))).stdout.trim() !== `${request.newOid} ${request.ref}`) deny("invalid_bundle");
      await run(git("bundle", "verify", bundle));
      await run(git("bundle", "unbundle", bundle));
      let objects = 0, expanded = 0;
      for (const file of readdirSync(join(repo, "objects", "pack")).filter(file => file.endsWith(".idx"))) {
        const rows = (await run(git("verify-pack", "-v", join(repo, "objects", "pack", file)))).stdout.split("\n");
        for (const row of rows) {
          if (!/^[a-f0-9]{40} /.test(row)) continue;
          const size = Number(row.trim().split(/\s+/)[2]); objects++; expanded += size;
          if (!Number.isSafeInteger(size) || size < 0 || objects > this.limits.objects || expanded > this.limits.expandedObjectBytes) deny("object_budget");
        }
      }
      await run(git("fsck", "--strict", "--full", "--no-reflogs", request.newOid));
      if ((await run(git("cat-file", "-t", request.newOid))).stdout.trim() !== "commit") deny("invalid_bundle");
      if (request.oldOid !== null) {
        if ((await run(git("cat-file", "-t", request.oldOid), true)).stdout.trim() !== "commit") deny("non_fast_forward");
        if ((await run(git("merge-base", "--is-ancestor", request.oldOid, request.newOid), true)).code !== 0) deny("non_fast_forward");
      }
      // Revalidate after untrusted object processing and immediately before handing the host adapter a plan.
      if (!sameGrant(grant, await this.authorize(publisher, request))) deny("revision_conflict");
      this.checkObservation(grant, request, await this.options.transport.observe(grant, request.ref, signal));
      if (signal?.aborted) deny("cancelled");
      await transition("prepared", "dispatched"); dispatched = true;
      if (signal?.aborted) {
        // Journal I/O may have yielded to cancellation. No external-effect adapter has
        // been invoked yet; persist that rejection and never replay this request.
        await transition("dispatched", "rejected"); deny("cancelled");
      }
      let outcome: "applied" | "rejected" | "uncertain";
      try {
        outcome = await this.options.transport.push(grant, { quarantine: repo, ref: request.ref, oldOid: request.oldOid, newOid: request.newOid,
          refspec: `${request.newOid}:${request.ref}`, lease: `--force-with-lease=${request.ref}:${request.oldOid ?? ""}` }, signal);
        if (!["applied", "rejected", "uncertain"].includes(outcome)) outcome = "uncertain";
      } catch { outcome = "uncertain"; }
      return await transition("dispatched", outcome);
    } catch (error) {
      if (!dispatched) await transition("prepared", "rejected");
      if (error instanceof GitPublicationError) throw error;
      throw new GitPublicationError("command_failed");
    } finally {
      if (quarantine) { try { await rm(quarantine, { recursive: true, force: true }); } catch { deny("command_failed"); } }
    }
  }
  private async authorize(publisher: Publisher, request: PublicationRequest): Promise<PublicationGrant> {
    let grant: PublicationGrant;
    try { grant = await this.options.authority.authorize(publisher, request); } catch { return deny("authority_denied"); }
    if (!grant || ![grant.repositoryId, grant.destinationId, grant.authorityId].every(v => typeof v === "string" && ID.test(v)) || !Number.isSafeInteger(grant.authorityRevision) || grant.authorityRevision < 1) deny("authority_denied");
    if (grant.sourceRevision !== request.sourceRevision || grant.publicationRevision !== request.publicationRevision) deny("revision_conflict");
    return Object.freeze({ repositoryId: grant.repositoryId, destinationId: grant.destinationId, authorityId: grant.authorityId,
      authorityRevision: grant.authorityRevision, sourceRevision: grant.sourceRevision, publicationRevision: grant.publicationRevision });
  }
  private checkObservation(grant: PublicationGrant, request: PublicationRequest, remote: Awaited<ReturnType<PublicationTransport["observe"]>>): void {
    if (remote.repositoryId !== grant.repositoryId || remote.destinationId !== grant.destinationId) deny("authority_denied");
    if (!branch(remote.defaultRef) || remote.protection !== "unprotected" || request.ref === remote.defaultRef || request.ref === "refs/heads/main" || request.ref === "refs/heads/master") deny("ref_denied");
    if (remote.currentOid !== null && !OID.test(remote.currentOid)) deny("ref_denied");
    if (remote.currentOid !== request.oldOid) deny("remote_conflict");
  }
  private diskBudget(root: string): boolean {
    const fs = statfsSync(this.options.quarantineRoot); if (fs.bavail * fs.bsize < this.limits.minimumFreeBytes) return false;
    let bytes = 0, entries = 0;
    const visit = (path: string): boolean => {
      let stat: ReturnType<typeof lstatSync>;
      try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && path !== root) return true; throw error; }
      bytes += stat.size; entries++;
      if (stat.isSymbolicLink() || bytes > this.limits.diskBytes || entries > this.limits.objects * 2 + 100) return false;
      if (!stat.isDirectory()) return true;
      try { return readdirSync(path).every(name => visit(join(path, name))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && path !== root) return true; throw error; }
    };
    return visit(root);
  }
}
