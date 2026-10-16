//! The fixture-only block trace must not exist in a production build. A failed `emit` fails the block
//! request and the guarded loop then stops the whole worker, so the 60,000-row process cap would end a
//! long-lived production guest after a few thousand block requests. Pure, VM-free checks; run with
//! `--test-threads=1`.

#[cfg(not(feature = "cowork-fixture-oracle"))]
#[test]
fn production_block_trace_is_compiled_out_silent_and_uncapped() {
    use devices::block_trace::{emit, COMPILED, MAX_ROWS};
    assert!(!COMPILED);
    // Far past the fixture's row cap, and every call still succeeds without printing a row.
    for _ in 0..MAX_ROWS + 1000 {
        assert!(emit("block_request_capture", String::from("\"request\":1")).is_ok());
    }
}

#[cfg(feature = "cowork-fixture-oracle")]
#[test]
fn fixture_oracle_keeps_the_block_trace_compiled_in() {
    assert!(devices::block_trace::COMPILED);
}
