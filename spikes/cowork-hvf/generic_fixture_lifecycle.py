"""Immediate direct-child ownership, including setup, startup failure and interruption."""
import json,os,socket,subprocess,time
from generic_capture import Limits,capture_owned_child,finish_owned_child
from generic_fixture_oracle import GenericOracle,receive_peer


def supervise(command,directory,run_stream,parent_control,worker_control,*,
              popen_factory=subprocess.Popen,capture_fn=capture_owned_child,
              oracle_factory=GenericOracle,receive_fn=receive_peer,after_ack=None,
              limits=Limits(),scenario="normal"):
    child=None;peer=None;oracle=None;rows=[];raw=None;sandbox_eof=None
    capture=None;error=None;interrupted=False;oracle_cleanup_error=None
    sampler=None;sampler_read_fd=None;sampler_write_fd=None
    try:
        # The supervisor creates the anonymous pipe; no caller path/descriptor is accepted.
        sampler_read_fd,sampler_write_fd=os.pipe()
        sampler=os.fdopen(sampler_read_fd,'rb',buffering=0);sampler_read_fd=None
        owned_command=[*command,str(sampler_write_fd)]
        # Ownership guard exists before Popen. No post-spawn statement escapes this scope.
        child=popen_factory(owned_command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                            env={'PATH':'/usr/bin:/bin','HOME':str(directory),'TMPDIR':str(directory)},
                            bufsize=0,start_new_session=True,close_fds=True,pass_fds=(worker_control.fileno(),sampler_write_fd))
        os.close(sampler_write_fd);sampler_write_fd=None
        worker_control.close()
        (directory/'pid.json').write_text(json.dumps({'pid':child.pid,'command':owned_command})+'\n')
        peer=receive_fn(parent_control);parent_control.send(b'A')
        if after_ack is not None:after_ack()
        parent_control.close()
        start=time.monotonic()
        if run_stream:
            oracle=oracle_factory(peer,directory,start,child=child,scenario=scenario);oracle.begin()
        rows,capture=capture_fn(child,directory,limits=limits,sampler=sampler)
        if peer is not None and not run_stream:
            peer.settimeout(1);sandbox_eof=peer.recv(1)==b''
    except BaseException as failure:
        error=type(failure).__name__+': '+str(failure)
        interrupted=isinstance(failure,(KeyboardInterrupt,SystemExit))
    finally:
        # On all setup/capture exceptions, terminate ONLY the object returned by this Popen.
        if child is not None and not (capture or {}).get('exitVerified'):
            termination=finish_owned_child(child,limits,kill_now=True)
            capture={**(capture or {}),**termination}
        for descriptor in (sampler_read_fd,sampler_write_fd):
            if descriptor is not None:
                try:os.close(descriptor)
                except BaseException as failure:error=error or type(failure).__name__
        for control in (parent_control,worker_control):
            try:control.close()
            except BaseException as failure:error=error or type(failure).__name__
        if oracle is not None:
            try:raw=oracle.finish(cancel=error is not None or not (capture or {}).get('exitVerified'))
            except BaseException as failure:oracle_cleanup_error=type(failure).__name__
        # A socket close is finite and also wakes an unjoined nonblocking oracle. Its files remain unaudited.
        if peer is not None:
            try:peer.close()
            except BaseException as failure:error=error or type(failure).__name__
        # Close pipe handles only when no reader can still be inside a read on them.
        if (capture or {}).get('readerThreadsJoined',True):
            for stream in ((child.stdout,child.stderr,sampler) if child is not None else (sampler,)):
                if stream is not None:
                    try:stream.close()
                    except BaseException as failure:error=error or type(failure).__name__
    capture=capture or {'exitCode':None,'exitVerified':False,'terminationUncertain':True,'ownedChildReaped':False}
    capture.setdefault('captureComplete',False);capture.setdefault('timedOut',False)
    capture.setdefault('readerThreadsJoined',True)
    capture['lifecycleError']=error;capture['interrupted']=interrupted or capture.get('interrupted',False);capture['oracleCleanupError']=oracle_cleanup_error
    raw_quiescent=oracle is None or bool(raw and raw.get('threadJoined'))
    capture['samplerTransport']='dedicated-inherited-pipe-v1'
    capture['samplerClosed']=sampler is None or sampler.closed
    capture['ownersQuiescent']=bool(capture['samplerClosed'] and capture['exitVerified'] and capture['readerThreadsJoined'] and raw_quiescent)
    if oracle is not None and raw_quiescent:
        rows.extend(oracle.events);rows.sort(key=lambda row:row['hostElapsedSeconds'])
    return rows,capture,raw,sandbox_eof
