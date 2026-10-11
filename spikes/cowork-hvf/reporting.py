"""Describe reporting receipts; reported bytes are cumulative, not verified returned bytes."""
from collections import Counter

def summary(rows):
    descriptors=[r for r in rows if r.get("kind")=="report_descriptor"]
    windows=[]
    for cycle in range(1,4):
        free=next((r for r in rows if r.get("kind")=="guest_freed" and r.get("cycle")==cycle),None)
        end=next((r for r in rows if r.get("kind")=="guest_integrity" and r.get("cycle")==cycle),None)
        if not free or not end: continue
        events=[r for r in descriptors if free["hostElapsedSeconds"]<=r["hostElapsedSeconds"]<end["hostElapsedSeconds"]]
        windows.append({"cycle":cycle,"descriptorCount":len(events),"cumulativeReportedBytes":sum(r["len"] for r in events),
            "sizesBytes":dict(Counter(str(r["len"]) for r in events)),
            "firstReportAfterFreeSeconds":round(events[0]["hostElapsedSeconds"]-free["hostElapsedSeconds"],3) if events else None})
    return {"batchCount":sum(r.get("kind")=="report_batch" for r in rows),"descriptorCount":len(descriptors),
        "cumulativeReportedBytes":sum(r["len"] for r in descriptors),"sizesBytes":dict(Counter(str(r["len"]) for r in descriptors)),
        "all16KiBAligned":bool(descriptors) and all(r["hostPageBytes"]==16384 and r["hvaAligned"] and r["gpaAligned"] and r["lengthAligned"] for r in descriptors),
        "allAdviceCallsSucceeded":bool(descriptors) and all(r["adviceReturn"]==0 for r in descriptors),
        "afterGuestFree":windows,"activeReturnVerified":False}
