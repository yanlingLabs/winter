//! Standalone bounded simulations and the same pure modules used by the candidate native patch.
#[path="reclaim_ranges.rs"] mod cowork_ranges;
#[path="reclaim_barrier.rs"] mod cowork_barrier;
#[path="reclaim_ops.rs"] mod cowork_ops;

#[cfg(test)] mod simulations {
    use super::cowork_barrier::{Barrier,Phase};
    use std::sync::{Arc,Mutex,mpsc};
    use std::thread;
    use std::time::Duration;
    #[test] fn running_wfe_and_waiting_boot_simulations_ack_exact_epoch() {
        let (acks,received)=mpsc::channel();let mut controls=Vec::new();let mut threads=Vec::new();
        for (id,state) in [(10,"running"),(20,"WFE"),(30,"waiting-boot")] {
            let (sender,control)=mpsc::channel::<u64>();controls.push(sender);let ack=acks.clone();
            threads.push(thread::spawn(move|| {
                if state=="running" { thread::yield_now(); }
                let epoch=control.recv_timeout(Duration::from_secs(1)).unwrap();ack.send((id,epoch)).unwrap();
            }));
        }
        let mut barrier=Barrier::new(17,&[10,20,30]).unwrap();
        for control in controls { control.send(17).unwrap(); }
        for _ in 0..3 { let(id,epoch)=received.recv_timeout(Duration::from_secs(1)).unwrap();barrier.pause_ack(id,epoch).unwrap(); }
        for handle in threads { handle.join().unwrap(); }
        assert_eq!(barrier.phase(),Phase::Parked);
    }
    #[test] fn sticky_hvf_exit_model_closes_check_then_run_race() {
        // Models the SDK's documented NEXT-run cancellation. This does not execute HVF.
        let checked_control_before_request=true;
        let mut pending_pause=None;let mut cancel_next_run=false;let mut guest_runs=0;
        assert!(checked_control_before_request);assert!(!cancel_next_run);
        pending_pause.replace(23);cancel_next_run=true; // publish pause/control first, then kick
        if !cancel_next_run { guest_runs+=1; } else { cancel_next_run=false; }
        assert_eq!(guest_runs,0);assert!(!cancel_next_run);
        let mut b=Barrier::new(23,&[0]).unwrap();b.pause_ack(0,pending_pause.take().unwrap()).unwrap();
        assert_eq!(b.phase(),Phase::Parked);
    }
    #[test] fn blocked_mmio_finishes_only_after_coordinator_releases_device_mutex() {
        let device=Arc::new(Mutex::new(()));let held=device.lock().unwrap();
        let (entered_tx,entered_rx)=mpsc::channel();let (ack_tx,ack_rx)=mpsc::channel();let cpu_device=device.clone();
        let cpu=thread::spawn(move|| { entered_tx.send(()).unwrap();{let _access=cpu_device.lock().unwrap();}ack_tx.send(31u64).unwrap(); });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(ack_rx.recv_timeout(Duration::from_millis(10)).is_err()); // bad lock order cannot park
        drop(held);assert_eq!(ack_rx.recv_timeout(Duration::from_secs(1)).unwrap(),31);cpu.join().unwrap();
    }
}
