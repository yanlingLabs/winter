//! N2 production profile regressions. Pure context and validator checks: nothing here creates a VM,
//! calls Hypervisor.framework or calls `krun_start_enter` (the start path is represented by the pure
//! `cowork_validate_profile` it runs first, and by the `krun_cowork_validate_profile_v1`
//! preflight). Run with `--test-threads=1`: contexts, descriptors and the context map are process-wide.
use super::*;
use devices::workspace_disks::{
    ExpectedVolume, DATA_DEVICE, ENVIRONMENT_DEVICE, MAX_DEVICES, MAX_PINNED_BYTES, MAX_PINS,
    MIN_CAPACITY, RUNTIME_DEVICE,
};
use std::fs::{self, File, OpenOptions};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

pub(crate) struct Volume {
    path: PathBuf,
    pub(crate) file: File,
    pub(crate) expected: ExpectedVolume,
}
impl Volume {
    pub(crate) fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "winter-production-api-{}-{}",
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
impl Drop for Volume {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
pub(crate) fn open_fds() -> Vec<i32> {
    let mut fds: Vec<_> = fs::read_dir("/dev/fd")
        .unwrap()
        .filter_map(|e| e.unwrap().file_name().to_str().and_then(|s| s.parse::<i32>().ok()))
        .filter(|fd| *fd >= 3 && unsafe { libc::fcntl(*fd, libc::F_GETFD) } >= 0)
        .collect();
    fds.sort_unstable();
    fds
}

/// The non-device setters every profile needs, applied to a fresh context.
pub(crate) fn bare() -> u32 {
    let id = krun_create_ctx() as u32;
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
pub(crate) fn machine(id: u32, vcpus: u8, memory: usize) {
    let mut map = CTX_MAP.lock().unwrap();
    map.get_mut(&id)
        .unwrap()
        .vmr
        .set_vm_config(&VmConfig {
            vcpu_count: Some(vcpus),
            mem_size_mib: Some(memory),
            ..Default::default()
        })
        .unwrap();
}
pub(crate) fn valid(id: u32) -> bool {
    let map = CTX_MAP.lock().unwrap();
    cowork_validate_profile(map.get(&id).unwrap()).is_ok()
}
fn pair_production(id: u32, a: &Volume, b: &Volume) -> i32 {
    unsafe {
        krun_cowork_set_workspace_disks_v1(id, a.file.as_raw_fd(), &a.expected, b.file.as_raw_fd(), &b.expected)
    }
}
fn pair_fixture(id: u32, a: &Volume, b: &Volume) -> i32 {
    unsafe {
        krun_set_cowork_workspace_disks(id, a.file.as_raw_fd(), &a.expected, b.file.as_raw_fd(), &b.expected)
    }
}
pub(crate) struct Production {
    pub(crate) id: u32,
    peer: Option<OwnedFd>,
    _a: Volume,
    _b: Volume,
}
impl Production {
    /// A complete production context: profile, runtime port and pair, at 2 vCPUs and 768 MiB.
    pub(crate) fn new() -> Self {
        let (a, b) = (Volume::new(), Volume::new());
        let id = bare();
        assert_eq!(krun_cowork_enable_profile_v1(id), 0);
        let raw = krun_cowork_create_runtime_port_v1(id);
        assert!(raw >= 3);
        let peer = unsafe { OwnedFd::from_raw_fd(raw) };
        assert_eq!(pair_production(id, &a, &b), 0);
        assert!(valid(id));
        assert_eq!(krun_cowork_validate_profile_v1(id), 0);
        Self {
            id,
            peer: Some(peer),
            _a: a,
            _b: b,
        }
    }
}
impl Drop for Production {
    fn drop(&mut self) {
        let freed = krun_free_ctx(self.id);
        // A second panic while unwinding would abort the whole test process and hide every later result.
        if !std::thread::panicking() {
            assert_eq!(freed, 0);
        }
        drop(self.peer.take());
    }
}

#[test]
fn production_profile_enable_is_virgin_only_and_exclusive_with_every_fixture_opt_in() {
    let before = open_fds();
    assert_eq!(krun_cowork_enable_profile_v1(u32::MAX), -libc::ENOENT);
    // Once, and never twice.
    let id = bare();
    assert_eq!(krun_cowork_enable_profile_v1(id), 0);
    assert_eq!(krun_cowork_enable_profile_v1(id), -libc::EINVAL);
    assert_eq!(krun_free_ctx(id), 0);
    // Never after any fixture opt-in.
    let id = bare();
    assert_eq!(krun_enable_cowork_block_fixture_reclaim(id), 0);
    assert_eq!(krun_cowork_enable_profile_v1(id), -libc::EINVAL);
    assert_eq!(krun_free_ctx(id), 0);
    let id = bare();
    assert_eq!(krun_enable_cowork_fixture_reclaim(id), 0);
    assert_eq!(krun_cowork_enable_profile_v1(id), -libc::EINVAL);
    assert_eq!(krun_free_ctx(id), 0);
    // Every fixture entry point refuses a production context and publishes nothing.
    let (a, b) = (Volume::new(), Volume::new());
    let baseline = open_fds();
    let id = bare();
    assert_eq!(krun_cowork_enable_profile_v1(id), 0);
    assert_eq!(krun_enable_cowork_fixture_reclaim(id), -libc::EINVAL);
    assert_eq!(krun_enable_cowork_block_fixture_reclaim(id), -libc::EINVAL);
    assert_eq!(krun_create_cowork_bootstrap_stream(id), -libc::EINVAL);
    assert_eq!(krun_create_cowork_runtime_stream(id), -libc::EINVAL);
    assert_eq!(krun_set_cowork_bootstrap_stream(id, a.file.as_raw_fd()), -libc::EINVAL);
    assert_eq!(pair_fixture(id, &a, &b), -libc::EINVAL);
    assert_eq!(open_fds(), baseline);
    let raw = krun_cowork_create_runtime_port_v1(id);
    assert!(raw >= 3);
    let peer = unsafe { OwnedFd::from_raw_fd(raw) };
    assert_eq!(krun_enable_cowork_runtime_port_fixture_trace(id), -libc::EINVAL);
    assert!(!CTX_MAP.lock().unwrap().get(&id).unwrap().vmr.cowork_runtime_fixture_trace);
    assert_eq!(krun_cowork_create_runtime_port_v1(id), -libc::EINVAL);
    assert_eq!(krun_free_ctx(id), 0);
    drop(peer);
    // The reverse: the production entry points refuse a fixture context.
    let id = bare();
    assert_eq!(krun_enable_cowork_block_fixture_reclaim(id), 0);
    assert_eq!(krun_cowork_create_runtime_port_v1(id), -libc::EINVAL);
    let raw = krun_create_cowork_runtime_stream(id);
    assert!(raw >= 3);
    let peer = unsafe { OwnedFd::from_raw_fd(raw) };
    let held = open_fds();
    assert_eq!(pair_production(id, &a, &b), -libc::EINVAL);
    assert_eq!(open_fds(), held);
    assert_eq!(krun_cowork_validate_profile_v1(id), -libc::EINVAL);
    assert_eq!(pair_fixture(id, &a, &b), 0);
    assert_eq!(krun_cowork_validate_profile_v1(id), -libc::EINVAL);
    assert!(!CTX_MAP.lock().unwrap().get(&id).unwrap().cowork_production);
    assert_eq!(krun_free_ctx(id), 0);
    drop(peer);
    drop((a, b));
    assert_eq!(open_fds(), before);
}

#[test]
fn production_profile_enforces_explicit_vcpu_and_memory_limits_inside_the_gate() {
    let production = Production::new();
    let id = production.id;
    // Admitted: exactly two vCPUs, 768..=1024 MiB.
    for memory in [768usize, 769, 900, 1023, 1024] {
        machine(id, 2, memory);
        assert!(valid(id), "memory {memory}");
        assert_eq!(krun_cowork_validate_profile_v1(id), 0, "memory {memory}");
    }
    // Refused: above the ceiling (the lifted-gate mutation), below the floor, other vCPU counts.
    for (vcpus, memory) in [
        (2u8, 1025usize),
        (2, 2048),
        (2, 1 << 20),
        (2, 767),
        (2, 512),
        (2, 1),
        (3, 768),
        (4, 768),
        (32, 1024),
        (1, 768),
        (1, 1024),
    ] {
        machine(id, vcpus, memory);
        assert!(!valid(id), "{vcpus} vCPU / {memory} MiB");
        assert_eq!(
            krun_cowork_validate_profile_v1(id),
            -libc::EINVAL,
            "{vcpus} vCPU / {memory} MiB"
        );
    }
    // A context whose machine was never configured is not production-admissible.
    CTX_MAP
        .lock()
        .unwrap()
        .get_mut(&id)
        .unwrap()
        .vmr
        .set_vm_config(&VmConfig::default())
        .unwrap();
    assert!(!valid(id));
    // The ceilings in the gate are the ones the header and the documentation state.
    assert_eq!(COWORK_PRODUCTION_VCPUS, 2);
    assert_eq!(COWORK_PRODUCTION_MIN_MEMORY_MIB, 768);
    assert_eq!(COWORK_PRODUCTION_MAX_MEMORY_MIB, 1024);
}

#[test]
fn production_range_never_leaks_into_the_fixture_profile() {
    // The fixture's workspace pair stays exactly 768 MiB and exactly two vCPUs.
    let (a, b) = (Volume::new(), Volume::new());
    let id = bare();
    assert_eq!(krun_enable_cowork_block_fixture_reclaim(id), 0);
    let raw = krun_create_cowork_runtime_stream(id);
    assert!(raw >= 3);
    let peer = unsafe { OwnedFd::from_raw_fd(raw) };
    assert_eq!(pair_fixture(id, &a, &b), 0);
    assert!(valid(id));
    for memory in [769usize, 900, 1024, 767] {
        machine(id, 2, memory);
        assert!(!valid(id), "fixture {memory} MiB");
    }
    machine(id, 2, 768);
    assert!(valid(id));
    machine(id, 1, 768);
    assert!(!valid(id));
    assert_eq!(krun_free_ctx(id), 0);
    drop(peer);
}

#[test]
fn production_gate_requires_the_pair_the_runtime_port_and_the_machinery_switches() {
    let (a, b) = (Volume::new(), Volume::new());
    // Profile alone is not enough.
    let id = bare();
    assert_eq!(krun_cowork_enable_profile_v1(id), 0);
    assert!(!valid(id));
    assert_eq!(krun_cowork_validate_profile_v1(id), -libc::EINVAL);
    // Pair without the runtime port.
    assert_eq!(pair_production(id, &a, &b), 0);
    assert!(!valid(id));
    // Pair with the runtime port is the admitted shape.
    let raw = krun_cowork_create_runtime_port_v1(id);
    assert!(raw >= 3);
    let peer = unsafe { OwnedFd::from_raw_fd(raw) };
    assert!(valid(id));
    // The shared reduced-device switches must both stay on.
    for which in 0..2 {
        {
            let mut map = CTX_MAP.lock().unwrap();
            let cfg = map.get_mut(&id).unwrap();
            if which == 0 {
                cfg.vmr.cowork_fixture_reclaim = false;
            } else {
                cfg.vmr.cowork_guarded_block = false;
            }
        }
        assert!(!valid(id), "switch {which}");
        let mut map = CTX_MAP.lock().unwrap();
        let cfg = map.get_mut(&id).unwrap();
        cfg.vmr.cowork_fixture_reclaim = true;
        cfg.vmr.cowork_guarded_block = true;
    }
    assert!(valid(id));
    // Runtime port without the pair.
    assert_eq!(krun_free_ctx(id), 0);
    drop(peer);
    let id = bare();
    assert_eq!(krun_cowork_enable_profile_v1(id), 0);
    let raw = krun_cowork_create_runtime_port_v1(id);
    assert!(raw >= 3);
    let peer = unsafe { OwnedFd::from_raw_fd(raw) };
    assert!(!valid(id));
    assert_eq!(krun_free_ctx(id), 0);
    drop(peer);
}

#[test]
fn production_gate_refuses_fixture_trace_hvc_stream_and_the_shutdown_device() {
    let production = Production::new();
    let id = production.id;
    // Fixture trace.
    CTX_MAP.lock().unwrap().get_mut(&id).unwrap().vmr.cowork_runtime_fixture_trace = true;
    assert!(!valid(id));
    assert_eq!(krun_cowork_validate_profile_v1(id), -libc::EINVAL);
    CTX_MAP.lock().unwrap().get_mut(&id).unwrap().vmr.cowork_runtime_fixture_trace = false;
    assert!(valid(id));
    // The HVC bootstrap stream variant instead of the generic runtime port.
    CTX_MAP.lock().unwrap().get_mut(&id).unwrap().vmr.cowork_runtime_port = false;
    assert!(!valid(id));
    CTX_MAP.lock().unwrap().get_mut(&id).unwrap().vmr.cowork_runtime_port = true;
    assert!(valid(id));
    // krun_get_shutdown_eventfd is what attaches the PL061 shutdown GPIO device; the admitted device
    // inventory has none, so a context that asked for the eventfd is not production-admissible.
    #[cfg(target_arch = "aarch64")]
    {
        let fd = krun_get_shutdown_eventfd(id);
        assert!(fd >= 3);
        assert!(!valid(id));
        assert_eq!(krun_cowork_validate_profile_v1(id), -libc::EINVAL);
        assert_eq!(unsafe { libc::close(fd) }, 0);
        CTX_MAP.lock().unwrap().get_mut(&id).unwrap().shutdown_efd = None;
        assert!(valid(id));
    }
}

#[test]
fn production_gate_keeps_the_reviewed_fixture_refusals() {
    // The unchanged reviewed checks still apply after the production ones.
    let production = Production::new();
    let id = production.id;
    let refused = |mutate: &dyn Fn(&mut ContextConfig)| {
        {
            let mut map = CTX_MAP.lock().unwrap();
            mutate(map.get_mut(&id).unwrap());
        }
        !valid(id)
    };
    assert!(refused(&|c| c.vmr.nested_enabled = true));
    CTX_MAP.lock().unwrap().get_mut(&id).unwrap().vmr.nested_enabled = false;
    assert!(refused(&|c| c.vsock_config = VsockConfig::default()));
    CTX_MAP.lock().unwrap().get_mut(&id).unwrap().vsock_config = VsockConfig::Disabled;
    assert!(refused(&|c| c.vmr.disable_implicit_console = false));
    CTX_MAP.lock().unwrap().get_mut(&id).unwrap().vmr.disable_implicit_console = true;
    assert!(refused(&|c| c.vmr.serial_consoles.push(SerialConsoleConfig {
        input_fd: -1,
        output_fd: -1
    })));
    CTX_MAP.lock().unwrap().get_mut(&id).unwrap().vmr.serial_consoles.pop();
    assert!(refused(&|c| c.vmr.external_kernel = None));
    CTX_MAP.lock().unwrap().get_mut(&id).unwrap().vmr.external_kernel = Some(ExternalKernel::default());
    assert!(refused(&|c| c.gpu_virgl_flags = Some(1)));
    CTX_MAP.lock().unwrap().get_mut(&id).unwrap().gpu_virgl_flags = None;
    assert!(valid(id));
}

#[test]
fn production_workspace_setter_owns_two_duplicates_and_never_closes_the_callers() {
    let (a, b) = (Volume::new(), Volume::new());
    let before = open_fds();
    let id = bare();
    assert_eq!(krun_cowork_enable_profile_v1(id), 0);
    let raw = krun_cowork_create_runtime_port_v1(id);
    assert!(raw >= 3);
    let peer = unsafe { OwnedFd::from_raw_fd(raw) };
    let with_port = open_fds();
    // Null identity, unknown context, duplicate descriptor and a stale identity publish nothing.
    assert_eq!(
        unsafe {
            krun_cowork_set_workspace_disks_v1(id, a.file.as_raw_fd(), std::ptr::null(), b.file.as_raw_fd(), &b.expected)
        },
        -libc::EINVAL
    );
    assert_eq!(pair_production(u32::MAX, &a, &b), -libc::ENOENT);
    assert_eq!(
        unsafe {
            krun_cowork_set_workspace_disks_v1(id, a.file.as_raw_fd(), &a.expected, a.file.as_raw_fd(), &a.expected)
        },
        -libc::EINVAL
    );
    let mut stale = b.expected;
    stale.inode ^= 1;
    assert!(unsafe {
        krun_cowork_set_workspace_disks_v1(id, a.file.as_raw_fd(), &a.expected, b.file.as_raw_fd(), &stale)
    } < 0);
    assert_eq!(open_fds(), with_port);
    assert_eq!(pair_production(id, &a, &b), 0);
    assert_eq!(open_fds().len(), with_port.len() + 2);
    assert_eq!(pair_production(id, &a, &b), -libc::EINVAL);
    assert_eq!(open_fds().len(), with_port.len() + 2);
    assert_eq!(krun_cowork_validate_profile_v1(id), 0);
    assert_eq!(krun_free_ctx(id), 0);
    drop(peer);
    assert_eq!(open_fds(), before);
    a.file.metadata().unwrap();
    b.file.metadata().unwrap();
}

/// Header declarations: the production API is visible without a macro, every fixture entry point only
/// inside `#ifdef KRUN_COWORK_FIXTURE_ORACLE`, and the stated limits equal the gate's constants.
#[test]
fn production_header_exposes_the_production_api_and_hides_the_fixture_entry_points() {
    let header = include_str!("../../../include/libkrun.h");
    let define = |name: &str| -> usize {
        header
            .lines()
            .find_map(|l| l.strip_prefix(&format!("#define {name} ")))
            .unwrap_or_else(|| panic!("{name} missing"))
            .trim()
            .parse()
            .unwrap()
    };
    assert_eq!(define("KRUN_COWORK_PRODUCTION_VCPUS"), COWORK_PRODUCTION_VCPUS as usize);
    assert_eq!(define("KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB"), COWORK_PRODUCTION_MIN_MEMORY_MIB);
    assert_eq!(define("KRUN_COWORK_PRODUCTION_MAX_MEMORY_MIB"), COWORK_PRODUCTION_MAX_MEMORY_MIB);
    let mut inside_oracle = false;
    let (mut production, mut fixture) = (Vec::new(), Vec::new());
    for line in header.lines() {
        match line.trim() {
            "#ifdef KRUN_COWORK_FIXTURE_ORACLE" => inside_oracle = true,
            l if l.starts_with("#endif /* KRUN_COWORK_FIXTURE_ORACLE") => inside_oracle = false,
            l => {
                let Some(call) = l.strip_prefix("int32_t krun_") else { continue };
                let name = format!("krun_{}", call.split('(').next().unwrap());
                if !name.contains("cowork") {
                    continue;
                }
                if inside_oracle {
                    fixture.push(name);
                } else {
                    production.push(name);
                }
            }
        }
    }
    assert!(!inside_oracle);
    production.sort();
    fixture.sort();
    assert_eq!(
        production,
        [
            "krun_cowork_create_runtime_port_v1",
            "krun_cowork_enable_profile_v1",
            "krun_cowork_get_flush_counters_v1",
            "krun_cowork_get_pin_counters_v1",
            "krun_cowork_set_exit_hook_v1",
            "krun_cowork_set_workspace_disks_v1",
            "krun_cowork_validate_profile_v1",
        ]
    );
    assert_eq!(
        fixture,
        [
            "krun_create_cowork_bootstrap_stream",
            "krun_create_cowork_runtime_stream",
            "krun_enable_cowork_block_fixture_reclaim",
            "krun_enable_cowork_runtime_port_fixture_trace",
            "krun_set_cowork_bootstrap_stream",
            "krun_set_cowork_workspace_disks",
        ]
    );
    // No production name carries "fixture", and the shared struct sits outside the oracle block.
    assert!(production.iter().all(|n| !n.contains("fixture")));
    let struct_at = header.find("struct krun_cowork_volume_identity {").unwrap();
    let oracle_at = header.find("#ifdef KRUN_COWORK_FIXTURE_ORACLE").unwrap();
    assert!(struct_at < oracle_at);
}

/// The admitted device inventory and pin budget are not changed by the production profile.
#[test]
fn production_profile_keeps_the_admitted_pin_budget_and_device_inventory() {
    assert_eq!((DATA_DEVICE, ENVIRONMENT_DEVICE, RUNTIME_DEVICE), (0, 1, 2));
    assert_eq!(MAX_DEVICES, 3);
    assert_eq!(MAX_PINS, 48);
    assert_eq!(MAX_PINNED_BYTES, 8 * 1024 * 1024);
    // The attach sequence of build_microvm, as written. A new device (the shutdown GPIO is the known
    // candidate) must change this list in a reviewed patch; nothing in the production profile does.
    let builder = include_str!("../../vmm/src/builder.rs");
    let start = builder.find("pub fn build_microvm(").unwrap();
    let body = &builder[start..];
    let end = body.find("\n}\n").unwrap();
    let body = &body[..end];
    let mut sequence = Vec::new();
    let mut rest = body;
    while let Some(at) = rest.find("attach_") {
        let tail = &rest[at..];
        let name_end = tail.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap();
        if tail[name_end..].starts_with('(') {
            sequence.push(tail[..name_end].to_string());
        }
        rest = &tail[name_end..];
    }
    assert_eq!(
        sequence,
        [
            "attach_legacy_devices",
            "attach_legacy_devices",
            "attach_legacy_devices",
            "attach_legacy_devices",
            "attach_balloon_device",
            "attach_rng_device",
            "attach_mmio_device",
            "attach_mmio_device",
            "attach_console_devices",
            "attach_console_devices",
            "attach_gpu_device",
            "attach_input_devices",
            "attach_fs_devices",
            "attach_block_devices",
            "attach_unixsock_vsock_device",
            "attach_net_devices",
            "attach_snd_device",
        ]
    );
    // The one place the shutdown GPIO can be attached is the shutdown-eventfd branch of
    // attach_legacy_devices, which the production gate closes by refusing the eventfd.
    assert_eq!(builder.matches("register_mmio_gpio").count(), 1);
    assert!(builder.contains("if let Some(shutdown_efd) = shutdown_efd"));
}
