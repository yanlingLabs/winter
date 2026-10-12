"""Generic fixture scopes: normal workload and explicit close77 recovery remain distinct."""


EXPECTED_ACKS=[(3,4294967295,0,1),(2,0,1,0),(3,0,3,1),(2,0,6,1),(3,0,6,1)]
def audit(rows,oracle,terminal_close=False):
    errors=[]
    ack=[r for r in rows if r.get('kind')=='runtime_control_used_ack' and r.get('channel')=='stderr']
    expected=EXPECTED_ACKS+([(3,0,6,0)] if terminal_close else [])
    tuples=[(r.get('queue'),r.get('id'),r.get('event'),r.get('value')) for r in ack]
    if tuples!=expected or any(r.get('row')!=i or r.get('usedAck') is not True for i,r in enumerate(ack)):errors.append('exact native control ACK sequence absent')
    ready=[r for r in rows if r.get('kind')=='guest_generic_ready']
    if len(ready)!=1 or any(ready[0].get(k)!=v for k,v in {'generic':True,'tty':False,'nonblocking':True,'exclusiveOwner':True,'openControlAckReturned':True,'portId':0,'queues':[0,1,2,3],'multiport':True}.items()):errors.append('single exclusive generic port identity absent')
    begin=next((r for r in rows if r.get('kind')=='host_sink_stall_begin'),None)
    end=next((r for r in rows if r.get('kind')==('host_sink_owner_exited' if terminal_close else 'host_sink_stall_end')),None)
    back=[r for r in rows if r.get('kind')=='guest_generic_tx_backpressure' and begin and end and begin['hostElapsedSeconds']<=r['hostElapsedSeconds']<=end['hostElapsedSeconds']]
    heartbeat=[r for r in rows if r.get('kind')=='guest_heartbeat' and begin and end and begin['hostElapsedSeconds']<=r['hostElapsedSeconds']<=end['hostElapsedSeconds']]
    disk=[r for r in rows if r.get('kind')=='guest_block_progress' and begin and end and begin['hostElapsedSeconds']<=r['hostElapsedSeconds']<=end['hostElapsedSeconds']]
    alive=[r for r in rows if r.get('kind')=='host_sink_worker_alive' and r.get('workerAlive') is True]
    if not begin or begin.get('workerAlive') is not True or not end or not back or len(heartbeat)<2 or {r['thread'] for r in disk}!={0,1} or len(alive)<2:errors.append('live sink stall/backpressure/concurrent progress unproved')
    if not oracle.get('threadJoined') or oracle.get('error') or not oracle.get('receiveOraclePassed'):errors.append('bounded raw oracle incomplete')
    result={'genericChecksPassed':not errors,'errors':errors,'controlUsedAcks':len(ack),'sinkStallHeartbeats':len(heartbeat),'sinkStallDiskThreads':sorted({r['thread'] for r in disk}),'sinkStallWorkerAliveReceipts':len(alive),'terminalCloseScenario':terminal_close,'activeReturnVerified':False,'effectOutcome':'UNCERTAIN' if terminal_close else 'independent-audit-pending'}
    if terminal_close:
        requested=next((r for r in rows if r.get('kind')=='guest_terminal_close_requested'),None)
        if not requested or requested.get('streamThreadsJoined') is not True or not ack or not begin or not end or end.get('stallActive') is not True or not(begin['hostElapsedSeconds']<=requested['hostElapsedSeconds']<begin['hostElapsedSeconds']+begin['durationSeconds']):errors.append('close ACK during sink stall unproved')
        result['guestCloseReturnedObserved']=any(r.get('kind')=='guest_terminal_close_returned' for r in rows)
    else:
        inherited=generic_stream_audit(rows,oracle)
        if not inherited['streamChecksPassed']:errors.extend(inherited['errors'])
        shutdown=next((r for r in rows if r.get('kind')=='guest_generic_shutdown'),None)
        if not shutdown or shutdown.get('supervisorPortHeldOpen') is not True or shutdown.get('closeControlSent') is not False or shutdown.get('diskFlushed') is not True:errors.append('normal flush/held-port poweroff order unproved')
        result['streamAudit']=inherited
    result['genericChecksPassed']=not errors
    return result

def generic_stream_audit(rows,oracle):
    errors=[];windows=[]
    frozen=[r for r in rows if r.get('kind')=='block_freeze_pin' and r.get('device')==1]
    if not frozen:errors.append('actual stream-device frozen pins absent')
    for pin in frozen:
        exclusions=[r for r in rows if r.get('kind')=='reclaim_exclusion' and r.get('epoch')==pin['epoch']]
        if not pin.get('ranges') or any(not any(e['gpa']<=span['gpa'] and span['gpa']+span['len']<=e['gpa']+e['len'] for e in exclusions) for span in pin.get('ranges',[])):errors.append('stream frozen pin outside reclaim exclusions')
    ready=[r for r in rows if r.get('kind')=='guest_generic_ready']
    if len(ready)!=1 or ready[0].get('generic') is not True or ready[0].get('tty') is not False or ready[0].get('queues')!=[0,1,2,3]:errors.append('generic data identity unproved')
    completion={r['direction']:r for r in rows if r.get('kind')=='guest_stream_complete'}
    if set(completion)!={'guest-to-host','host-to-guest'}:errors.append('both guest streams must finish/join')
    if completion.get('guest-to-host',{}).get('bytes')!=oracle.get('receivedBytes'):errors.append('guest TX and raw host RX counts differ')
    inbound=completion.get('host-to-guest',{}).get('bytes',0)
    if inbound<=0 or inbound>oracle.get('sentBytes',0):errors.append('guest RX count outside captured sent prefix')
    for cycle in range(1,4):
        free=next((r for r in rows if r.get('kind')=='guest_freed' and r.get('cycle')==cycle),None)
        integrity=next((r for r in rows if r.get('kind')=='guest_integrity' and r.get('cycle')==cycle),None)
        progress=[r for r in rows if r.get('kind')=='guest_stream_progress' and free and integrity and free['hostElapsedSeconds']+.25<r['hostElapsedSeconds']<integrity['hostElapsedSeconds']-.25]
        directions=sorted({r['direction'] for r in progress});windows.append({'cycle':cycle,'directions':directions,'progressReceipts':len(progress)})
        if set(directions)!={'guest-to-host','host-to-guest'}:errors.append('both stream directions absent in free window '+str(cycle))
    if not oracle.get('threadJoined') or oracle.get('error') or not oracle.get('receiveOraclePassed') or not oracle.get('peerEOF'):errors.append('raw capture/oracle incomplete')
    if oracle.get('wouldBlockWrites',0)==0:errors.append('actual host nonblocking backpressure absent')
    if not completion.get('guest-to-host',{}).get('waits'):errors.append('guest TX readiness stall absent')
    return {'streamChecksPassed':not errors,'errors':errors,'freedWindows':windows,'guestCompletion':completion,'streamFrozenPinObservations':len(frozen),'activeReturnVerified':False,'blockedSyscallVerified':False,'authenticatedProtocolImplemented':False}
