//! Pure planning only: never unmaps or modifies memory. Runtime owns the registry and exclusions.
//! Compile tests with the slice-local rustc --test; no VM or library linkage is needed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Extent { pub start: u64, pub len: u64 }
#[derive(Clone, Copy, Debug)]
pub struct OwnedRegion { pub gpa: u64, pub hva: u64, pub len: u64, pub private_anonymous: bool }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReclaimSpan { pub gpa: u64, pub hva: u64, pub len: u64 }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reject { HostPageSize, Empty, TooMany, Overflow, Registry, Unowned, Alignment, Overlap, Excluded, Limit }

fn end(start: u64, len: u64) -> Result<u64, Reject> {
    if len == 0 { return Err(Reject::Empty); }
    start.checked_add(len).ok_or(Reject::Overflow)
}
fn overlaps(a: Extent, b: Extent) -> Result<bool, Reject> {
    Ok(a.start < end(b.start,b.len)? && b.start < end(a.start,a.len)?)
}

/// Every input descriptor must be a complete host page, inside ONE sealed private RAM region.
/// Reject whole batches atomically. Never round, truncate, merge a gap, or translate only the start.
pub fn plan(regions: &[OwnedRegion], excluded: &[Extent], reports: &[Extent], host_page: u64)
    -> Result<Vec<ReclaimSpan>, Reject>
{
    if host_page != 16384 { return Err(Reject::HostPageSize); }
    if reports.is_empty() { return Err(Reject::Empty); }
    if reports.len()>256 || regions.len()>256 || excluded.len()>4096 { return Err(Reject::TooMany); }
    for (i,r) in regions.iter().enumerate() {
        end(r.gpa,r.len)?; end(r.hva,r.len)?;
        if !r.private_anonymous || r.gpa%host_page!=0 || r.hva%host_page!=0 || r.len%host_page!=0 {
            return Err(Reject::Registry);
        }
        for previous in &regions[..i] {
            if overlaps(Extent{start:r.gpa,len:r.len},Extent{start:previous.gpa,len:previous.len})?
                || overlaps(Extent{start:r.hva,len:r.len},Extent{start:previous.hva,len:previous.len})? {
                return Err(Reject::Registry);
            }
        }
    }
    for x in excluded { end(x.start,x.len)?; }
    let mut spans=Vec::with_capacity(reports.len()); let mut total=0u64;
    for (i,report) in reports.iter().enumerate() {
        let report_end=end(report.start,report.len)?;
        if report.start%host_page!=0 || report.len%host_page!=0 { return Err(Reject::Alignment); }
        total=total.checked_add(report.len).ok_or(Reject::Overflow)?;
        if total>384*1024*1024 { return Err(Reject::Limit); }
        let region=regions.iter().find(|r| report.start>=r.gpa && report_end<=r.gpa+r.len).ok_or(Reject::Unowned)?;
        let hva=region.hva.checked_add(report.start-region.gpa).ok_or(Reject::Overflow)?;
        if hva%host_page!=0 || end(hva,report.len)?>region.hva+region.len { return Err(Reject::Alignment); }
        for previous in &reports[..i] { if overlaps(*report,*previous)? { return Err(Reject::Overlap); } }
        for x in excluded { if overlaps(*report,*x)? { return Err(Reject::Excluded); } }
        spans.push(ReclaimSpan{gpa:report.start,hva,len:report.len});
    }
    Ok(spans)
}

#[cfg(test)]
mod tests {
    use super::*;
    const PAGE:u64=16384;
    fn region()->OwnedRegion { OwnedRegion{gpa:0x80000000,hva:0x100000000,len:8*PAGE,private_anonymous:true} }
    fn report(start:u64,len:u64)->Extent { Extent{start,len} }
    #[test] fn full_span_translation() {
        let r=region(); let p=plan(&[r],&[],&[report(r.gpa+PAGE,2*PAGE)],PAGE).unwrap();
        assert_eq!(p,[ReclaimSpan{gpa:r.gpa+PAGE,hva:r.hva+PAGE,len:2*PAGE}]);
    }
    #[test] fn valid_start_invalid_full_span() {
        let r=region();assert_eq!(plan(&[r],&[],&[report(r.gpa+7*PAGE,2*PAGE)],PAGE),Err(Reject::Unowned));
    }
    #[test] fn adjacent_regions_are_not_one_owned_span() {
        let a=region(); let b=OwnedRegion{gpa:a.gpa+a.len,hva:a.hva+a.len,..a};
        assert_eq!(plan(&[a,b],&[],&[report(a.gpa+7*PAGE,2*PAGE)],PAGE),Err(Reject::Unowned));
    }
    #[test] fn partial_host_pages_are_never_rounded() {
        let r=region();
        for x in [report(r.gpa,4096),report(r.gpa+4096,PAGE),report(r.gpa,PAGE+4096)] {
            assert_eq!(plan(&[r],&[],&[x],PAGE),Err(Reject::Alignment));
        }
    }
    #[test] fn overflow_and_empty_inputs() {
        let r=region();
        assert_eq!(plan(&[r],&[],&[report(u64::MAX-PAGE+1,2*PAGE)],PAGE),Err(Reject::Overflow));
        assert_eq!(plan(&[r],&[],&[report(r.gpa,0)],PAGE),Err(Reject::Empty));
        assert_eq!(plan(&[r],&[],&[],PAGE),Err(Reject::Empty));
    }
    #[test] fn duplicate_or_overlapping_reports_rejected() {
        let r=region();
        for start in [r.gpa,r.gpa+PAGE] {
            assert_eq!(plan(&[r],&[],&[report(r.gpa,2*PAGE),report(start,PAGE)],PAGE),Err(Reject::Overlap));
        }
    }
    #[test] fn dma_or_ring_exclusion_even_one_byte() {
        let r=region();
        assert_eq!(plan(&[r],&[report(r.gpa+PAGE-1,1)],&[report(r.gpa,PAGE)],PAGE),Err(Reject::Excluded));
        assert!(plan(&[r],&[report(r.gpa+PAGE,1)],&[report(r.gpa,PAGE)],PAGE).is_ok());
    }
    #[test] fn registry_rejects_aliases_shared_memory_and_unaligned_hva() {
        let r=region();
        for invalid in [OwnedRegion{private_anonymous:false,..r},OwnedRegion{hva:r.hva+4096,..r}] {
            assert_eq!(plan(&[invalid],&[],&[report(r.gpa,PAGE)],PAGE),Err(Reject::Registry));
        }
        let alias=OwnedRegion{gpa:r.gpa+r.len,..r};
        assert_eq!(plan(&[r,alias],&[],&[report(r.gpa,PAGE)],PAGE),Err(Reject::Registry));
    }
    #[test] fn bounded_fixture_limit_and_descriptor_count() {
        let r=OwnedRegion{len:512*1024*1024,..region()};
        assert_eq!(plan(&[r],&[],&[report(r.gpa,385*1024*1024)],PAGE),Err(Reject::Limit));
        assert_eq!(plan(&[r],&[],&vec![report(r.gpa,PAGE);257],PAGE),Err(Reject::TooMany));
        assert_eq!(plan(&[r],&[],&[report(r.gpa,PAGE)],4096),Err(Reject::HostPageSize));
    }
}
