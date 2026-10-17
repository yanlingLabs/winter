//! Bounded fixture-only metadata receipts. No guest payload, pointers, credentials or host paths.
//!
//! The rows exist for the fixture and its regression oracle only. They are compiled in under test and
//! with the `cowork-fixture-trace` feature (which libkrun's `cowork-fixture-oracle` enables). A
//! production build compiles them out: `emit` is then an inert `Ok(())`. Without that, the 60,000-row
//! process cap below would make a long-lived guest terminate itself (a failed `emit` fails the block
//! request, which stops the whole worker), and every request would print guest physical addresses.
use crate::reclaim_access::{Fault, Range};
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(any(test, feature = "cowork-fixture-trace"))]
use std::sync::OnceLock;
#[cfg(any(test, feature = "cowork-fixture-trace"))]
use std::time::Instant;
#[cfg(any(test, feature = "cowork-fixture-trace"))]
static START: OnceLock<Instant> = OnceLock::new();
#[cfg(any(test, feature = "cowork-fixture-trace"))]
static ROWS: AtomicU64 = AtomicU64::new(0);
static REQUESTS: AtomicU64 = AtomicU64::new(0);
pub const MAX_ROWS: u64 = 60000;
/// True only in builds that carry the trace (test and `cowork-fixture-trace`).
pub const COMPILED: bool = cfg!(any(test, feature = "cowork-fixture-trace"));
/// The fixture's per-request completion hold (it widens the window in which a request is in flight so the
/// reclaim fixture can observe it). It is a sleep after the host I/O of EVERY block request, so a production
/// build must not carry it: zero outside test and `cowork-fixture-trace`.
pub const COMPLETION_HOLD_MILLIS: u64 = if COMPILED { 25 } else { 0 };
#[cfg(any(test, feature = "cowork-fixture-trace"))]
pub fn clock_micros() -> u128 {
    START.get_or_init(Instant::now).elapsed().as_micros()
}
#[cfg(not(any(test, feature = "cowork-fixture-trace")))]
pub fn clock_micros() -> u128 {
    0
}
pub fn next_request() -> Result<u64, Fault> {
    REQUESTS
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_add(1))
        .map(|n| n + 1)
        .map_err(|_| Fault::Overflow)
}
pub fn ranges(ranges: &[Range]) -> String {
    format!(
        "[{}]",
        ranges
            .iter()
            .map(|r| format!("{{\"gpa\":{},\"len\":{}}}", r.gpa, r.len))
            .collect::<Vec<_>>()
            .join(",")
    )
}
/// Production build: no row, no counter, no cap, never an error.
#[cfg(not(any(test, feature = "cowork-fixture-trace")))]
pub fn emit(kind: &str, fields: String) -> Result<(), Fault> {
    let _ = (kind, fields);
    Ok(())
}
#[cfg(any(test, feature = "cowork-fixture-trace"))]
pub fn emit(kind: &str, fields: String) -> Result<(), Fault> {
    let row = ROWS.fetch_add(1, Ordering::AcqRel);
    if row >= MAX_ROWS {
        if row == MAX_ROWS {
            eprintln!(
                "{{\"kind\":\"block_trace_overflow\",\"maxRows\":{}}}",
                MAX_ROWS
            );
        }
        return Err(Fault::Limit);
    }
    eprintln!(
        "{{\"kind\":\"{}\",\"clockMicros\":{},\"row\":{},{} }}",
        kind,
        clock_micros(),
        row,
        fields
    );
    Ok(())
}
