//! Actual control/wait functions used by the native candidate, testable without creating an HVF VM.
use crossbeam_channel::{Receiver, Sender, TryRecvError};
#[cfg(test)]
use std::time::Duration;
use std::time::Instant;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Meaning {
    Pause(u64),
    Resume(u64),
    Other,
}
pub trait Event {
    fn meaning(&self) -> Meaning;
}
pub trait Response {
    fn paused(epoch: u64) -> Self;
    fn resumed(epoch: u64) -> Self;
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    ControlClosed,
    AckClosed,
    Epoch,
    ResumeWithoutPause,
    BootClosed,
    IrqClosed,
}

pub fn handle<E: Event, A: Response>(
    event: E,
    control: &Receiver<E>,
    ack: &Sender<A>,
) -> Result<(), Fault> {
    match event.meaning() {
        Meaning::Pause(epoch) => {
            ack.send(A::paused(epoch)).map_err(|_| Fault::AckClosed)?;
            match control.recv().map_err(|_| Fault::ControlClosed)?.meaning() {
                Meaning::Resume(resume) if resume == epoch => {
                    ack.send(A::resumed(epoch)).map_err(|_| Fault::AckClosed)?;
                    Ok(())
                }
                _ => Err(Fault::Epoch),
            }
        }
        Meaning::Resume(_) => Err(Fault::ResumeWithoutPause),
        Meaning::Other => Ok(()),
    }
}
pub fn drain<E: Event, A: Response>(control: &Receiver<E>, ack: &Sender<A>) -> Result<(), Fault> {
    loop {
        match control.try_recv() {
            Ok(event) => handle(event, control, ack)?,
            Err(TryRecvError::Empty) => return Ok(()),
            Err(TryRecvError::Disconnected) => return Err(Fault::ControlClosed),
        }
    }
}
pub fn boot<E: Event, A: Response>(
    entry: &Receiver<u64>,
    control: &Receiver<E>,
    ack: &Sender<A>,
) -> Result<u64, Fault> {
    loop {
        crossbeam_channel::select! {
            recv(entry) -> value => return value.map_err(|_|Fault::BootClosed),
            recv(control) -> event => handle(event.map_err(|_|Fault::ControlClosed)?,control,ack)?,
        }
    }
}
#[cfg(test)]
pub fn wfe<E: Event, A: Response>(
    irq: &Receiver<u32>,
    control: &Receiver<E>,
    ack: &Sender<A>,
    timeout: Option<Duration>,
    should_wait: impl Fn() -> bool,
) -> Result<(), Fault> {
    wfe_deadline(
        irq,
        control,
        ack,
        timeout.map(|d| Instant::now() + d),
        should_wait,
    )
}
/// Deadline must be captured before step() can ACK a pause after emulation.
pub fn wfe_deadline<E: Event, A: Response>(
    irq: &Receiver<u32>,
    control: &Receiver<E>,
    ack: &Sender<A>,
    deadline: Option<Instant>,
    should_wait: impl Fn() -> bool,
) -> Result<(), Fault> {
    loop {
        if !should_wait() {
            return Ok(());
        }
        if let Some(deadline) = deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(());
            }
            crossbeam_channel::select! {
                recv(irq) -> value => { value.map_err(|_|Fault::IrqClosed)?;return Ok(()); },
                recv(control) -> event => handle(event.map_err(|_|Fault::ControlClosed)?,control,ack)?,
                default(remaining) => return Ok(()),
            }
        } else {
            crossbeam_channel::select! {
                recv(irq) -> value => { value.map_err(|_|Fault::IrqClosed)?;return Ok(()); },
                recv(control) -> event => handle(event.map_err(|_|Fault::ControlClosed)?,control,ack)?,
            }
        }
    }
}
/// Called around the actual MMIO/emulation callback. Its borrowed guards end before post-step ACK.
pub fn step<E: Event, A: Response, T>(
    control: &Receiver<E>,
    ack: &Sender<A>,
    emulate: impl FnOnce() -> T,
    is_stop: impl FnOnce(&T) -> bool,
) -> Result<T, Fault> {
    drain(control, ack)?;
    let result = emulate();
    if !is_stop(&result) {
        drain(control, ack)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossbeam_channel::unbounded;
    use std::sync::{Arc, Mutex};
    use std::thread;
    impl Event for Meaning {
        fn meaning(&self) -> Meaning {
            *self
        }
    }
    #[derive(Debug, PartialEq, Eq)]
    enum Ack {
        Pause(u64),
        Resume(u64),
    }
    impl Response for Ack {
        fn paused(e: u64) -> Self {
            Self::Pause(e)
        }
        fn resumed(e: u64) -> Self {
            Self::Resume(e)
        }
    }
    #[test]
    fn actual_boot_wait_parks_then_preserves_boot_arrival() {
        let (entry, boot_rx) = unbounded();
        let (send, control) = unbounded();
        let (acks, response) = unbounded::<Ack>();
        send.send(Meaning::Pause(11)).unwrap();
        let worker = thread::spawn(move || boot(&boot_rx, &control, &acks));
        assert_eq!(
            response.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ack::Pause(11)
        );
        entry.send(0x8100).unwrap();
        assert!(response.try_recv().is_err());
        send.send(Meaning::Resume(11)).unwrap();
        assert_eq!(
            response.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ack::Resume(11)
        );
        assert_eq!(worker.join().unwrap(), Ok(0x8100));
    }
    #[test]
    fn actual_wfe_preserves_irq_received_while_parked() {
        let (irq, irq_rx) = unbounded();
        let (send, control) = unbounded();
        let (acks, response) = unbounded::<Ack>();
        send.send(Meaning::Pause(12)).unwrap();
        let worker = thread::spawn(move || wfe(&irq_rx, &control, &acks, None, || true));
        assert_eq!(
            response.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ack::Pause(12)
        );
        irq.send(3).unwrap();
        send.send(Meaning::Resume(12)).unwrap();
        assert_eq!(
            response.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ack::Resume(12)
        );
        assert_eq!(worker.join().unwrap(), Ok(()));
    }
    #[test]
    fn actual_wfe_deadline_is_not_restarted_after_pause() {
        let (_irq, irq_rx) = unbounded();
        let (send, control) = unbounded();
        let (acks, response) = unbounded::<Ack>();
        let (done, completed) = unbounded();
        send.send(Meaning::Pause(13)).unwrap();
        let worker = thread::spawn(move || {
            let result = wfe(
                &irq_rx,
                &control,
                &acks,
                Some(Duration::from_millis(150)),
                || true,
            );
            done.send(result).unwrap();
        });
        assert_eq!(
            response.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ack::Pause(13)
        );
        thread::sleep(Duration::from_millis(180));
        send.send(Meaning::Resume(13)).unwrap();
        assert_eq!(
            response.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ack::Resume(13)
        );
        assert_eq!(
            completed.recv_timeout(Duration::from_millis(100)).unwrap(),
            Ok(())
        );
        worker.join().unwrap();
    }
    #[test]
    fn actual_step_unlocks_mmio_before_pause_ack() {
        let device = Arc::new(Mutex::new(()));
        let (send, control) = unbounded();
        let (acks, response) = unbounded::<Ack>();
        let (entered, at_mmio) = unbounded();
        let (finish, may_finish) = unbounded();
        let cpu_device = device.clone();
        let worker = thread::spawn(move || {
            step(
                &control,
                &acks,
                || {
                    let _guard = cpu_device.lock().unwrap();
                    entered.send(()).unwrap();
                    may_finish.recv().unwrap();
                    42
                },
                |_| false,
            )
        });
        at_mmio.recv_timeout(Duration::from_secs(1)).unwrap();
        send.send(Meaning::Pause(14)).unwrap();
        assert!(response.try_recv().is_err());
        finish.send(()).unwrap();
        assert_eq!(
            response.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ack::Pause(14)
        );
        assert!(device.try_lock().is_ok());
        send.send(Meaning::Resume(14)).unwrap();
        assert_eq!(
            response.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ack::Resume(14)
        );
        assert_eq!(worker.join().unwrap(), Ok(42));
    }
    #[test]
    fn actual_step_stop_bypasses_queued_pause_ack() {
        let (send, control) = unbounded();
        let (acks, response) = unbounded::<Ack>();
        send.send(Meaning::Other).unwrap();
        let result = step(
            &control,
            &acks,
            || {
                send.send(Meaning::Pause(15)).unwrap();
                true
            },
            |stop| *stop,
        );
        assert_eq!(result, Ok(true));
        assert!(response.try_recv().is_err());
    }
    #[test]
    fn actual_handler_rejects_wrong_resume_epoch() {
        let (send, control) = unbounded();
        let (acks, response) = unbounded::<Ack>();
        send.send(Meaning::Resume(17)).unwrap();
        assert_eq!(
            handle(Meaning::Pause(16), &control, &acks),
            Err(Fault::Epoch)
        );
        assert_eq!(response.recv().unwrap(), Ack::Pause(16));
        assert!(response.try_recv().is_err());
    }
    #[test]
    fn actual_wfe_deadline_captured_before_post_emulation_park_does_not_restart() {
        let (irq, irq_rx) = unbounded();
        let (send, control) = unbounded();
        let (acks, response) = unbounded::<Ack>();
        let (exited, finished) = unbounded();
        let pause = send.clone();
        let worker = thread::spawn(move || {
            let deadline = step(
                &control,
                &acks,
                || {
                    let deadline = Instant::now() + Duration::from_millis(20);
                    pause.send(Meaning::Pause(19)).unwrap();
                    deadline
                },
                |_| false,
            )
            .unwrap();
            wfe_deadline(&irq_rx, &control, &acks, Some(deadline), || true).unwrap();
            assert_eq!(irq_rx.try_recv(), Ok(7));
            exited.send(()).unwrap();
        });
        assert_eq!(
            response.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ack::Pause(19)
        );
        thread::sleep(Duration::from_millis(40));
        // A queued IRQ remains unconsumed if the absolute deadline expired while parked.
        irq.send(7).unwrap();
        send.send(Meaning::Resume(19)).unwrap();
        assert_eq!(
            response.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ack::Resume(19)
        );
        finished.recv_timeout(Duration::from_secs(1)).unwrap();
        worker.join().unwrap();
    }
}
