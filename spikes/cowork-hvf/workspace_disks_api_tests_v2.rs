use super::*;
use devices::workspace_disks::{ExpectedVolume, MIN_CAPACITY};
use std::fs::{self, File, OpenOptions};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
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
            "winter-workspace-api-{}-{}",
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
        Self {
            path,
            file,
            expected: ExpectedVolume {
                device: m.dev(),
                inode: m.ino(),
                capacity_bytes: m.len(),
                uid: m.uid(),
                mode: 0o600,
            },
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
fn context() -> u32 {
    let id = krun_create_ctx() as u32;
    assert_eq!(krun_enable_cowork_block_fixture_reclaim(id), 0);
    let mut map = CTX_MAP.lock().unwrap();
    let cfg = map.get_mut(&id).unwrap();
    cfg.vsock_config = VsockConfig::Disabled;
    cfg.vmr.disable_implicit_console = true;
    cfg.vmr.serial_consoles.push(SerialConsoleConfig {
        input_fd: -1,
        output_fd: -1,
    });
    cfg.vmr.external_kernel = Some(ExternalKernel::default());
    cfg.vmr
        .set_vm_config(&VmConfig {
            vcpu_count: Some(2),
            mem_size_mib: Some(768),
            ..Default::default()
        })
        .unwrap();
    id
}
fn intake(id: u32, a: &Fixture, b: &Fixture) -> i32 {
    unsafe {
        krun_set_cowork_workspace_disks(
            id,
            a.file.as_raw_fd(),
            &a.expected,
            b.file.as_raw_fd(),
            &b.expected,
        )
    }
}
fn stream(id: u32) -> OwnedFd {
    let fd = krun_create_cowork_runtime_stream(id);
    assert!(fd >= 3);
    unsafe { OwnedFd::from_raw_fd(fd) }
}
#[test]
fn workspace_disks_api_context_free_closes_duplicates_only_and_duplicate_setter_is_atomic() {
    let a = Fixture::new();
    let b = Fixture::new();
    let before = open_fds();
    let id = context();
    let peer = stream(id);
    let with_stream = open_fds();
    assert_eq!(intake(id, &a, &b), 0);
    assert_eq!(open_fds().len(), with_stream.len() + 2);
    assert_eq!(intake(id, &a, &b), -libc::EINVAL);
    assert_eq!(open_fds().len(), with_stream.len() + 2);
    assert!(cowork_validate_profile(CTX_MAP.lock().unwrap().get(&id).unwrap()).is_ok());
    assert_eq!(krun_free_ctx(id), 0);
    drop(peer);
    assert_eq!(open_fds(), before);
    a.file.metadata().unwrap();
    b.file.metadata().unwrap();
}
#[test]
fn workspace_disks_api_missing_context_null_invalid_second_and_alias_do_not_publish_or_close_callers(
) {
    let a = Fixture::new();
    let b = Fixture::new();
    let before = open_fds();
    assert_eq!(intake(u32::MAX, &a, &b), -libc::ENOENT);
    assert_eq!(open_fds(), before);
    let id = context();
    assert_eq!(
        unsafe {
            krun_set_cowork_workspace_disks(
                id,
                a.file.as_raw_fd(),
                std::ptr::null(),
                b.file.as_raw_fd(),
                &b.expected,
            )
        },
        -libc::EINVAL
    );
    let mut bad = b.expected;
    bad.inode ^= 1;
    assert!(
        unsafe {
            krun_set_cowork_workspace_disks(
                id,
                a.file.as_raw_fd(),
                &a.expected,
                b.file.as_raw_fd(),
                &bad,
            )
        } < 0
    );
    assert_eq!(intake(id, &a, &a), -libc::EINVAL);
    assert!(CTX_MAP
        .lock()
        .unwrap()
        .get(&id)
        .unwrap()
        .vmr
        .cowork_workspace_disks
        .is_none());
    assert_eq!(krun_free_ctx(id), 0);
    assert_eq!(open_fds(), before);
    a.file.metadata().unwrap();
    b.file.metadata().unwrap();
}
fn path_disk() -> BlockDeviceConfig {
    BlockDeviceConfig {
        block_id: "not-workspace".into(),
        cache_type: CacheType::Writeback,
        disk_image_path: "/NO-OPEN-admission-test".into(),
        disk_image_format: ImageType::Raw,
        is_disk_read_only: false,
        direct_io: false,
        sync_mode: SyncMode::Full,
    }
}
#[test]
fn workspace_disks_api_refuses_old_path_backed_and_hvc_configuration() {
    let a = Fixture::new();
    let b = Fixture::new();
    for option in 0..4 {
        let id = context();
        {
            let mut map = CTX_MAP.lock().unwrap();
            let cfg = map.get_mut(&id).unwrap();
            match option {
                0 => cfg.block_cfgs.push(path_disk()),
                1 => cfg.root_block_cfg = Some(path_disk()),
                2 => cfg.data_block_cfg = Some(path_disk()),
                _ => {}
            }
        }
        let peer = if option == 3 {
            Some(unsafe { OwnedFd::from_raw_fd(krun_create_cowork_bootstrap_stream(id)) })
        } else {
            None
        };
        assert_eq!(intake(id, &a, &b), -libc::EINVAL);
        assert!(CTX_MAP
            .lock()
            .unwrap()
            .get(&id)
            .unwrap()
            .vmr
            .cowork_workspace_disks
            .is_none());
        assert_eq!(krun_free_ctx(id), 0);
        drop(peer);
    }
}
#[test]
fn workspace_disks_api_incompatible_profile_refuses_before_kernel_disk_or_vm_construction() {
    let a = Fixture::new();
    let b = Fixture::new();
    for option in 0..6 {
        let id = context();
        let peer = stream(id);
        assert_eq!(intake(id, &a, &b), 0);
        {
            let mut map = CTX_MAP.lock().unwrap();
            let cfg = map.get_mut(&id).unwrap();
            match option {
                0 => cfg.block_cfgs.push(path_disk()),
                1 => cfg.vmr.cowork_fixture_reclaim = false,
                2 => cfg.vmr.cowork_runtime_port = false,
                3 => {
                    cfg.vmr
                        .set_vm_config(&VmConfig {
                            vcpu_count: Some(2),
                            mem_size_mib: Some(512),
                            ..Default::default()
                        })
                        .unwrap();
                }
                4 => {
                    cfg.vmr
                        .set_vm_config(&VmConfig {
                            vcpu_count: Some(1),
                            mem_size_mib: Some(768),
                            ..Default::default()
                        })
                        .unwrap();
                }
                _ => cfg.vmr.serial_consoles.push(SerialConsoleConfig {
                    input_fd: -1,
                    output_fd: -1,
                }),
            }
            assert!(cowork_validate_profile(cfg).is_err());
        }
        {
            let cfg = CTX_MAP.lock().unwrap();
            assert!(cowork_validate_profile(cfg.get(&id).unwrap()).is_err());
        }
        assert_eq!(krun_free_ctx(id), 0);
        drop(peer);
    }
    let id = context();
    assert_eq!(intake(id, &a, &b), 0);
    {
        let cfg = CTX_MAP.lock().unwrap();
        assert!(cowork_validate_profile(cfg.get(&id).unwrap()).is_err());
    }
    assert_eq!(krun_free_ctx(id), 0);
}
#[test]
fn workspace_disks_api_metadata_drift_refuses_start_without_permission_repair() {
    let a = Fixture::new();
    let b = Fixture::new();
    let id = context();
    let peer = stream(id);
    assert_eq!(intake(id, &a, &b), 0);
    fs::set_permissions(&b.path, fs::Permissions::from_mode(0o644)).unwrap();
    {
        let cfg = CTX_MAP.lock().unwrap();
        assert!(cowork_validate_profile(cfg.get(&id).unwrap()).is_err());
    }
    assert_eq!(b.file.metadata().unwrap().mode() & 0o7777, 0o644);
    assert_eq!(krun_free_ctx(id), 0);
    drop(peer);
}
#[test]
fn workspace_disks_api_actual_two_block_construction_has_stable_ids_and_no_volume_path() {
    let mut a = Fixture::new();
    let mut b = Fixture::new();
    let id = context();
    let peer = stream(id);
    assert_eq!(intake(id, &a, &b), 0);
    // Rename preserves nlink1; original names are absent. Construction has no volume path to reopen.
    let renamed = a.path.with_extension("admitted");
    fs::rename(&a.path, &renamed).unwrap();
    a.path = renamed;
    let renamed = b.path.with_extension("admitted");
    fs::rename(&b.path, &renamed).unwrap();
    b.path = renamed;
    {
        let map = CTX_MAP.lock().unwrap();
        let pair = map
            .get(&id)
            .unwrap()
            .vmr
            .cowork_workspace_disks
            .as_ref()
            .unwrap();
        let blocks = vmm::vmm_config::block::BlockBuilder::from_cowork_workspace(pair).unwrap();
        assert_eq!(blocks.list.len(), 2);
        let ids: Vec<_> = blocks
            .list
            .iter()
            .map(|b| b.lock().unwrap().id().clone())
            .collect();
        assert_eq!(ids, vec!["winter-data", "winter-environment"]);
    }
    assert_eq!(krun_free_ctx(id), 0);
    drop(peer);
}

// Compile the exact production block-builder file without unrelated stale HVF test modules.
#[allow(dead_code)]
#[path = "../../vmm/src/vmm_config/block.rs"]
mod actual_block_builder;

#[test]
fn workspace_disks_startup_preconstruct_postvalidate_sequence() {
    let a = Fixture::new();
    let b = Fixture::new();
    let before = open_fds();
    let id = context();
    let peer = stream(id);
    assert_eq!(intake(id, &a, &b), 0);
    let mut cfg = CTX_MAP.lock().unwrap().remove(&id).unwrap();
    assert!(
        cowork_prepare_blocks(&mut cfg).is_ok(),
        "actual startup disk preparation rejected owned pair"
    );
    assert_eq!(cfg.vmr.block.list.len(), 2);
    assert!(cowork_validate_profile_in_phase(&cfg, CoworkProfilePhase::BeforeVmm).is_ok());
    assert!(
        cowork_validate_profile(&cfg).is_err(),
        "constructed devices cannot reenter preconstruction admission"
    );
    drop(cfg);
    drop(peer);
    assert_eq!(open_fds(), before);
    a.file.metadata().unwrap();
    b.file.metadata().unwrap();
}

#[test]
fn workspace_disks_startup_postvalidation_requires_exact_owned_pair_order_and_provenance() {
    for mutation in 0..7 {
        let a = Fixture::new();
        let b = Fixture::new();
        let before = open_fds();
        let id = context();
        let peer = stream(id);
        assert_eq!(intake(id, &a, &b), 0);
        let mut cfg = CTX_MAP.lock().unwrap().remove(&id).unwrap();
        cowork_prepare_blocks(&mut cfg).unwrap();
        match mutation {
            0 => {
                cfg.vmr.block.list.pop_back();
            }
            1 => {
                let first = cfg.vmr.block.list.front().unwrap().clone();
                cfg.vmr.block.list.push_back(first);
            }
            2 => {
                cfg.vmr.block.list.swap(0, 1);
            }
            3 => {
                // A freshly constructed same-inode/tag/ID block is still a substituted object.
                let [data, environment] = cfg
                    .vmr
                    .cowork_workspace_disks
                    .as_ref()
                    .unwrap()
                    .duplicate_for_blocks()
                    .unwrap();
                drop(environment);
                cfg.vmr.block.list[0] = std::sync::Arc::new(std::sync::Mutex::new(
                    devices::virtio::Block::new_cowork_fd("winter-data".into(), data).unwrap(),
                ));
            }
            4 => {
                // The IDs/path contents alone cannot mint the private FD constructor provenance.
                let mut config = path_disk();
                config.block_id = "winter-data".into();
                config.disk_image_path = a.path.to_string_lossy().into_owned();
                cfg.vmr.block.list[0] = std::sync::Arc::new(std::sync::Mutex::new(
                    vmm::vmm_config::block::BlockBuilder::create_block(config).unwrap(),
                ));
            }
            5 => {
                cfg.vmr
                    .set_vm_config(&VmConfig {
                        vcpu_count: Some(2),
                        mem_size_mib: Some(512),
                        ..Default::default()
                    })
                    .unwrap();
            }
            _ => {
                fs::set_permissions(&b.path, fs::Permissions::from_mode(0o644)).unwrap();
            }
        }
        assert!(cowork_validate_profile_in_phase(&cfg, CoworkProfilePhase::BeforeVmm).is_err());
        drop(cfg);
        drop(peer);
        assert_eq!(open_fds(), before);
        a.file.metadata().unwrap();
        b.file.metadata().unwrap();
    }
}

#[test]
fn workspace_disks_startup_preparation_refuses_prebuilt_extra_or_retained_provenance_before_duplication(
) {
    for mutation in 0..3 {
        let a = Fixture::new();
        let b = Fixture::new();
        let before = open_fds();
        let id = context();
        let peer = stream(id);
        assert_eq!(intake(id, &a, &b), 0);
        let mut cfg = CTX_MAP.lock().unwrap().remove(&id).unwrap();
        cfg.vmr.block = vmm::vmm_config::block::BlockBuilder::from_cowork_workspace(
            cfg.vmr.cowork_workspace_disks.as_ref().unwrap(),
        )
        .unwrap();
        if mutation == 1 {
            let first = cfg.vmr.block.list.front().unwrap().clone();
            cfg.vmr.block.list.push_back(first);
        }
        if mutation == 2 {
            cfg.vmr.block.list.clear();
        }
        let staged = open_fds();
        assert!(cowork_prepare_blocks(&mut cfg).is_err());
        assert_eq!(open_fds(), staged);
        drop(cfg);
        drop(peer);
        assert_eq!(open_fds(), before);
    }
}

#[test]
fn workspace_disks_startup_postvalidation_rejects_pair_from_another_admission() {
    let a = Fixture::new();
    let b = Fixture::new();
    let other_a = Fixture::new();
    let other_b = Fixture::new();
    let before = open_fds();
    let id = context();
    let peer = stream(id);
    assert_eq!(intake(id, &a, &b), 0);
    let mut cfg = CTX_MAP.lock().unwrap().remove(&id).unwrap();
    cowork_prepare_blocks(&mut cfg).unwrap();
    cfg.vmr.cowork_workspace_disks = Some(
        devices::workspace_disks::WorkspaceDisks::intake(
            other_a.file.as_raw_fd(),
            other_a.expected,
            other_b.file.as_raw_fd(),
            other_b.expected,
        )
        .unwrap(),
    );
    assert!(cowork_validate_profile_in_phase(&cfg, CoworkProfilePhase::BeforeVmm).is_err());
    drop(cfg);
    drop(peer);
    assert_eq!(open_fds(), before);
}
