import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeFenceFor, registerHostStorageFences } from "../../src/runtime-sdk/home-fence";
import { controlPlaneTargetForCall } from "../../src/runtime-sdk/control-plane";
import { childSandboxConfigFor, controlPlaneDenyRules } from "../../src/runtime-sdk/mode-options";
import { escapeFloorHit } from "../../src/runtime-sdk/hooks";
import { planProjectMigration, runProjectMigration } from "../../src/migration/project-files";
import { LEGACY_INSTRUCTIONS_FILE } from "../../src/legacy-names";

describe("Cowork host storage fences", () => {
  let root: string, home: string, other: string, coordination: string, workspace: string;
  let unregister: () => void;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "winter-cowork-fences-")));
    home = join(root, "home [fixture]"); other = join(root, "custom-profile"); coordination = join(root, "coordination");
    workspace = join(other, "cowork/workspaces/ws-a");
    for (const dir of [home, join(workspace, "shared/outputs"), coordination]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(workspace, "manifest.json"), "{}");
    writeFileSync(join(workspace, "data.ext4"), "fixture disk");
    writeFileSync(join(workspace, "shared/outputs/manifest.json"), "ordinary shared artifact");
    unregister = registerHostStorageFences(home, { participatingHomes: [other], coordinationDir: coordination });
  });
  afterEach(() => { unregister(); rmSync(root, { recursive: true, force: true }); });
  const target = (tool: string, path: string) => controlPlaneTargetForCall(tool, { file_path: path }, home, homeFenceFor(home));

  test("coordination cannot overlap a home, including through a symlink", () => {
    expect(() => registerHostStorageFences(home, { coordinationDir: join(home, "coordination") })).toThrow("may not overlap");
    symlinkSync(coordination, join(root, "coordination-alias"));
    expect(() => registerHostStorageFences(join(root, "coordination-alias/home"), { coordinationDir: coordination })).toThrow("may not overlap");
  });

  test("all host write tools refuse whole storage, ancestors and the isolated coordination directory", () => {
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "write", "edit", "notebook_edit"]) {
      for (const path of [workspace, other, join(workspace, "shared/outputs/a.md"), coordination, join(coordination, "cowork-admission.sqlite-wal")]) expect(target(tool, path)).not.toBeNull();
    }
    expect(controlPlaneTargetForCall("MultiEdit", { edits: [{ file_path: join(root, "ordinary.txt") }, { file_path: join(workspace, "data.ext4") }] }, home, homeFenceFor(home))).not.toBeNull();
  });
  test("Read/Glob/Grep control reads and ancestor scans are denied; shared content stays readable", () => {
    for (const tool of ["Read", "Glob", "Grep", "read", "glob", "grep"]) {
      for (const path of [join(workspace, "manifest.json"), join(workspace, "data.ext4"), workspace, other, coordination]) expect(target(tool, path)).not.toBeNull();
      expect(target(tool, join(workspace, "shared/outputs/manifest.json"))).toBeNull();
      expect(target(tool, join(root, "project/manifest.json"))).toBeNull();
    }
  });
  test("symlink and hard-link aliases into volumes or manifests are denied", () => {
    symlinkSync(workspace, join(root, "alias"));
    linkSync(join(workspace, "data.ext4"), join(root, "disk-alias"));
    linkSync(join(workspace, "manifest.json"), join(workspace, "shared/outputs/fake-artifact"));
    for (const tool of ["Read", "Write"]) {
      for (const path of [join(root, "alias/data.ext4"), join(root, "disk-alias"), join(workspace, "shared/outputs/fake-artifact")]) expect(target(tool, path)).not.toBeNull();
    }
  });
  test("shell deny lists and native rules derive from the same injected roots and control entries", () => {
    const fs = childSandboxConfigFor(home).filesystem!;
    expect(fs.denyWrite).toContain(join(other, "cowork"));
    expect(fs.denyWrite).toContain(coordination);
    expect(fs.denyRead).toContain(join(other, "cowork/workspaces/*/manifest.json"));
    expect(fs.denyRead).toContain(join(other, "cowork/workspaces/*/data.ext4"));
    expect(fs.denyRead).not.toContain(join(other, "cowork"));
    const rules = controlPlaneDenyRules(home);
    expect(rules).toContain(`Read(/${other}/cowork/workspaces/*/manifest.json)`);
    expect(rules).toContain(`Write(/${other}/cowork/**)`);
  });
  test("nested escape precedence preserves reads of shared artifacts without guessing manifest filenames", () => {
    expect(escapeFloorHit(`cat ${workspace}/manifest.json`, home)).toBeDefined();
    expect(escapeFloorHit(`cat ${workspace}/shared/outputs/manifest.json`, home)).toBeUndefined();
    expect(escapeFloorHit(`cat ${root}/project/manifest.json`, home)).toBeUndefined();
    expect(escapeFloorHit(`chmod 777 ${workspace}/shared/outputs`, home)).toBeDefined();
    expect(escapeFloorHit(`mv ${other} ${root}/replacement`, home)).toBeDefined();
  });
  test("an active backing store refuses escapes including scripts and computed paths", () => {
    const restore = registerHostStorageFences(home, { participatingHomes: [other], coordinationDir: coordination, coworkStorageActive: true });
    try {
      for (const command of ["python3 -c 'import os; os.rename(*(os.environ[x] for x in [\"A\",\"B\"]))'", "./fixture-script", "cat harmless.txt"]) expect(escapeFloorHit(command, home)).toBeDefined();
    } finally { restore(); }
  });
  test("an explicit inactive home cannot disable another participating home's escape floor", () => {
    const stopOther = registerHostStorageFences(other, { coordinationDir: coordination, coworkStorageActive: true });
    const restore = registerHostStorageFences(home, { coordinationDir: coordination, coworkStorageActive: false });
    try { expect(escapeFloorHit("./computed-path-script", home)).toBeDefined(); }
    finally { restore(); stopOther(); }
  });
  test("migrate-project refuses backing trees and revalidates a preview whose directory becomes a link", () => {
    expect(() => planProjectMigration(workspace, { winterHome: home })).toThrow("migrate-project cannot");
    expect(() => planProjectMigration(join(root, "alias"), { winterHome: home })).not.toThrow();
    const project = join(root, "project"); mkdirSync(project); writeFileSync(join(project, LEGACY_INSTRUCTIONS_FILE), "fixture");
    const plan = planProjectMigration(project, { winterHome: home });
    rmSync(project, { recursive: true }); symlinkSync(workspace, project);
    expect(() => runProjectMigration(plan)).toThrow("migrate-project cannot");
  });
  test("migrate-project refuses a hard-linked volume masquerading as an instructions file", () => {
    const project = join(root, "project"); mkdirSync(project);
    linkSync(join(workspace, "data.ext4"), join(project, LEGACY_INSTRUCTIONS_FILE));
    const plan = planProjectMigration(project, { winterHome: home });
    expect(() => runProjectMigration(plan)).toThrow("migrate-project cannot");
    expect(Bun.file(join(workspace, "data.ext4")).size).toBe("fixture disk".length);
  });
});
