import wrapAnsi from "wrap-ansi";

/** Draft styles close on each logical line. Reuse wrapping for unchanged lines across edits;
 * unlike wrapping the entire accumulated draft, appending a paste only measures new lines.
 * Bound retained keys by characters so old draft versions cannot grow the cache indefinitely. */
export function makeDraftWrapper() {
  let width = 0;
  let retained = 0;
  const cache = new Map<string, string[]>();
  return (content: string, columns: number): string[] => {
    const nextWidth = Math.max(1, columns);
    if (width !== nextWidth) { cache.clear(); retained = 0; width = nextWidth; }
    const result: string[] = [];
    for (const line of content.split("\n")) {
      let rows = cache.get(line);
      if (!rows) {
        rows = wrapAnsi(line, width, { hard: true, trim: false }).split("\n");
        // Oversized individual lines still render, but don't evict the whole useful working set.
        if (line.length <= 65536) {
          while (cache.size && (retained + line.length > 4_000_000 || cache.size >= 20000)) {
            const oldest = cache.keys().next().value!;
            retained -= oldest.length;
            cache.delete(oldest);
          }
          cache.set(line, rows);
          retained += line.length;
        }
      }
      for (const row of rows) result.push(row);
    }
    return result;
  };
}
