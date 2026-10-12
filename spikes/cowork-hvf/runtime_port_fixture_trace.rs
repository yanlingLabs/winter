//! Opt-in fixture-only bounded control ACK metadata. Never logs data-lane bytes.
use crate::reclaim_access::Fault;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
pub const MAX_ROWS: usize = 64;
#[derive(Clone)]
pub struct Trace {
    rows: Arc<AtomicUsize>,
}
#[derive(PartialEq, Eq)]
pub struct Ack {
    pub row: usize,
    pub queue: u8,
    pub id: u32,
    pub event: u16,
    pub value: u16,
}
impl Trace {
    pub fn new() -> Self {
        Self {
            rows: Arc::new(AtomicUsize::new(0)),
        }
    }
    fn record(&self, queue: u8, bytes: &[u8]) -> Result<Ack, Fault> {
        if bytes.len() != 8 || !matches!(queue, 2 | 3) {
            return Err(Fault::InvalidRange);
        }
        let row = self
            .rows
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                if n < MAX_ROWS {
                    Some(n + 1)
                } else {
                    None
                }
            })
            .map_err(|_| Fault::Limit)?;
        Ok(Ack {
            row,
            queue,
            id: u32::from_le_bytes(bytes[..4].try_into().unwrap()),
            event: u16::from_le_bytes(bytes[4..6].try_into().unwrap()),
            value: u16::from_le_bytes(bytes[6..8].try_into().unwrap()),
        })
    }
    #[cfg(test)]
    pub fn row_count(&self) -> usize {
        self.rows.load(Ordering::Acquire)
    }
    pub fn used_ack(&self, queue: u8, bytes: &[u8]) -> Result<(), Fault> {
        let ack = self.record(queue, bytes)?;
        eprintln!("{{\"kind\":\"runtime_control_used_ack\",\"row\":{},\"queue\":{},\"id\":{},\"event\":{},\"value\":{},\"usedAck\":true}}",ack.row,ack.queue,ack.id,ack.event,ack.value);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_port_fixture_trace_exact_fields_and_strict_shared_cap() {
        let trace = Trace::new();
        let alias = trace.clone();
        let bytes = super::super::runtime_port_control::frame(0, 6, 0);
        for row in 0..MAX_ROWS {
            let ack = alias.record(3, &bytes).unwrap();
            assert_eq!(ack.row, row);
            assert_eq!(ack.queue, 3);
            assert_eq!(ack.id, 0);
            assert_eq!(ack.event, 6);
            assert_eq!(ack.value, 0);
        }
        assert!(trace.record(3, &bytes).is_err());
        assert_eq!(trace.rows.load(Ordering::Acquire), MAX_ROWS);
    }
    #[test]
    fn runtime_port_fixture_trace_rejects_data_queues_and_bad_sizes_without_rows() {
        let trace = Trace::new();
        for queue in [0, 1, 4, 255] {
            assert!(trace.record(queue, &[0; 8]).is_err());
        }
        for length in [0, 7, 9, 4096] {
            assert!(trace.record(3, &vec![0; length]).is_err());
        }
        assert_eq!(trace.rows.load(Ordering::Acquire), 0);
    }
}
