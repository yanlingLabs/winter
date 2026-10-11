#!/usr/bin/env python3
"""Output-only Node-API package. No Swift/VZ/VM, install, or real signing key."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

HERE=Path(__file__).resolve().parent
SOURCE=HERE.parent/"WinterHostOutput/Sources"
FILES=("adapter.c","fd_creation.c","output_transport.c")
HEADERS=("node_api.h","node_api_types.h","js_native_api.h","js_native_api_types.h")

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def source_identity(root):
    hashes={name:sha(root/name) for name in FILES}
    return hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(",",":")).encode()).hexdigest(),hashes

def build(node_headers):
    if platform.system()!="Darwin" or platform.machine()!="arm64": raise ValueError("Darwin arm64 output build required")
    if not (node_headers/"node_api.h").is_file(): raise ValueError("existing Node-API headers required")
    (HERE/"out").mkdir(exist_ok=True)
    root=Path(tempfile.mkdtemp(prefix="output-",dir=HERE/"out")).resolve()
    source=root/"source";shutil.copytree(SOURCE,source)
    headers=root/"node-api-headers";headers.mkdir()
    for name in HEADERS:shutil.copyfile(node_headers/name,headers/name)
    shutil.copyfile(Path(__file__).resolve(),root/"build-output.py")
    digest,hashes=source_identity(source)
    bundle=root/"bundle";bundle.mkdir()
    addon=bundle/"winter-host-output.node"
    env={k:v for k,v in os.environ.items() if not k.startswith(("DYLD_","PKG_CONFIG_")) and k not in ("CPATH","CFLAGS","LDFLAGS","LIBRARY_PATH","SDKROOT")}
    env.update(MACOSX_DEPLOYMENT_TARGET="26.0",LC_ALL="C",LANG="C")
    command=["xcrun","clang","-std=c11","-Wall","-Wextra","-Werror","-fPIC","-bundle","-undefined","dynamic_lookup",f"-I{headers}",
        f'-DWINTER_HOST_OUTPUT_SOURCE_SHA256="{digest}"',str(source/"adapter.c"),"-o",str(addon)]
    with (root/"build.log").open("w") as log: subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
    # Final distribution signing changes bytes. Stage/update the final artifact
    # hash after nested signing and BEFORE signing the enclosing app resource seal.
    manifest={"schema":1,"protocolVersion":1,"implementationId":"winter-host-output/v1","sourceSha256":digest,
        "artifactSha256":sha(addon),"artifact":"winter-host-output.node","platform":"darwin","architecture":"arm64","minimumMacOS":"26.0"}
    (bundle/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    (root/"build-evidence.json").write_text(json.dumps({"command":command,"sourceHashes":hashes,"sourceSha256":digest,
        "nodeApiHeaderHashes":{name:sha(headers/name) for name in HEADERS},"recipeSha256":sha(root/"build-output.py"),
        "compiler":subprocess.check_output(["xcrun","clang","--version"],env=env,text=True).strip(),
        "productionSigned":False},indent=2)+"\n")
    loads=subprocess.check_output(["otool","-L",addon],text=True)
    for line in loads.splitlines()[1:]:
        ref=line.strip().split(" (",1)[0]
        if not ref.startswith(("/usr/lib/","/System/Library/")): raise ValueError(f"non-system output dependency: {ref}")
    (root/"closure.log").write_text(loads)
    return root

if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--node-headers",type=Path,default=Path("/opt/homebrew/opt/node/include/node"))
    args=parser.parse_args();result=build(args.node_headers.resolve());print(json.dumps({"outputOnlyBundle":str(result/"bundle"),"noVZDependency":True,"realVM":False}))
