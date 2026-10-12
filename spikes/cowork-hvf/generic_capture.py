"""Generic fixture capture: separate bounded host-sampler pipe; frozen stream v2 stays unchanged."""
import json,os,queue,select,threading,time
from stream_capture_v2 import Limits,finish_owned_child

def capture_owned_child(child,directory,limits=Limits(),thread_factory=threading.Thread,*,sampler):
    start=time.monotonic();pending=queue.Queue(maxsize=limits.queue_items);stop=threading.Event();rows=[]
    malformed={channel:0 for channel in ['stdout','stderr','sampler']}
    totals={'stdout':0,'stderr':0,'sampler':0};buffers={name:bytearray() for name in totals};closed=set();error=None;overflow=False;timed_out=False;interrupted=False
    def put(item):
        while not stop.is_set():
            try:pending.put(item,timeout=.05);return
            except queue.Full:pass
    def reader(stream,channel):
        try:
            descriptor=stream.fileno();os.set_blocking(descriptor,False)
            while not stop.is_set():
                readable,_,_=select.select([descriptor],[],[],.05)
                if not readable:continue
                try:chunk=os.read(descriptor,limits.chunk_bytes)
                except BlockingIOError:continue
                if not chunk:break
                put((channel,chunk))
        except (OSError,ValueError):put((channel,'reader_error'))
        finally:put((channel,None))
    threads=[thread_factory(target=reader,args=(stream,channel),daemon=True) for stream,channel in [(child.stdout,'stdout'),(child.stderr,'stderr'),(sampler,'sampler')]]
    def line(raw,channel):
        nonlocal error,overflow
        if len(raw)>limits.line_bytes:error='line byte cap';overflow=True;return
        try:
            text=raw.decode('utf-8');payload=text[text.index('{'):] if text.startswith('[') and '{' in text else text
            row=json.loads(payload)
            if not isinstance(row,dict):return
        except (ValueError,UnicodeDecodeError,RecursionError):
            if b'{' in raw:malformed[channel]+=1
            return
        if len(rows)>=limits.parsed_rows:error='parsed row cap';overflow=True;return
        row.update(channel=channel,hostElapsedSeconds=round(time.monotonic()-start,6));rows.append(row)
    termination=None
    try:
        for thread in threads:thread.start()
        with (directory/'stdout.log').open('wb') as stdout,(directory/'stderr.log').open('wb') as stderr,(directory/'sampler.log').open('wb') as sampler_sink:
            sinks={'stdout':stdout,'stderr':stderr,'sampler':sampler_sink}
            while len(closed)<3 and error is None:
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
        # Nonblocking readers poll stop every 50 ms. Each finite join is recorded; no unbounded close/wait.
        for thread in threads:
            if thread.ident is not None:
                try:thread.join(timeout=limits.reader_join_seconds)
                except BaseException as exc:error=type(exc).__name__
    return rows,{**termination,'timedOut':timed_out,'captureError':error,'interrupted':interrupted,'captureOverflow':overflow,'captureComplete':len(closed)==3 and error is None,'readerThreadsJoined':all(t.ident is None or not t.is_alive() for t in threads),'readerThreadsStarted':sum(t.ident is not None for t in threads),'channelBytes':totals,'totalBytes':sum(totals.values()),'parsedRows':len(rows),'malformedJsonLines':malformed,'limits':vars(limits)}
