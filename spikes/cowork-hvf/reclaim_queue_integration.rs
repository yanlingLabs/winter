//! Actual pinned Queue parser + actual parked transaction, with HVF/mmap replaced by counted fakes.
#[cfg(test)] mod tests {
    use krun_devices::virtio::{Queue,Descriptor};
    use vm_memory::{Address,Bytes,GuestAddress,GuestMemory,GuestMemoryMmap};
    use crate::{cowork_barrier::Barrier,cowork_coordinator::{self,Snapshot,ReportOps,Disposition,Fatal},cowork_ranges::{OwnedRegion,Extent,ReclaimSpan,Reject},cowork_ops::ReplaceOps};
    struct Ops {queue:Queue,mem:GuestMemoryMmap,maps:usize,acks:usize,fail_replace:bool}
    impl ReplaceOps for Ops {
        fn stopped(&self)->bool {false}
        fn unmap(&mut self,_:ReclaimSpan)->Result<(),()> {self.maps+=1;Ok(())}
        fn replace(&mut self,_:ReclaimSpan)->Result<(),()> {self.maps+=1;if self.fail_replace {Err(())}else{Ok(())}}
        fn map(&mut self,_:ReclaimSpan)->Result<(),()> {self.maps+=1;Ok(())}
    }
    impl ReportOps for Ops {
        fn snapshot(&mut self)->Result<Snapshot,()> {
            self.queue.fixture_validate_report(&self.mem).map_err(|_|())?;
            let exclusions=self.queue.fixture_exclusions(&self.mem,false).map_err(|_|())?.into_iter().map(|(start,len)|Extent{start,len}).collect();
            let batches=self.queue.fixture_pop_reports(&self.mem).map_err(|_|())?;
            Ok(Snapshot{indices:batches.iter().map(|(index,_)|*index).collect(),reports:batches.iter().flat_map(|(_,ranges)|ranges.iter().map(|&(start,len)|Extent{start,len})).collect(),exclusions})
        }
        fn acknowledge(&mut self,indices:&[u16])->Result<(),()> {self.queue.fixture_ack_reports(&self.mem,indices).map_err(|_|())?;self.acks+=indices.len();Ok(())}
    }
    fn fixture(addr:u64,len:u32,flags:u16)->Ops {
        let mem=GuestMemoryMmap::from_ranges(&[(GuestAddress(0),65536)]).unwrap();let mut queue=Queue::new(8);queue.size=8;queue.ready=true;
        queue.desc_table=GuestAddress(0x1000);queue.avail_ring=GuestAddress(0x2000);queue.used_ring=GuestAddress(0x3000);
        mem.write_obj(Descriptor{addr,len,flags,next:0},queue.desc_table).unwrap();mem.write_obj(0u16,queue.avail_ring.unchecked_add(4)).unwrap();mem.write_obj(1u16,queue.avail_ring.unchecked_add(2)).unwrap();
        Ops{queue,mem,maps:0,acks:0,fail_replace:false}
    }
    fn region(ops:&Ops)->OwnedRegion {OwnedRegion{gpa:0,hva:ops.mem.get_host_address(GuestAddress(0)).unwrap() as u64,len:65536,private_anonymous:true}}
    fn barrier(epoch:u64)->Barrier {let mut b=Barrier::new(epoch,&[0]).unwrap();b.pause_ack(0,epoch).unwrap();b}
    fn used(ops:&Ops)->u16 {ops.mem.read_obj(ops.queue.used_ring.unchecked_add(2)).unwrap()}
    #[test] fn real_queue_unaligned_or_ring_overlap_is_acknowledged_noop() {
        for(addr,len,reject) in [(0x5000,4096,Reject::Alignment),(0,16384,Reject::Excluded),(65536,16384,Reject::Unowned)] {
            let mut ops=fixture(addr,len,2);let r=region(&ops);let mut b=barrier(1);
            assert_eq!(cowork_coordinator::finish(&mut b,&[r],16384,&mut ops),Ok(Disposition::Noop(reject)));
            assert_eq!(ops.maps,0);assert_eq!(ops.acks,1);assert_eq!(used(&ops),1);b.begin_resume().unwrap();
        }
    }
    #[test] fn real_nonready_nonzero_queue_with_ring_overlap_has_no_maps_or_ack() {
        let mut ops=fixture(0,16384,2);ops.queue.ready=false;let r=region(&ops);let mut b=barrier(1);
        assert_eq!(cowork_coordinator::finish(&mut b,&[r],16384,&mut ops),Err(Fatal::Malformed));assert_eq!(ops.maps,0);assert_eq!(ops.acks,0);assert_eq!(used(&ops),0);assert!(b.begin_resume().is_err());
    }
    #[test] fn real_queue_two_kicks_one_batch_has_exactly_one_used_entry() {
        let mut ops=fixture(0x4000,16384,2);let r=region(&ops);let mut first=barrier(1);
        assert_eq!(cowork_coordinator::finish(&mut first,&[r],16384,&mut ops),Ok(Disposition::Replaced{bytes:16384,spans:1}));assert_eq!(used(&ops),1);
        let before_maps=ops.maps;let mut second=barrier(2);
        assert_eq!(cowork_coordinator::finish(&mut second,&[r],16384,&mut ops),Ok(Disposition::Empty));assert_eq!(ops.maps,before_maps);assert_eq!(ops.acks,1);assert_eq!(used(&ops),1);second.begin_resume().unwrap();
    }
    #[test] fn real_queue_chain_error_and_partial_mapping_failure_never_ack_or_resume() {
        for malformed in [true,false] {
            let mut ops=fixture(0x4000,16384,if malformed {3}else{2});ops.fail_replace=!malformed;let r=region(&ops);let mut b=barrier(1);
            assert!(cowork_coordinator::finish(&mut b,&[r],16384,&mut ops).is_err());assert_eq!(ops.maps,if malformed {0}else{2});assert_eq!(ops.acks,0);assert_eq!(used(&ops),0);assert!(b.begin_resume().is_err());
        }
    }
}
