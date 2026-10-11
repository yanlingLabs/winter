"""Run the same extracted controls/transaction as the native patch, plus actual FRQ parser tests."""
from pathlib import Path
import os,subprocess
from build import ROOT,OUT
from prepare_reclaim import prepare

def main():
    source=prepare()
    env=os.environ.copy()
    env.update(PATH=str(OUT/"rust/bin")+":"+env["PATH"],CARGO_HOME=str(OUT/"cargo-home"))
    subprocess.run([str(OUT/"rust/bin/cargo"),"test","--manifest-path",str(source/"Cargo.toml"),"-p","krun-devices","--locked","--no-default-features","--jobs","4","cowork_frq","--","--nocapture"],check=True,env=env)
    subprocess.run([str(OUT/"rust/bin/cargo"),"build","--manifest-path",str(source/"Cargo.toml"),"-p","krun-devices","--locked","--no-default-features","--jobs","4"],check=True,env=env)
    libraries=list((source/"target/debug/deps").glob("libcrossbeam_channel-*.rlib"))
    if len(libraries)!=1:raise RuntimeError("Expected one pinned crossbeam build artifact")
    extra=[]
    for name in ["krun_devices","vm_memory"]:
        matches=list((source/"target/debug/deps").glob("lib"+name+"-*.rlib"))
        if len(matches)!=1:raise RuntimeError("Expected one pinned "+name+" artifact")
        extra.extend(["--extern",name+"="+str(matches[0])])
    subprocess.run([str(OUT/"rust/bin/rustc"),"--edition=2021","--test",str(ROOT/"reclaim_tests.rs"),"-L","dependency="+str(source/"target/debug/deps"),"--extern","crossbeam_channel="+str(libraries[0]),*extra,"-o",str(OUT/"reclaim-tests")],check=True)
    subprocess.run([str(OUT/"reclaim-tests")],check=True)

if __name__=="__main__":main()
