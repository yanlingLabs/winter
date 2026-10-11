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

typedef struct {
  void *library;
  uint32_t (*version)(void);
  void *(*create)(const char *, uint32_t);
  uint64_t (*submit)(void *, const char *, uint32_t);
  int32_t (*event_fd)(void *);
  char *(*poll)(void *);
  void (*string_free)(char *);
  uint64_t (*shutdown)(void *, uint32_t);
  int32_t (*release)(void *);
  int32_t (*can_release)(void *);
} native_api;
typedef struct {
  napi_env env;
  native_api api;
  void *native;
  pthread_t thread;
  napi_threadsafe_function callback;
  napi_ref self;
  bool polling;
  atomic_bool closing;
  bool finalized;
  bool thread_finalized;
  bool close_requested;
  bool js_released;
  bool thread_started;
  atomic_uint pending_callbacks;
  atomic_bool reading;
} controller;

static napi_value fail(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message); return NULL;
}
static char *string_arg(napi_env env, napi_value value, size_t limit, size_t *size) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, NULL, 0, size) != napi_ok || *size > limit) return NULL;
  char *text = malloc(*size + 1);
  if (!text) return NULL;
  if (napi_get_value_string_utf8(env, value, text, *size + 1, size) != napi_ok) { free(text); return NULL; }
  return text;
}
static controller *context(napi_env env, napi_callback_info info, napi_value *args, size_t *count) {
  void *data = NULL; napi_value self;
  if (napi_get_cb_info(env, info, count, args, &self, NULL) != napi_ok || napi_unwrap(env, self, &data) != napi_ok) return NULL;
  return data;
}
static napi_value submit(napi_env env, napi_callback_info info) {
  napi_value args[1], result; size_t count = 1, length = 0;
  controller *ctx = context(env, info, args, &count);
  if (!ctx || atomic_load(&ctx->closing) || !ctx->native) return fail(env, "controller_closed", "Native controller is closed");
  if (count != 1) return fail(env, "invalid_request", "submit accepts one bounded JSON string");
  char *json = string_arg(env, args[0], 65536, &length);
  if (!json) return fail(env, "invalid_request", "submit accepts one bounded JSON string");
  uint64_t id = ctx->api.submit(ctx->native, json, (uint32_t)length); free(json);
  if (!id) return fail(env, "native_backpressure", "Native operation queue is full or input is invalid");
  if (napi_create_bigint_uint64(env, id, &result) != napi_ok) return NULL;
  return result;
}
static napi_value poll_event(napi_env env, napi_callback_info info) {
  size_t count = 0; controller *ctx = context(env, info, NULL, &count); napi_value result;
  if (!ctx || atomic_load(&ctx->closing) || !ctx->native) return fail(env, "controller_closed", "Native controller is closed");
  if (ctx->polling) return fail(env, "event_channel_subscribed", "Manual polling cannot steal events from a subscribed channel");
  char *json = ctx->api.poll(ctx->native);
  if (!json) { napi_get_null(env, &result); return result; }
  napi_status status = napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &result);
  ctx->api.string_free(json);
  return status == napi_ok ? result : NULL;
}
static void call_js(napi_env env, napi_value callback, void *data, void *event_data) {
  controller *ctx = data;
  char *json = event_data;
  if (env && callback && !atomic_load(&ctx->closing)) {
    napi_value global, value, ignored;
    if (napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &value) == napi_ok && napi_get_global(env, &global) == napi_ok)
      (void)napi_call_function(env, global, callback, 1, &value, &ignored);
  }
  ctx->api.string_free(json);
  atomic_fetch_sub(&ctx->pending_callbacks, 1);
}
static void thread_finalized(napi_env env, void *data, void *hint) {
  (void)hint;
  controller *ctx = data;
  if (ctx->thread_started) pthread_join(ctx->thread, NULL);
  ctx->thread_finalized = true;
  if (ctx->close_requested && ctx->native && ctx->api.release(ctx->native) == 1) ctx->native = NULL;
  if (ctx->self && env) { napi_delete_reference(env, ctx->self); ctx->self = NULL; }
  if (ctx->finalized) free(ctx);
}
static void *event_thread(void *data) {
  controller *ctx = data;
  struct pollfd fd = {ctx->api.event_fd(ctx->native), POLLIN, 0};
  while (!atomic_load(&ctx->closing)) {
    int ready = poll(&fd, 1, 1000);
    if (ready <= 0 || !(fd.revents & POLLIN)) continue;
    for (int i = 0; i < 256 && !atomic_load(&ctx->closing); i++) {
      atomic_store(&ctx->reading, true);
      char *json = ctx->api.poll(ctx->native);
      if (json) atomic_fetch_add(&ctx->pending_callbacks, 1);
      atomic_store(&ctx->reading, false);
      if (!json) break;
      // Only this native thread may block on the bounded TSFN queue. No VZ/NIO
      // callback or JavaScript thread waits for JavaScript to drain it.
      if (napi_call_threadsafe_function(ctx->callback, json, napi_tsfn_blocking) != napi_ok) {
        ctx->api.string_free(json); atomic_fetch_sub(&ctx->pending_callbacks, 1); atomic_store(&ctx->closing, true); break;
      }
    }
  }
  napi_release_threadsafe_function(ctx->callback, napi_tsfn_release);
  return NULL;
}
static napi_value subscribe(napi_env env, napi_callback_info info) {
  napi_value args[1], self, name; size_t count = 1; controller *ctx = context(env, info, args, &count);
  if (!ctx || atomic_load(&ctx->closing) || !ctx->native || ctx->polling) return fail(env, "controller_closed", "Controller is closed or already subscribed");
  napi_valuetype type;
  if (count != 1 || napi_typeof(env, args[0], &type) != napi_ok || type != napi_function) return fail(env, "invalid_callback", "subscribe accepts one event callback");
  if (ctx->api.event_fd(ctx->native) < 0) return fail(env, "event_channel_unavailable", "Native wakeup FD is unavailable");
  napi_create_string_utf8(env, "Winter Cowork native events", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, args[0], NULL, name, 64, 2, ctx, thread_finalized, ctx, call_js, &ctx->callback) != napi_ok)
    return fail(env, "event_channel_unavailable", "Node-API thread-safe event delivery is unavailable");
  napi_get_cb_info(env, info, NULL, NULL, &self, NULL);
  napi_create_reference(env, self, 1, &ctx->self);
  ctx->polling = true;
  if (pthread_create(&ctx->thread, NULL, event_thread, ctx) != 0) {
    atomic_store(&ctx->closing, true);
    napi_release_threadsafe_function(ctx->callback, napi_tsfn_abort);
    napi_release_threadsafe_function(ctx->callback, napi_tsfn_release);
    return fail(env, "event_channel_unavailable", "Native event thread cannot start");
  }

  ctx->thread_started = true;
  napi_value result; napi_get_undefined(env, &result); return result;
}
static void cleanup(void *data) {
  controller *ctx = data;
  bool already_closing = atomic_exchange(&ctx->closing, true);
  if (!already_closing && !ctx->close_requested && ctx->native) {
    ctx->api.shutdown(ctx->native, 30000);
    // Fail closed: unresolved controllers stay native-owned. No dlclose occurs.
  }
  if (ctx->polling && !ctx->js_released) { ctx->js_released = true; napi_release_threadsafe_function(ctx->callback, napi_tsfn_abort); }
}
static napi_value close_controller(napi_env env, napi_callback_info info) {
  size_t count = 0; controller *ctx = context(env, info, NULL, &count); napi_value result;
  if (!ctx || atomic_load(&ctx->closing) || !ctx->native) return fail(env, "controller_closed", "Native controller is closed");
  // The caller submits/awaits shutdown and drains terminal events first. Stop
  // the reader before releasing native memory: an in-flight reader owns an fd.
  bool safe = ctx->api.can_release(ctx->native) == 1 && !atomic_load(&ctx->reading) && atomic_load(&ctx->pending_callbacks) == 0;
  if (safe) {
    ctx->close_requested = true;
    if (ctx->polling) napi_unref_threadsafe_function(env, ctx->callback);
    cleanup(ctx);
    if (!ctx->polling && ctx->api.release(ctx->native) == 1) ctx->native = NULL;
    napi_remove_env_cleanup_hook(env, cleanup, ctx);
  }
  napi_get_boolean(env, safe, &result); return result;
}
static void finalize(napi_env env, void *data, void *hint) {
  (void)hint;
  controller *ctx = data;
  napi_remove_env_cleanup_hook(env, cleanup, ctx);
  cleanup(ctx); ctx->finalized = true;
  if (!ctx->polling || ctx->thread_finalized) free(ctx);
}
static napi_value open_controller(napi_env env, napi_callback_info info) {
  napi_value args[2], result; size_t count = 2, path_size = 0, options_size = 0;
  napi_get_cb_info(env, info, &count, args, NULL, NULL);
  if (count != 2) return fail(env, "invalid_registration", "open accepts absolute library path and host controller JSON");
  char *path = string_arg(env, args[0], 4096, &path_size), *options = string_arg(env, args[1], 65536, &options_size);
  if (!path || path[0] != '/' || !options) { free(path); free(options); return fail(env, "invalid_registration", "Absolute library path and bounded host registration JSON required"); }
  controller *ctx = calloc(1, sizeof(controller));
  if (!ctx) { free(path); free(options); return fail(env, "allocation_failed", "Cannot allocate controller adapter"); }
  atomic_init(&ctx->closing, false); atomic_init(&ctx->pending_callbacks, 0); atomic_init(&ctx->reading, false);
  ctx->env = env; ctx->api.library = dlopen(path, RTLD_NOW | RTLD_LOCAL); free(path);
  if (!ctx->api.library) { free(options); free(ctx); return fail(env, "native_load_failed", "Cannot load native controller library"); }
#define LOAD(field, name) ctx->api.field = dlsym(ctx->api.library, name); if (!ctx->api.field) { free(options); free(ctx); return fail(env, "native_abi_mismatch", "Native controller symbol is missing"); }
  LOAD(version, "winter_cowork_native_protocol_version")
  LOAD(create, "winter_cowork_native_create")
  LOAD(submit, "winter_cowork_native_submit")
  LOAD(event_fd, "winter_cowork_native_event_fd")
  LOAD(poll, "winter_cowork_native_poll")
  LOAD(string_free, "winter_cowork_native_string_free")
  LOAD(shutdown, "winter_cowork_native_shutdown")
  LOAD(release, "winter_cowork_native_release")
  LOAD(can_release, "winter_cowork_native_can_release")
#undef LOAD
  if (ctx->api.version() != 1) { free(options); free(ctx); return fail(env, "native_abi_mismatch", "Native protocol version differs"); }
  ctx->native = ctx->api.create(options, (uint32_t)options_size); free(options);
  if (!ctx->native) { free(ctx); return fail(env, "invalid_registration", "Native controller host registration refused"); }
  napi_create_object(env, &result);
  napi_property_descriptor methods[] = {
    {"submit", NULL, submit, NULL, NULL, NULL, napi_default, NULL},
    {"poll", NULL, poll_event, NULL, NULL, NULL, napi_default, NULL},
    {"subscribe", NULL, subscribe, NULL, NULL, NULL, napi_default, NULL},
    {"close", NULL, close_controller, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, result, sizeof(methods)/sizeof(methods[0]), methods);
  napi_wrap(env, result, ctx, finalize, NULL, NULL);
  napi_add_env_cleanup_hook(env, cleanup, ctx);
  return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor method = {"open", NULL, open_controller, NULL, NULL, NULL, napi_default, NULL};
  napi_define_properties(env, exports, 1, &method); return exports;
}
NAPI_MODULE(winter_cowork_native, initialize)
