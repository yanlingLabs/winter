//! Bounded owned stream I/O. No guest memory, packet interpretation or credential authority here.
use crate::reclaim_access::Fault;
use std::io::{self, ErrorKind};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use utils::eventfd::EventFd;
pub const CHUNK: usize = 16 * 1024;
pub const MAX_TX: usize = 64 * 1024;
pub const MAX_CHAIN: usize = 1024 * 1024;
pub struct ScopedStream {
    fd: OwnedFd,
}
impl ScopedStream {
    /// Creates both endpoints internally. Only the opposite peer is published to the caller.
    /// Production worker must deny process-fork/exec before this call and never fork afterward.
    /// CLOEXEC covers exec only; this library is not a hostile-same-process boundary.
    pub fn create_pair() -> io::Result<(Self, OwnedFd)> {
        Self::create_pair_configured(|device, _peer| Self::configure_device(device))
    }
    fn create_pair_configured(
        configure: impl FnOnce(RawFd, RawFd) -> io::Result<()>,
    ) -> io::Result<(Self, OwnedFd)> {
        let mut fds = [-1; 2];
        if unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // Owned immediately: every failure closes both endpoints. CLOEXEC is set before publication.
        let device = unsafe { OwnedFd::from_raw_fd(fds[0]) };
        let peer = unsafe { OwnedFd::from_raw_fd(fds[1]) };
        let device = Self::normalize_owned(device)?;
        let peer = Self::normalize_owned(peer)?;
        configure(device.as_raw_fd(), peer.as_raw_fd())?;
        Ok((Self { fd: device }, peer))
    }
    fn normalize_owned(fd: OwnedFd) -> io::Result<OwnedFd> {
        if fd.as_raw_fd() < 3 {
            let duplicate = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
            if duplicate < 0 {
                return Err(io::Error::last_os_error());
            }
            return Ok(unsafe { OwnedFd::from_raw_fd(duplicate) });
        }
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(fd)
    }
    fn configure_device(fd: RawFd) -> io::Result<()> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } != 0 {
            return Err(io::Error::last_os_error());
        }
        #[cfg(target_os = "macos")]
        {
            let no_sigpipe = 1i32;
            if unsafe {
                libc::setsockopt(
                    fd,
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
        Ok(())
    }
    pub(crate) fn as_raw_fd(&self) -> RawFd {
        self.fd.as_raw_fd()
    }
    /// Internal alias only; no C API exposes a device-end descriptor.
    pub fn duplicate(&self) -> io::Result<Self> {
        let duplicate = unsafe { libc::fcntl(self.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
        if duplicate < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            fd: unsafe { OwnedFd::from_raw_fd(duplicate) },
        })
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
pub(crate) fn test_pair() -> (ScopedStream, std::os::unix::net::UnixStream) {
    let (device, peer) = ScopedStream::create_pair().unwrap();
    (device, std::os::unix::net::UnixStream::from(peer))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cowork_stream_factory_owned_dup_cloexec_and_closure() {
        let (stream, peer) = ScopedStream::create_pair().unwrap();
        let original = stream.as_raw_fd();
        let peer_fd = peer.as_raw_fd();
        assert!(original >= 3 && peer_fd >= 3 && original != peer_fd);
        for fd in [original, peer_fd] {
            assert!(unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC != 0);
        }
        assert!(unsafe { libc::fcntl(original, libc::F_GETFL) } & libc::O_NONBLOCK != 0);
        let duplicate = stream.duplicate().unwrap();
        let duplicate_fd = duplicate.as_raw_fd();
        assert!(duplicate_fd != original && duplicate_fd != peer_fd);
        assert!(unsafe { libc::fcntl(duplicate_fd, libc::F_GETFD) } & libc::FD_CLOEXEC != 0);
        drop(stream);
        assert!(unsafe { libc::fcntl(original, libc::F_GETFD) } < 0);
        assert!(unsafe { libc::fcntl(peer_fd, libc::F_GETFD) } >= 0);
        drop(duplicate);
        assert!(unsafe { libc::fcntl(duplicate_fd, libc::F_GETFD) } < 0);
        drop(peer);
        assert!(unsafe { libc::fcntl(peer_fd, libc::F_GETFD) } < 0);
    }
    #[test]
    fn cowork_stream_factory_failure_closes_private_and_peer_before_publication() {
        let private = std::cell::Cell::new(-1);
        let peer = std::cell::Cell::new(-1);
        let result = ScopedStream::create_pair_configured(|device, opposite| {
            private.set(device);
            peer.set(opposite);
            Err(io::Error::from(ErrorKind::Other))
        });
        assert!(result.is_err());
        for fd in [private.get(), peer.get()] {
            assert!(fd >= 3 && unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0);
        }
    }
    #[test]
    fn cowork_stream_io_bounds_reject_without_guest_or_payload_logging() {
        let (stream, _peer) = ScopedStream::create_pair().unwrap();
        let mut bytes = vec![0; CHUNK + 1];
        assert!(stream.read_owned(&mut bytes).is_err());
        assert!(stream.write_owned(&bytes).is_err());
    }
}
#[cfg(test)]
mod adversarial_tests {
    use super::*;
    use std::time::{Duration, Instant};
    #[test]
    fn cowork_stream_peer_mutation_sigpipe_child() {
        if std::env::var_os("COWORK_SIGPIPE_CHILD").is_none() {
            return;
        }
        let (stream, peer) = ScopedStream::create_pair().unwrap();
        let alias = unsafe { libc::fcntl(peer.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
        assert!(alias >= 3);
        let alias = unsafe { OwnedFd::from_raw_fd(alias) };
        unsafe {
            let initial = libc::fcntl(alias.as_raw_fd(), libc::F_GETFL);
            assert!(libc::fcntl(alias.as_raw_fd(), libc::F_SETFL, initial | libc::O_NONBLOCK) == 0);
            assert!(libc::fcntl(peer.as_raw_fd(), libc::F_GETFL) & libc::O_NONBLOCK != 0);
            let flags = libc::fcntl(peer.as_raw_fd(), libc::F_GETFL);
            assert!(libc::fcntl(peer.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK) == 0);
            #[cfg(target_os = "macos")]
            {
                let enabled = 1i32;
                assert!(
                    libc::setsockopt(
                        alias.as_raw_fd(),
                        libc::SOL_SOCKET,
                        libc::SO_NOSIGPIPE,
                        &enabled as *const _ as *const _,
                        4
                    ) == 0
                );
            }
            let disabled = 0i32;
            #[cfg(target_os = "macos")]
            assert!(
                libc::setsockopt(
                    peer.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_NOSIGPIPE,
                    &disabled as *const _ as *const _,
                    4
                ) == 0
            );
            assert!(libc::fcntl(stream.as_raw_fd(), libc::F_GETFL) & libc::O_NONBLOCK != 0);
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
                assert_eq!(value, 1);
            }
            assert!(libc::signal(libc::SIGPIPE, libc::SIG_DFL) != libc::SIG_ERR);
            let mut action: libc::sigaction = std::mem::zeroed();
            assert!(libc::sigaction(libc::SIGPIPE, std::ptr::null(), &mut action) == 0);
            assert!(action.sa_sigaction == libc::SIG_DFL);
        }
        let mut bytes = [0u8; 16];
        assert!(stream.read_owned(&mut bytes).unwrap_err().kind() == ErrorKind::WouldBlock);
        let small_buffer = 4096i32;
        assert!(
            unsafe {
                libc::setsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_SNDBUF,
                    &small_buffer as *const _ as *const _,
                    4,
                )
            } == 0
        );
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
        assert!(
            saw_backpressure,
            "private device endpoint must remain nonblocking after peer mutation"
        );
        drop(alias);
        drop(peer);
        assert!(stream.write_owned(&bytes).is_err());
    }
    #[test]
    fn cowork_stream_factory_peer_mutation_cannot_change_private_io_with_sigpipe_default() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("stream_io::adversarial_tests::cowork_stream_peer_mutation_sigpipe_child")
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
