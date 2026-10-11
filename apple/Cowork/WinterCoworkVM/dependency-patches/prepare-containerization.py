#!/usr/bin/env python3
"""Prepare/verify ONE fixed disposable source tree. No arbitrary source paths."""
import argparse, hashlib, json, pathlib, shutil, subprocess, tarfile, tempfile, urllib.request
BASE = pathlib.Path(__file__).resolve().parent.parent
PINS = BASE / 'dependency-patches/output-completion-provenance.json'
REVISION = 'bc994b88df46207fad7775b0eabc51947e315881'
ARCHIVE_SHA = '94a9deedeaa8cf50869ea86b995e1c3cf133d9787c0733b140938ea992a1343e'
SOURCE = BASE / 'out/dependencies/containerization'
ARCHIVE = BASE / 'out/dependencies/containerization-source.tar.gz'
IGNORED = {'.build', '.swiftpm', '.git'}
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def tree(root):
    entries=[]
    for file in sorted(root.rglob('*')):
        relative=file.relative_to(root)
        if any(p in IGNORED for p in relative.parts): continue
        if file.is_symlink(): raise RuntimeError('Source symlinks are refused')
        if file.is_file(): entries.append(str(relative)+'\0'+sha(file)+'\n')
    return hashlib.sha256(''.join(sorted(entries)).encode()).hexdigest()
def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--verify-only', action='store_true'); parser.add_argument('--offline',action='store_true'); args=parser.parse_args()
    pins=json.loads(PINS.read_text()); patch=BASE/'dependency-patches/containerization-output-completion.patch'
    if pins['revision']!=REVISION or pins['archiveSha256']!=ARCHIVE_SHA or sha(patch)!=pins['patchSha256']: raise RuntimeError('Pinned source/patch identity mismatch')
    if SOURCE.exists():
        if not pins.get('sourceTreeSha256') or tree(SOURCE)!=pins['sourceTreeSha256']: raise RuntimeError('Prepared source tree differs from reviewed pin; no mutable checkout is accepted')
    else:
        if args.verify_only: raise RuntimeError('Verified source profile has not been prepared')
        SOURCE.parent.mkdir(parents=True,exist_ok=True)
        if not ARCHIVE.exists():
            if args.offline: raise RuntimeError('Pinned source archive is unavailable offline')
            with urllib.request.urlopen(pins['archiveUrl'],timeout=30) as response, ARCHIVE.with_suffix('.download').open('wb') as output: shutil.copyfileobj(response,output)
            ARCHIVE.with_suffix('.download').rename(ARCHIVE)
        if sha(ARCHIVE)!=ARCHIVE_SHA: raise RuntimeError('Pinned upstream source archive digest mismatch')
        stage=pathlib.Path(tempfile.mkdtemp(prefix='.source-',dir=SOURCE.parent))
        try:
            with tarfile.open(ARCHIVE,'r:gz') as archive:
                for member in archive:
                    parts=pathlib.PurePosixPath(member.name).parts
                    if not parts or parts[0]!='containerization-'+REVISION or any(p in {'..',''} for p in parts) or member.name.startswith('/') or not (member.isdir() or member.isfile()): raise RuntimeError('Unsafe source archive entry')
                    dest=stage.joinpath(*parts[1:])
                    if member.isdir(): dest.mkdir(parents=True,exist_ok=True)
                    else:
                        dest.parent.mkdir(parents=True,exist_ok=True)
                        with archive.extractfile(member) as data, dest.open('wb') as output: shutil.copyfileobj(data,output)
                        dest.chmod(member.mode & 0o755)
            for name,value in pins['files'].items():
                path=stage/name
                if value['upstreamSha256']!=hashlib.sha256(b'').hexdigest() and sha(path)!=value['upstreamSha256']: raise RuntimeError('Upstream source file digest differs')
            subprocess.run(['git','apply','--check',str(patch)],cwd=stage,check=True)
            subprocess.run(['git','apply',str(patch)],cwd=stage,check=True)
            for name,value in pins['files'].items():
                if sha(stage/name)!=value['patchedSha256']: raise RuntimeError('Patched source file digest differs')
            digest=tree(stage)
            if pins.get('sourceTreeSha256') and digest!=pins['sourceTreeSha256']: raise RuntimeError('Patched full tree digest differs')
            # First preparation is a development pin computation, never silently
            # an accepted production profile. Review and commit this digest.
            if not pins.get('sourceTreeSha256'): print(json.dumps({'computedSourceTreeSha256':digest,'reviewRequired':True}))
            stage.rename(SOURCE)
        finally:
            if stage.exists(): shutil.rmtree(stage)
    if not ARCHIVE.exists() or sha(ARCHIVE)!=ARCHIVE_SHA: raise RuntimeError('Corresponding pinned archive required alongside source')
    print(json.dumps({'revision':REVISION,'patchSha256':pins['patchSha256'],'sourceTreeSha256':tree(SOURCE),'source':str(SOURCE),'archive':str(ARCHIVE)}))
if __name__=='__main__': main()
