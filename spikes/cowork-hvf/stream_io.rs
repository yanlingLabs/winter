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
        let result =
            unsafe { libc::read(self.as_raw_fd(), target.as_mut_ptr().cast(), target.len()) };
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
        #[cfg(target_os = "linux")]
        let flags = libc::MSG_NOSIGNAL;
        #[cfg(not(target_os = "linux"))]
        let flags = 0;
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
