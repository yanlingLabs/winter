import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeFenceFor, registerHostStorageFences, hostStorageReadPatterns, hostStorageFloorDescriptor } from "../../src/runtime-sdk/home-fence";
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
    for (const dir of [join(home,"cowork"), join(workspace, "shared/outputs"), coordination]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(workspace, "manifest.json"), "{}");
    writeFileSync(join(workspace, "data.ext4"), "fixture disk");
    writeFileSync(join(workspace, "shared/outputs/manifest.json"), "ordinary shared artifact");
    unregister = registerHostStorageFences(home, { participatingHomes: [other], coordinationDir: coordination, coworkStorageActive:true });
  });
  afterEach(() => { unregister(); rmSync(root, { recursive: true, force: true }); });
  const target = (tool: string, path: string) => controlPlaneTargetForCall(tool, { file_path: path }, home, homeFenceFor(home));

  test("coordination cannot overlap a home, including through a symlink", () => {
    expect(() => registerHostStorageFences(home, { coordinationDir: join(home, "coordination") })).toThrow("may not overlap");
    symlinkSync(coordination, join(root, "coordination-alias"));
    expect(() => registerHostStorageFences(join(root, "coordination-alias/home"), { coordinationDir: coordination })).toThrow("may not overlap");
  });
  test("an active registered Cowork root becoming a symlink or non-directory fails closed",()=>{
    const cowork=join(other,"cowork");rmSync(cowork,{recursive:true});symlinkSync(home,cowork);
    expect(()=>hostStorageFloorDescriptor(home)).toThrow("cannot be inspected safely");
    rmSync(cowork);writeFileSync(cowork,"not a storage root");
    expect(()=>hostStorageFloorDescriptor(home)).toThrow("cannot be inspected safely");
  });
  test("a missing active owner's root refuses recovery while unrelated absent homes are ignored",()=>{
    const restore=registerHostStorageFences(home,{participatingHomes:[other,join(root,"unrelated-absent")],coordinationDir:coordination,coworkStorageActive:true});
    try {
      expect(hostStorageFloorDescriptor(home).denyReadPaths).toContain(coordination);
      expect(hostStorageFloorDescriptor(home).denyReadPaths).toContain(join(home,"runtimes/runtime-state.db"));
      rmSync(join(home,"cowork"),{recursive:true});
      expect(()=>hostStorageFloorDescriptor(home)).toThrow("cannot be inspected safely");
      expect(()=>childSandboxConfigFor(home)).toThrow("cannot be inspected safely");
    } finally {restore();}
  });
  test.skipIf(process.geteuid?.()===0)("a non-ENOENT failure inspecting active storage never removes the floor",()=>{
    chmodSync(other,0);
    try {expect(()=>hostStorageFloorDescriptor(home)).toThrow("cannot be inspected safely");}
    finally {chmodSync(other,0o700);}
  });

  test("all host write tools refuse whole storage, ancestors and the isolated coordination directory", () => {
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "write", "edit", "notebook_edit"]) {
      for (const path of [workspace, other, join(workspace, "shared/outputs/a.md"), coordination, join(coordination, "cowork-admission.sqlite-wal")]) expect(target(tool, path)).not.toBeNull();
    }
    expect(controlPlaneTargetForCall("MultiEdit", { edits: [{ file_path: join(root, "ordinary.txt") }, { file_path: join(workspace, "data.ext4") }] }, home, homeFenceFor(home))).not.toBeNull();
  });
  test("Read/Glob/Grep control reads are denied; ancestor queries and shared content stay readable", () => {
    for (const tool of ["Read", "Glob", "Grep", "read", "glob", "grep"]) {
      for (const path of [join(workspace, "manifest.json"), join(workspace, "data.ext4"), workspace, coordination]) expect(target(tool, path)).not.toBeNull();
      expect(target(tool, other)).toBeNull();
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
  test("the trusted spawn floor descriptor protects controls and link/ancestor operations while allowing shared reads", () => {
    const floor=hostStorageFloorDescriptor(home);
    expect(floor.denyWritePaths).toContain(join(other,"cowork"));
    expect(floor.denyReadPaths).toContain(coordination);
    expect(floor.denyLinkPaths).toEqual(floor.denyWritePaths);
    expect(floor.protectAncestorsOf).toEqual(floor.denyWritePaths);
    const runtime=join(other,"runtimes"),binary=join(runtime,"bin/winter");
    expect(floor.denyReadPaths).not.toContain(runtime);
    expect(floor.denyWritePaths).not.toContain(runtime);
    for (const name of ["runtime-state.db","runtime-state.db-wal","runtime-state.db-shm"]) {
      expect(floor.denyReadPaths).toContain(join(runtime,name));
      expect(floor.denyWritePaths).toContain(join(runtime,name));
    }
    expect(floor.denyReadPaths.some(path => binary===path || binary.startsWith(`${path}/`))).toBe(false);
    expect(floor.denyReadRegexes.some(pattern => new RegExp(pattern).test(binary))).toBe(false);
    for (const file of ["manifest.json","env.ext4","data.ext4","control/grants.json"]) {
      expect(floor.denyReadRegexes.some(pattern => new RegExp(pattern).test(join(workspace,file)))).toBe(true);
    }
    for (const file of [join(workspace,"shared/outputs/manifest.json"),join(root,"project/manifest.json")]) {
      expect(floor.denyReadRegexes.some(pattern => new RegExp(pattern).test(file))).toBe(false);
    }
    expect(escapeFloorHit(`du -sh ${root}`,home)).toBeUndefined();
    expect(escapeFloorHit(`find ${root} -name fixture`,home)).toBeUndefined();
    expect(escapeFloorHit(`cd / && cat ${root}/ordinary.txt`,home)).toBeUndefined();
  });
  test("nested escape precedence preserves reads of shared artifacts without guessing manifest filenames", () => {
    expect(escapeFloorHit(`cat ${workspace}/manifest.json`, home)).toBeDefined();
    expect(escapeFloorHit(`cat ${workspace}/shared/outputs/manifest.json`, home)).toBeUndefined();
    expect(escapeFloorHit(`cat ${root}/project/manifest.json`, home)).toBeUndefined();
    expect(escapeFloorHit(`chmod 777 ${workspace}/shared/outputs`, home)).toBeDefined();
    expect(escapeFloorHit(`mv ${other} ${root}/replacement`, home)).toBeDefined();
  });
  test("an active backing store preserves ordinary escape policy; kernel floor protects computed paths", () => {
    const restore = registerHostStorageFences(home, { participatingHomes: [other], coordinationDir: coordination, coworkStorageActive: true });
    try {
      for (const command of ["python3 -c 'print(1)'", "./fixture-script", "cat harmless.txt"]) expect(escapeFloorHit(command, home)).toBeUndefined();
    } finally { restore(); }
  });
  test("an explicit inactive home cannot disable another participating home's escape floor", () => {
    const stopOther = registerHostStorageFences(other, { coordinationDir: coordination, coworkStorageActive: true });
    const restore = registerHostStorageFences(home, { coordinationDir: coordination, coworkStorageActive: false });
    try { expect(target("Read",join(workspace,"data.ext4"))).not.toBeNull(); }
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

test("disabled and unregistered Cowork preserve ordinary Code scans and escapes at HOME", () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-cowork-disabled-")));
  const userHome=join(root,"user-home"), home=join(userHome,".winter"), coordination=join(root,"coordination");
  mkdirSync(home,{recursive:true}); mkdirSync(coordination);
  writeFileSync(join(home,"trust.json"),"{}"); linkSync(join(home,"trust.json"),join(root,"trust-alias.json"));
  try {
    for (const config of [{registered:false,active:false,exists:false},{registered:true,active:false,exists:true}]) {
      if (config.exists) mkdirSync(join(home,"cowork")); else rmSync(join(home,"cowork"),{recursive:true,force:true});
      const dispose=config.registered ? registerHostStorageFences(home,{coordinationDir:coordination,coworkStorageActive:config.active}) : () => {};
      try {
        expect(hostStorageReadPatterns(home)).toEqual([]);
        expect(hostStorageFloorDescriptor(home)).toEqual({denyReadPaths:[],denyWritePaths:[],denyReadRegexes:[],denyWriteRegexes:[],denyLinkPaths:[],protectAncestorsOf:[]});
        expect(controlPlaneTargetForCall("Read",{file_path:join(root,"trust-alias.json")},userHome,homeFenceFor(home))).toBeNull();
        expect(controlPlaneTargetForCall("Write",{file_path:join(root,"trust-alias.json")},userHome,homeFenceFor(home))).not.toBeNull();
        for (const tool of ["Glob","Grep"]) {
          expect(controlPlaneTargetForCall(tool,{pattern:"fixture"},userHome,homeFenceFor(home))).toBeNull();
          expect(controlPlaneTargetForCall(tool,{path:userHome,pattern:"fixture"},userHome,homeFenceFor(home))).toBeNull();
        }
        for (const command of [`du -sh ${userHome}`,`find ${userHome} -name fixture`,`cd ${userHome} && ls`,`rsync -a ${userHome}/ ${root}/copy/`]) expect(escapeFloorHit(command,home,userHome)).toBeUndefined();
      } finally { dispose(); }
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
