//! The start-time admission `krun_start_enter` runs first: the mandatory preflight and the
//! `cowork-production-only` build. Pure checks on `cowork_start_admission`, the function the start path
//! calls before it does anything else; `krun_start_enter` itself is never called. Run with
//! `--test-threads=1`.
use super::*;
use crate::cowork_production_profile_tests::{bare, machine, valid, Production, Volume};
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

fn admitted(id: u32) -> bool {
    cowork_start_admission(CTX_MAP.lock().unwrap().get(&id).unwrap()).is_ok()
}

#[test]
fn start_admission_requires_the_mandatory_preflight() {
    let production = Production::new();
    let id = production.id;
    assert!(admitted(id));
    // A production context that never had a successful preflight does not start.
    CTX_MAP.lock().unwrap().get_mut(&id).unwrap().cowork_validated = false;
    assert!(!admitted(id));
    assert_eq!(krun_cowork_validate_profile_v1(id), 0);
    assert!(admitted(id));
    // A failed preflight clears the record, and a setter after a good preflight cannot make it stale-admit.
    machine(id, 2, 2048);
    assert_eq!(krun_cowork_validate_profile_v1(id), -libc::EINVAL);
    assert!(!admitted(id));
    machine(id, 2, 768);
    assert!(!admitted(id));
    assert_eq!(krun_cowork_validate_profile_v1(id), 0);
    machine(id, 2, 1025);
    assert!(!admitted(id), "the full admission re-runs at start");
    let tag = CString::new("tag").unwrap();
    machine(id, 2, 768);
    assert!(admitted(id));
    assert_eq!(unsafe { krun_add_virtiofs(id, tag.as_ptr(), tag.as_ptr()) }, 0);
    assert!(!admitted(id), "a device added after the preflight is still refused at start");
}

#[test]
fn production_only_build_refuses_plain_and_fixture_contexts() {
    let only = cfg!(feature = "cowork-production-only");
    // A plain context runs as stock libkrun unless the build is production-only.
    let plain = bare();
    assert_eq!(admitted(plain), !only);
    assert_eq!(krun_free_ctx(plain), 0);
    // A valid fixture-profile context (the reviewed fixture gate passes it) likewise.
    let (a, b) = (Volume::new(), Volume::new());
    let fixture = bare();
    assert_eq!(krun_enable_cowork_block_fixture_reclaim(fixture), 0);
    let peer = unsafe { OwnedFd::from_raw_fd(krun_create_cowork_runtime_stream(fixture)) };
    assert_eq!(unsafe { krun_set_cowork_workspace_disks(fixture, a.file.as_raw_fd(), &a.expected, b.file.as_raw_fd(), &b.expected) }, 0);
    assert!(valid(fixture));
    assert_eq!(admitted(fixture), !only);
    assert_eq!(krun_free_ctx(fixture), 0);
    drop(peer);
    // A prepared and preflighted production context always starts its admission.
    let production = Production::new();
    assert!(admitted(production.id));
}
