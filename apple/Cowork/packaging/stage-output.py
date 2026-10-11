#!/usr/bin/env python3
"""Build-time staging only. No runtime-selected native paths or signing keys."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

SUBPATH="native/host-output"
ARTIFACT="winter-host-output.node"
REQUIREMENT='identifier "com.winter.host-output" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ"'
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def destination(resources):
    if resources.name!="Resources" or resources.parent.name!="Contents" or not resources.parent.parent.name.endswith(".app"):
        raise ValueError("fixed Contents/Resources bundle layout required")
    return resources/SUBPATH
def stage(source,resources):
    for name in (ARTIFACT,"manifest.json"):
        path=source/name
        if path.is_symlink() or not path.is_file() or path.stat().st_nlink!=1:
            raise ValueError("source aliases refused")
    record=json.loads((source/"manifest.json").read_text())
    if record.get("artifact")!=ARTIFACT or record.get("schema")!=1 or record.get("protocolVersion")!=1 or record.get("implementationId")!="winter-host-output/v1" or digest(source/ARTIFACT)!=record.get("artifactSha256"):
        raise ValueError("invalid output-only source package")
    target=destination(resources);target.mkdir(parents=True,exist_ok=False)
    for name in (ARTIFACT,"manifest.json"):
        shutil.copyfile(source/name,target/name);(target/name).chmod(0o644)
    return target
def refresh_signed(resources):
    target=destination(resources);addon=target/ARTIFACT
    # Release composition signs this nested code first. Only then can its final
    # byte digest be sealed into the manifest by the enclosing app signature.
    subprocess.run(["/usr/bin/codesign","--verify","--strict","-R",REQUIREMENT,str(addon)],check=True,timeout=10)
    record=json.loads((target/"manifest.json").read_text());record["artifactSha256"]=digest(addon)
    (target/"manifest.json").write_text(json.dumps(record,indent=2)+"\n")
if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--resources",type=Path,required=True);parser.add_argument("--source",type=Path);parser.add_argument("--refresh-signed-manifest",action="store_true")
    args=parser.parse_args()
    if args.refresh_signed_manifest:
        if args.source:parser.error("source and refresh are exclusive")
        refresh_signed(args.resources.resolve())
    else:
        if not args.source:parser.error("source required for staging")
        print(stage(args.source.resolve(),args.resources.resolve()))
