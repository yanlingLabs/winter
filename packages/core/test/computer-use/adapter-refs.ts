// A POSITIVE check of the window, document and tab references in an app adapter's AppleScript: every one must be the
// BOUND window (`window id <bound>`, or a variable set from it), or an object the agent named — never whichever window,
// document or tab happens to be in front. The allowed forms are removed one by one; whatever reference is left is a
// problem. Shared by the adapters' unit and service tests.

/** Strings out (so a URL or a name never counts), comments out, lower case, whitespace collapsed. */
function codeOf(source: string): { code: string; strings: string[] } {
  const strings: string[] = [];
  let code = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "\"") {
      let s = "";
      for (i++; i < source.length && source[i] !== "\""; i++) { if (source[i] === "\\") i++; s += source[i]; }
      code += ` str${strings.length} `;
      strings.push(s);
    } else if (ch === "-" && source[i + 1] === "-") { while (i < source.length && source[i] !== "\n") i++; code += "\n"; }
    else code += ch;
  }
  return { code: code.toLowerCase().replace(/\s+/g, " "), strings };
}

/**
 * The references in `source` that are neither the bound window `bound` nor an object the agent named (`named`: the
 * workspace names it passed). Empty: every reference is accounted for.
 */
export function referenceProblems(source: string, bound: number, named: { workspaces?: readonly string[] } = {}): string[] {
  const { code: raw, strings } = codeOf(source);
  let code = raw;
  const problems: string[] = [];
  const cut = (re: RegExp): boolean => { const hit = re.test(code); code = code.replace(re, " "); return hit; };
  // The frame's tab CHARACTER, set before the `tell` (not a tab of anything).
  cut(/\bset wintertab to tab\b/g);
  // Variables set from the bound window: `w` (the window) and `ct` (its current tab).
  const wFromBound = new RegExp(`\\bset w to window id ${bound}\\b`).test(code);
  // Finder's proof that its selection is the bound window's (`selectionIsBound`): its frontmost window's id compared
  // with the bound one, the bound window's folder against the desktop and the insertion location.
  const proof = new RegExp(`\\(id of finder window 1\\) is not ${bound}\\b`).test(code) && /insertionurl is not boundurl/.test(code);
  cut(new RegExp(`\\(id of finder window 1\\) is not ${bound}\\b`, "g"));
  cut(new RegExp(`\\bdocument of window id ${bound}\\b`, "g"));
  cut(new RegExp(`\\b(finder )?window id ${bound}\\b`, "g"));
  if (wFromBound) {
    cut(/\bmake new tab at end of tabs of w\b/g);
    cut(/\b(current tab|count of tabs|tabs|tab \S+) of w\b/g);
  }
  if (proof) {
    cut(/\burl of desktop\b/g);
    cut(/\burl of \(get insertion location\)/g);
    cut(/\(get selection\)/g);
  }
  // `openWindow`: the agent's OWN new window, found by the one id that was not there before.
  if (/\bif \(count of fresh\) is not 1 then return str\d+/.test(code)) {
    cut(/\bid of every window\b/g);
    cut(/\bmake new document with properties\b/g);
  }
  // A workspace the agent named, by its literal name; and the read-only listing of the open workspaces (schemes()).
  for (const m of [...code.matchAll(/\b(exists )?workspace document (str\d+)/g)]) {
    const lit = strings[Number(m[2]!.slice(3))];
    if (lit !== undefined && (named.workspaces ?? []).includes(lit)) code = code.replace(m[0], " ");
  }
  cut(/\brepeat with d in workspace documents\b/g);
  // The workspace in `d` (bound or named): its own last result.
  cut(/\blast scheme action result of d\b/g);
  // (`frontmost` alone is the APP's "is it the active app" property, not a window: allowed.)
  for (const m of code.matchAll(/\b(front|frontmost (window|document|tab)|first (window|document|tab)|last (window|document|tab)|windows?|documents?|tabs?|current tab|active tab|selection|insertion location|desktop)\b/g)) {
    problems.push(`"${m[0]}" is neither the bound window (window id ${bound}) nor an object the agent named: …${code.slice(Math.max(0, m.index! - 40), m.index! + 40)}…`);
  }
  return problems;
}
