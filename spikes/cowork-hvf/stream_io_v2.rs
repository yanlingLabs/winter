//! Bounded owned stream I/O. No guest memory, packet interpretation or credential authority here.
use crate::reclaim_access::Fault;
use std::io::{self, ErrorKind};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use utils::eventfd::EventFd;
// Darwin's public MSG_DONTWAIT controls sb-lock acquisition but sosendcheck's
// capacity wait checks this private per-call flag instead. Feasibility-only ABI:
// Apple XNU f6217f891ac0bb64f3d375211650a4c1ff8ca1ea, bsd/sys/socket_private.h:569.
// The real alias/full-buffer subprocess regression must pass on the target host.
#[cfg(target_os = "macos")]
const DARWIN_MSG_NBIO: libc::c_int = 0x20000;
pub const CHUNK: usize = 16 * 1024;
pub const MAX_TX: usize = 64 * 1024;
pub const MAX_CHAIN: usize = 1024 * 1024;
pub struct ScopedStream {
    fd: OwnedFd,
}
impl ScopedStream {
    /// Only connected unnamed local socketpair endpoints, never stdio/TTY/path/connect.
    pub fn admit(fd: RawFd) -> io::Result<Self> {
        if fd < 3 {
            return Err(io::Error::from(ErrorKind::InvalidInput));
        }
        let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
        if duplicate < 0 {
            return Err(io::Error::last_os_error());
        }
        let owned = unsafe { OwnedFd::from_raw_fd(duplicate) };
        let fd = owned.as_raw_fd(); // Validate the owned duplicate, not a replaceable caller fd.
        let mut kind = 0i32;
        let mut length = std::mem::size_of_val(&kind) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_TYPE,
                &mut kind as *mut _ as *mut _,
                &mut length,
            )
        } != 0
            || kind != libc::SOCK_STREAM
        {
            return Err(io::Error::from(ErrorKind::InvalidInput));
        }
        for peer in [false, true] {
            let mut address: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
            let mut size = std::mem::size_of_val(&address) as libc::socklen_t;
            let rc = unsafe {
                if peer {
                    libc::getpeername(fd, &mut address as *mut _ as *mut _, &mut size)
                } else {
                    libc::getsockname(fd, &mut address as *mut _ as *mut _, &mut size)
                }
            };
            let offset = std::mem::offset_of!(libc::sockaddr_un, sun_path);
            if rc != 0
                || address.ss_family as i32 != libc::AF_UNIX
                || (size as usize) < offset
                || (size as usize) > std::mem::size_of_val(&address)
            {
                return Err(io::Error::from(ErrorKind::InvalidInput));
            }
            // Darwin reports an unnamed sockaddr with length16; require zero name bytes, not length2.
            let bytes = unsafe {
                std::slice::from_raw_parts(&address as *const _ as *const u8, size as usize)
            };
            if bytes[offset..].iter().any(|byte| *byte != 0) {
                return Err(io::Error::from(ErrorKind::InvalidInput));
            }
        }
        let flags = unsafe { libc::fcntl(duplicate, libc::F_GETFL) };
        if flags < 0
            || unsafe { libc::fcntl(duplicate, libc::F_SETFL, flags | libc::O_NONBLOCK) } != 0
        {
            return Err(io::Error::last_os_error());
        }
        #[cfg(target_os = "macos")]
        {
            let no_sigpipe = 1i32;
            if unsafe {
                libc::setsockopt(
                    duplicate,
                    libc::SOL_SOCKET,
                    libc::SO_NOSIGPIPE,
                    &no_sigpipe as *const _ as *const _,
                    std::mem::size_of_val(&no_sigpipe) as libc::socklen_t,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(Self { fd: owned })
    }
    pub fn as_raw_fd(&self) -> RawFd {
        self.fd.as_raw_fd()
    }
    pub fn duplicate(&self) -> io::Result<Self> {
        Self::admit(self.as_raw_fd())
    }
    pub fn read_owned(&self, target: &mut [u8]) -> io::Result<usize> {
        if target.len() > CHUNK {
            return Err(io::Error::from(ErrorKind::InvalidInput));
        }
        let result = unsafe {
            libc::recv(
                self.as_raw_fd(),
                target.as_mut_ptr().cast(),
                target.len(),
                libc::MSG_DONTWAIT,
            )
        };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(result as usize)
        }
    }
    pub fn write_owned(&self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > CHUNK {
            return Err(io::Error::from(ErrorKind::InvalidInput));
        }
        let flags = libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL;
        #[cfg(target_os = "macos")]
        let flags = flags | DARWIN_MSG_NBIO;
        let result =
            unsafe { libc::send(self.as_raw_fd(), bytes.as_ptr().cast(), bytes.len(), flags) };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(result as usize)
        }
    }
    /// Interruptible readiness wait touches only an owned host FD and cancellation descriptor.
    pub fn wait(&self, writable: bool, stop_fd: &EventFd, stop: &AtomicBool) -> Result<(), Fault> {
        use std::os::fd::AsRawFd;
        loop {
            if stop.load(Ordering::Acquire) {
                return Err(Fault::Stopped);
            }
            let mut fds = [
                libc::pollfd {
                    fd: self.as_raw_fd(),
                    events: if writable {
                        libc::POLLOUT
                    } else {
                        libc::POLLIN
                    },
                    revents: 0,
                },
                libc::pollfd {
                    fd: stop_fd.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            let result = unsafe { libc::poll(fds.as_mut_ptr(), 2, 100) };
            if result < 0 {
                if io::Error::last_os_error().kind() == ErrorKind::Interrupted {
                    continue;
                }
                return Err(Fault::Stopped);
            }
            if fds[1].revents != 0 || stop.load(Ordering::Acquire) {
                return Err(Fault::Stopped);
            }
            if fds[0].revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
                return Err(Fault::Stopped);
            }
            if fds[0].revents != 0 {
                return Ok(());
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::{UnixDatagram, UnixStream};
    #[test]
    fn cowork_stream_fd_kind_owned_dup_cloexec_and_closure() {
        let (a, _b) = UnixStream::pair().unwrap();
        let original = a.as_raw_fd();
        let stream = ScopedStream::admit(original).unwrap();
        let duplicate = stream.as_raw_fd();
        assert!(duplicate != original);
        assert!(unsafe { libc::fcntl(duplicate, libc::F_GETFD) } & libc::FD_CLOEXEC != 0);
        drop(stream);
        assert!(unsafe { libc::fcntl(duplicate, libc::F_GETFD) } < 0);
        assert!(unsafe { libc::fcntl(original, libc::F_GETFD) } >= 0);
        assert!(ScopedStream::admit(0).is_err());
        let (a, _b) = UnixDatagram::pair().unwrap();
        assert!(ScopedStream::admit(a.as_raw_fd()).is_err());
    }
    #[test]
    fn cowork_stream_io_bounds_reject_without_guest_or_payload_logging() {
        let (a, _b) = UnixStream::pair().unwrap();
        let stream = ScopedStream::admit(a.as_raw_fd()).unwrap();
        let mut bytes = vec![0; CHUNK + 1];
        assert!(stream.read_owned(&mut bytes).is_err());
        assert!(stream.write_owned(&bytes).is_err());
    }
}
#[cfg(test)]
mod adversarial_tests {
    use super::*;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::time::{Duration, Instant};
    #[test]
    fn cowork_stream_alias_mutation_sigpipe_child() {
        if std::env::var_os("COWORK_SIGPIPE_CHILD").is_none() {
            return;
        }
        let (a, peer) = UnixStream::pair().unwrap();
        let stream = ScopedStream::admit(a.as_raw_fd()).unwrap();
        unsafe {
            let flags = libc::fcntl(a.as_raw_fd(), libc::F_GETFL);
            assert!(libc::fcntl(a.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK) == 0);
            let disabled = 0i32;
            #[cfg(target_os = "macos")]
            assert!(
                libc::setsockopt(
                    a.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_NOSIGPIPE,
                    &disabled as *const _ as *const _,
                    4
                ) == 0
            );
            assert!(libc::fcntl(stream.as_raw_fd(), libc::F_GETFL) & libc::O_NONBLOCK == 0);
            #[cfg(target_os = "macos")]
            {
                let mut value = 1i32;
                let mut size = 4;
                assert!(
                    libc::getsockopt(
                        stream.as_raw_fd(),
                        libc::SOL_SOCKET,
                        libc::SO_NOSIGPIPE,
                        &mut value as *mut _ as *mut _,
                        &mut size
                    ) == 0
                );
                assert_eq!(value, 0);
            }
            assert!(libc::signal(libc::SIGPIPE, libc::SIG_DFL) != libc::SIG_ERR);
            let mut action: libc::sigaction = std::mem::zeroed();
            assert!(libc::sigaction(libc::SIGPIPE, std::ptr::null(), &mut action) == 0);
            assert!(action.sa_sigaction == libc::SIG_DFL);
        }
        let mut bytes = [0u8; 16];
        assert!(stream.read_owned(&mut bytes).unwrap_err().kind() == ErrorKind::WouldBlock);
        let small_buffer = 4096i32;
        assert!(unsafe {
            libc::setsockopt(a.as_raw_fd(), libc::SOL_SOCKET, libc::SO_SNDBUF,
                &small_buffer as *const _ as *const _, 4)
        } == 0);
        let chunk = [0u8; CHUNK];
        let mut saw_backpressure = false;
        for _ in 0..64 {
            match stream.write_owned(&chunk) {
                Ok(count) => assert!(count > 0 && count <= CHUNK),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    saw_backpressure = true;
                    break;
                }
                Err(_) => panic!("unexpected owned socket error"),
            }
        }
        assert!(saw_backpressure, "per-call send must remain nonblocking after alias mutation");
        drop(peer);
        assert!(stream.write_owned(&bytes).is_err());
    }
    #[test]
    fn cowork_stream_per_call_flags_survive_alias_mutation_with_sigpipe_default() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("stream_io::adversarial_tests::cowork_stream_alias_mutation_sigpipe_child")
            .arg("--test-threads=1")
            .env("COWORK_SIGPIPE_CHILD", "1")
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "owned signal-default child failed");
                break;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                let reap = Instant::now() + Duration::from_secs(2);
                while Instant::now() < reap {
                    if child.try_wait().unwrap().is_some() {
                        panic!("bounded alias child deadline");
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                panic!("owned alias child termination uncertain");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn cowork_stream_named_and_unconnected_fds_refused() {
        let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
        assert!(raw >= 3);
        let unconnected = unsafe { OwnedFd::from_raw_fd(raw) };
        assert!(ScopedStream::admit(unconnected.as_raw_fd()).is_err());
        let directory =
            std::env::temp_dir().join(format!("cowork-stream-fd-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("socket");
        let listener = UnixListener::bind(&path).unwrap();
        assert!(ScopedStream::admit(listener.as_raw_fd()).is_err());
        let client = UnixStream::connect(&path).unwrap();
        let (server, _) = listener.accept().unwrap();
        assert!(ScopedStream::admit(client.as_raw_fd()).is_err());
        assert!(ScopedStream::admit(server.as_raw_fd()).is_err());
        drop((client, server, listener));
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }
}
#[cfg(all(test, target_os = "macos"))]
mod lifecycle_wait_tests {
    use polly::event_manager::EventManager;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};
    static SIGNALS: AtomicUsize = AtomicUsize::new(0);
    extern "C" fn interrupted(_: i32) {
        SIGNALS.fetch_add(1, Ordering::Relaxed);
    }
    #[test]
    fn cowork_stream_scoped_event_wait_zero_and_positive_bound() {
        let mut manager = EventManager::new().unwrap();
        let start = Instant::now();
        assert_eq!(manager.run_cowork_lifecycle_timeout(0).unwrap(), 0);
        assert!(start.elapsed() < Duration::from_millis(100));
        let start = Instant::now();
        assert_eq!(manager.run_cowork_lifecycle_timeout(10).unwrap(), 0);
        assert!(
            start.elapsed() >= Duration::from_millis(5)
                && start.elapsed() < Duration::from_millis(100)
        );
    }
    #[test]
    fn cowork_stream_scoped_event_wait_interrupted_child() {
        if std::env::var_os("COWORK_EINTR_CHILD").is_none() {
            return;
        }
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = interrupted as usize;
            action.sa_flags = 0;
            libc::sigemptyset(&mut action.sa_mask);
            assert!(libc::sigaction(libc::SIGUSR1, &action, std::ptr::null_mut()) == 0);
        }
        let target = unsafe { libc::pthread_self() } as usize;
        let sender = std::thread::spawn(move || {
            for _ in 0..20 {
                std::thread::sleep(Duration::from_millis(5));
                unsafe {
                    libc::pthread_kill(target as libc::pthread_t, libc::SIGUSR1);
                }
            }
        });
        let mut manager = EventManager::new().unwrap();
        let start = Instant::now();
        assert_eq!(manager.run_cowork_lifecycle_timeout(60).unwrap(), 0);
        let elapsed = start.elapsed();
        assert!(SIGNALS.load(Ordering::Relaxed) > 0);
        assert!(
            elapsed >= Duration::from_millis(40) && elapsed < Duration::from_millis(130),
            "deadline restarted or historical three-second wait used"
        );
        sender.join().unwrap();
    }
    #[test]
    fn cowork_stream_scoped_event_wait_eintr_keeps_absolute_deadline() {
        let mut child=std::process::Command::new(std::env::current_exe().unwrap()).arg("--exact").arg("stream_io::lifecycle_wait_tests::cowork_stream_scoped_event_wait_interrupted_child").arg("--test-threads=1").env("COWORK_EINTR_CHILD","1").spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "owned interrupted-wait child failed");
                break;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                let reap = Instant::now() + Duration::from_secs(2);
                while Instant::now() < reap {
                    if child.try_wait().unwrap().is_some() {
                        panic!("bounded EINTR child deadline");
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                panic!("owned EINTR child termination uncertain");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
