//! A production build carries none of the fixture's timing or output: no per-request completion hold, no
//! reclaim rows on stderr. Pure, VM-free checks; run with `--test-threads=1`.

/// The fixture sleeps 25 ms after the host I/O of every block request (an extra 25 ms of pinned time and
/// at most about 40 requests per second per disk). Production must not.
#[test]
fn production_block_requests_have_no_completion_hold() {
    let oracle = cfg!(feature = "cowork-fixture-oracle");
    assert_eq!(devices::block_trace::COMPLETION_HOLD_MILLIS, if oracle { 25 } else { 0 });
}

/// The reclaim rows are written to stderr while every vCPU is parked, with host virtual addresses; a stalled
/// reader would block the pause/resume path past its deadlines.
#[test]
fn production_reclaim_rows_are_compiled_out() {
    assert_eq!(vmm::COWORK_FIXTURE_ROWS, cfg!(feature = "cowork-fixture-oracle"));
}
