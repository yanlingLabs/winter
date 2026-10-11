//! Shared replacement sequence; real HVF operations and bounded fakes use this exact function.
use crate::cowork_barrier::Barrier;
use crate::cowork_ranges::ReclaimSpan;
pub trait ReplaceOps {
    fn stopped(&self)->bool;
    fn unmap(&mut self, span:ReclaimSpan)->Result<(),()>;
    fn replace(&mut self, span:ReclaimSpan)->Result<(),()>;
    fn map(&mut self, span:ReclaimSpan)->Result<(),()>;
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub enum Failure { NotParked, Empty, Stopped, Unmap, Replace, Map, State }
fn stop(barrier:&mut Barrier, ops:&impl ReplaceOps)->Result<(),Failure> {
    if ops.stopped() { barrier.stop(); Err(Failure::Stopped) } else { Ok(()) }
}
pub fn apply(barrier:&mut Barrier, spans:&[ReclaimSpan], ops:&mut impl ReplaceOps)->Result<(),Failure> {
    stop(barrier,ops)?;
    if spans.is_empty() { barrier.fail(); return Err(Failure::Empty); }
    barrier.begin_replacement().map_err(|_|Failure::NotParked)?;
    for &span in spans {
        stop(barrier,ops)?;
        if ops.unmap(span).is_err() { barrier.fail(); return Err(Failure::Unmap); }
        stop(barrier,ops)?;
        if ops.replace(span).is_err() { barrier.fail(); return Err(Failure::Replace); }
        stop(barrier,ops)?;
        if ops.map(span).is_err() { barrier.fail(); return Err(Failure::Map); }
    }
    stop(barrier,ops)?;
    barrier.mappings_complete().map_err(|_|Failure::State)
}
#[cfg(test)] mod tests {
    use super::*;
    use crate::cowork_barrier::Phase;
    #[derive(Default)] struct Fake { calls:Vec<(&'static str,ReclaimSpan)>, fail_at:Option<usize>, stop_at:Option<usize> }
    impl Fake { fn call(&mut self,op:&'static str,span:ReclaimSpan)->Result<(),()> {
        self.calls.push((op,span)); if self.fail_at==Some(self.calls.len()) { Err(()) } else { Ok(()) }
    } }
    impl ReplaceOps for Fake {
        fn stopped(&self)->bool { self.stop_at.is_some_and(|n| self.calls.len()>=n) }
        fn unmap(&mut self,s:ReclaimSpan)->Result<(),()> { self.call("unmap",s) }
        fn replace(&mut self,s:ReclaimSpan)->Result<(),()> { self.call("replace",s) }
        fn map(&mut self,s:ReclaimSpan)->Result<(),()> { self.call("map",s) }
    }
    fn spans()->[ReclaimSpan;2] { [ReclaimSpan{gpa:0x80000000,hva:0x100000000,len:16384},ReclaimSpan{gpa:0x80008000,hva:0x100008000,len:32768}] }
    fn parked()->Barrier { let mut b=Barrier::new(9,&[10,20]).unwrap(); b.pause_ack(10,9).unwrap(); b.pause_ack(20,9).unwrap(); b }
    #[test] fn every_partial_hvf_or_mmap_failure_forbids_ack_resume() {
        for failure in 1..=6 {
            let mut b=parked();let mut ops=Fake{fail_at:Some(failure),..Fake::default()};
            assert!(apply(&mut b,&spans(),&mut ops).is_err()); assert_eq!(ops.calls.len(),failure);
            assert_eq!(b.phase(),Phase::Failed); assert!(b.acknowledge_used().is_err()); assert!(b.begin_resume().is_err());
        }
    }
    #[test] fn stop_at_each_transition_prevents_more_operations_or_ack() {
        for position in 0..=6 {
            let mut b=parked();let mut ops=Fake{stop_at:Some(position),..Fake::default()};
            assert_eq!(apply(&mut b,&spans(),&mut ops),Err(Failure::Stopped)); assert_eq!(ops.calls.len(),position);
            assert_eq!(b.phase(),Phase::Stopped); assert!(b.acknowledge_used().is_err()); assert!(b.begin_resume().is_err());
        }
    }
    #[test] fn missing_stale_duplicate_cpu_means_zero_map_calls() {
        for ack in [None,Some((10,8)),Some((10,9))] {
            let mut b=Barrier::new(9,&[10,20]).unwrap(); b.pause_ack(10,9).unwrap();
            if let Some((id,e))=ack { assert!(b.pause_ack(id,e).is_err()); }
            let mut ops=Fake::default(); assert!(apply(&mut b,&spans(),&mut ops).is_err()); assert!(ops.calls.is_empty());
        }
    }
    #[test] fn full_sequence_preserves_every_hva_and_delays_used_ack() {
        let mut b=parked();let mut ops=Fake::default();apply(&mut b,&spans(),&mut ops).unwrap();
        assert_eq!(ops.calls,vec![("unmap",spans()[0]),("replace",spans()[0]),("map",spans()[0]),("unmap",spans()[1]),("replace",spans()[1]),("map",spans()[1])]);
        assert_eq!(b.phase(),Phase::Mapped);assert!(b.begin_resume().is_err());
        b.acknowledge_used().unwrap();b.begin_resume().unwrap();
    }
    #[test] fn empty_plan_is_not_a_replacement() {
        let mut b=parked();let mut ops=Fake::default();assert_eq!(apply(&mut b,&[],&mut ops),Err(Failure::Empty));assert!(ops.calls.is_empty());
    }
    #[test] fn malformed_report_or_ring_intersection_rejected_before_any_map_call() {
        use crate::cowork_ranges::{self,OwnedRegion,Extent};
        let region=OwnedRegion{gpa:0x80000000,hva:0x100000000,len:8*16384,private_anonymous:true};
        let bad=[Extent{start:region.gpa,len:4096},Extent{start:region.gpa+7*16384,len:2*16384},Extent{start:u64::MAX-16383,len:32768},Extent{start:region.gpa,len:0}];
        for report in bad {
            let mut b=parked();let mut ops=Fake::default();
            if let Ok(spans)=cowork_ranges::plan(&[region],&[],&[report],16384) { let _=apply(&mut b,&spans,&mut ops); }
            assert!(ops.calls.is_empty());
        }
        let report=Extent{start:region.gpa,len:16384};let ring=Extent{start:region.gpa+16383,len:1};
        assert!(cowork_ranges::plan(&[region],&[ring],&[report],16384).is_err());
    }
}
