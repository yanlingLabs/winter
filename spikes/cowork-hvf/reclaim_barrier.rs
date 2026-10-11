//! Exact-epoch coordinator state. No OS/HVF calls; runtime must supply the actual immutable roster.
use std::collections::BTreeSet;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase { Awaiting, Parked, Replacing, Mapped, Acknowledged, Resuming, Finished, Stopped, Failed }
#[derive(Debug)]
pub struct Barrier {
    pub epoch: u64,
    phase: Phase,
    roster: BTreeSet<u64>,
    paused: BTreeSet<u64>,
    resumed: BTreeSet<u64>,
}
impl Barrier {
    pub fn new(epoch:u64, roster:&[u64])->Result<Self,&'static str> {
        let set:BTreeSet<_>=roster.iter().copied().collect();
        if epoch==0 || set.is_empty() || set.len()!=roster.len() || set.contains(&u64::MAX) { return Err("invalid epoch/roster"); }
        Ok(Self{epoch,phase:Phase::Awaiting,roster:set,paused:BTreeSet::new(),resumed:BTreeSet::new()})
    }
    pub fn phase(&self)->Phase { self.phase }
    pub fn pause_ack(&mut self, cpu:u64, epoch:u64)->Result<(),&'static str> {
        if self.phase!=Phase::Awaiting || epoch!=self.epoch || !self.roster.contains(&cpu) || !self.paused.insert(cpu) { self.fail(); return Err("invalid pause ACK"); }
        if self.paused==self.roster { self.phase=Phase::Parked; }
        Ok(())
    }
    pub fn begin_replacement(&mut self)->Result<(),&'static str> {
        if self.phase!=Phase::Parked { return Err("CPUs not parked"); }
        self.phase=Phase::Replacing; Ok(())
    }
    pub fn mappings_complete(&mut self)->Result<(),&'static str> {
        if self.phase!=Phase::Replacing { return Err("invalid mapping state"); }
        self.phase=Phase::Mapped; Ok(())
    }
    pub fn acknowledge_used(&mut self)->Result<(),&'static str> {
        if self.phase!=Phase::Mapped { return Err("mappings incomplete"); }
        self.phase=Phase::Acknowledged; Ok(())
    }
    pub fn begin_resume(&mut self)->Result<(),&'static str> {
        if self.phase!=Phase::Acknowledged { return Err("used ring not acknowledged"); }
        self.phase=Phase::Resuming; Ok(())
    }
    pub fn resume_ack(&mut self,cpu:u64,epoch:u64)->Result<(),&'static str> {
        if self.phase!=Phase::Resuming || epoch!=self.epoch || !self.roster.contains(&cpu) || !self.resumed.insert(cpu) { self.fail(); return Err("invalid resume ACK"); }
        if self.resumed==self.roster { self.phase=Phase::Finished; }
        Ok(())
    }
    pub fn stop(&mut self) { self.phase=Phase::Stopped; }
    pub fn fail(&mut self) { if self.phase!=Phase::Stopped { self.phase=Phase::Failed; } }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn exact_roster_and_epoch_before_any_mapping() {
        let mut b=Barrier::new(7,&[10,20,30]).unwrap();
        assert!(b.begin_replacement().is_err());
        b.pause_ack(10,7).unwrap();
        b.pause_ack(20,7).unwrap(); assert!(b.begin_replacement().is_err());
        b.pause_ack(30,7).unwrap(); b.begin_replacement().unwrap();
        assert!(b.acknowledge_used().is_err()); assert!(b.begin_resume().is_err());
        b.mappings_complete().unwrap(); b.acknowledge_used().unwrap(); b.begin_resume().unwrap();
        for id in [10,20,30] { b.resume_ack(id,7).unwrap(); }
        assert_eq!(b.phase(),Phase::Finished);
    }
    #[test] fn stale_unknown_duplicate_acks_permanently_forbid_mutation() {
        for (id,epoch) in [(10,6),(40,7),(10,7)] {
            let mut b=Barrier::new(7,&[10,20,30]).unwrap(); b.pause_ack(10,7).unwrap();
            assert!(b.pause_ack(id,epoch).is_err()); assert_eq!(b.phase(),Phase::Failed);
            assert!(b.begin_replacement().is_err()); assert!(b.acknowledge_used().is_err()); assert!(b.begin_resume().is_err());
        }
    }
    #[test] fn stop_wins_over_every_pause_or_mapping_phase() {
        for position in 0..6 {
            let mut b=Barrier::new(1,&[0]).unwrap();
            if position>=1 { b.pause_ack(0,1).unwrap(); }
            if position>=2 { b.begin_replacement().unwrap(); }
            if position>=3 { b.mappings_complete().unwrap(); }
            if position>=4 { b.acknowledge_used().unwrap(); }
            if position>=5 { b.begin_resume().unwrap(); }
            b.stop();
            assert!(b.pause_ack(0,1).is_err()); assert!(b.begin_replacement().is_err());
            assert!(b.mappings_complete().is_err()); assert!(b.acknowledge_used().is_err());
            assert!(b.begin_resume().is_err()); assert!(b.resume_ack(0,1).is_err());
        }
    }
    #[test] fn partial_failure_never_acknowledges_or_resumes() {
        let mut b=Barrier::new(1,&[0,1]).unwrap();
        b.pause_ack(0,1).unwrap(); b.pause_ack(1,1).unwrap(); b.begin_replacement().unwrap(); b.fail();
        assert!(b.mappings_complete().is_err()); assert!(b.acknowledge_used().is_err()); assert!(b.begin_resume().is_err());
    }
    #[test] fn unknown_or_duplicate_roster_refused() {
        for ids in [&[][..],&[0,0][..],&[u64::MAX][..]] { assert!(Barrier::new(1,ids).is_err()); }
        assert!(Barrier::new(0,&[0]).is_err());
    }
}
