"""Stream-only capture revision: startup/cancellation cleanup; frozen RAW capture remains unchanged."""
from dataclasses import dataclass
import json,queue,subprocess,threading,time

@dataclass(frozen=True)
class Limits:
    channel_bytes:int=32*1024*1024
    total_bytes:int=48*1024*1024
    line_bytes:int=64*1024
    parsed_rows:int=80000
    queue_items:int=64
    chunk_bytes:int=16*1024
    run_seconds:float=130
    normal_wait_seconds:float=2
    kill_wait_seconds:float=3
    reader_join_seconds:float=.2

def finish_owned_child(child,limits,kill_now=False):
    code=None;killed=False;error=None
    if not kill_now:
        try:code=child.wait(timeout=limits.normal_wait_seconds)
        except subprocess.TimeoutExpired:kill_now=True
        except BaseException as exc:error=type(exc).__name__;kill_now=True
    if kill_now:
        try:child.kill();killed=True
        except BaseException as exc:error=type(exc).__name__
        try:code=child.wait(timeout=limits.kill_wait_seconds)
        except BaseException as exc:error=type(exc).__name__
    verified=code is not None
    return {'exitCode':code,'exitVerified':verified,'terminationUncertain':not verified,'ownedChildReaped':verified,'killIssued':killed,'terminationError':error}

def capture_owned_child(child,directory,limits=Limits(),thread_factory=threading.Thread):
    start=time.monotonic();pending=queue.Queue(maxsize=limits.queue_items);stop=threading.Event();rows=[]
    totals={'stdout':0,'stderr':0};buffers={'stdout':bytearray(),'stderr':bytearray()};closed=set();error=None;overflow=False;timed_out=False;interrupted=False
    def put(item):
        while not stop.is_set():
            try:pending.put(item,timeout=.05);return
            except queue.Full:pass
    def reader(stream,channel):
        try:
            while not stop.is_set():
                chunk=stream.read(limits.chunk_bytes)
                if not chunk:break
                put((channel,chunk))
        except (OSError,ValueError):put((channel,'reader_error'))
        finally:put((channel,None))
    threads=[thread_factory(target=reader,args=(stream,channel),daemon=True) for stream,channel in [(child.stdout,'stdout'),(child.stderr,'stderr')]]
    def line(raw,channel):
        nonlocal error,overflow
        if len(raw)>limits.line_bytes:error='line byte cap';overflow=True;return
        try:
            text=raw.decode('utf-8');payload=text[text.index('{'):] if text.startswith('[') and '{' in text else text
            row=json.loads(payload)
            if not isinstance(row,dict):return
        except (ValueError,UnicodeDecodeError,RecursionError):return
        if len(rows)>=limits.parsed_rows:error='parsed row cap';overflow=True;return
        row.update(channel=channel,hostElapsedSeconds=round(time.monotonic()-start,6));rows.append(row)
    termination=None
    try:
        for thread in threads:thread.start()
        with (directory/'stdout.log').open('wb') as stdout,(directory/'stderr.log').open('wb') as stderr:
            sinks={'stdout':stdout,'stderr':stderr}
            while len(closed)<2 and error is None:
                if time.monotonic()-start>=limits.run_seconds:timed_out=True;error='capture timeout';break
                try:channel,chunk=pending.get(timeout=min(.1,max(.001,limits.run_seconds-(time.monotonic()-start))))
                except queue.Empty:continue
                if chunk is None:
                    if buffers[channel]:line(bytes(buffers[channel]),channel);buffers[channel].clear()
                    closed.add(channel);continue
                if chunk=='reader_error':error='pipe reader error';break
                if totals[channel]+len(chunk)>limits.channel_bytes or sum(totals.values())+len(chunk)>limits.total_bytes:error='channel/total byte cap';overflow=True;break
                totals[channel]+=len(chunk);sinks[channel].write(chunk)
                # At most one bounded chunk is appended beyond the current partial-line cap.
                buffers[channel].extend(chunk)
                while b'\n' in buffers[channel] and error is None:
                    offset=buffers[channel].index(10)+1;raw=bytes(buffers[channel][:offset]);del buffers[channel][:offset];line(raw,channel)
                if len(buffers[channel])>limits.line_bytes:error='newline-free line byte cap';overflow=True
            termination=finish_owned_child(child,limits,kill_now=error is not None)
    except BaseException as exc:
        error=type(exc).__name__;interrupted=isinstance(exc,(KeyboardInterrupt,SystemExit));termination=finish_owned_child(child,limits,kill_now=True)
    finally:
        stop.set()
        if termination is None:termination=finish_owned_child(child,limits,kill_now=True)
        # Blocking readers are daemon threads. Each finite join is recorded; no unbounded close/wait.
        for thread in threads:
            if thread.ident is not None:
                try:thread.join(timeout=limits.reader_join_seconds)
                except BaseException as exc:error=type(exc).__name__
    return rows,{**termination,'timedOut':timed_out,'captureError':error,'interrupted':interrupted,'captureOverflow':overflow,'captureComplete':len(closed)==2 and error is None,'readerThreadsJoined':all(t.ident is None or not t.is_alive() for t in threads),'readerThreadsStarted':sum(t.ident is not None for t in threads),'channelBytes':totals,'totalBytes':sum(totals.values()),'parsedRows':len(rows),'limits':vars(limits)}
