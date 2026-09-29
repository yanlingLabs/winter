/** Coalesce ordinary multi-character stdin chunks before Ink's synchronous render path. Flush
 * before any key/control event so Enter and editing keys always see the complete preceding paste. */
export function makePasteBatch(deliver: (text: string) => void, delayMs = 16) {
  let chunks: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (chunks.length === 0) return;
    const text = chunks.join("");
    chunks = [];
    deliver(text);
  };
  return {
    push(text: string) {
      if (text.length > 1 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
        chunks.push(text);
        if (timer === undefined) timer = setTimeout(flush, delayMs);
      } else { flush(); deliver(text); }
    },
    flush,
    dispose() { if (timer !== undefined) clearTimeout(timer); timer = undefined; chunks = []; },
  };
}
