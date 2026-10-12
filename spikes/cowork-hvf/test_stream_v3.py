"""No-VM tests of actual guarded console, owned socket I/O, reset/epoch and admitted profile."""
import json,os,subprocess
from build import ROOT,OUT,digest
from prepare_stream_v3 import prepare

def main():
    source=prepare();env=os.environ.copy();env.update(PATH=str(OUT/'rust/bin')+':'+env['PATH'],CARGO_HOME=str(OUT/'cargo-home'),CARGO_NET_OFFLINE='true')
    common=['--manifest-path',str(source/'Cargo.toml'),'--locked','--offline','--no-default-features','--features','blk','--jobs','2']
    receipt={'vmStarted':False,'keysOrUnlock':False,'payloadLogging':False,'productionReady':False,'patchSha256':digest(ROOT/'patches/0009-proposed-guarded-stream-closed-factory.patch'),'commands':[]}
    # Serialize unrelated FD-close assertions; worker/freeze/reset concurrency remains real inside tests.
    for package,name in [('krun-devices','cowork_stream'),('krun-devices','cowork_rng'),('krun-devices','reclaim_access::tests'),('krun-devices','cowork_frq'),('krun-devices','cowork_block'),('krun-devices','block_bounce::tests'),('libkrun','cowork_stream'),('libkrun','cowork_admission')]:
        command=[str(OUT/'rust/bin/cargo'),'test',*common,'-p',package,name,'--','--test-threads=1','--nocapture'];receipt['commands'].append(command);subprocess.run(command,check=True,env=env)
    command=[str(OUT/'rust/bin/cargo'),'check',*common,'-p','libkrun'];receipt['commands'].append(command);subprocess.run(command,check=True,env=env)
    receipt['passed']=True;(OUT/'stream-v3-test-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
if __name__=='__main__':main()
