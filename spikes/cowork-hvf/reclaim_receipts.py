"""Audit recorded native ordering. Cumulative replacement bytes are not unique returned RAM."""
from collections import Counter

def summary(rows):
    epochs={}
    for row in rows:
        if row.get("kind","").startswith("reclaim_") and "epoch" in row:
            epochs.setdefault(row["epoch"],[]).append(row)
    errors=[];spans=[];pauses=[];parks=[];dispositions=Counter()
    for epoch,events in epochs.items():
        parked=[r for r in events if r["kind"]=="reclaim_parked"]
        resumed=[r for r in events if r["kind"]=="reclaim_resumed"]
        if len(parked)!=1 or len(resumed)!=1:
            errors.append(f"epoch {epoch}: incomplete park/resume");continue
        if parked[0]["roster"]!=[0,1] or resumed[0]["roster"]!=[0,1]:errors.append(f"epoch {epoch}: roster changed")
        pauses.append(parked[0]["pauseMicros"]);parks.append(resumed[0]["parkMicros"])
        pending=None;mapped=0;acked=False;did_resume=False
        excluded=[(r["gpa"],r["gpa"]+r["len"]) for r in events if r["kind"]=="reclaim_exclusion"]
        for row in events:
            kind=row["kind"]
            if kind=="reclaim_unmap":
                if pending or acked or did_resume:errors.append(f"epoch {epoch}: unmap ordering")
                pending=(row,"unmapped")
                if row["return"]!=0 or any(row[x]%16384 for x in ["gpa","hva","len"]) or row["len"]<=0:errors.append(f"epoch {epoch}: invalid unmap")
                if any(row["gpa"]<end and start<row["gpa"]+row["len"] for start,end in excluded):errors.append(f"epoch {epoch}: exclusion overlap")
            elif kind=="reclaim_replace":
                if not pending or pending[1]!="unmapped" or row["gpa"]!=pending[0]["gpa"] or not row["sameHVA"] or row["errnoIfFailed"]!=0:errors.append(f"epoch {epoch}: backing replacement")
                if pending:pending=(pending[0],"replaced")
            elif kind=="reclaim_map":
                if not pending or pending[1]!="replaced" or row["gpa"]!=pending[0]["gpa"] or not row["sameHVA"] or row["return"]!=0 or row["flags"]!="RWX":errors.append(f"epoch {epoch}: remap")
                if pending:spans.append(pending[0]);mapped+=1
                pending=None
            elif kind=="reclaim_used_ack":
                if pending or did_resume or acked or not row["indices"]:errors.append(f"epoch {epoch}: used ACK ordering")
                acked=True
            elif kind=="reclaim_disposition":
                dispositions[row["disposition"]]+=1
                if row["disposition"]=="replaced" and not acked:errors.append(f"epoch {epoch}: missing used ACK")
            elif kind=="reclaim_resumed":
                if pending or row["spanCount"]!=mapped:errors.append(f"epoch {epoch}: incomplete mappings before resume")
                did_resume=True
        if not did_resume:errors.append(f"epoch {epoch}: resume absent")
    windows=[]
    for cycle in range(1,4):
        free=next((r for r in rows if r.get("kind")=="guest_freed" and r.get("cycle")==cycle),None)
        integrity=next((r for r in rows if r.get("kind")=="guest_integrity" and r.get("cycle")==cycle),None)
        if free and integrity:
            found=[r for r in spans if free["hostElapsedSeconds"]<=r["hostElapsedSeconds"]<integrity["hostElapsedSeconds"]]
            heart=[r for r in rows if r.get("kind")=="guest_heartbeat" and free["hostElapsedSeconds"]<=r["hostElapsedSeconds"]<integrity["hostElapsedSeconds"]]
            windows.append({"cycle":cycle,"spanCount":len(found),"cumulativeReplacedBytes":sum(r["len"] for r in found),"firstUnmapAfterFreeSeconds":round(found[0]["hostElapsedSeconds"]-free["hostElapsedSeconds"],3) if found else None,"heartbeatsDuringWindow":len(heart)})
    return {"receiptOrderingPassed":bool(epochs) and not errors,"errors":errors,"epochCount":len(epochs),"spanCount":len(spans),"cumulativeReplacedBytes":sum(r["len"] for r in spans),"sizesBytes":dict(Counter(str(r["len"]) for r in spans)),"dispositions":dict(dispositions),"maxPauseAckMicros":max(pauses,default=None),"maxParkThroughResumeMicros":max(parks,default=None),"afterGuestFree":windows,"timerLatencyGuarantee":False}
