//! The production counters: layout, size handling and the process-global flush and pin accounting. The
//! counters are process-global, so every assertion is relative to a snapshot taken first. Pure, VM-free
//! checks; run with `--test-threads=1`.
use super::*;

fn flush() -> KrunCoworkFlushCountersV1 {
    let mut out = KrunCoworkFlushCountersV1 { size: std::mem::size_of::<KrunCoworkFlushCountersV1>() as u32, ..Default::default() };
    assert_eq!(unsafe { krun_cowork_get_flush_counters_v1(&mut out) }, 0);
    out
}
fn pins() -> KrunCoworkPinCountersV1 {
    let mut out = KrunCoworkPinCountersV1 { size: std::mem::size_of::<KrunCoworkPinCountersV1>() as u32, ..Default::default() };
    assert_eq!(unsafe { krun_cowork_get_pin_counters_v1(&mut out) }, 0);
    out
}

#[test]
fn counter_structures_have_the_header_layout() {
    assert_eq!(std::mem::size_of::<KrunCoworkFlushDeviceV1>(), 32);
    assert_eq!(std::mem::size_of::<KrunCoworkFlushCountersV1>(), 72);
    assert_eq!(std::mem::size_of::<KrunCoworkPinCountersV1>(), 48);
    let header = include_str!("../../../include/libkrun.h");
    for field in ["uint64_t requested;", "uint64_t completed;", "uint64_t final_sync_attempted;", "uint64_t final_sync_completed;", "struct krun_cowork_flush_device_v1 device[2];", "uint64_t high_water_pins;", "uint64_t high_water_bytes;", "uint64_t budget_refusals;"] {
        assert!(header.contains(field), "{field}");
    }
}

#[test]
fn counter_getters_validate_the_caller_structure() {
    assert_eq!(unsafe { krun_cowork_get_flush_counters_v1(std::ptr::null_mut()) }, -libc::EINVAL);
    assert_eq!(unsafe { krun_cowork_get_pin_counters_v1(std::ptr::null_mut()) }, -libc::EINVAL);
    let mut short = KrunCoworkFlushCountersV1 { size: 71, ..Default::default() };
    assert_eq!(unsafe { krun_cowork_get_flush_counters_v1(&mut short) }, -libc::EINVAL);
    assert_eq!(short.device_count, 0, "a refused call writes nothing");
    let mut short = KrunCoworkPinCountersV1 { size: 47, ..Default::default() };
    assert_eq!(unsafe { krun_cowork_get_pin_counters_v1(&mut short) }, -libc::EINVAL);
    assert_eq!(flush().device_count, 2);
    assert_eq!(flush().size, 72);
    assert_eq!(pins().size, 48);
}

#[test]
fn flush_counters_follow_the_captured_and_completed_flushes() {
    let before = flush();
    devices::cowork_counters::flush_requested(0);
    devices::cowork_counters::flush_requested(1);
    devices::cowork_counters::flush_requested(1);
    devices::cowork_counters::flush_completed(1);
    devices::cowork_counters::final_sync(0, true);
    let after = flush();
    assert_eq!(after.device[0].requested - before.device[0].requested, 1);
    assert_eq!(after.device[0].completed - before.device[0].completed, 0);
    assert_eq!(after.device[0].final_sync_completed - before.device[0].final_sync_completed, 1);
    assert_eq!(after.device[1].requested - before.device[1].requested, 2);
    assert_eq!(after.device[1].completed - before.device[1].completed, 1);
}

#[test]
fn pin_counters_report_the_admitted_budget_and_the_high_water_marks() {
    let before = pins();
    assert_eq!(before.max_pins, 48);
    assert_eq!(before.max_pinned_bytes, 8 * 1024 * 1024);
    devices::cowork_counters::pin_accepted(before.high_water_pins as usize + 1, before.high_water_bytes + 4096);
    let after = pins();
    assert_eq!(after.high_water_pins, before.high_water_pins + 1);
    assert_eq!(after.high_water_bytes, before.high_water_bytes + 4096);
}

/// The real pin path feeds the high-water mark and a real budget refusal is counted.
#[test]
fn the_access_pin_path_feeds_the_counters() {
    use devices::reclaim_access::{Access, Range};
    let before = pins();
    let access = Access::new(1, 2, 8192);
    let device = access.register(0).unwrap();
    let lease = access.begin(device).unwrap();
    let first = lease.pin(&[Range { gpa: 0, len: 4096 }]).unwrap();
    let second = lease.pin(&[Range { gpa: 8192, len: 4096 }]).unwrap();
    assert!(lease.pin(&[Range { gpa: 16384, len: 1 }]).is_err());
    let after = pins();
    assert_eq!(after.budget_refusals - before.budget_refusals, 1);
    assert!(after.high_water_pins >= 2 && after.high_water_bytes >= 8192);
    drop((first, second, lease));
}
