"""Same guarded worker/access/Queue implementation, without a VM or host disk I/O."""
import os,subprocess,json
from build import ROOT,OUT,digest
from prepare_block import prepare

def main():
    source=prepare();env=os.environ.copy();env.update(PATH=str(OUT/'rust/bin')+':'+env['PATH'],CARGO_HOME=str(OUT/'cargo-home'),CARGO_NET_OFFLINE='true')
    cargo=[str(OUT/'rust/bin/cargo')];common=['--manifest-path',str(source/'Cargo.toml'),'--locked','--offline','--no-default-features','--features','blk','--jobs','4']
    result={'vmStarted':False,'productionReady':False,'patchSha256':digest(ROOT/'patches/0003-proposed-guarded-block.patch'),'commands':[]}
    for name in ['cowork_frq','cowork_block','reclaim_access::tests','block_bounce::tests']:
        command=cargo+['test',*common,'-p','krun-devices',name,'--','--nocapture'];result['commands'].append(command);subprocess.run(command,check=True,env=env)
    command=cargo+['check',*common,'-p','libkrun'];result['commands'].append(command);subprocess.run(command,check=True,env=env)
    result['passed']=True
    (OUT/'block-test-receipt.json').write_text(json.dumps(result,indent=2)+'\n')

if __name__=='__main__':main()
