import {
  COWORK_DECISIONS, COWORK_DYNAMIC_TOOL_FAMILIES, COWORK_HOST_ACCESS_REFUSALS, COWORK_READINESS, COWORK_TOOL_ALLOWLIST, COWORK_TOOL_DENYLIST,
  COWORK_UNBUILT_CAPABILITY_SERVERS, coworkSystemPrompt, type CoworkPromptFacts,
} from "../../src/cowork/session-profile";

/*
 * Renders every generated block of docs/cowork-prompt-and-tools.md from the module's data. The test compares each
 * block with the document EXACTLY, so an edit to a cell, a status or a decision recommendation in the document that
 * the code does not carry fails. `COWORK_PROFILE_DOC_UPDATE=1 bun test test/cowork/session-profile.test.ts`
 * rewrites the blocks from the code instead of comparing (the document's other text is commentary and is left alone).
 */

const FILES: Record<string, string> = { spec: "cowork-spec.md", contracts: "cowork-execution-contracts.md", protocol: "cowork-host-protocol.md" };
const slug = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");
const cell = (text: string) => text.replace(/\|/g, "\\|");

/** `spec#Heading` -> a link; `code#path#symbol` -> the symbol in its file; `house#Export` -> the export in mode-options.ts. */
export function renderCite(value: string): string {
  const [kind, ...rest] = value.split("#");
  if (kind === "house") return `\`${rest.join("#")}\` in \`mode-options.ts\``;
  if (kind === "code") return `\`${rest[1]}\` in [\`${rest[0]!.split("/").pop()}\`](../${rest[0]})`;
  const target = rest.join("#");
  return `[${kind}: ${target}](${FILES[kind!]}#${slug(target)})`;
}
const cites = (values: readonly string[]) => values.map(renderCite).join("<br>");

const BROKER: Record<string, string> = { "provider-gateway": "provider gateway", network: "network policy", messaging: "message broker", scheduler: "schedule broker", questions: "question and approval cards" };
const WHEN: Record<string, string> = {
  "exa-key": "only while an Exa key is stored", "no-exa-key": "only while no Exa key is stored", "mcp-servers": "only when an MCP server is admitted",
  "mcp-servers-tool-search-off": "only when an MCP server is admitted and Tool Search is off", "tool-search-needed": "only when Tool Search is on and something is deferred",
};
const KIND: Record<string, string> = {
  never: "Never (the spec forbids it)", "opt-in": "Off by default (separate host capability)", "not-specified": "Not in the spec", "visible-unavailable": "Unavailable, with a visible reason",
};
const code = (text: string) => `\`${text}\``;

function allowlist(): string {
  const rows = COWORK_TOOL_ALLOWLIST.map((row) => {
    const depends = [
      ...row.brokers.map((broker) => BROKER[broker]!), ...(row.when ? [WHEN[row.when]!] : []),
      ...(row.onlyUnder ? [`only under ${row.onlyUnder.join(", ")}`] : []), ...(row.deniedUnder ? [`not under ${row.deniedUnder.join(", ")}`] : []),
    ].join("; ") || "none";
    const notes = [
      row.needs ? `Needs ${row.needs.map(code).join(", ")}.` : "", row.deferred ? "Starts deferred." : "", row.decision ? `Decision ${row.decision}.` : "",
    ].filter(Boolean).join(" ");
    return `| ${code(row.name)} | ${row.runs} | ${row.classes ? row.classes.join(" + ") : "none"} | ${cell(depends)} | ${cell(row.why)} | ${cites(row.cite)} | ${cell(notes)} |`;
  });
  return ["| Tool | Runs | Class | Depends on | Why | Spec source | Notes |", "| --- | --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function denylist(): string {
  const rows = COWORK_TOOL_DENYLIST.map((row) =>
    `| ${code(row.name)} | ${row.runs}${row.server ? ` (server ${code(row.server)})` : ""} | ${KIND[row.kind]} | ${cell(row.why)} | ${cites(row.cite)} | ${row.decision ?? ""} |`);
  return ["| Tool | Runs | Status | Why | Spec source | Decision |", "| --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function servers(): string {
  const rows = COWORK_UNBUILT_CAPABILITY_SERVERS.map((row) => `| ${code(row.key)} | ${KIND[row.kind]} | ${cell(row.why)} | ${cites(row.cite)} |`);
  return ["| Server | Status | Why | Spec source |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function refusals(): string {
  const rows = COWORK_HOST_ACCESS_REFUSALS.map((row) => `| ${code(row.id)} | ${cell(row.rule)} | ${cites(row.cite)} |`);
  return ["| Id | Rule | Spec source |", "| --- | --- | --- |", ...rows].join("\n");
}

function families(): string {
  const rows = COWORK_DYNAMIC_TOOL_FAMILIES.map((row) => `| ${code(row.pattern)} | ${row.runs} | ${cell(row.gate)} | ${cites(row.cite)} |`);
  return ["| Pattern | Runs | Gate | Spec source |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function readiness(): string {
  const rows = Object.entries(COWORK_READINESS).map(([key, text]) =>
    `| ${code(key)} | ${cell(text)} | ${COWORK_TOOL_ALLOWLIST.filter((row) => row.needs?.includes(key as keyof typeof COWORK_READINESS)).map((row) => code(row.name)).join(", ")} |`);
  return ["| Readiness key | What must exist | Tools withheld until it is declared |", "| --- | --- | --- |", ...rows].join("\n");
}

function summary(): string {
  const guest = COWORK_TOOL_ALLOWLIST.filter((row) => row.runs === "guest").length, host = COWORK_TOOL_ALLOWLIST.length - guest;
  const withheld = COWORK_TOOL_ALLOWLIST.filter((row) => row.needs !== undefined).length;
  const open = COWORK_DECISIONS.filter((decision) => decision.status === "open").length;
  return [
    `- **${COWORK_TOOL_ALLOWLIST.length}** allowlisted tools: **${guest}** run in the guest and **${host}** are host brokers.`,
    `- **${withheld}** of them are withheld by default until the host declares the readiness key they need.`,
    `- **${COWORK_TOOL_DENYLIST.length}** tools and **${COWORK_UNBUILT_CAPABILITY_SERVERS.length}** capability servers are not offered.`,
    `- **${open}** open decisions for the owner; **${COWORK_DECISIONS.length - open}** settled by the spec.`,
  ].join("\n");
}

function decisions(status: "open" | "settled"): string {
  return COWORK_DECISIONS.filter((decision) => decision.status === status).map((decision) => {
    const head = `### ${decision.id} — ${decision.title}`;
    const body = decision.status === "open"
      ? [`**Recommended:** ${decision.recommended}`, `**Instead:** ${decision.instead}`, decision.why]
      : [`**Settled:** ${decision.resolution}`, decision.why];
    return [head, ...body, `*Spec and code sources:* ${decision.cite.map(renderCite).join("; ")}`].join("\n\n");
  }).join("\n\n");
}

/** The facts the document's sample renders. Every readiness key is declared, so the sample is the finished prompt. */
export const DOC_SAMPLE: CoworkPromptFacts = {
  workspaceTitle: "Billing service", ownership: "project", sessionId: "s_4f2a91c0", approvalPolicy: "auto",
  toolClasses: ["read", "write", "execute"], network: "internet", readiness: Object.keys(COWORK_READINESS) as (keyof typeof COWORK_READINESS)[],
};

export function renderDocBlocks(): Record<string, string> {
  return {
    summary: summary(), "prompt-sample": ["```text", coworkSystemPrompt(DOC_SAMPLE), "```"].join("\n"), readiness: readiness(),
    allowlist: allowlist(), families: families(), denylist: denylist(), servers: servers(), refusals: refusals(),
    "decisions-open": decisions("open"), "decisions-settled": decisions("settled"),
  };
}

const marker = (name: string, edge: "begin" | "end") => `<!-- ${name}:${edge} -->`;

/** The text between a block's markers, or undefined when a marker is missing. */
export function readBlock(doc: string, name: string): string | undefined {
  const from = doc.indexOf(marker(name, "begin")), to = doc.indexOf(marker(name, "end"));
  if (from < 0 || to < from) return undefined;
  return doc.slice(from + marker(name, "begin").length, to).replace(/^\n/, "").replace(/\n$/, "");
}

/** Every block that does not match, by name. Empty when the document carries exactly what the code renders. */
export function docBlockProblems(doc: string, blocks: Record<string, string> = renderDocBlocks()): string[] {
  return Object.entries(blocks).filter(([name, expected]) => readBlock(doc, name) !== expected).map(([name]) => name);
}

/** The document with every block replaced by what the code renders. */
export function syncDocBlocks(doc: string, blocks: Record<string, string> = renderDocBlocks()): string {
  let out = doc;
  for (const [name, content] of Object.entries(blocks)) {
    const begin = marker(name, "begin"), end = marker(name, "end"), from = out.indexOf(begin), to = out.indexOf(end);
    if (from < 0 || to < from) throw new Error(`docs/cowork-prompt-and-tools.md has no ${name} block`);
    out = `${out.slice(0, from + begin.length)}\n${content}\n${out.slice(to)}`;
  }
  return out;
}
