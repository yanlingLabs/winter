import { createHash } from "node:crypto";
import { posix } from "node:path";
import { COWORK_CONTEXT_MAX_BYTES } from "./current-context";
import { COWORK_INSTRUCTION_MAX_FILES, COWORK_SHARED_INSTRUCTION_VIEW, CoworkContextResolverError, normalizeCoworkInstructionReadResult,
  type CoworkInstructionReadRequest, type CoworkInstructionReadResult, type CoworkInstructionBlock, type CoworkInstructionFile, type CoworkInstructionTier } from "./current-context-resolver";

const SHARED_ALIAS = "/workspace/.winter/WINTER.md";
const SHARED_FILE = `${COWORK_SHARED_INSTRUCTION_VIEW}/WINTER.md`;
interface Block { requestedPath: string; admittedPath: string; text: string; textSha256: string; tier: CoworkInstructionTier }
interface Provenance extends Block { depth: number; importerPath?: string; importerAdmittedPath?: string }
const fail = (): never => { throw new CoworkContextResolverError("context_unavailable"); };
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function closed(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).some(key => typeof key !== "string" || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(fields, key)) || Object.values(fields).some(field => !("value" in field))) return fail();
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
}
interface BoundedList { value: unknown[]; count: number }
function listLength(value: unknown, max: number): BoundedList {
  if (!Array.isArray(value)) return fail();
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > max) return fail();
  return { value, count: length.value as number };
}
function list(input: BoundedList): unknown[] {
  const fields = Object.getOwnPropertyDescriptors(input.value) as unknown as Record<string, PropertyDescriptor>, length = fields["length"];
  if (!length || !("value" in length) || length.value !== input.count || Reflect.ownKeys(fields).length !== input.count + 1
    || Object.values(fields).some(field => !("value" in field))) return fail();
  if (Array.from({ length: input.count }, (_, i) => Object.hasOwn(fields, String(i))).some(present => !present)) return fail();
  return Array.from({ length: input.count }, (_, i) => fields[String(i)]!.value);
}

function path(value: unknown): string {
  if (typeof value !== "string" || bytes(value) > 4096 || !value.startsWith("/") || /[\\\0\r\n]/.test(value)
    || posix.normalize(value) !== value || value.split("/").includes("..")) return fail();
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.includes("\0") || bytes(value) > max) return fail();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return fail();
  return value;
}
function record(value: unknown, raw: boolean): Provenance {
  const v = closed(value, ["requestedPath", "admittedPath", "text", "textSha256", "tier", ...(raw ? ["depth"] : [])], raw ? ["importerPath", "importerAdmittedPath"] : []);
  const requestedPath = path(v.requestedPath), admittedPath = path(v.admittedPath), body = text(v.text, COWORK_CONTEXT_MAX_BYTES), textSha256 = hash(v.textSha256);
  if (sha(body) !== textSha256 || typeof v.tier !== "string" || !["workspace", "project", "local"].includes(v.tier)) return fail();
  if (raw && (!Number.isSafeInteger(v.depth) || (v.depth as number) < 0 || (v.depth as number) > 5)) return fail();
  if (!raw && !body.endsWith("\n")) return fail();
  const result: Provenance = { requestedPath, admittedPath, text: body, textSha256, tier: v.tier as CoworkInstructionTier, depth: raw ? v.depth as number : 0 };
  for (const key of ["importerPath", "importerAdmittedPath"] as const) if (Object.hasOwn(v, key)) result[key] = path(v[key]);
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Pure v1 projection from structured SDK data. The request MUST be supplied by the owning host
 * resolver, never caller JSON. This function checks data; it grants no filesystem/native authority. */
export function mapStructuredCoworkInstructions(value: unknown, canonicalHostRequest: CoworkInstructionReadRequest): Readonly<CoworkInstructionReadResult> {
  try {
    if (canonicalHostRequest.sharedImportRoot !== COWORK_SHARED_INSTRUCTION_VIEW || canonicalHostRequest.scopes.shared.path !== SHARED_ALIAS) return fail();
    const v = closed(value, ["text", "digest", "files", "skippedLinks", "droppedImports", "tiers", "blocks", "provenance"]);
    if (v.tiers !== "admitted-only") return fail();
    // Bound ALL five array lengths before enumerating any elements or their descriptors.
    const shapes = { blocks: listLength(v.blocks, COWORK_INSTRUCTION_MAX_FILES), provenance: listLength(v.provenance, COWORK_INSTRUCTION_MAX_FILES),
      files: listLength(v.files, COWORK_INSTRUCTION_MAX_FILES), skippedLinks: listLength(v.skippedLinks, 0), droppedImports: listLength(v.droppedImports, 0) };
    list(shapes.skippedLinks); list(shapes.droppedImports);
    const aggregate = text(v.text, COWORK_CONTEXT_MAX_BYTES), digest = hash(v.digest);
    const blocks = list(shapes.blocks).map(item => record(item, false));
    const provenance = list(shapes.provenance).map(item => record(item, true));
    const legacy = list(shapes.files);
    if (blocks.length === 0 || provenance.length === 0 || legacy.length !== provenance.length
      || [...blocks, ...provenance].reduce((sum, file) => sum + bytes(file.text), 0) > COWORK_CONTEXT_MAX_BYTES * 2) return fail();
    // Recompose from exact structured bodies, never parse attacker-controlled headings.
    if (blocks.map(b => `# ${b.requestedPath}\n\n${b.text}`).join("\n") !== aggregate || sha(aggregate) !== digest) return fail();
    for (let i = 0; i < legacy.length; i++) {
      const f = closed(legacy[i], ["path", "tier", "sha256", "imported"], ["requestedPath"]), p = provenance[i]!;
      if (path(f.path) !== p.admittedPath || f.tier !== p.tier || hash(f.sha256) !== p.textSha256 || f.imported !== (p.depth > 0)) return fail();
      const requested = p.depth === 0 && p.requestedPath !== p.admittedPath ? p.requestedPath : undefined;
      if (requested === undefined ? Object.hasOwn(f, "requestedPath") : !Object.hasOwn(f, "requestedPath") || path(f.requestedPath) !== requested) return fail();
    }
    // The physical shared top-level name is the ONE supported alias. Actual identities stay intact.
    if (blocks[0]!.requestedPath !== SHARED_FILE || blocks[0]!.tier !== "workspace"
      || provenance[0]!.requestedPath !== SHARED_FILE || provenance[0]!.depth !== 0 || provenance[0]!.tier !== "workspace") return fail();
    const projectedBlocks: CoworkInstructionBlock[] = blocks.map((b, i) => {
      if (i !== 0 && b.requestedPath === SHARED_FILE) return fail();
      return { requestedPath: i === 0 ? SHARED_ALIAS : b.requestedPath, admittedPath: b.admittedPath, text: b.text, sha256: b.textSha256, tier: b.tier };
    });
    const lineage: Provenance[] = [];
    const projectedFiles: CoworkInstructionFile[] = provenance.map((p, i) => {
      if (p.depth > lineage.length) return fail();
      lineage.length = p.depth;
      const parent = p.depth === 0 ? undefined : lineage[p.depth - 1];
      const sharedTop = i === 0 && p.depth === 0;
      if (p.requestedPath === SHARED_FILE && !sharedTop) return fail();
      let importer = p.importerPath;
      if (importer === SHARED_FILE) {
        if (p.depth !== 1 || parent !== provenance[0]) return fail();
        importer = SHARED_ALIAS;
      }
      lineage.push(p);
      return { requestedPath: sharedTop ? SHARED_ALIAS : p.requestedPath,
        admittedPath: p.admittedPath, text: p.text, sha256: p.textSha256, tier: p.tier, depth: p.depth,
        ...(importer !== undefined ? { importerPath: importer } : {}),
        ...(p.importerAdmittedPath !== undefined ? { importerAdmittedPath: p.importerAdmittedPath } : {}) };
    });
    return freeze(normalizeCoworkInstructionReadResult({ request: canonicalHostRequest, tiers: "admitted-only", blocks: projectedBlocks, files: projectedFiles }, canonicalHostRequest));
  } catch { throw new CoworkContextResolverError("context_unavailable"); }
}
