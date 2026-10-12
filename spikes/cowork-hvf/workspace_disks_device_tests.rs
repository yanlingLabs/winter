use super::*;
use crate::block_bounce::Disk;
use crate::workspace_disks::{ExpectedVolume, WorkspaceDisks, MIN_CAPACITY};
use std::fs::{self, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Cleanup(std::path::PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn workspace_disks_actual_raw_io_survives_names_and_caller_fds_without_reopen() {
    let root = std::env::temp_dir().join(format!(
        "winter-workspace-raw-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    let _cleanup = Cleanup(root.clone());
    let make = |name: &str| {
        let path = root.join(name);
        let f = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        f.set_len(MIN_CAPACITY).unwrap();
        let m = f.metadata().unwrap();
        let e = ExpectedVolume {
            device: m.dev(),
            inode: m.ino(),
            capacity_bytes: m.len(),
            uid: m.uid(),
            mode: 0o600,
        };
        (f, e)
    };
    let (data, de) = make("data");
    let (env, ee) = make("environment");
    data.write_all_at(b"existing-data-header", 0).unwrap();
    env.write_all_at(b"existing-env-header", 0).unwrap();
    let before_data = data.metadata().unwrap();
    let before_env = env.metadata().unwrap();
    let before_data_bytes = fs::read(root.join("data")).unwrap();
    let before_env_bytes = fs::read(root.join("environment")).unwrap();
    let pair = WorkspaceDisks::intake(data.as_raw_fd(), de, env.as_raw_fd(), ee).unwrap();
    fs::rename(root.join("data"), root.join("data-admitted")).unwrap();
    fs::rename(root.join("environment"), root.join("env-admitted")).unwrap();
    fs::write(root.join("data"), b"unknown-replacement-data").unwrap();
    fs::write(root.join("environment"), b"unknown-replacement-env").unwrap();
    drop(data);
    drop(env);
    let [data, env] = pair.duplicate_for_blocks().unwrap();
    let mut data = Block::new_cowork_fd("winter-data".into(), data).unwrap();
    let mut env = Block::new_cowork_fd("winter-environment".into(), env).unwrap();
    drop(pair);
    // Intake and both actual RAW constructors neither write, resize nor allocate backing blocks.
    for (name, before, bytes) in [
        ("data-admitted", before_data, before_data_bytes),
        ("env-admitted", before_env, before_env_bytes),
    ] {
        let after = fs::metadata(root.join(name)).unwrap();
        assert_eq!(after.len(), before.len());
        assert_eq!(
            (after.mtime(), after.mtime_nsec()),
            (before.mtime(), before.mtime_nsec())
        );
        assert_eq!(after.blocks(), before.blocks());
        assert_eq!(fs::read(root.join(name)).unwrap(), bytes);
    }
    let data_capacity = data.config.capacity;
    let env_capacity = env.config.capacity;
    assert_eq!(data_capacity, MIN_CAPACITY / 512);
    assert_eq!(env_capacity, MIN_CAPACITY / 512);
    assert_eq!(&data.disk_image_id[..11], b"winter-data");
    assert_eq!(&env.disk_image_id[..18], b"winter-environment");
    let mut dp = data.disk.take().unwrap();
    let mut ep = env.disk.take().unwrap();
    assert!(dp
        .file
        .lock()
        .unwrap()
        .resize(MIN_CAPACITY + 4096, imago::format::PreallocateMode::None)
        .is_err());
    assert!(ep
        .file
        .lock()
        .unwrap()
        .resize(MIN_CAPACITY - 4096, imago::format::PreallocateMode::None)
        .is_err());
    assert_eq!(
        fs::metadata(root.join("data-admitted")).unwrap().len(),
        MIN_CAPACITY
    );
    assert_eq!(
        fs::metadata(root.join("env-admitted")).unwrap().len(),
        MIN_CAPACITY
    );
    assert_eq!(dp.write(4096, b"durable-data"), Ok(12));
    assert_eq!(ep.write(4096, b"durable-env"), Ok(11));
    let mut buffer = [0; 12];
    assert_eq!(dp.read(4096, &mut buffer), Ok(12));
    assert_eq!(&buffer, b"durable-data");
    let mut buffer = [0; 11];
    assert_eq!(ep.read(4096, &mut buffer), Ok(11));
    assert_eq!(&buffer, b"durable-env");
    drop(dp);
    drop(ep);
    drop(data);
    drop(env);
    assert_eq!(
        fs::read(root.join("data")).unwrap(),
        b"unknown-replacement-data"
    );
    assert_eq!(
        fs::read(root.join("environment")).unwrap(),
        b"unknown-replacement-env"
    );
    assert_eq!(
        &fs::read(root.join("data-admitted")).unwrap()[4096..4108],
        b"durable-data"
    );
    assert_eq!(
        &fs::read(root.join("env-admitted")).unwrap()[4096..4107],
        b"durable-env"
    );
    fs::remove_dir_all(root).unwrap();
}
