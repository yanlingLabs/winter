// Host-only SDK output transport. Included by adapter.c so both development and
// protected package builds compile the same immutable implementation.
#include <errno.h>

#define OUTPUT_CONTEXT_LIMIT 128
#define OUTPUT_CHUNK_LIMIT 65536

typedef struct output_engine output_engine;
typedef struct output_context output_context;
typedef struct { int stream; int error; size_t length; uint8_t bytes[]; } output_event;
struct output_context {
  output_engine *engine;
  atomic_uint owners;
  int readers[2], writers[2];
  bool started, ready, paused, disposed, complete, pending[2], eof[2];
  bool listed, tsfn_released;
  int read_error;
  output_event *terminal_event;
  uint64_t pending_bytes, peak_bytes, read_calls;
  napi_env env;
  napi_threadsafe_function callback;
  napi_deferred done;
  napi_ref self, sinks[2];
};
struct output_engine {
  napi_env env;
  atomic_uint owners;
  pthread_mutex_t lock;
  pthread_t thread;
  bool closing;
  int wake[2];
  output_context *contexts[OUTPUT_CONTEXT_LIMIT];
  size_t count;
};
static void output_engine_release(output_engine *engine) {
  if (atomic_fetch_sub(&engine->owners, 1) == 1) { pthread_mutex_destroy(&engine->lock); free(engine); }
}
static void output_retain(output_context *ctx) { atomic_fetch_add(&ctx->owners, 1); }
static void output_release(output_context *ctx) {
  if (atomic_fetch_sub(&ctx->owners, 1) == 1) { free(ctx->terminal_event); output_engine_release(ctx->engine); free(ctx); }
}
static void output_wake(output_engine *engine) {
  if (!engine->closing && engine->wake[1]>=0) { uint8_t byte=1; (void)write(engine->wake[1],&byte,1); }
}
static void output_close_fd(int *fd) { if (*fd>=0) { close(*fd); *fd=-1; } }
static void output_remove(output_context *ctx) {
  output_engine *engine=ctx->engine;
  if (!ctx->listed) return;
  for (size_t i=0;i<engine->count;i++) if (engine->contexts[i]==ctx) { engine->contexts[i]=engine->contexts[--engine->count]; break; }
  ctx->listed=false;
  output_release(ctx); // Reactor registration owner, under engine lock.
}
static void output_dispose_locked(output_context *ctx, bool reject) {
  if (ctx->disposed) return;
  ctx->disposed=true;
  for (int i=0;i<2;i++) { output_close_fd(&ctx->readers[i]); output_close_fd(&ctx->writers[i]); }
  (void)reject; // Deferred rejection happens on JS after releasing the lock.
  output_remove(ctx);
  output_wake(ctx->engine);
}
static void output_release_tsfn(output_context *ctx,napi_threadsafe_function_release_mode mode) {
  pthread_mutex_lock(&ctx->engine->lock);
  bool release=ctx->started && !ctx->tsfn_released && (ctx->disposed || ctx->complete);
  if(ctx->disposed)mode=napi_tsfn_abort;
  if(release)ctx->tsfn_released=true;
  napi_threadsafe_function callback=ctx->callback;
  pthread_mutex_unlock(&ctx->engine->lock);
  // Finalization/GC may reenter; no engine lock or later ctx access is held.
  if(release)napi_release_threadsafe_function(callback,mode);
}
static void output_reject_disposed(output_context *ctx) {
  if(ctx->done){napi_deferred done=ctx->done;ctx->done=NULL;napi_value message,error;napi_create_string_utf8(ctx->env,"Native output transport disposed",NAPI_AUTO_LENGTH,&message);napi_create_error(ctx->env,NULL,message,&error);napi_reject_deferred(ctx->env,done,error);}
}
static void output_tsfn_finalized(napi_env env,void *data,void *hint) {
  (void)hint; output_context *ctx=data;
  if (env) {
    // A failed terminal enqueue aborts the TSFN without a call_js receipt.
    // Finalization is the last live-JS owner and must settle its promise.
    output_reject_disposed(ctx);
    for (int i=0;i<2;i++) if (ctx->sinks[i]) { napi_delete_reference(env,ctx->sinks[i]); ctx->sinks[i]=NULL; }
    if (ctx->self) { napi_delete_reference(env,ctx->self); ctx->self=NULL; }
  }
  output_release(ctx); // TSFN owner; protects reentrant wrapper finalization.
}
static void output_call_js(napi_env env,napi_value callback,void *data,void *event_data) {
  (void)callback; output_context *ctx=data; output_event *event=event_data;
  output_engine *engine=ctx->engine;
  pthread_mutex_lock(&engine->lock); bool deliver=env && !ctx->disposed; pthread_mutex_unlock(&engine->lock);
  bool finish=false,abort=false;
  if (deliver && event->stream>=0) {
    napi_value sink,global,buffer,ignored;
    napi_status status=napi_get_reference_value(env,ctx->sinks[event->stream],&sink);
    if (status==napi_ok) status=napi_create_buffer_copy(env,event->length,event->bytes,NULL,&buffer);
    if (status==napi_ok) status=napi_get_global(env,&global);
    if (status==napi_ok) status=napi_call_function(env,global,sink,1,&buffer,&ignored);
    if (status!=napi_ok) {
      napi_value error=NULL;
      if (status==napi_pending_exception) napi_get_and_clear_last_exception(env,&error);
      if (!error) { napi_value message; napi_create_string_utf8(env,"Native output callback failed",NAPI_AUTO_LENGTH,&message); napi_create_error(env,NULL,message,&error); }
      if (ctx->done) { napi_deferred done=ctx->done;ctx->done=NULL;napi_reject_deferred(env,done,error); }
      pthread_mutex_lock(&engine->lock); output_dispose_locked(ctx,false); pthread_mutex_unlock(&engine->lock);abort=true;
    }
  } else if (deliver && event->stream<0) {
    if (ctx->done) {
      napi_deferred done=ctx->done;ctx->done=NULL;
      napi_value value;
      if (event->error) { napi_value message; napi_create_string_utf8(env,"Native output read failed",NAPI_AUTO_LENGTH,&message); napi_create_error(env,NULL,message,&value); napi_reject_deferred(env,done,value); }
      else { napi_get_undefined(env,&value); napi_resolve_deferred(env,done,value); }
    }
    finish=true;
  }
  pthread_mutex_lock(&engine->lock);
  if (event->stream>=0) { ctx->pending[event->stream]=false; ctx->pending_bytes-=event->length; }
  output_wake(engine); pthread_mutex_unlock(&engine->lock);
  free(event);
  if(abort)output_release_tsfn(ctx,napi_tsfn_abort);
  else if(finish)output_release_tsfn(ctx,napi_tsfn_release);
}
static bool output_enqueue(output_context *ctx,int stream,const uint8_t *bytes,size_t length,int error) {
  // Compile-time fixture only: the production artifact has no fault switch.
#ifdef WINTER_OUTPUT_FIXTURE_TERMINAL_FAILURE
  if (stream<0) return false;
#endif
  output_event *event=stream<0?ctx->terminal_event:malloc(sizeof(*event)+length);
  if (!event) return false;
  event->stream=stream;event->error=error;event->length=length;if(length)memcpy(event->bytes,bytes,length);
  if (napi_call_threadsafe_function(ctx->callback,event,napi_tsfn_nonblocking)!=napi_ok) { if(stream>=0)free(event); return false; }
  if(stream<0)ctx->terminal_event=NULL;
  return true;
}
static void output_finish_locked(output_context *ctx,int error) {
  if (ctx->disposed || ctx->complete) return;
  if(error && !ctx->read_error)ctx->read_error=error;
  error=ctx->read_error;
  if (ctx->pending[0] || ctx->pending[1]) return;
  if (!error && (!ctx->eof[0] || !ctx->eof[1])) return;
  // One completion follows every delivered byte. EOF is never inferred from
  // process exit or from closing a reader during dispose.
  if (!output_enqueue(ctx,-1,NULL,0,error)) { output_dispose_locked(ctx,false); return; }
  ctx->complete=true;
  for(int i=0;i<2;i++)output_close_fd(&ctx->readers[i]);
  output_remove(ctx);
}
static void *output_reactor(void *data) {
  output_engine *engine=data;
  struct pollfd polls[OUTPUT_CONTEXT_LIMIT*2+1];
  output_context *contexts[OUTPUT_CONTEXT_LIMIT*2]; int streams[OUTPUT_CONTEXT_LIMIT*2];
  uint8_t chunk[OUTPUT_CHUNK_LIMIT];
  while (true) {
    pthread_mutex_lock(&engine->lock);
    if(engine->closing){pthread_mutex_unlock(&engine->lock);break;}
    output_context *finished[OUTPUT_CONTEXT_LIMIT];size_t finished_count=0;
    size_t count=1;polls[0]=(struct pollfd){.fd=engine->wake[0],.events=POLLIN};
    for(size_t i=0;i<engine->count;) {
      output_context *ctx=engine->contexts[i];
      if(ctx->started && ctx->ready) { output_retain(ctx); output_finish_locked(ctx,0);
        if(!ctx->listed){finished[finished_count++]=ctx;continue;} output_release(ctx);
      }
      if(ctx->started && ctx->ready && !ctx->paused && !ctx->disposed && !ctx->complete)for(int stream=0;stream<2;stream++)if(!ctx->pending[stream] && !ctx->eof[stream] && ctx->readers[stream]>=0){
        output_retain(ctx);contexts[count-1]=ctx;streams[count-1]=stream;polls[count++]=(struct pollfd){.fd=ctx->readers[stream],.events=POLLIN};
      }
      i++;
    }
    pthread_mutex_unlock(&engine->lock);
    for(size_t i=0;i<finished_count;i++){output_release_tsfn(finished[i],napi_tsfn_release);output_release(finished[i]);}
    int ready=poll(polls,count,-1);
    pthread_mutex_lock(&engine->lock);
    if(polls[0].revents&POLLIN){uint8_t bytes[64];while(read(engine->wake[0],bytes,sizeof(bytes))>0){}}
    for(size_t i=1;i<count;i++) {
      output_context *ctx=contexts[i-1];int stream=streams[i-1];
      // Recheck ownership/paused state after poll: a disposed FD may already
      // have been reused elsewhere in this process. Never read that alias.
      if(ready>0 && polls[i].revents && !engine->closing && !ctx->disposed && !ctx->paused && !ctx->pending[stream] && ctx->readers[stream]==polls[i].fd){
        ssize_t length=read(ctx->readers[stream],chunk,sizeof(chunk));ctx->read_calls++;
        if(length>0){ctx->pending[stream]=true;ctx->pending_bytes+=(uint64_t)length;if(ctx->pending_bytes>ctx->peak_bytes)ctx->peak_bytes=ctx->pending_bytes;
          if(!output_enqueue(ctx,stream,chunk,(size_t)length,0)){ctx->pending[stream]=false;ctx->pending_bytes-=(uint64_t)length;output_finish_locked(ctx,ENOMEM);}
        } else if(length==0){ctx->eof[stream]=true;output_close_fd(&ctx->readers[stream]);}
        else if(errno!=EAGAIN && errno!=EWOULDBLOCK && errno!=EINTR){ctx->eof[stream]=true;output_close_fd(&ctx->readers[stream]);output_finish_locked(ctx,errno);}
      }
    }
    pthread_mutex_unlock(&engine->lock);
    for(size_t i=1;i<count;i++){output_context *ctx=contexts[i-1];output_release_tsfn(ctx,napi_tsfn_release);output_release(ctx);}
  }
  return NULL;
}
static void output_engine_cleanup(void *data) {
  output_engine *engine=data;
  pthread_mutex_lock(&engine->lock);engine->closing=true;
  output_context *pending[OUTPUT_CONTEXT_LIMIT];size_t total=0;
  while(engine->count){output_context *ctx=engine->contexts[0];output_retain(ctx);pending[total++]=ctx;output_dispose_locked(ctx,false);}
  uint8_t wake=1;(void)write(engine->wake[1],&wake,1);pthread_mutex_unlock(&engine->lock);
  for(size_t i=0;i<total;i++){output_release_tsfn(pending[i],napi_tsfn_abort);output_release(pending[i]);}
  pthread_join(engine->thread,NULL);
  pthread_mutex_lock(&engine->lock);output_close_fd(&engine->wake[0]);output_close_fd(&engine->wake[1]);pthread_mutex_unlock(&engine->lock);
  output_engine_release(engine); // Remaining wrappers/TSFNs own engine memory.
}
static output_engine *output_get_engine(napi_env env) {
  void *data=NULL;if(napi_get_instance_data(env,&data)!=napi_ok)return NULL;if(data)return data;
  output_engine *engine=calloc(1,sizeof(*engine));if(!engine)return NULL;
  engine->env=env;atomic_init(&engine->owners,1);pthread_mutex_init(&engine->lock,NULL);
  if(pipe(engine->wake)!=0){pthread_mutex_destroy(&engine->lock);free(engine);return NULL;}
  for(int i=0;i<2;i++){
    if(fcntl(engine->wake[i],F_SETFL,O_NONBLOCK)||fcntl(engine->wake[i],F_SETFD,FD_CLOEXEC)){close(engine->wake[0]);close(engine->wake[1]);pthread_mutex_destroy(&engine->lock);free(engine);return NULL;}
  }
  if(pthread_create(&engine->thread,NULL,output_reactor,engine)!=0){close(engine->wake[0]);close(engine->wake[1]);pthread_mutex_destroy(&engine->lock);free(engine);return NULL;}
  if(napi_set_instance_data(env,engine,NULL,NULL)!=napi_ok || napi_add_env_cleanup_hook(env,output_engine_cleanup,engine)!=napi_ok){napi_set_instance_data(env,NULL,NULL,NULL);output_engine_cleanup(engine);return NULL;}return engine;
}
static output_context *output_this(napi_env env,napi_callback_info info,napi_value *args,size_t *count,napi_value *self) {
  void *data=NULL;napi_value value;if(napi_get_cb_info(env,info,count,args,&value,NULL)!=napi_ok||napi_unwrap(env,value,&data)!=napi_ok)return NULL;if(self)*self=value;return data;
}
static napi_value output_void(napi_env env){napi_value value;napi_get_undefined(env,&value);return value;}
static napi_value output_pause(napi_env env,napi_callback_info info){size_t count=0;output_context *ctx=output_this(env,info,NULL,&count,NULL);if(!ctx)return fail(env,"output_transport_invalid","Missing native output transport");pthread_mutex_lock(&ctx->engine->lock);ctx->paused=true;output_wake(ctx->engine);pthread_mutex_unlock(&ctx->engine->lock);return output_void(env);}
static napi_value output_resume(napi_env env,napi_callback_info info){size_t count=0;output_context *ctx=output_this(env,info,NULL,&count,NULL);if(!ctx)return fail(env,"output_transport_invalid","Missing native output transport");pthread_mutex_lock(&ctx->engine->lock);ctx->paused=false;output_wake(ctx->engine);pthread_mutex_unlock(&ctx->engine->lock);return output_void(env);}
static napi_value output_close_writers(napi_env env,napi_callback_info info){size_t count=0;output_context *ctx=output_this(env,info,NULL,&count,NULL);if(!ctx)return fail(env,"output_transport_invalid","Missing native output transport");pthread_mutex_lock(&ctx->engine->lock);for(int i=0;i<2;i++)output_close_fd(&ctx->writers[i]);output_wake(ctx->engine);pthread_mutex_unlock(&ctx->engine->lock);return output_void(env);}
static napi_value output_dispose(napi_env env,napi_callback_info info){size_t count=0;output_context *ctx=output_this(env,info,NULL,&count,NULL);if(!ctx)return fail(env,"output_transport_invalid","Missing native output transport");pthread_mutex_lock(&ctx->engine->lock);output_dispose_locked(ctx,true);pthread_mutex_unlock(&ctx->engine->lock);output_reject_disposed(ctx);output_release_tsfn(ctx,napi_tsfn_abort);return output_void(env);}
static napi_value output_start(napi_env env,napi_callback_info info) {
  napi_value args[2],self,promise,name;size_t count=2;output_context *ctx=output_this(env,info,args,&count,&self);
  if(!ctx)return fail(env,"output_transport_invalid","Missing native output transport");
  pthread_mutex_lock(&ctx->engine->lock);bool refused=ctx->disposed||ctx->started||ctx->engine->closing;pthread_mutex_unlock(&ctx->engine->lock);
  if(refused)return fail(env,"output_transport_closed","Output transport is closed or already started");
  for(int i=0;i<2;i++){napi_valuetype type;if(count!=2||napi_typeof(env,args[i],&type)!=napi_ok||type!=napi_function)return fail(env,"invalid_callback","Two output callbacks required");}
  if(napi_create_promise(env,&ctx->done,&promise)!=napi_ok||napi_create_string_utf8(env,"Winter host output readiness",NAPI_AUTO_LENGTH,&name)!=napi_ok)return fail(env,"output_transport_unavailable","Cannot allocate output completion promise");
  if(napi_create_threadsafe_function(env,NULL,NULL,name,3,1,ctx,output_tsfn_finalized,ctx,output_call_js,&ctx->callback)!=napi_ok){ctx->done=NULL;return fail(env,"output_transport_unavailable","Native output readiness callback unavailable");}
  output_retain(ctx); // TSFN context owner.
  pthread_mutex_lock(&ctx->engine->lock);ctx->started=true;pthread_mutex_unlock(&ctx->engine->lock);
  bool references=napi_create_reference(env,self,1,&ctx->self)==napi_ok;
  for(int i=0;i<2;i++)references &= napi_create_reference(env,args[i],1,&ctx->sinks[i])==napi_ok;
  if(!references){pthread_mutex_lock(&ctx->engine->lock);output_dispose_locked(ctx,true);pthread_mutex_unlock(&ctx->engine->lock);output_reject_disposed(ctx);output_release_tsfn(ctx,napi_tsfn_abort);return promise;}
  pthread_mutex_lock(&ctx->engine->lock);ctx->ready=true;output_wake(ctx->engine);pthread_mutex_unlock(&ctx->engine->lock);return promise;
}
static napi_value output_stats(napi_env env,napi_callback_info info) {
  size_t count=0;output_context *ctx=output_this(env,info,NULL,&count,NULL);napi_value result,value;if(!ctx)return NULL;
  pthread_mutex_lock(&ctx->engine->lock);
  uint64_t pending=ctx->pending_bytes,peak=ctx->peak_bytes,reads=ctx->read_calls;size_t shared=ctx->engine->count;bool paused=ctx->paused;
  bool flags=true;
  for(int i=0;i<2;i++){
    if(ctx->readers[i]>=0){int status=fcntl(ctx->readers[i],F_GETFL),descriptor=fcntl(ctx->readers[i],F_GETFD);flags &= status>=0 && descriptor>=0 && (status&O_NONBLOCK)!=0 && (descriptor&FD_CLOEXEC)!=0;}
    if(ctx->writers[i]>=0){int descriptor=fcntl(ctx->writers[i],F_GETFD);flags &= descriptor>=0 && (descriptor&FD_CLOEXEC)!=0;}
  }
  pthread_mutex_unlock(&ctx->engine->lock);napi_create_object(env,&result);
#define OUTPUT_NUMBER(name, number) napi_create_double(env,(double)(number),&value);napi_set_named_property(env,result,name,value)
  OUTPUT_NUMBER("pendingBytes",pending);OUTPUT_NUMBER("peakPendingBytes",peak);OUTPUT_NUMBER("readCalls",reads);OUTPUT_NUMBER("chunkLimit",OUTPUT_CHUNK_LIMIT);OUTPUT_NUMBER("sharedReaders",shared);
#undef OUTPUT_NUMBER
  napi_get_boolean(env,paused,&value);napi_set_named_property(env,result,"paused",value);napi_get_boolean(env,flags,&value);napi_set_named_property(env,result,"flagsVerified",value);return result;
}
static void output_wrapper_finalized(napi_env env,void *data,void *hint){(void)env;(void)hint;output_context *ctx=data;pthread_mutex_lock(&ctx->engine->lock);output_dispose_locked(ctx,false);pthread_mutex_unlock(&ctx->engine->lock);output_release_tsfn(ctx,napi_tsfn_abort);output_release(ctx);}
static napi_value output_create(napi_env env,napi_callback_info info) {
  (void)info;output_engine *engine=output_get_engine(env);if(!engine)return fail(env,"output_transport_unavailable","Cannot create native shared readiness queue");
  pthread_mutex_lock(&engine->lock);bool full=engine->closing||engine->count>=OUTPUT_CONTEXT_LIMIT;pthread_mutex_unlock(&engine->lock);if(full)return fail(env,"output_transport_capacity","Native output transport limit reached");
  output_context *ctx=calloc(1,sizeof(*ctx));if(!ctx)return fail(env,"allocation_failed","Cannot allocate bounded native output transport");ctx->env=env;ctx->engine=engine;atomic_init(&ctx->owners,1);atomic_fetch_add(&engine->owners,1);
  for(int i=0;i<2;i++)ctx->readers[i]=ctx->writers[i]=-1;
  ctx->terminal_event=malloc(sizeof(output_event));if(!ctx->terminal_event)goto failed;
  for(int i=0;i<2;i++){int fds[2];if(pipe(fds)!=0)goto failed;ctx->readers[i]=fds[0];ctx->writers[i]=fds[1];
    if(fcntl(fds[0],F_SETFL,O_NONBLOCK)||fcntl(fds[0],F_SETFD,FD_CLOEXEC)||fcntl(fds[1],F_SETFD,FD_CLOEXEC))goto failed;
    int read_status=fcntl(fds[0],F_GETFL),read_descriptor=fcntl(fds[0],F_GETFD),write_descriptor=fcntl(fds[1],F_GETFD),write_status=fcntl(fds[1],F_GETFL);
    if(read_status<0||read_descriptor<0||write_descriptor<0||write_status<0||(write_status&O_NONBLOCK)||!(read_status&O_NONBLOCK)||!(read_descriptor&FD_CLOEXEC)||!(write_descriptor&FD_CLOEXEC))goto failed;
  }
  napi_value result,out,err;if(napi_create_object(env,&result)!=napi_ok||napi_create_int32(env,ctx->writers[0],&out)!=napi_ok||napi_create_int32(env,ctx->writers[1],&err)!=napi_ok)goto failed;
  napi_property_descriptor methods[]={
    {"stdoutFd",NULL,NULL,NULL,NULL,out,napi_enumerable,NULL},{"stderrFd",NULL,NULL,NULL,NULL,err,napi_enumerable,NULL},
    {"closeWriters",NULL,output_close_writers,NULL,NULL,NULL,napi_default,NULL},{"pause",NULL,output_pause,NULL,NULL,NULL,napi_default,NULL},
    {"resume",NULL,output_resume,NULL,NULL,NULL,napi_default,NULL},{"start",NULL,output_start,NULL,NULL,NULL,napi_default,NULL},
    {"dispose",NULL,output_dispose,NULL,NULL,NULL,napi_default,NULL},{"statistics",NULL,output_stats,NULL,NULL,NULL,napi_default,NULL}
  };
  if(napi_define_properties(env,result,sizeof(methods)/sizeof(methods[0]),methods)!=napi_ok||napi_wrap(env,result,ctx,output_wrapper_finalized,NULL,NULL)!=napi_ok)goto failed;
  pthread_mutex_lock(&engine->lock);ctx->listed=true;output_retain(ctx);engine->contexts[engine->count++]=ctx;output_wake(engine);pthread_mutex_unlock(&engine->lock);return result;
failed:
  for(int i=0;i<2;i++){output_close_fd(&ctx->readers[i]);output_close_fd(&ctx->writers[i]);}output_release(ctx);return fail(env,"output_transport_unavailable","Native pipe creation/descriptor flags failed");
}
static void output_initialize(napi_env env,napi_value exports){napi_property_descriptor method={"createOutputTransport",NULL,output_create,NULL,NULL,NULL,napi_default,NULL};napi_define_properties(env,exports,1,&method);}
