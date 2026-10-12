"""Native constructor/intake/RAW/access/profile regressions only. Never invokes a worker/VM."""
import json, os, re, subprocess, tempfile
from build import ROOT, OUT, digest
from prepare_workspace_disks_v2 import prepare

def main():
    source=prepare();env=os.environ.copy()
    env.update(PATH=str(OUT/'rust/bin')+':'+env['PATH'],CARGO_HOME=str(OUT/'cargo-home'),CARGO_NET_OFFLINE='true')
    common=['--manifest-path',str(source/'Cargo.toml'),'--locked','--offline','--no-default-features','--features','blk','--jobs','2']
    receipt={'vmStarted':False,'workerBuilt':False,'nativeAuthorityImplemented':False,'productionReady':False,'fullResourceGatePassed':False,'patchSha256':digest(ROOT/'patches/0013-proposed-workspace-disks-startup-phases.patch'),'commands':[],'testsPassed':0,'testExecutionsPassed':0}
    with tempfile.TemporaryDirectory(prefix='winter-workspace-native-',dir='/tmp') as directory:
        env['TMPDIR']=directory
        for package,name in [('krun-devices','workspace_disks'),('libkrun','workspace_disks'),('krun-devices','runtime_port'),('libkrun','runtime_port'),('krun-devices','cowork_stream'),('krun-devices','cowork_rng'),('krun-devices','reclaim_access::tests'),('krun-devices','cowork_frq'),('krun-devices','cowork_block'),('krun-devices','block_bounce::tests'),('libkrun','cowork_stream')]:
            command=[str(OUT/'rust/bin/cargo'),'test',*common,'-p',package,name,'--','--test-threads=1','--nocapture']
            result=subprocess.run(command,env=env,capture_output=True,text=True)
            print(result.stdout,end='');print(result.stderr,end='')
            result.check_returncode()
            counts=re.findall(r'test result: ok\. (\d+) passed',result.stdout)
            if not counts or sum(map(int,counts))==0:raise RuntimeError('Missing executed native tests: '+name)
            count=int(counts[-1]);executions=sum(map(int,counts));receipt['testsPassed']+=count;receipt['testExecutionsPassed']+=executions
            receipt['commands'].append({'command':command,'passed':count,'executionsPassed':executions,'exitCode':result.returncode})
        command=[str(OUT/'rust/bin/cargo'),'check',*common,'-p','libkrun'];subprocess.run(command,check=True,env=env);receipt['commands'].append({'command':command,'exitCode':0})
    receipt['passed']=True;(OUT/'workspace-disks-v2-test-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
if __name__=='__main__':main()
