//! Fixed-capacity positional RAW storage over an owned admitted descriptor. Construction only
//! validates metadata; unlike imago::File conversion, it performs no alignment read/write probes.
use crate::workspace_disks::{validate, ExpectedVolume};
use imago::io_buffers::{IoVector, IoVectorMut};
use imago::storage::drivers::CommonStorageHelper;
use imago::storage::PreallocateMode;
use imago::Storage;
use std::fmt;
use std::fs::File;
use std::io;
use std::os::unix::fs::FileExt;

pub struct PinnedRawStorage {
    file: File,
    expected: ExpectedVolume,
    helper: CommonStorageHelper,
}
impl fmt::Debug for PinnedRawStorage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PinnedRawStorage")
            .field("capacity", &self.expected.capacity_bytes)
            .finish_non_exhaustive()
    }
}
impl fmt::Display for PinnedRawStorage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("admitted-raw-volume")
    }
}
impl PinnedRawStorage {
    pub(crate) fn new(file: File, expected: ExpectedVolume) -> io::Result<Self> {
        validate(&file, expected)?;
        Ok(Self {
            file,
            expected,
            helper: CommonStorageHelper::default(),
        })
    }
    fn range(&self, offset: u64, length: u64) -> io::Result<()> {
        validate(&self.file, self.expected)?;
        if offset
            .checked_add(length)
            .is_none_or(|end| end > self.expected.capacity_bytes)
        {
            return Err(io::Error::from_raw_os_error(libc::EINVAL));
        }
        Ok(())
    }
    fn read_buffer(&self, buffer: &mut [u8], offset: u64) -> io::Result<()> {
        self.range(offset, buffer.len() as u64)?;
        transfer(
            offset,
            buffer.len(),
            io::ErrorKind::UnexpectedEof,
            |done, position| self.file.read_at(&mut buffer[done..], position),
        )
    }
    fn write_buffer(&self, buffer: &[u8], offset: u64) -> io::Result<()> {
        self.range(offset, buffer.len() as u64)?;
        transfer(
            offset,
            buffer.len(),
            io::ErrorKind::WriteZero,
            |done, position| self.file.write_at(&buffer[done..], position),
        )
    }
}
/// The one full-sync call of the admitted storage (`sync_all`, as imago's `SyncMode::Full`). Test builds can
/// count the calls made on one inode and fail the next ones, which is how the tests pin that a guest FLUSH and
/// the final flush at exit really reach it.
fn full_sync(file: &File) -> io::Result<()> {
    #[cfg(test)]
    {
        use std::os::unix::fs::MetadataExt;
        use std::sync::atomic::Ordering;
        if file.metadata()?.ino() == sync_seam::WATCH_INODE.load(Ordering::Acquire) {
            sync_seam::CALLS.fetch_add(1, Ordering::AcqRel);
            if sync_seam::FAIL.load(Ordering::Acquire) {
                return Err(io::Error::from_raw_os_error(libc::EIO));
            }
        }
    }
    file.sync_all()
}
#[cfg(test)]
pub(crate) mod sync_seam {
    use std::sync::atomic::{AtomicBool, AtomicU64};
    use std::sync::Mutex;
    /// Inode whose full syncs are counted (0: none).
    pub static WATCH_INODE: AtomicU64 = AtomicU64::new(0);
    pub static CALLS: AtomicU64 = AtomicU64::new(0);
    pub static FAIL: AtomicBool = AtomicBool::new(false);
    /// Serializes the tests that use the seam.
    pub static LOCK: Mutex<()> = Mutex::new(());
}
fn transfer(
    offset: u64,
    length: usize,
    zero: io::ErrorKind,
    mut operation: impl FnMut(usize, u64) -> io::Result<usize>,
) -> io::Result<()> {
    offset
        .checked_add(length as u64)
        .ok_or_else(|| io::Error::from_raw_os_error(libc::EOVERFLOW))?;
    let mut done = 0;
    while done < length {
        match operation(done, offset + done as u64) {
            Ok(0) => return Err(zero.into()),
            Ok(count) if count <= length - done => done += count,
            Ok(_) => return Err(io::ErrorKind::InvalidData.into()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
impl Storage for PinnedRawStorage {
    fn size(&self) -> io::Result<u64> {
        validate(&self.file, self.expected)?;
        Ok(self.expected.capacity_bytes)
    }
    // No filename, open/create, relative-path resolution, implicit dependency or growth API.
    async unsafe fn pure_readv(&self, vectors: IoVectorMut<'_>, mut offset: u64) -> io::Result<()> {
        self.range(offset, vectors.len())?;
        for mut buffer in vectors.into_inner() {
            let bytes: &mut [u8] = &mut buffer;
            self.read_buffer(bytes, offset)?;
            offset += bytes.len() as u64;
        }
        Ok(())
    }
    async unsafe fn pure_writev(&self, vectors: IoVector<'_>, mut offset: u64) -> io::Result<()> {
        self.range(offset, vectors.len())?;
        for buffer in vectors.into_inner() {
            let bytes: &[u8] = &buffer;
            self.write_buffer(bytes, offset)?;
            offset += bytes.len() as u64;
        }
        Ok(())
    }
    async fn flush(&self) -> io::Result<()> {
        validate(&self.file, self.expected)
    }
    async fn sync(&self) -> io::Result<()> {
        validate(&self.file, self.expected)?;
        // Same full-sync primitive as imago::File's SyncMode::Full; no relaxed fsync override.
        full_sync(&self.file)?;
        validate(&self.file, self.expected)
    }
    async unsafe fn invalidate_cache(&self) -> io::Result<()> {
        validate(&self.file, self.expected)
    }
    fn get_storage_helper(&self) -> &CommonStorageHelper {
        &self.helper
    }
    async fn resize(&self, _size: u64, _mode: PreallocateMode) -> io::Result<()> {
        Err(io::ErrorKind::Unsupported.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_disks::MIN_CAPACITY;
    use std::fs::{self, OpenOptions};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    #[test]
    fn workspace_disks_fixed_capacity_refuses_oob_overflow_and_drift_without_growth_or_partial_write(
    ) {
        let path =
            std::env::temp_dir().join(format!("winter-workspace-storage-{}", std::process::id()));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        let _cleanup = Cleanup(path.clone());
        file.set_len(MIN_CAPACITY).unwrap();
        let m = file.metadata().unwrap();
        let expected = ExpectedVolume {
            device: m.dev(),
            inode: m.ino(),
            capacity_bytes: m.len(),
            uid: m.uid(),
            mode: 0o600,
        };
        let before_blocks = m.blocks();
        let caller = file.try_clone().unwrap();
        let storage = PinnedRawStorage::new(file, expected).unwrap();
        for offset in [MIN_CAPACITY, MIN_CAPACITY - 1, u64::MAX] {
            assert!(storage.write_buffer(b"no", offset).is_err());
            let mut read = [0; 2];
            assert!(storage.read_buffer(&mut read, offset).is_err());
        }
        assert_eq!(caller.metadata().unwrap().len(), MIN_CAPACITY);
        assert_eq!(caller.metadata().unwrap().blocks(), before_blocks);
        storage.write_buffer(b"last", MIN_CAPACITY - 4).unwrap();
        let mut read = [0; 4];
        storage.read_buffer(&mut read, MIN_CAPACITY - 4).unwrap();
        assert_eq!(&read, b"last");
        caller.set_len(MIN_CAPACITY - 4096).unwrap();
        assert!(storage.size().is_err());
        assert!(storage.write_buffer(b"refuse", 0).is_err());
        assert_eq!(caller.metadata().unwrap().len(), MIN_CAPACITY - 4096);
    }
    #[test]
    fn workspace_disks_positional_partial_interrupted_zero_error_and_overflow_paths() {
        let mut calls = 0;
        transfer(4096, 7, io::ErrorKind::WriteZero, |done, offset| {
            assert_eq!(offset, 4096 + done as u64);
            calls += 1;
            if calls == 1 {
                Err(io::ErrorKind::Interrupted.into())
            } else {
                Ok((7 - done).min(2))
            }
        })
        .unwrap();
        assert_eq!(calls, 5);
        assert_eq!(
            transfer(0, 1, io::ErrorKind::UnexpectedEof, |_, _| Ok(0))
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert_eq!(
            transfer(0, 1, io::ErrorKind::WriteZero, |_, _| Ok(0))
                .unwrap_err()
                .kind(),
            io::ErrorKind::WriteZero
        );
        assert_eq!(
            transfer(0, 1, io::ErrorKind::WriteZero, |_, _| Ok(2))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            transfer(0, 1, io::ErrorKind::WriteZero, |_, _| Err(
                io::Error::from_raw_os_error(libc::EIO)
            ))
            .unwrap_err()
            .raw_os_error(),
            Some(libc::EIO)
        );
        let mut calls = 0;
        assert!(transfer(u64::MAX, 2, io::ErrorKind::WriteZero, |_, _| {
            calls += 1;
            Ok(1)
        })
        .is_err());
        assert_eq!(calls, 0);
    }

    /// The sync path of the storage is one `sync_all` through `full_sync`; the Block-level tests count and fail
    /// it, this pins the two lines that cannot be observed without a real device failure.
    #[test]
    fn workspace_disks_storage_sync_is_a_validated_sync_all() {
        let source = include_str!("workspace_raw_storage.rs");
        let sync = &source[source.find("async fn sync(&self)").unwrap()..];
        let sync = &sync[..sync.find("\n    }\n").unwrap()];
        let first = sync.find("validate(&self.file, self.expected)?;").expect("validates before");
        let call = sync.find("full_sync(&self.file)?;").expect("full sync");
        let last = sync.rfind("validate(&self.file, self.expected)").unwrap();
        assert!(first < call && call < last);
        let helper = &source[source.find("fn full_sync(file: &File)").unwrap()..];
        let helper = &helper[..helper.find("\n}\n").unwrap()];
        assert!(helper.trim_end().ends_with("file.sync_all()"), "{helper}");
    }
}
