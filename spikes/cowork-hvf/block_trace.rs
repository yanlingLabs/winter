//! Bounded fixture-only metadata receipts. No guest payload, pointers, credentials or host paths.
use crate::reclaim_access::{Fault, Range};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;
static START: OnceLock<Instant> = OnceLock::new();
static ROWS: AtomicU64 = AtomicU64::new(0);
static REQUESTS: AtomicU64 = AtomicU64::new(0);
pub const MAX_ROWS: u64 = 60000;
pub fn clock_micros() -> u128 {
    START.get_or_init(Instant::now).elapsed().as_micros()
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
