import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, relative } from "node:path";
import { fileAtCell, transcriptFileAtCell } from "../../src/tui/file-links";

test("clicks resolve existing relative, nested, absolute and home file paths only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "winter-links-"));
  try {
    await mkdir(join(dir, "docs"));
    const file = join(dir, "docs", "Sushi_Story.pptx");
    await writeFile(file, "fixture");
    for (const path of ["docs/Sushi_Story.pptx", file, file.slice(1), "~/" + relative(homedir(), file)]) {
      const line = "See " + path + ".";
      expect(await fileAtCell(line, 6, dir)).toBe(file);
      expect(await fileAtCell(line, 1, dir)).toBeNull();
    }
    expect(await fileAtCell("Sushi_Story.pptx", 3, join(dir, "docs"))).toBe(file);
    expect(await fileAtCell("missing.pptx", 3, dir)).toBeNull();
    expect(await fileAtCell("https://example.com/file.pptx", 3, dir)).toBeNull();
    expect(await fileAtCell("docs/", 2, dir)).toBeNull();
    const wrapped = Array.from({ length: Math.ceil(file.length / 18) }, (_, i) => "  " + file.slice(i * 18, (i + 1) * 18));
    expect(await transcriptFileAtCell(wrapped, 1, 5, 20, dir)).toBe(file);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
