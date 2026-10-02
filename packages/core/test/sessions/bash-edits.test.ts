import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BashEditPairer, bashCommandOf, bashEditedPaths, stripHeredocBodies } from "../../src/sessions/bash-edits";

// The edited-files index's Bash source: the files a command WRITES, read statically off its text.
const R = "/repo";
const paths = (command: string, cwd: string | undefined = R): string[] => bashEditedPaths(command, cwd);

describe("bashEditedPaths: what counts as a write", () => {
  test("output redirects — never an fd dup or /dev/*; quoted targets keep their spaces; case is kept", () => {
    expect(paths("echo hi > Out.TXT")).toEqual(["/repo/Out.TXT"]);
    expect(paths('echo hi >> "My File.txt" 2>&1')).toEqual(["/repo/My File.txt"]);
    expect(paths("cmd &> all.log; cmd2 >| clobber.txt; echo x>tight.txt")).toEqual(["/repo/all.log", "/repo/clobber.txt", "/repo/tight.txt"]);
    expect(paths("ls 2>/dev/null >&2; ls >&-")).toEqual([]);
    expect(paths("grep x f > out.txt")).toEqual(["/repo/out.txt"]);
  });

  test("a redirect or separator INSIDE quotes is text, not a write", () => {
    expect(paths("echo 'a > b.txt'")).toEqual([]);
    expect(paths('git commit -m "fix > stuff; rm -rf x"')).toEqual([]);
    expect(paths('cat <<< "a > b" > z.txt')).toEqual(["/repo/z.txt"]);
  });

  test("tee, touch, mkdir, truncate, chmod (after its mode), dd of=", () => {
    expect(paths("echo hi | tee -a log.txt other.txt")).toEqual(["/repo/log.txt", "/repo/other.txt"]);
    expect(paths("touch -r ref.txt new.txt && mkdir -p a/b -m 755")).toEqual(["/repo/new.txt", "/repo/a/b"]);
    expect(paths("truncate -s 0 big.log")).toEqual(["/repo/big.log"]);
    expect(paths("chmod +x run.sh")).toEqual(["/repo/run.sh"]);
    expect(paths("dd if=in.img of=out.img bs=1m")).toEqual(["/repo/out.img"]);
  });

  test("rm counts — a deletion is a change the user may search for", () => {
    expect(paths("rm -rf build dist/old.js")).toEqual(["/repo/build", "/repo/dist/old.js"]);
    expect(paths("rm -- -weird")).toEqual(["/repo/-weird"]);
    expect(paths("rmdir empty && unlink link")).toEqual(["/repo/empty", "/repo/link"]);
  });

  test("cp/install/ln/rsync: the destination only; into a directory it is dest/<source name>", () => {
    expect(paths("cp src.ts dst.ts")).toEqual(["/repo/dst.ts"]);
    expect(paths("cp a.ts b.ts lib")).toEqual(["/repo/lib/a.ts", "/repo/lib/b.ts"]);
    expect(paths("cp a.ts lib/")).toEqual(["/repo/lib/a.ts"]);
    expect(paths("cp -t lib a.ts")).toEqual(["/repo/lib/a.ts"]);
    expect(paths("ln -s ../shared/x.ts x.ts")).toEqual(["/repo/x.ts"]);
    expect(paths("rsync -a --exclude tmp src/ host:/backup")).toEqual([]);
  });

  test("cp into a directory that EXISTS is dest/<source name>", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-bash-edits-"));
    try {
      mkdirSync(join(dir, "lib"));
      expect(paths("cp a.ts lib", dir)).toEqual([join(dir, "lib", "a.ts")]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("mv and git mv record the source AND the destination; git rm/restore/checkout -- record their paths", () => {
    expect(paths("mv old.ts new.ts")).toEqual(["/repo/new.ts", "/repo/old.ts"]);
    expect(paths("git mv A.ts B.ts")).toEqual(["/repo/B.ts", "/repo/A.ts"]);
    expect(paths("git rm stale.ts")).toEqual(["/repo/stale.ts"]);
    expect(paths("git rm --cached keep.ts")).toEqual([]);
    expect(paths("git restore --source HEAD~1 a.ts")).toEqual(["/repo/a.ts"]);
    expect(paths("git checkout -- a.ts b.ts")).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(paths("git checkout main")).toEqual([]);
    expect(paths("git -C ../other restore a.txt")).toEqual(["/other/a.txt"]);
  });

  test("git, curl and friends record only what they write — never a commit message or a URL", () => {
    expect(paths('git commit -am "update README.md"')).toEqual([]);
    expect(paths("git status && git diff --stat")).toEqual([]);
    expect(paths("curl -sSL https://example.com/x")).toEqual([]);
    expect(paths("curl -o out.json https://x && curl --output=b.bin https://y && wget -O page.html https://z")).toEqual(["/repo/out.json", "/repo/b.bin", "/repo/page.html"]);
  });

  test("in-place editors: sed -i (GNU and BSD spellings), perl -i, gawk -i inplace, scripted vim, ed, patch", () => {
    expect(paths("sed -i 's/a/b/' Foo.ts")).toEqual(["/repo/Foo.ts"]);
    expect(paths("sed -i '' 's/a/b/' Foo.ts")).toEqual(["/repo/Foo.ts"]);
    expect(paths("sed -i .bak s/a/b/ f.txt")).toEqual(["/repo/f.txt"]);
    expect(paths("sed -i.bak -e s/x/y/ a.ts b.ts")).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(paths("sed 's/a/b/' read-only.ts")).toEqual([]);
    expect(paths("perl -pi -e 's/a/b/' x.pl")).toEqual(["/repo/x.pl"]);
    expect(paths("awk -i inplace '{print}' f1 f2")).toEqual(["/repo/f1", "/repo/f2"]);
    expect(paths("vim -es -c '%s/a/b/' -c wq notes.md")).toEqual(["/repo/notes.md"]);
    expect(paths("vim notes.md")).toEqual([]);
    expect(paths("patch -p1 target.c fix.diff")).toEqual(["/repo/target.c"]);
    expect(paths("patch -p1 < fix.diff")).toEqual([]);
  });

  test("formatters in their writing form, through a package runner too; only path-shaped operands", () => {
    expect(paths("npx -y prettier --write src/a.ts --parser typescript")).toEqual(["/repo/src/a.ts"]);
    expect(paths("prettier --check src/a.ts")).toEqual([]);
    expect(paths("gofmt -w main.go && black app.py && ruff format x.py")).toEqual(["/repo/main.go", "/repo/app.py", "/repo/x.py"]);
  });

  test("never a read", () => {
    expect(paths("cat a.ts b.ts | grep x; ls -la src; head -5 c.ts < d.ts")).toEqual([]);
  });
});

describe("bashEditedPaths: where a path resolves", () => {
  test("a cd earlier in the SAME command moves the base; a subshell's and a nested bash -c's too", () => {
    expect(paths("cd src && sed -i '' 's/a/b/' Foo.ts")).toEqual(["/repo/src/Foo.ts"]);
    expect(paths("cd /abs/dir; touch x")).toEqual(["/abs/dir/x"]);
    expect(paths("cd a && cd ../b && touch y")).toEqual(["/repo/b/y"]);
    expect(paths("(cd lib; touch q)")).toEqual(["/repo/lib/q"]);
    expect(paths('bash -c "cd sub && echo 1 > f"')).toEqual(["/repo/sub/f"]);
  });

  test("~, $HOME and $PWD expand; a path built at run time, a glob or `cd -` is out of reach", () => {
    expect(paths("echo x > ~/y.txt")).toEqual([join(homedir(), "y.txt")]);
    expect(paths("touch $HOME/z && touch ${PWD}/w")).toEqual([join(homedir(), "z"), "/repo/w"]);
    expect(paths("echo $VAR > $OUT; touch $(pwd)/x; rm *.log; touch {a,b}.ts")).toEqual([]);
    expect(paths("cd - && touch rel.txt && touch /abs.txt")).toEqual(["/abs.txt"]);
  });

  test("without a cwd only absolute and home paths are returned", () => {
    expect(bashEditedPaths("touch rel.txt /abs.txt ~/h.txt", undefined)).toEqual(["/abs.txt", join(homedir(), "h.txt")]);
  });

  test("heredoc bodies are data, not commands", () => {
    expect(paths("cat > notes.md <<'EOF'\nrm -rf important\necho x > not-a-write\nEOF\necho done > d.txt")).toEqual(["/repo/notes.md", "/repo/d.txt"]);
    expect(paths("cat <<-END > t.txt\n\trm gone\n\tEND\ntouch after")).toEqual(["/repo/t.txt", "/repo/after"]);
    expect(stripHeredocBodies("a <<<x\nb")).toBe("a <<<x\nb");
    expect(paths("python3 - <<EOF\nopen('x','w')\nEOF")).toEqual([]);
  });

  test("an interpreter one-liner is out of reach (stated limit)", () => {
    expect(paths(`python3 -c "open('x','w').write('y')"`)).toEqual([]);
  });
});

describe("BashEditPairer", () => {
  const call = (callId: string, command: string, name = "bash") => ({ type: "tool_call", callId, name, argsJson: JSON.stringify({ command }) });
  const result = (callId: string, isError: boolean) => ({ type: "tool_result", callId, isError });

  test("records a call's paths only when its result ran (isError false) — a non-zero exit is not an error", () => {
    const p = new BashEditPairer();
    expect(p.observe("c1", call("c1", "echo x > a.txt"), R)).toEqual([]);
    expect(p.observe("c1", result("c1", false), undefined)).toEqual(["/repo/a.txt"]);
    // One-shot.
    expect(p.observe("c1", result("c1", false), undefined)).toEqual([]);
  });

  test("a denied/interrupted call (an error result) records nothing; the runtime's own name is accepted too", () => {
    const p = new BashEditPairer();
    p.observe("c2", call("c2", "rm x", "Bash"), R);
    expect(p.observe("c2", result("c2", true), undefined)).toEqual([]);
    p.observe("c3", call("c3", "rm y", "Bash"), R);
    expect(p.observe("c3", result("c3", false), undefined)).toEqual(["/repo/y"]);
  });

  test("other tools are ignored; the pending map is bounded", () => {
    expect(bashCommandOf({ type: "tool_call", name: "read", argsJson: '{"command":"rm x"}' })).toBeUndefined();
    expect(bashCommandOf({ type: "tool_call", name: "bash", argsJson: "not json" })).toBeUndefined();
    const p = new BashEditPairer(2);
    p.observe("a", call("a", "touch a"), R);
    p.observe("b", call("b", "touch b"), R);
    p.observe("c", call("c", "touch c"), R);
    expect(p.observe("a", result("a", false), undefined)).toEqual([]);   // evicted
    expect(p.observe("c", result("c", false), undefined)).toEqual(["/repo/c"]);
  });
});
