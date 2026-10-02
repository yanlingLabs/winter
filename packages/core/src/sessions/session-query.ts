// ListSessions' free-form `query` (user ruling 2026-10-02): "the session that edited
// ~/projects/winter/config.toml", "the login bug from yesterday", "last week's build fix". Interpreted
// HERE, by plain structured/lexical rules — no embeddings, no model call — so the same query over the
// same sessions at the same instant always ranks the same way (the tests pin it).
//
// What a query is read as:
//   - DATE phrases → a local-time range a session's span [created, last event] must overlap: today,
//     yesterday, this/last week, this/last month, N days/weeks ago, a weekday name ("monday", "last
//     friday" — the most recent one, today counting), a month name ("september"), an ISO date.
//   - PATHS → any token with a `/`, a leading `~`, or a file extension: matched against the files the
//     session EDITED (the store's edited-files index) and its working directory.
//   - WORDS (everything else, minus filler) → matched against the title, the first message, the cwd and
//     the edited files' paths.
// A session scores by what it matched; only sessions that matched something are returned, best first,
// then most recent, then by id.
import { homedir } from "node:os";
import { basename } from "node:path";

export interface QueryableSession {
  sessionId: string;
  title?: string;
  firstMessage?: string;
  cwd?: string;
  createdAt: number;
  lastEventTs: number;
  editedFiles: readonly string[];
}

export interface ParsedSessionQuery {
  words: string[];
  paths: string[];
  ranges: Array<{ from: number; to: number; label: string }>;
}

export interface RankedSession {
  session: QueryableSession;
  score: number;
  /** Short human reasons, for the listing ("edited /x/config.toml", "active yesterday", "title: login"). */
  why: string[];
}

const FILLER = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "for", "with", "about", "from", "by", "into",
  "that", "which", "where", "when", "what", "who", "whose", "this", "these", "those", "it", "its",
  "i", "me", "my", "we", "our", "you", "your", "was", "were", "is", "are", "be", "been", "did", "do", "does",
  "session", "sessions", "edited", "edit", "edits", "changed", "touched", "worked", "work", "working", "find", "show",
  "one", "some", "any", "there", "had", "has", "have", "ago", "day", "days", "week", "weeks", "month", "months",
]);
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function dayRange(start: number, days: number, label: string): { from: number; to: number; label: string } {
  const d = new Date(start);
  return { from: start, to: new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime(), label };
}
/** `t` (a local midnight) moved by `days` calendar days — DST-safe, unlike adding `days * DAY_MS`. */
function addDays(t: number, days: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}
/** Monday-based week start, local time. */
function startOfWeek(t: number): number {
  const d = new Date(startOfDay(t));
  const offset = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset).getTime();
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return `${homedir()}${p.slice(1)}`;
  return p;
}

function looksLikePath(token: string): boolean {
  return token.includes("/") || token.startsWith("~") || /^[^\s/]+\.[a-z0-9]{1,8}$/i.test(token);
}

/** Read a free-form query into words, paths and date ranges, against the instant `now` (local time). */
export function parseSessionQuery(query: string, now: number): ParsedSessionQuery {
  const ranges: ParsedSessionQuery["ranges"] = [];
  const paths: string[] = [];
  const words: string[] = [];
  const raw = query.trim().split(/\s+/).filter((t) => t.length > 0);
  const lower = raw.map((t) => t.toLowerCase().replace(/^[("'`]+|[)"'`,.;:!?]+$/g, ""));
  const today = startOfDay(now);
  for (let i = 0; i < raw.length; i++) {
    const t = lower[i]!;
    const next = lower[i + 1];
    const cleanRaw = raw[i]!.replace(/^[("'`]+|[)"'`,;:!?]+$/g, "");
    if (looksLikePath(cleanRaw) && !/^\d{4}-\d{2}-\d{2}$/.test(cleanRaw)) { paths.push(expandHome(cleanRaw.replace(/\.$/, ""))); continue; }
    if (t === "today") { ranges.push(dayRange(today, 1, "today")); continue; }
    if (t === "yesterday") { ranges.push(dayRange(addDays(today, -1), 1, "yesterday")); continue; }
    if ((t === "this" || t === "last" || t === "past") && (next === "week" || next === "month")) {
      if (next === "week") {
        const thisWeek = startOfWeek(now);
        ranges.push(t === "this" ? dayRange(thisWeek, 7, "this week") : dayRange(addDays(thisWeek, -7), 7, "last week"));
      } else {
        const d = new Date(today);
        const from = t === "this" ? new Date(d.getFullYear(), d.getMonth(), 1) : new Date(d.getFullYear(), d.getMonth() - 1, 1);
        const to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
        ranges.push({ from: from.getTime(), to: to.getTime(), label: `${t} month` });
      }
      i++;
      continue;
    }
    if (/^\d+$/.test(t) && (next === "days" || next === "day" || next === "weeks" || next === "week") && lower[i + 2] === "ago") {
      const n = Number(t);
      if (next.startsWith("day")) ranges.push(dayRange(addDays(today, -n), 1, `${n} day${n === 1 ? "" : "s"} ago`));
      else ranges.push(dayRange(addDays(startOfWeek(now), -7 * n), 7, `${n} week${n === 1 ? "" : "s"} ago`));
      i += 2;
      continue;
    }
    const weekday = WEEKDAYS.indexOf(t.replace(/s$/, ""));
    if (weekday >= 0) {
      const back = (new Date(today).getDay() - weekday + 7) % 7;
      ranges.push(dayRange(addDays(today, -back), 1, WEEKDAYS[weekday]!));
      continue;
    }
    // A full month name, or its three-letter form (`sep`, `oct`) — never `may`/`mar`, which are words too.
    const month = MONTHS.findIndex((m) => m === t || (t.length === 3 && t !== "may" && t !== "mar" && m.slice(0, 3) === t));
    if (month >= 0) {
      const d = new Date(today);
      const year = month > d.getMonth() ? d.getFullYear() - 1 : d.getFullYear();
      const from = new Date(year, month, 1);
      ranges.push({ from: from.getTime(), to: new Date(year, month + 1, 1).getTime(), label: MONTHS[month]! });
      continue;
    }
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (iso) {
      ranges.push(dayRange(new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).getTime(), 1, t));
      continue;
    }
    if (t === "last" || t === "this" || t === "past") continue;
    if (t.length < 2 || FILLER.has(t)) continue;
    words.push(t);
  }
  return { words: [...new Set(words)], paths: [...new Set(paths)], ranges };
}

function pathMatch(query: string, candidate: string): "exact" | "suffix" | "base" | undefined {
  if (candidate === query) return "exact";
  const q = query.replace(/\/+$/, "");
  if (q.length > 0 && (candidate.endsWith(`/${q.replace(/^\/+/, "")}`) || candidate === q)) return "suffix";
  if (!q.includes("/") && basename(candidate) === q) return "base";
  return undefined;
}

/** Score every session against a parsed query; return the ones that matched something, best first. */
export function rankSessions(sessions: readonly QueryableSession[], parsed: ParsedSessionQuery): RankedSession[] {
  const out: RankedSession[] = [];
  for (const s of sessions) {
    let score = 0;
    const why: string[] = [];
    for (const p of parsed.paths) {
      let best: { kind: "exact" | "suffix" | "base"; file: string } | undefined;
      for (const f of s.editedFiles) {
        const kind = pathMatch(p, f);
        if (kind !== undefined && (best === undefined || rank(kind) > rank(best.kind))) best = { kind, file: f };
      }
      if (best !== undefined) {
        score += best.kind === "exact" ? 12 : best.kind === "suffix" ? 10 : 6;
        why.push(`edited ${best.file}`);
      } else if (s.cwd !== undefined && (s.cwd === p.replace(/\/+$/, "") || s.cwd.startsWith(`${p.replace(/\/+$/, "")}/`) || p.startsWith(`${s.cwd}/`))) {
        score += 4;
        why.push(`works in ${s.cwd}`);
      }
    }
    for (const r of parsed.ranges) {
      if (s.createdAt < r.to && s.lastEventTs >= r.from) {
        score += 4;
        why.push(`active ${r.label}`);
      }
    }
    const title = s.title?.toLowerCase() ?? "";
    const first = s.firstMessage?.toLowerCase() ?? "";
    const cwd = s.cwd?.toLowerCase() ?? "";
    for (const w of parsed.words) {
      if (title.includes(w)) { score += 3; why.push(`title: ${w}`); }
      else if (first.includes(w)) { score += 2; why.push(`first message: ${w}`); }
      else if (s.editedFiles.some((f) => f.toLowerCase().includes(w))) { score += 1.5; why.push(`edited a file matching ${w}`); }
      else if (cwd.includes(w)) { score += 1; why.push(`cwd: ${w}`); }
    }
    if (score > 0) out.push({ session: s, score, why });
  }
  out.sort((a, b) => b.score - a.score || b.session.lastEventTs - a.session.lastEventTs || (a.session.sessionId < b.session.sessionId ? -1 : 1));
  return out;
}

function rank(kind: "exact" | "suffix" | "base"): number {
  return kind === "exact" ? 3 : kind === "suffix" ? 2 : 1;
}
