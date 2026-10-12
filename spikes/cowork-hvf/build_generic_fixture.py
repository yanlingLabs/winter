"""Build nonsecret stream v3 fixture artifacts only; no VM or global installation."""
import argparse,json,os,shutil,stat,subprocess
from build import ROOT,OUT,PINS,checked,digest,verify,cpio
from prepare_runtime_port_trace import prepare

def main():
    if os.uname().sysname!='Darwin' or os.uname().machine!='arm64':raise RuntimeError('Apple Silicon macOS required')
    parser=argparse.ArgumentParser();parser.add_argument('--receipt-only',action='store_true');args=parser.parse_args()
    source=prepare();artifacts=OUT/'generic-fixture';artifacts.mkdir(exist_ok=True)
    prior_sha=digest(artifacts/'build.json') if (artifacts/'build.json').exists() else None
    if args.receipt_only:
        prior=json.loads((artifacts/'build.json').read_text())
        if prior['candidate']!=json.loads((ROOT/'runtime-port-trace-candidate.json').read_text()):raise RuntimeError('Candidate changed; full build required')
        for name,pin in prior['artifacts'].items():verify(artifacts/name,pin)
        for name in ['generic_fixture_worker.c','generic_fixture_init.c','stream_frame_deadline.h','generic_port_discovery.h']:verify(ROOT/name,prior['fixtureSources'][name])
        write_receipt(artifacts,prior_sha,True);return
    env=os.environ.copy();env.update(PATH=str(OUT/'rust/bin')+':'+env['PATH'],CARGO_HOME=str(OUT/'cargo-home'),CARGO_NET_OFFLINE='true')
    checked([OUT/'rust/bin/cargo','rustc','--crate-type','staticlib','--manifest-path',source/'Cargo.toml','-p','libkrun','--locked','--offline','--no-default-features','--features','blk','--jobs','2','--','--print','native-static-libs'],env=env)
    library=artifacts/'libkrun.a';shutil.copy2(source/'target/debug/libkrun.a',library)
    checked(['/usr/bin/clang','-O2','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-I',source/'include',ROOT/'generic_fixture_worker.c',library,'-framework','Hypervisor','-liconv','-o',artifacts/'cowork-hvf-generic-worker'])
    checked(['/usr/bin/codesign','--force','--sign','-','--options','runtime','--identifier','dev.cowork.hvf.generic-fixture-worker','--entitlements',ROOT/'worker.entitlements',artifacts/'cowork-hvf-generic-worker'])
    zig=(ROOT/PINS['zig']['cachedPath']).resolve();verify(ROOT/'../cowork-vm/out/tools/zig.tar.xz',PINS['zig']['archiveSha256'])
    if subprocess.check_output([str(zig),'version'],text=True).strip()!=PINS['zig']['version']:raise RuntimeError('Unexpected Zig')
    env=os.environ.copy();env.update(ZIG_GLOBAL_CACHE_DIR=str(OUT/'zig-global-cache'),ZIG_LOCAL_CACHE_DIR=str(OUT/'zig-local-cache'))
    checked([zig,'cc','-target','aarch64-linux-musl','-static','-O2','-Wall','-Wextra','-Werror','-DCOWORK_FIXTURE_SERIAL_LOG=1','-pthread',ROOT/'generic_fixture_init.c','-o',artifacts/'init'],env=env)
    kernel=(ROOT/PINS['kernel']['cachedPath']).resolve();verify(kernel,PINS['kernel']['sha256']);shutil.copy2(kernel,artifacts/'kernel')
    (artifacts/'initramfs.cpio').write_bytes(cpio([('dev',stat.S_IFDIR|0o755,b'',0,0),('dev/console',stat.S_IFCHR|0o600,b'',5,1),('init',stat.S_IFREG|0o755,(artifacts/'init').read_bytes(),0,0),('TRAILER!!!',0,b'',0,0)]))
    write_receipt(artifacts,prior_sha,False)

def write_receipt(artifacts,prior_sha,receipt_only):
    pin=json.loads((ROOT/'runtime-port-trace-candidate.json').read_text())
    receipt={'pins':PINS,'candidate':pin,'productionReady':False,'vmStarted':False,'identity':'dev.cowork.hvf.generic-fixture-worker','nativeOwnedCompletionHoldMillis':25,'encryption':False,'nonsecretOnly':True,'sandboxBeforeFactory':True,'hardenedRuntime':True,'nativeLinkage':'staticlib','debuggerEntitlement':False,'kernelProfile':'previously-measured-Apple-kernel/generic-vport-PL011-telemetry','normalShutdown':'supervisor port remains open through disk flush/poweroff','terminalCloseExpectedExitCode':77,'terminalCloseEffects':'UNCERTAIN','deliberateHostSinkStallSeconds':6,'fixtureTraceMaxRows':64,'priorBuildSha256':prior_sha,'receiptOnly':receipt_only,'artifactRebuilt':not receipt_only}
    receipt['artifacts']={name:digest(artifacts/name) for name in ['libkrun.a','cowork-hvf-generic-worker','init','initramfs.cpio','kernel']}
    receipt['fixtureSources']={name:digest(ROOT/name) for name in ['generic_fixture_worker.c','generic_fixture_init.c','stream_frame_deadline.h','generic_port_discovery.h','build_generic_fixture.py','run_generic_fixture.py','generic_fixture_lifecycle.py','stream_capture_v2.py','block_capture.py','block_receipts.py','generic_fixture_oracle.py','run_block.py','reclaim_receipts.py','build.py','prepare_runtime_port_trace.py','runtime_port_traced.rs','runtime_port_control.rs','runtime_port_fixture_trace.rs','generic_fixture_receipts.py','run_stream_fixture.py','stream_lifecycle.py','stream_fixture_oracle.py','stream_io_v3.rs','stream_reclaim_access.rs','worker.entitlements','pins.json','runtime-port-trace-candidate.json']}
    (artifacts/'build.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
if __name__=='__main__':main()
