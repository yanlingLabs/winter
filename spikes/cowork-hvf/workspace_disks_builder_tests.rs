use super::*;
use devices::workspace_disks::{ExpectedVolume, WorkspaceDisks, MIN_CAPACITY};
use std::fs::{self, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
struct Cleanup(std::path::PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn open_fds() -> Vec<i32> {
    let names: Vec<_> = fs::read_dir("/dev/fd")
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    let mut fds: Vec<_> = names
        .into_iter()
        .filter_map(|n| n.to_str().and_then(|s| s.parse::<i32>().ok()))
        .filter(|fd| *fd >= 3 && unsafe { libc::fcntl(*fd, libc::F_GETFD) } >= 0)
        .collect();
    fds.sort_unstable();
    fds
}
#[test]
fn workspace_disks_partial_actual_block_construction_closes_all_new_handles_preserves_callers() {
    let root =
        std::env::temp_dir().join(format!("winter-workspace-builder-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let _cleanup = Cleanup(root.clone());
    let make = |name: &str| {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(root.join(name))
            .unwrap();
        file.set_len(MIN_CAPACITY).unwrap();
        let m = file.metadata().unwrap();
        let e = ExpectedVolume {
            device: m.dev(),
            inode: m.ino(),
            capacity_bytes: m.len(),
            uid: m.uid(),
            mode: 0o600,
        };
        (file, e)
    };
    let (data, de) = make("data");
    let (env, ee) = make("env");
    let pair = WorkspaceDisks::intake(data.as_raw_fd(), de, env.as_raw_fd(), ee).unwrap();
    let before = open_fds();
    let mut called = 0;
    let mut constructed_fds = vec![];
    assert!(
        BlockBuilder::from_cowork_workspace_with(&pair, |id, volume| {
            called += 1;
            constructed_fds.push(volume.as_raw_fd());
            if called == 2 {
                return Err(std::io::Error::from_raw_os_error(libc::EIO));
            }
            Block::new_cowork_fd(id.into(), volume)
        })
        .is_err()
    );
    assert_eq!(called, 2);
    assert_eq!(open_fds(), before);
    for fd in constructed_fds {
        assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
    }
    data.metadata().unwrap();
    env.metadata().unwrap();
    pair.validate().unwrap();
}
