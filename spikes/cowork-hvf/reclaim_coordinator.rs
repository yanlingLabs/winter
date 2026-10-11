//! Actual parked report transaction used by the candidate native event-loop adapter.
use crate::cowork_barrier::Barrier;
use crate::cowork_ranges::{self,OwnedRegion,Extent,Reject};
use crate::cowork_ops::{self,ReplaceOps};
#[derive(Default)] pub struct Snapshot { pub indices:Vec<u16>,pub reports:Vec<Extent>,pub exclusions:Vec<Extent> }
pub trait ReportOps:ReplaceOps {
    fn snapshot(&mut self)->Result<Snapshot,()>;
    fn acknowledge(&mut self,indices:&[u16])->Result<(),()>;
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)] pub enum Disposition { Empty, Noop(Reject), Replaced{bytes:u64,spans:usize} }
#[derive(Clone,Copy,Debug,PartialEq,Eq)] pub enum Fatal { Malformed, Stop, Replacement(cowork_ops::Failure), State, Acknowledge }
pub fn finish(barrier:&mut Barrier,regions:&[OwnedRegion],host_page:u64,ops:&mut impl ReportOps)->Result<Disposition,Fatal> {
    if ops.stopped() { barrier.stop();return Err(Fatal::Stop); }
    let snapshot=ops.snapshot().map_err(|_| {barrier.fail();Fatal::Malformed})?;
    if snapshot.indices.is_empty()!=snapshot.reports.is_empty() {barrier.fail();return Err(Fatal::Malformed);}
    for extent in &snapshot.exclusions {
        let end=extent.start.checked_add(extent.len).ok_or_else(|| {barrier.fail();Fatal::Malformed})?;
        if extent.len==0 || !regions.iter().any(|r|extent.start>=r.gpa && r.gpa.checked_add(r.len).is_some_and(|last|end<=last)) {barrier.fail();return Err(Fatal::Malformed);}
    }
    let disposition=if snapshot.reports.is_empty() {
        barrier.prepare_noop().map_err(|_|Fatal::State)?;Disposition::Empty
    } else {
        match cowork_ranges::plan(regions,&snapshot.exclusions,&snapshot.reports,host_page) {
            Ok(spans)=> {cowork_ops::apply(barrier,&spans,ops).map_err(Fatal::Replacement)?;
                Disposition::Replaced{bytes:spans.iter().map(|r|r.len).sum(),spans:spans.len()}},
            Err(reject)=> {barrier.prepare_noop().map_err(|_|Fatal::State)?;Disposition::Noop(reject)},
        }
    };
    if ops.stopped() {barrier.stop();return Err(Fatal::Stop);}
    // Empty/stale kicks invent no used entries. Valid planning rejects return every consumed head.
    if !snapshot.indices.is_empty() {ops.acknowledge(&snapshot.indices).map_err(|_| {barrier.fail();Fatal::Acknowledge})?;}
    barrier.acknowledge_used().map_err(|_|Fatal::State)?;
    Ok(disposition)
}
#[cfg(test)] mod tests {
    use super::*;use crate::cowork_ranges::ReclaimSpan;use crate::cowork_barrier::Phase;
    struct Fake { snapshot:Option<Result<Snapshot,()>>,calls:Vec<&'static str>,ack:Vec<u16>,fail:Option<usize> }
    impl ReplaceOps for Fake {
        fn stopped(&self)->bool {false}
        fn unmap(&mut self,_:ReclaimSpan)->Result<(),()> {self.op("unmap")}
        fn replace(&mut self,_:ReclaimSpan)->Result<(),()> {self.op("replace")}
        fn map(&mut self,_:ReclaimSpan)->Result<(),()> {self.op("map")}
    }
    impl Fake {fn op(&mut self,name:&'static str)->Result<(),()> {self.calls.push(name);if self.fail==Some(self.calls.len()) {Err(())}else{Ok(())}}}
    impl ReportOps for Fake {
        fn snapshot(&mut self)->Result<Snapshot,()> {self.snapshot.take().unwrap()}
        fn acknowledge(&mut self,indices:&[u16])->Result<(),()> {self.ack.extend(indices);Ok(())}
    }
    fn region()->OwnedRegion {OwnedRegion{gpa:0x80000000,hva:0x100000000,len:8*16384,private_anonymous:true}}
    fn parked()->Barrier {let mut b=Barrier::new(1,&[0]).unwrap();b.pause_ack(0,1).unwrap();b}
    fn fake(snapshot:Result<Snapshot,()>)->Fake {Fake{snapshot:Some(snapshot),calls:Vec::new(),ack:Vec::new(),fail:None}}
    #[test] fn actual_transaction_planner_rejection_acks_noop_and_allows_resume() {
        let r=region();
        for reports in [vec![Extent{start:r.gpa,len:4096}],vec![Extent{start:r.gpa+r.len,len:16384}],vec![Extent{start:r.gpa,len:16384};2]] {
            let mut b=parked();let mut ops=fake(Ok(Snapshot{indices:vec![3],reports,exclusions:vec![]}));
            assert!(matches!(finish(&mut b,&[r],16384,&mut ops),Ok(Disposition::Noop(_))));assert!(ops.calls.is_empty());assert_eq!(ops.ack,[3]);b.begin_resume().unwrap();
        }
        let mut b=parked();let mut ops=fake(Ok(Snapshot{indices:vec![4],reports:vec![Extent{start:r.gpa,len:16384}],exclusions:vec![Extent{start:r.gpa+1,len:2}]}));
        assert_eq!(finish(&mut b,&[r],16384,&mut ops),Ok(Disposition::Noop(Reject::Excluded)));assert!(ops.calls.is_empty());assert_eq!(ops.ack,[4]);
    }
    #[test] fn actual_transaction_two_kicks_one_batch_second_is_empty_no_ack() {
        let r=region();let mut first=parked();let mut ops=fake(Ok(Snapshot{indices:vec![7],reports:vec![Extent{start:r.gpa,len:16384}],exclusions:vec![]}));
        assert!(matches!(finish(&mut first,&[r],16384,&mut ops),Ok(Disposition::Replaced{..})));assert_eq!(ops.ack,[7]);
        let mut second=parked();ops.calls.clear();ops.ack.clear();ops.snapshot=Some(Ok(Snapshot::default()));
        assert_eq!(finish(&mut second,&[r],16384,&mut ops),Ok(Disposition::Empty));assert!(ops.calls.is_empty());assert!(ops.ack.is_empty());second.begin_resume().unwrap();
    }
    #[test] fn actual_transaction_malformed_frq_never_maps_acks_or_resumes() {
        let mut b=parked();let mut ops=fake(Err(()));assert_eq!(finish(&mut b,&[region()],16384,&mut ops),Err(Fatal::Malformed));
        assert!(ops.calls.is_empty());assert!(ops.ack.is_empty());assert_eq!(b.phase(),Phase::Failed);assert!(b.begin_resume().is_err());
    }
    #[test] fn actual_transaction_partial_map_failure_stays_parked_without_ack() {
        for failure in 1..=6 {
            let r=region();let mut b=parked();let mut ops=fake(Ok(Snapshot{indices:vec![2],reports:vec![Extent{start:r.gpa,len:16384},Extent{start:r.gpa+16384,len:16384}],exclusions:vec![]}));ops.fail=Some(failure);
            assert!(matches!(finish(&mut b,&[r],16384,&mut ops),Err(Fatal::Replacement(_))));assert_eq!(ops.calls.len(),failure);assert!(ops.ack.is_empty());assert!(b.begin_resume().is_err());
        }
    }
    #[test] fn actual_transaction_limit_rejection_returns_heads_without_mapping() {
        let r=OwnedRegion{len:512*1024*1024,..region()};let mut b=parked();let mut ops=fake(Ok(Snapshot{indices:vec![1],reports:vec![Extent{start:r.gpa,len:385*1024*1024}],exclusions:vec![]}));
        assert_eq!(finish(&mut b,&[r],16384,&mut ops),Ok(Disposition::Noop(Reject::Limit)));assert!(ops.calls.is_empty());assert_eq!(ops.ack,[1]);b.begin_resume().unwrap();
    }
}
