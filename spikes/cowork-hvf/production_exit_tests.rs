//! The production exit path: the exit hook registration, the reason values the header promises, the final
//! flush observer of the guarded block devices, and the registration order in the builder. Pure, VM-free
//! checks; the exit sequence itself (`_exit`) is never run. Run with `--test-threads=1`.
use super::*;
use crate::cowork_production_profile_tests::{bare, valid, Production};
use devices::virtio::block::{Block, ImageType, SyncMode};
use devices::virtio::{CacheType, VmmExitObserver};

extern "C" fn hook(_: *mut c_void, _: u32) {}

#[test]
fn the_exit_hook_is_production_only_once_and_non_null() {
    // Unknown context, no production profile, null hook.
    assert_eq!(unsafe { krun_cowork_set_exit_hook_v1(u32::MAX, Some(hook), std::ptr::null_mut()) }, -libc::ENOENT);
    let plain = bare();
    assert_eq!(unsafe { krun_cowork_set_exit_hook_v1(plain, Some(hook), std::ptr::null_mut()) }, -libc::EINVAL);
    assert_eq!(krun_free_ctx(plain), 0);
    let fixture = bare();
    assert_eq!(krun_enable_cowork_block_fixture_reclaim(fixture), 0);
    assert_eq!(unsafe { krun_cowork_set_exit_hook_v1(fixture, Some(hook), std::ptr::null_mut()) }, -libc::EINVAL);
    assert_eq!(krun_free_ctx(fixture), 0);
    let production = Production::new();
    let id = production.id;
    assert_eq!(unsafe { krun_cowork_set_exit_hook_v1(id, None, std::ptr::null_mut()) }, -libc::EINVAL);
    assert!(CTX_MAP.lock().unwrap().get(&id).unwrap().vmr.cowork_exit_hook.is_none());
    assert_eq!(unsafe { krun_cowork_set_exit_hook_v1(id, Some(hook), 0x10 as *mut c_void) }, 0);
    assert!(CTX_MAP.lock().unwrap().get(&id).unwrap().vmr.cowork_exit_hook.is_some());
    assert_eq!(unsafe { krun_cowork_set_exit_hook_v1(id, Some(hook), std::ptr::null_mut()) }, -libc::EINVAL, "once");
    // A registered hook does not change what the gate admits.
    assert!(valid(id));
    assert_eq!(krun_cowork_validate_profile_v1(id), 0);
}

#[test]
fn exit_reasons_match_the_header_and_distinguish_off_from_reset() {
    use vmm::cowork_exit::*;
    let header = include_str!("../../../include/libkrun.h");
    let define = |name: &str| -> u32 {
        header.lines().find_map(|l| l.strip_prefix(&format!("#define {name} "))).map(|rest| rest.split_whitespace().next().unwrap().parse().unwrap()).unwrap_or_else(|| panic!("{name} missing"))
    };
    assert_eq!(define("KRUN_COWORK_EXIT_NONE"), REASON_NONE);
    assert_eq!(define("KRUN_COWORK_EXIT_OFF"), REASON_OFF);
    assert_eq!(define("KRUN_COWORK_EXIT_RESET"), REASON_RESET);
    assert_eq!(define("KRUN_COWORK_EXIT_VCPU_ERROR"), REASON_VCPU_ERROR);
    assert_eq!(define("KRUN_COWORK_EXIT_TERMINAL_FAULT"), REASON_TERMINAL_FAULT);
    let all = [REASON_NONE, REASON_OFF, REASON_RESET, REASON_VCPU_ERROR, REASON_TERMINAL_FAULT];
    for (i, a) in all.iter().enumerate() {
        for b in &all[i + 1..] {
            assert_ne!(a, b);
        }
    }
    assert_eq!(TERMINAL_FAULT_EXIT_CODE, 77);
}

fn backing(name: &str) -> String {
    let path = std::env::temp_dir().join(format!("winter-exit-{}-{name}", std::process::id()));
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(1 << 20).unwrap();
    path.to_string_lossy().into_owned()
}

/// The final-flush observer: a guarded block device flushes and syncs its volume at exit and records the
/// result per disk; an unguarded device keeps the default no-op.
#[test]
fn guarded_block_devices_do_a_final_flush_at_exit() {
    let slot = || devices::cowork_counters::flush_snapshot();
    let before = slot();
    let (a, b) = (backing("a"), backing("b"));
    let access = devices::reclaim_access::Access::new(3, 48, 8 * 1024 * 1024);
    let mut disks = Vec::new();
    for (index, path) in [&a, &b].into_iter().enumerate() {
        let mut block = Block::new(format!("exit-{index}"), None, CacheType::Writeback, path.clone(), ImageType::Raw, false, false, SyncMode::Full).unwrap();
        block.enable_cowork_guard(access.clone(), access.register(index as u64).unwrap());
        disks.push(block);
    }
    for block in &mut disks {
        block.on_vmm_exit();
    }
    let after = slot();
    for index in 0..2 {
        assert_eq!(after[index].final_attempted - before[index].final_attempted, 1, "disk {index}");
        assert_eq!(after[index].final_completed - before[index].final_completed, 1, "disk {index}");
    }
    // Unguarded: nothing is flushed or counted.
    let mut plain = Block::new("plain".into(), None, CacheType::Writeback, a.clone(), ImageType::Raw, false, false, SyncMode::Full).unwrap();
    plain.on_vmm_exit();
    assert_eq!(slot(), after);
    for path in [a, b] {
        let _ = std::fs::remove_file(path);
    }
}

/// The exit hook is the last observer registered by `build_microvm`, after every device attach, and the
/// observer list is published before the vCPUs start. Text pin on the builder source: a reordering must be a
/// reviewed change.
#[test]
fn the_exit_hook_is_registered_last_and_the_list_is_published_before_the_vcpus_start() {
    let builder = include_str!("../../vmm/src/builder.rs");
    let start = builder.find("pub fn build_microvm(").unwrap();
    let body = &builder[start..];
    let body = &body[..body.find("\n}\n").unwrap()];
    let hook = body.find("vmm.exit_observers.push(Arc::new(Mutex::new(hook)))").expect("hook registration");
    assert_eq!(body.matches("vmm.exit_observers.push(Arc::new(Mutex::new(hook)))").count(), 1);
    assert_eq!(body.rfind("vmm.exit_observers.push(").unwrap(), hook, "no observer is registered after the hook");
    assert!(body.rfind("attach_").unwrap() < hook, "the hook follows every device attach");
    let publish = body.find("crate::cowork_exit::publish(&vmm.exit_observers)").expect("publish");
    assert!(hook < publish);
    assert!(publish < body.find("vmm.start_vcpus(vcpus)").unwrap(), "published before any vCPU can run");
    // The block observers are registered where the guarded devices are attached.
    assert!(builder.contains("vmm.exit_observers.push(block.clone());"));
}

/// Every `_exit` in the Cowork VMM goes through `cowork_exit`; only the signal handlers (hard crashes) and the
/// exit module itself call `_exit` directly.
#[test]
fn only_the_exit_module_and_the_crash_handlers_call_underscore_exit() {
    let fixture = include_str!("../../vmm/src/cowork_fixture.rs");
    assert!(!fixture.contains("_exit("), "fatal() must use cowork_exit::terminate");
    assert!(fixture.contains("cowork_exit::terminate("));
    let lib = include_str!("../../vmm/src/lib.rs");
    let stop = &lib[lib.find("pub fn stop(").unwrap()..];
    let stop = &stop[..stop.find("\n    }\n").unwrap()];
    assert!(stop.contains("cowork_exit::finish(&self.exit_observers, exit_code)"));
}

/// PSCI SYSTEM_OFF and SYSTEM_RESET both used to end as `Shutdown`, indistinguishable. Now they are different
/// vCPU exits and different recorded reasons. Text pins: a change must be a reviewed one.
#[test]
fn psci_off_and_reset_are_different_exits_with_different_reasons() {
    let hvf = include_str!("../../hvf/src/lib.rs");
    let arm = |code: &str| {
        let at = hvf.find(code).unwrap_or_else(|| panic!("{code} missing"));
        let rest = &hvf[at..];
        rest[..rest.find("},").unwrap()].to_string()
    };
    assert!(arm("0x8400_0008").contains("Ok(VcpuExit::Shutdown)"));
    assert!(arm("0x8400_0009").contains("Ok(VcpuExit::Reset)"));
    let vstate = include_str!("../../vmm/src/macos/vstate.rs");
    let exit = |variant: &str| {
        let at = vstate.find(&format!("VcpuExit::{variant} => {{")).unwrap_or_else(|| panic!("{variant} missing"));
        let rest = &vstate[at..];
        rest[..rest.find("Ok(VcpuEmulation::Stopped)").unwrap()].to_string()
    };
    assert!(exit("Shutdown").contains("REASON_OFF"));
    assert!(exit("Reset").contains("REASON_RESET"));
    // An emulation error is recorded before the stop is marked.
    assert!(vstate.contains("if result.is_err() {crate::cowork_exit::record(crate::cowork_exit::REASON_VCPU_ERROR);}"));
}

/// The final flush stops and joins the block worker BEFORE it flushes and syncs the volume, and records the result.
#[test]
fn the_final_flush_joins_the_worker_before_it_syncs() {
    let device = include_str!("../../devices/src/virtio/block/device.rs");
    let at = device.find("impl crate::virtio::VmmExitObserver for Block").expect("observer");
    let body = &device[at..];
    let body = &body[..body.find("\n}\n").unwrap()];
    let stop = body.find("self.cowork_stop.store(true").expect("stop flag");
    let join = body.find("worker.join()").expect("join");
    let flush = body.find("file.flush()").expect("flush");
    let sync = body.find("file.sync()").expect("sync");
    let record = body.find("cowork_counters::final_sync(slot, ok)").expect("record");
    assert!(stop < join && join < flush && flush < sync && sync < record);
    assert!(body.contains("let Some((_, device)) = &self.cowork_access else { return };"), "unguarded devices keep the no-op");
}
