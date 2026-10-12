//! Developer-only admitted RAW volume pair. Expected identity corroborates a host admission;
//! it is not daemon/workspace/worker authority. No volume path is retained or reopened.
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::MetadataExt;

pub const MIN_CAPACITY: u64 = 16 * 1024 * 1024;
pub const MAX_CAPACITY: u64 = 256 * 1024 * 1024 * 1024;
pub const DATA_DEVICE: u64 = 0;
pub const ENVIRONMENT_DEVICE: u64 = 1;
pub const RUNTIME_DEVICE: u64 = 2;
pub const MAX_DEVICES: usize = 3;
pub const MAX_PINS: usize = 48;
pub const MAX_PINNED_BYTES: u64 = 8 * 1024 * 1024;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExpectedVolume {
    pub device: u64,
    pub inode: u64,
    pub capacity_bytes: u64,
    pub uid: u32,
    pub mode: u32,
}

fn invalid() -> io::Error {
    io::Error::from_raw_os_error(libc::EINVAL)
}
fn duplicate(fd: RawFd) -> io::Result<File> {
    if fd < 3 {
        return Err(invalid());
    }
    // Owned immediately, including all later validation failures. Caller retains its original FD.
    let owned = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    if owned < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(owned) })
}
pub(crate) fn validate(file: &File, expected: ExpectedVolume) -> io::Result<()> {
    if expected.uid != unsafe { libc::geteuid() }
        || expected.mode != 0o600
        || !(MIN_CAPACITY..=MAX_CAPACITY).contains(&expected.capacity_bytes)
        || expected.capacity_bytes % 4096 != 0
    {
        return Err(invalid());
    }
    let metadata = file.metadata()?;
    let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != expected.uid
        || metadata.mode() & 0o7777 != expected.mode
        || metadata.dev() != expected.device
        || metadata.ino() != expected.inode
        || metadata.len() != expected.capacity_bytes
        || flags & libc::O_ACCMODE != libc::O_RDWR
        || flags & libc::O_APPEND != 0
    {
        return Err(io::Error::from_raw_os_error(libc::ESTALE));
    }
    let descriptor_flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
    if descriptor_flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if descriptor_flags & libc::FD_CLOEXEC == 0 {
        return Err(invalid());
    }
    Ok(())
}

pub struct AdmittedVolume {
    file: File,
    expected: ExpectedVolume,
}
impl AsRawFd for AdmittedVolume {
    fn as_raw_fd(&self) -> RawFd {
        self.file.as_raw_fd()
    }
}
impl AdmittedVolume {
    fn intake(fd: RawFd, expected: ExpectedVolume) -> io::Result<Self> {
        let file = duplicate(fd)?;
        validate(&file, expected)?;
        Ok(Self { file, expected })
    }
    fn duplicate(&self) -> io::Result<Self> {
        let file = duplicate(self.file.as_raw_fd())?;
        validate(&file, self.expected)?;
        Ok(Self {
            file,
            expected: self.expected,
        })
    }
    pub fn expected_identity(&self) -> ExpectedVolume {
        self.expected
    }
    pub(crate) fn into_storage(self) -> io::Result<crate::workspace_raw_storage::PinnedRawStorage> {
        crate::workspace_raw_storage::PinnedRawStorage::new(self.file, self.expected)
    }
}
pub struct WorkspaceDisks {
    data: AdmittedVolume,
    environment: AdmittedVolume,
}
impl WorkspaceDisks {
    pub fn intake(
        data_fd: RawFd,
        data: ExpectedVolume,
        env_fd: RawFd,
        environment: ExpectedVolume,
    ) -> io::Result<Self> {
        let pair = Self {
            data: AdmittedVolume::intake(data_fd, data)?,
            environment: AdmittedVolume::intake(env_fd, environment)?,
        };
        if (data.device, data.inode) == (environment.device, environment.inode) {
            return Err(invalid());
        }
        // Corroborate both pinned descriptors after all intake work, before publishing the pair.
        pair.validate()?;
        Ok(pair)
    }
    pub fn validate(&self) -> io::Result<()> {
        validate(&self.data.file, self.data.expected)?;
        validate(&self.environment.file, self.environment.expected)
    }
    pub fn expected_identities(&self) -> [ExpectedVolume; 2] {
        [self.data.expected, self.environment.expected]
    }
    pub fn duplicate_for_blocks(&self) -> io::Result<[AdmittedVolume; 2]> {
        let files = [self.data.duplicate()?, self.environment.duplicate()?];
        self.validate()?;
        validate(&files[0].file, self.data.expected)?;
        validate(&files[1].file, self.environment.expected)?;
        Ok(files)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, OpenOptions};
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        path: PathBuf,
        file: File,
        expected: ExpectedVolume,
    }
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "winter-workspace-disk-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .unwrap();
            file.set_len(MIN_CAPACITY).unwrap();
            let m = file.metadata().unwrap();
            let expected = ExpectedVolume {
                device: m.dev(),
                inode: m.ino(),
                capacity_bytes: m.len(),
                uid: m.uid(),
                mode: 0o600,
            };
            Self {
                path,
                file,
                expected,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }
    fn open_fds() -> Vec<i32> {
        let names: Vec<_> = fs::read_dir("/dev/fd")
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        let mut fds: Vec<_> = names
            .into_iter()
            .filter_map(|name| name.to_str().and_then(|s| s.parse::<i32>().ok()))
            .filter(|fd| *fd >= 3 && unsafe { libc::fcntl(*fd, libc::F_GETFD) } >= 0)
            .collect();
        fds.sort_unstable();
        fds
    }
    #[test]
    fn workspace_disks_duplicate_cloexec_and_close_only_owned_descriptors() {
        let a = Fixture::new();
        let b = Fixture::new();
        let before = open_fds();
        let pair = WorkspaceDisks::intake(
            a.file.as_raw_fd(),
            a.expected,
            b.file.as_raw_fd(),
            b.expected,
        )
        .unwrap();
        assert_eq!(open_fds().len(), before.len() + 2);
        assert_ne!(pair.data.file.as_raw_fd(), a.file.as_raw_fd());
        assert_ne!(pair.environment.file.as_raw_fd(), b.file.as_raw_fd());
        for file in [&pair.data.file, &pair.environment.file] {
            assert!(
                unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC != 0
            );
        }
        drop(pair);
        assert_eq!(open_fds(), before);
        a.file.metadata().unwrap();
        b.file.metadata().unwrap();
    }
    #[test]
    fn workspace_disks_partial_failure_alias_stdio_and_closed_fd_leave_no_extra_handles() {
        let a = Fixture::new();
        let b = Fixture::new();
        let before = open_fds();
        for fd in [-1, 0, 1, 2, 999_999] {
            assert!(
                WorkspaceDisks::intake(a.file.as_raw_fd(), a.expected, fd, b.expected).is_err()
            );
            assert_eq!(open_fds(), before);
        }
        let alias = a.file.try_clone().unwrap();
        let with_alias = open_fds();
        assert!(WorkspaceDisks::intake(
            a.file.as_raw_fd(),
            a.expected,
            alias.as_raw_fd(),
            a.expected
        )
        .is_err());
        assert_eq!(open_fds(), with_alias);
        a.file.metadata().unwrap();
        alias.metadata().unwrap();
    }
    #[test]
    fn workspace_disks_strict_identity_capacity_mode_links_access_and_append() {
        let a = Fixture::new();
        let b = Fixture::new();
        for change in 0..8 {
            let mut expected = b.expected;
            match change {
                0 => expected.device ^= 1,
                1 => expected.inode ^= 1,
                2 => expected.uid ^= 1,
                3 => expected.mode = 0o644,
                4 => expected.capacity_bytes = MIN_CAPACITY - 4096,
                5 => expected.capacity_bytes = MAX_CAPACITY + 4096,
                6 => expected.capacity_bytes += 1,
                _ => expected.capacity_bytes += 4096,
            }
            let before = open_fds();
            assert!(WorkspaceDisks::intake(
                a.file.as_raw_fd(),
                a.expected,
                b.file.as_raw_fd(),
                expected
            )
            .is_err());
            assert_eq!(open_fds(), before);
        }
        for file in [
            OpenOptions::new().read(true).open(&b.path).unwrap(),
            OpenOptions::new().write(true).open(&b.path).unwrap(),
            OpenOptions::new()
                .read(true)
                .append(true)
                .open(&b.path)
                .unwrap(),
        ] {
            let before = open_fds();
            assert!(WorkspaceDisks::intake(
                a.file.as_raw_fd(),
                a.expected,
                file.as_raw_fd(),
                b.expected
            )
            .is_err());
            assert_eq!(open_fds(), before);
        }
        let pair = WorkspaceDisks::intake(
            a.file.as_raw_fd(),
            a.expected,
            b.file.as_raw_fd(),
            b.expected,
        )
        .unwrap();
        fs::set_permissions(&b.path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(pair.validate().is_err());
        fs::set_permissions(&b.path, fs::Permissions::from_mode(0o600)).unwrap();
        let link = b.path.with_extension("alias");
        fs::hard_link(&b.path, &link).unwrap();
        assert!(pair.validate().is_err());
        fs::remove_file(link).unwrap();
        b.file.set_len(MIN_CAPACITY - 4096).unwrap();
        assert!(pair.duplicate_for_blocks().is_err());
    }
    #[test]
    fn workspace_disks_reject_directory_and_socket_without_mutating_callers() {
        let a = Fixture::new();
        let directory = File::open(std::env::temp_dir()).unwrap();
        let (socket, peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let before = open_fds();
        for fd in [directory.as_raw_fd(), socket.as_raw_fd()] {
            assert!(
                WorkspaceDisks::intake(a.file.as_raw_fd(), a.expected, fd, a.expected).is_err()
            );
            assert_eq!(open_fds(), before);
        }
        assert!(socket.peer_addr().is_ok());
        assert!(peer.peer_addr().is_ok());
        directory.metadata().unwrap();
    }
    #[test]
    fn workspace_disks_aggregate_pin_budget_has_distinct_ids_and_retains_pins_on_stop() {
        use crate::reclaim_access::{Access, Fault, Range};
        let access = Access::new(MAX_DEVICES, MAX_PINS, MAX_PINNED_BYTES);
        let tokens = [
            access.register(DATA_DEVICE).unwrap(),
            access.register(ENVIRONMENT_DEVICE).unwrap(),
            access.register(RUNTIME_DEVICE).unwrap(),
        ];
        assert_eq!(access.register(RUNTIME_DEVICE), Err(Fault::Duplicate));
        assert_eq!(access.register(3), Err(Fault::Limit));
        // Each block: permanent 256-entry ring pin plus one <=1MiB request including those rings.
        // Runtime: four 32-entry rings, two reported <=1MiB RX chains, <=64KiB TX, 8-byte control TX.
        let block_ring = 256 * 16 + (6 + 256 * 2) + (6 + 256 * 8);
        let port_rings = 4 * (32 * 16 + (6 + 32 * 2) + (6 + 32 * 8));
        let sizes = [
            2 * block_ring + crate::block_bounce::MAX_REQUEST as u64 + 17,
            2 * block_ring + crate::block_bounce::MAX_REQUEST as u64 + 17,
            port_rings
                + 2 * crate::stream_io::MAX_CHAIN as u64
                + crate::stream_io::MAX_TX as u64
                + 8,
        ];
        assert!(sizes.iter().sum::<u64>() < MAX_PINNED_BYTES);
        let mut pins = Vec::new();
        for (token, size) in tokens.into_iter().zip(sizes) {
            let lease = access.begin(token).unwrap();
            pins.push(
                lease
                    .pin(&[Range {
                        gpa: 0x1000,
                        len: size,
                    }])
                    .unwrap(),
            );
        }
        let usage = access.pinned_usage();
        let lease = access.begin(tokens[0]).unwrap();
        assert!(matches!(
            lease.pin(&[Range {
                gpa: 0x1000,
                len: MAX_PINNED_BYTES
            }]),
            Err(Fault::Limit)
        ));
        drop(lease);
        assert_eq!(access.pinned_usage(), usage);
        let frozen = access.freeze(1, std::time::Duration::from_secs(1)).unwrap();
        let ids: Vec<_> = frozen.pin_snapshots().iter().map(|p| p.device).collect();
        assert_eq!(ids, vec![DATA_DEVICE, ENVIRONMENT_DEVICE, RUNTIME_DEVICE]);
        access.stop();
        assert_eq!(access.pinned_usage(), usage);
        assert!(frozen.resume().is_err());
        drop(pins);
        assert_eq!(access.pinned_usage(), (0, 0));
        let access = Access::new(MAX_DEVICES, MAX_PINS, MAX_PINNED_BYTES);
        let token = access.register(DATA_DEVICE).unwrap();
        let lease = access.begin(token).unwrap();
        let held: Vec<_> = (0..MAX_PINS)
            .map(|_| {
                lease
                    .pin(&[Range {
                        gpa: 0x1000,
                        len: 1,
                    }])
                    .unwrap()
            })
            .collect();
        assert!(matches!(
            lease.pin(&[Range {
                gpa: 0x1000,
                len: 1
            }]),
            Err(Fault::Limit)
        ));
        assert_eq!(access.pinned_usage(), (MAX_PINS, MAX_PINS as u64));
        drop(held);
    }
}
