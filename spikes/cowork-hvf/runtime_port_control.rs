//! Closed single-generic-port virtio control protocol. Owned fixed frames only; no guest RAM or I/O.
use crate::reclaim_access::Fault;
pub const CONTROL_BYTES: usize = 8;
pub const FEATURES: u64 = (1u64 << 32) | (1u64 << 1);
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    DeviceReady,
    PortReady,
    GuestOpen,
    Open,
    Closed,
}
pub struct Control {
    phase: Phase,
}
pub struct Transition {
    phase: Phase,
    pub response: Option<[u8; CONTROL_BYTES]>,
}
impl Control {
    pub fn new() -> Self {
        Self {
            phase: Phase::DeviceReady,
        }
    }
    pub fn open(&self) -> bool {
        self.phase == Phase::Open
    }
    pub fn closed(&self) -> bool {
        self.phase == Phase::Closed
    }
    pub fn validate(&self, bytes: &[u8]) -> Result<Transition, Fault> {
        if bytes.len() != CONTROL_BYTES {
            return Err(Fault::Limit);
        }
        let id = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        let event = u16::from_le_bytes(bytes[4..6].try_into().unwrap());
        let value = u16::from_le_bytes(bytes[6..8].try_into().unwrap());
        let (phase, response) = match (self.phase, id, event, value) {
            (Phase::DeviceReady, u32::MAX, 0, 1) => (Phase::PortReady, Some(frame(0, 1, 0))),
            (Phase::PortReady, 0, 3, 1) => (Phase::GuestOpen, Some(frame(0, 6, 1))),
            (Phase::GuestOpen, 0, 6, 1) => (Phase::Open, None),
            (Phase::Open, 0, 6, 0) => (Phase::Closed, None),
            _ => return Err(Fault::InvalidRange),
        };
        Ok(Transition { phase, response })
    }
    // Apply only AFTER generation-checked control TX used ACK. Validation has no state effects.
    pub fn apply(&mut self, transition: Transition) {
        self.phase = transition.phase;
    }
    #[cfg(test)]
    pub fn opened_for_test() -> Self {
        Self { phase: Phase::Open }
    }
}
pub fn frame(id: u32, event: u16, value: u16) -> [u8; CONTROL_BYTES] {
    let mut bytes = [0; CONTROL_BYTES];
    bytes[..4].copy_from_slice(&id.to_le_bytes());
    bytes[4..6].copy_from_slice(&event.to_le_bytes());
    bytes[6..].copy_from_slice(&value.to_le_bytes());
    bytes
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_port_exact_linux_handshake_and_close() {
        let mut control = Control::new();
        for bytes in [frame(u32::MAX, 0, 1), frame(0, 3, 1), frame(0, 6, 1)] {
            let next = control.validate(&bytes).unwrap();
            control.apply(next);
        }
        assert!(control.open());
        let next = control.validate(&frame(0, 6, 0)).unwrap();
        control.apply(next);
        assert!(control.closed());
        assert!(control.validate(&frame(0, 6, 1)).is_err());
    }
    #[test]
    fn runtime_port_no_state_change_before_ack() {
        let control = Control::new();
        let next = control.validate(&frame(u32::MAX, 0, 1)).unwrap();
        assert_eq!(next.response, Some(frame(0, 1, 0)));
        assert!(control.validate(&frame(0, 3, 1)).is_err());
        assert!(!control.open());
    }
    #[test]
    fn runtime_port_bounded_adversarial_events_ids_values_lengths() {
        for len in [0, 1, 7, 9, 64, 65536] {
            assert!(Control::new().validate(&vec![0; len]).is_err());
        }
        for event in 0..=7 {
            for value in [0, 1, 2, u16::MAX] {
                for id in [0, 1, u32::MAX] {
                    let accepted = Control::new().validate(&frame(id, event, value)).is_ok();
                    assert_eq!(accepted, id == u32::MAX && event == 0 && value == 1);
                }
            }
        }
        let mut control = Control::new();
        let next = control.validate(&frame(u32::MAX, 0, 1)).unwrap();
        control.apply(next);
        for event in 0..=7 {
            for value in [0, 1, 2, u16::MAX] {
                for id in [0, 1, u32::MAX] {
                    assert_eq!(
                        control.validate(&frame(id, event, value)).is_ok(),
                        id == 0 && event == 3 && value == 1
                    );
                }
            }
        }
    }
    #[test]
    fn runtime_port_all_later_phase_adversarial_messages_and_duplicate_refusal() {
        for phase in [Phase::GuestOpen, Phase::Open, Phase::Closed] {
            let control = Control { phase };
            for event in 0..=7 {
                for value in [0, 1, 2, u16::MAX] {
                    for id in [0, 1, u32::MAX] {
                        let expected = id == 0
                            && event == 6
                            && ((phase == Phase::GuestOpen && value == 1)
                                || (phase == Phase::Open && value == 0));
                        assert_eq!(control.validate(&frame(id, event, value)).is_ok(), expected);
                    }
                }
            }
        }
    }
}
