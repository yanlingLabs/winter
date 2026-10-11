"""Host-side RAW fixture checks. Expanded return remains unverified until independent raw audit."""
from collections import Counter
from reclaim_receipts import summary as reclaim_summary

def summary(rows):
    errors=[];requests={};overlap=[];freeze=[];capture_pins={};ring=set()
    for row in rows:
        kind=row.get('kind')
        if kind=='block_trace_overflow':errors.append('bounded trace overflow')
        if kind=='block_ring_pin':ring.add(row['pin'])
        if kind=='block_request_capture':
            request=row['request']
            if request in requests:errors.append('duplicate request identity')
            if not row['leaseReleased'] or row['length']>1048576:errors.append('capture bound/lease')
            requests[request]={'capture':row,'stages':[]};capture_pins[row['pin']]=request
        elif kind in ['block_owned_io_begin','block_owned_io_end','block_owned_completion_hold','block_completion_deferred','block_used_ack']:
            item=requests.get(row['request'])
            if item is None:errors.append('stage without capture');continue
            item['stages'].append(row)
        elif kind=='block_freeze_pin':freeze.append(row)
    for request,item in requests.items():
        stages=item['stages'];kinds=[r['kind'] for r in stages]
        required=['block_owned_io_begin','block_owned_io_end','block_used_ack']
        if any(kinds.count(k)!=1 for k in required):errors.append('incomplete request '+str(request));continue
        if [k for k in kinds if k in required]!=required:errors.append('IO/completion order '+str(request))
        if not next(r for r in stages if r['kind']=='block_owned_io_end')['success']:errors.append('failed IO '+str(request))
        ack=next(r for r in stages if r['kind']=='block_used_ack')
        if stages[-1]['kind']!='block_used_ack' or not ack['success'] or ack['head']!=item['capture']['head']:errors.append('bad ACK '+str(request))
    for row in freeze:
        exclusions=[r for r in rows if r.get('kind')=='reclaim_exclusion' and r.get('epoch')==row['epoch']]
        for span in row['ranges']:
            if not any(exclusion['gpa']<=span['gpa'] and span['gpa']+span['len']<=exclusion['gpa']+exclusion['len'] for exclusion in exclusions):errors.append('freeze pin missing from reclaim exclusions')
        request=capture_pins.get(row['pin'])
        if request is None:continue
        item=requests[request];capture=item['capture'];
        if row['ranges']!=capture['ranges']:errors.append('frozen request pin ranges changed')
        ack=next((r for r in item['stages'] if r['kind']=='block_used_ack'),None)
        if ack and capture['clockMicros']<=row['clockMicros']<ack['clockMicros']:
            overlap.append({'epoch':row['epoch'],'request':request,'pin':row['pin'],'ownedCompletionHold':any(r['kind']=='block_owned_completion_hold' for r in item['stages']),'osSyscallOverlap':any(a['clockMicros']<=row['clockMicros']<b['clockMicros'] for a in item['stages'] if a['kind']=='block_owned_io_begin' for b in item['stages'] if b['kind']=='block_owned_io_end')})
        else:errors.append('freeze pin outside captured outstanding lifetime')
    windows=[]
    for cycle in range(1,4):
        free=next((r for r in rows if r.get('kind')=='guest_freed' and r.get('cycle')==cycle),None);integrity=next((r for r in rows if r.get('kind')=='guest_integrity' and r.get('cycle')==cycle),None)
        progress=[r for r in rows if r.get('kind')=='guest_block_progress' and free and integrity and free['hostElapsedSeconds']<=r['hostElapsedSeconds']<integrity['hostElapsedSeconds']]
        windows.append({'cycle':cycle,'progressReceipts':len(progress),'threads':sorted({r['thread'] for r in progress})})
        if {r['thread'] for r in progress}!={0,1}:errors.append('missing concurrent disk progress in freed interval '+str(cycle))
    reclaimed=reclaim_summary(rows)
    return {'blockReceiptsPassed':bool(requests) and bool(overlap) and not errors,'errors':errors,'requestCount':len(requests),'commands':dict(Counter(item['capture']['command'] for item in requests.values())),'outstandingRequestOverlap':overlap,'ringPinCount':len(ring),'freedWindows':windows,'reclaim':reclaimed,'activeReturnVerified':False,'verificationPending':'Independent root raw receipt/footprint audit','productionReady':False,'fullResourceGatePassed':False,'encryption':False}
