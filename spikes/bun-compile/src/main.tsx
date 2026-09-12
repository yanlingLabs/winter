import React, { useEffect, useState } from "react";
import { render, Text, Box } from "ink";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function checks(): Promise<string[]> {
  const results: string[] = [];

  // 1. bun:sqlite
  const db = new Database(join(mkdtempSync(join(tmpdir(), "winter-spike-")), "t.db"));
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  db.run("INSERT INTO t (v) VALUES (?)", ["hello"]);
  const row = db.query("SELECT v FROM t WHERE id = 1").get() as { v: string };
  results.push(`sqlite: ${row.v === "hello" ? "OK" : "FAIL"}`);

  // 2. Bun.secrets (Keychain)
  await Bun.secrets.set({ service: "com.winter.spike", name: "probe", value: "s3cret" });
  const got = await Bun.secrets.get({ service: "com.winter.spike", name: "probe" });
  await Bun.secrets.delete({ service: "com.winter.spike", name: "probe" });
  results.push(`secrets: ${got === "s3cret" ? "OK" : "FAIL"}`);

  // 3. unix socket round-trip
  const sock = join(tmpdir(), `winter-spike-${process.pid}.sock`);
  const server = Bun.listen({
    unix: sock,
    socket: { data(s, d) { s.write(d); } }, // echo
  });
  const reply = await new Promise<string>((resolve) => {
    Bun.connect({
      unix: sock,
      socket: {
        open(s) { s.write("ping\n"); },
        data(_s, d) { resolve(new TextDecoder().decode(d).trim()); },
      },
    });
  });
  server.stop(true);
  results.push(`unix-socket: ${reply === "ping" ? "OK" : "FAIL"}`);

  return results;
}

function App() {
  const [lines, setLines] = useState<string[]>(["running checks…"]);
  useEffect(() => {
    checks().then((r) => { setLines(r); setTimeout(() => process.exit(r.some(l => l.includes("FAIL")) ? 1 : 0), 100); });
  }, []);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Text color="cyan" bold>◍ winter bun-compile spike</Text>
      {lines.map((l, i) => <Text key={i}>{l}</Text>)}
    </Box>
  );
}

render(<App />);
