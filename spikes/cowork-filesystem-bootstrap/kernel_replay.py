"""Fixture-only bridge to an immutable kernel replay helper. No production native
boot/mount admission is supplied here. Core's replay debt remains canonical.
Timeout retains the actual helper and file descriptors; never kill=>cleanup.
"""
import errno,fcntl,hashlib,json,os,stat,subprocess,sys,tempfile,time
LOOP_GET_STATUS64=0x4c05
retained=[]
class ReplayUncertain(Exception):pass

def detached_loop(number):
    if type(number) is not int or not 0<=number<=65535:raise ReplayUncertain('loop_identity')
    fd=os.open(f'/dev/loop{number}',os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW)
    try:
        identity=os.fstat(fd)
        if not stat.S_ISBLK(identity.st_mode) or os.major(identity.st_rdev)!=7 or os.minor(identity.st_rdev)!=number:raise ReplayUncertain('loop_identity')
        try:fcntl.ioctl(fd,LOOP_GET_STATUS64,bytes(232))
        except OSError as error:
            if error.errno==errno.ENXIO:return
            raise ReplayUncertain('loop_status_unknown') from None
        raise ReplayUncertain('loop_still_associated')
    finally:os.close(fd)

class FixtureKernelReplay:
    """Only explicit Root fixture setup may provide a reviewed executable FD/hash.
    These are not guest/model/RuntimeConfig authority. Root-source review precedes use.
    """
    def __init__(self,artifact_fd,digest):
        identity=os.fstat(artifact_fd);flags=fcntl.fcntl(artifact_fd,fcntl.F_GETFL)
        if not stat.S_ISREG(identity.st_mode) or identity.st_uid!=0 or identity.st_nlink!=1 or identity.st_size>4*1024*1024 or identity.st_mode&0o222 or flags&os.O_ACCMODE!=os.O_RDONLY:raise ReplayUncertain('immutable_replay_artifact')
        if hashlib.sha256(os.pread(artifact_fd,identity.st_size,0)).hexdigest()!=digest:raise ReplayUncertain('replay_artifact_hash')
        self.artifact_fd=os.dup(artifact_fd);self.digest=digest
    def __call__(self,fd,target,deadline):
        if sys.platform!='linux' or os.geteuid()!=0 or len(retained)>=16:raise ReplayUncertain('replay_unavailable')
        remaining=min(20,deadline-time.monotonic())
        if remaining<=0:raise ReplayUncertain('operation_deadline')
        image=os.dup(fd);executable=os.dup(self.artifact_fd);out=tempfile.TemporaryFile();err=tempfile.TemporaryFile();child=None
        try:
            identity=os.fstat(executable)
            if hashlib.sha256(os.pread(executable,identity.st_size,0)).hexdigest()!=self.digest:raise ReplayUncertain('replay_artifact_changed')
            child=subprocess.Popen([f'/proc/self/fd/{executable}','--image-fd',str(image),'--uuid',target['expectedFilesystemUUID'],'--capacity',str(target['capacityBytes'])],pass_fds=(image,executable),stdin=subprocess.DEVNULL,stdout=out,stderr=err,env={'LANG':'C','LC_ALL':'C','PATH':'/nonexistent','HOME':'/nonexistent'},close_fds=True)
            try:code=child.wait(timeout=remaining)
            except subprocess.TimeoutExpired:raise ReplayUncertain('kernel_replay_lifetime_retained') from None
            out.seek(0);wire=out.read(4097);err.seek(0)
            if len(wire)>4096 or len(err.read(4097))>4096:raise ReplayUncertain('replay_capture_bound')
            records=[json.loads(line) for line in wire.splitlines()]
            if len(records)!=2:raise ReplayUncertain('replay_receipt_missing')
            initial,receipt=records;source=os.fstat(image)
            if set(initial)!={'loopMinor','backingDevice','backingInode'} or initial['backingDevice']!=str(source.st_dev) or initial['backingInode']!=str(source.st_ino):raise ReplayUncertain('replay_backing_identity')
            if receipt!={'journalReplay':'kernel-mount','mountReleased':code==0,'loopDetached':True,'loopMinor':initial['loopMinor']}:raise ReplayUncertain('replay_receipt_invalid')
            detached_loop(initial['loopMinor']) # fresh kernel observation AFTER actual reap
            if code!=0:raise ReplayUncertain('kernel_replay_failed_metadata_may_have_changed')
            return 'kernel-mount'
        except BaseException:
            # Even a reaped helper with a missing/malformed detach proof retains files/FDs.
            retained.append((child,image,executable,out,err));raise
        else:pass
        finally:
            if not any(record[1]==image for record in retained):
                os.close(image);os.close(executable);out.close();err.close()
    def close(self):os.close(self.artifact_fd)
