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

// ---- the flush chain on the real admitted-storage path, and the final flush at exit ----
use crate::virtio::VmmExitObserver;
use crate::workspace_raw_storage::sync_seam;
use std::sync::Arc;

/// Two guarded blocks over admitted temp volumes (disk slots 0 and 1) and the inode of each backing file.
fn guarded_pair(tag: &str) -> (Cleanup, [Block; 2], [u64; 2]) {
    let root = std::env::temp_dir().join(format!("winter-final-flush-{tag}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    fs::create_dir(&root).unwrap();
    let cleanup = Cleanup(root.clone());
    let make = |name: &str| {
        let f = OpenOptions::new().read(true).write(true).create_new(true).mode(0o600).open(root.join(name)).unwrap();
        f.set_len(MIN_CAPACITY).unwrap();
        let m = f.metadata().unwrap();
        (f, ExpectedVolume { device: m.dev(), inode: m.ino(), capacity_bytes: m.len(), uid: m.uid(), mode: 0o600 })
    };
    let (data, de) = make("data");
    let (env, ee) = make("environment");
    let pair = WorkspaceDisks::intake(data.as_raw_fd(), de, env.as_raw_fd(), ee).unwrap();
    let [d, e] = pair.duplicate_for_blocks().unwrap();
    let access = crate::reclaim_access::Access::new(3, 48, 8 * 1024 * 1024);
    let mut data_block = Block::new_cowork_fd("winter-data".into(), d).unwrap();
    let mut env_block = Block::new_cowork_fd("winter-environment".into(), e).unwrap();
    data_block.enable_cowork_guard(access.clone(), access.register(0).unwrap());
    env_block.enable_cowork_guard(access.clone(), access.register(1).unwrap());
    (cleanup, [data_block, env_block], [de.inode, ee.inode])
}
fn watch(inode: u64, fail: bool) {
    sync_seam::WATCH_INODE.store(inode, Ordering::Release);
    sync_seam::CALLS.store(0, Ordering::Release);
    sync_seam::FAIL.store(fail, Ordering::Release);
}
fn unwatch() {
    sync_seam::WATCH_INODE.store(0, Ordering::Release);
    sync_seam::FAIL.store(false, Ordering::Release);
}

/// A guest FLUSH on the guarded disk reaches `sync_all` on the admitted volume, and a failing sync fails the
/// FLUSH (so the `completed` counter, which the block worker bumps only on Ok, cannot move).
#[test]
fn a_disk_flush_reaches_sync_all_on_the_admitted_volume_and_a_failing_sync_fails_it() {
    let _serial = sync_seam::LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (_cleanup, mut blocks, inodes) = guarded_pair("flush");
    let disk = blocks[0].disk.as_mut().unwrap();
    watch(inodes[0], false);
    assert_eq!(disk.flush(), Ok(()));
    assert_eq!(sync_seam::CALLS.load(Ordering::Acquire), 1, "one flush, one sync_all");
    assert_eq!(disk.flush(), Ok(()));
    assert_eq!(sync_seam::CALLS.load(Ordering::Acquire), 2);
    sync_seam::FAIL.store(true, Ordering::Release);
    assert_eq!(disk.flush(), Err(()));
    assert_eq!(sync_seam::CALLS.load(Ordering::Acquire), 3, "the failing sync was attempted");
    // The other volume's syncs are not counted against this one.
    watch(inodes[1], false);
    let disk = blocks[0].disk.as_mut().unwrap();
    assert_eq!(disk.flush(), Ok(()));
    assert_eq!(sync_seam::CALLS.load(Ordering::Acquire), 0);
    unwatch();
}

/// The final flush at exit runs flush + `sync_all` on the admitted volume and records the true result: success
/// moves `final_completed`, a failing sync moves only `final_attempted`.
#[test]
fn the_final_flush_syncs_the_admitted_volume_and_reports_its_real_result() {
    let _serial = sync_seam::LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (_cleanup, mut blocks, inodes) = guarded_pair("final");
    for slot in 0..2usize {
        let before = crate::cowork_counters::flush_snapshot()[slot];
        watch(inodes[slot], false);
        blocks[slot].on_vmm_exit();
        let after = crate::cowork_counters::flush_snapshot()[slot];
        assert_eq!(sync_seam::CALLS.load(Ordering::Acquire), 1, "disk {slot}: exactly one sync_all");
        assert_eq!(after.final_attempted - before.final_attempted, 1, "disk {slot}");
        assert_eq!(after.final_completed - before.final_completed, 1, "disk {slot}");
        watch(inodes[slot], true);
        blocks[slot].on_vmm_exit();
        let failed = crate::cowork_counters::flush_snapshot()[slot];
        assert_eq!(sync_seam::CALLS.load(Ordering::Acquire), 1, "disk {slot}: the failing sync was attempted");
        assert_eq!(failed.final_attempted - after.final_attempted, 1, "disk {slot}");
        assert_eq!(failed.final_completed, after.final_completed, "disk {slot}: a failed sync is not a completed final flush");
    }
    unwatch();
}

/// The final flush wakes a worker blocked on its stop fd (and sets the stop flag) and joins it before it
/// syncs. The "worker" here blocks on the real stop fd exactly like the epoll loop would; if the observer
/// never wrote the fd the join would wait forever, so the observer runs on its own thread with a deadline.
#[test]
fn the_final_flush_wakes_the_worker_through_the_stop_fd_and_joins_it_before_syncing() {
    let _serial = sync_seam::LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (_cleanup, blocks, inodes) = guarded_pair("wake");
    let [mut block, _other] = blocks;
    let fd = block.worker_stopfd.as_raw_fd();
    let flag = block.cowork_stop.clone();
    let (seen_tx, seen_rx) = std::sync::mpsc::channel();
    let worker_done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let worker_flag = worker_done.clone();
    block.worker_thread = Some(std::thread::spawn(move || {
        let mut poll = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        // Blocks until the stop fd is written; `stop_seen` is what the worker sees once it is woken.
        while unsafe { libc::poll(&mut poll, 1, 100) } <= 0 {
            if worker_flag.load(Ordering::Acquire) {
                return; // test teardown after a failure
            }
        }
        seen_tx.send(flag.load(Ordering::Acquire)).unwrap();
    }));
    let before = crate::cowork_counters::flush_snapshot()[0];
    watch(inodes[0], false);
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let runner = std::thread::spawn(move || {
        block.on_vmm_exit();
        done_tx.send(block).unwrap();
    });
    let outcome = done_rx.recv_timeout(std::time::Duration::from_secs(10));
    worker_done.store(true, Ordering::Release);
    let block = outcome.expect("the final flush must wake and join the worker (the stop fd was never written)");
    runner.join().unwrap();
    assert!(block.worker_thread.is_none(), "the worker was joined");
    assert_eq!(seen_rx.try_recv(), Ok(true), "the stop flag was set before the worker woke");
    let after = crate::cowork_counters::flush_snapshot()[0];
    assert_eq!(after.final_completed - before.final_completed, 1);
    assert_eq!(sync_seam::CALLS.load(Ordering::Acquire), 1, "synced after the join");
    unwatch();
}
