#define NAPI_VERSION 8
#include <node_api.h>
#include <pthread.h>
#include <poll.h>
#include <stdatomic.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#ifndef WINTER_HOST_OUTPUT_SOURCE_SHA256
#error Build through the pinned output-only packaging recipe
#endif
static napi_value fail(napi_env env,const char *code,const char *message){napi_throw_error(env,code,message);return NULL;}
#include "fd_creation.c"
#include "output_transport.c"
static napi_value initialize(napi_env env,napi_value exports){
  // Pin atfork callbacks while the verified loading FD remains open. No event
  // thread/pipe is created until a host requests an output transport.
  pthread_once(&native_fd_creation_once,native_fd_creation_initialize);
  if(!native_fd_creation_ready)return fail(env,"output_transport_unavailable","Native descriptor creation guard unavailable");
  output_initialize(env,exports);
  napi_value version,identity,source;
  if(napi_create_uint32(env,1,&version)!=napi_ok || napi_create_string_utf8(env,"winter-host-output/v1",NAPI_AUTO_LENGTH,&identity)!=napi_ok ||
     napi_create_string_utf8(env,WINTER_HOST_OUTPUT_SOURCE_SHA256,NAPI_AUTO_LENGTH,&source)!=napi_ok)return NULL;
  napi_property_descriptor fields[]={
    {"protocolVersion",NULL,NULL,NULL,NULL,version,napi_enumerable,NULL},
    {"implementationId",NULL,NULL,NULL,NULL,identity,napi_enumerable,NULL},
    {"sourceSha256",NULL,NULL,NULL,NULL,source,napi_enumerable,NULL}
  };
  return napi_define_properties(env,exports,3,fields)==napi_ok?exports:NULL;
}
NAPI_MODULE(winter_host_output,initialize)
