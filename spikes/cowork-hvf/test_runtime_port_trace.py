"""Native-only generic port/copy/control/lease/lifecycle/admission regression harness. No VM."""
import json,os,subprocess
from build import ROOT,OUT,digest
from prepare_runtime_port_trace import prepare

def main():
    source=prepare();env=os.environ.copy();env.update(PATH=str(OUT/'rust/bin')+':'+env['PATH'],CARGO_HOME=str(OUT/'cargo-home'),CARGO_NET_OFFLINE='true')
    common=['--manifest-path',str(source/'Cargo.toml'),'--locked','--offline','--no-default-features','--features','blk','--jobs','2']
    receipt={'vmStarted':False,'keysOrUnlock':False,'payloadLogging':False,'productionReady':False,'patchSha256':digest(ROOT/'patches/0011-proposed-runtime-port-fixture-trace.patch'),'commands':[]}
    for package,name in [('krun-devices','runtime_port'),('libkrun','runtime_port'),('krun-devices','cowork_stream'),('krun-devices','cowork_rng'),('krun-devices','reclaim_access::tests'),('krun-devices','cowork_frq'),('krun-devices','cowork_block'),('krun-devices','block_bounce::tests'),('libkrun','cowork_stream'),('libkrun','cowork_admission')]:
        command=[str(OUT/'rust/bin/cargo'),'test',*common,'-p',package,name,'--','--test-threads=1','--nocapture'];receipt['commands'].append(command);subprocess.run(command,check=True,env=env)
    command=[str(OUT/'rust/bin/cargo'),'check',*common,'-p','libkrun'];receipt['commands'].append(command);subprocess.run(command,check=True,env=env)
    receipt['passed']=True;(OUT/'runtime-port-trace-test-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
if __name__=='__main__':main()
