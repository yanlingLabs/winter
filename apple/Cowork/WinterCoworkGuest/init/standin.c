/* See standin.h. No I/O in this file. */
#include "standin.h"

#include <string.h>

static void note(struct wg_standin *s, const char *code) { s->ops->log(s->ops->ctx, code); }

static void fail(struct wg_standin *s, const char *code) {
    if (s->listener_fd >= 3) s->ops->close_fd(s->ops->ctx, s->listener_fd);
    s->listener_fd = -1;
    s->state = WG_SI_FAILED;
    note(s, code);
}

void wg_standin_init(struct wg_standin *s, const struct wg_standin_ops *ops) {
    memset(s, 0, sizeof *s);
    s->ops = ops;
    s->state = WG_SI_NONE;
    s->listener_fd = -1;
}

int wg_standin_note_set(struct wg_standin *s, const struct wg_conversation_set *set) {
    s->items_length = 0;   /* nothing is kept unless every check below passes */
    if (set->profile != 1 || set->count != 1 || set->json_length < 2 || set->json_length > WG_STANDIN_ITEMS_MAX) return -1;
    size_t sid_length = strlen(set->session_id[0]);   /* the array holds at most WG_SESSION_ID_MAX characters and a NUL */
    if (sid_length < 1) return -1;
    memcpy(s->session_id, set->session_id[0], sid_length + 1);
    s->runtime_uid = set->runtime_uid[0];
    memcpy(s->items, set->json, set->json_length);
    s->items[set->json_length] = '\0';
    s->items_length = set->json_length;
    return 0;
}

void wg_standin_supervisor_ready(struct wg_standin *s) {
    if (s->state != WG_SI_NONE) return;
    if (s->items_length == 0) { s->state = WG_SI_FAILED; note(s, "standin-unsupported-set"); return; }
    if (s->ops->prepare(s->ops->ctx, s->session_id, s->runtime_uid, s->items, s->items_length) != 0) { fail(s, "standin-prepare-failed"); return; }
    int listener = s->ops->bind_listener(s->ops->ctx, s->session_id, s->runtime_uid);
    if (listener < 3) { fail(s, "standin-listener-failed"); return; }
    s->listener_fd = listener;
    s->deadline_ms = s->ops->now_ms(s->ops->ctx) + WG_STANDIN_LOCATE_MS;
    s->state = WG_SI_LISTENING;
    note(s, "standin-listening");
}

void wg_standin_tick(struct wg_standin *s) {
    if (s->state != WG_SI_LISTENING) return;
    int pidfd = s->ops->find_runtime(s->ops->ctx, s->runtime_uid);
    if (pidfd < 0) { fail(s, "standin-runtime-refused"); return; }
    if (pidfd == 0) {
        if (s->ops->now_ms(s->ops->ctx) >= s->deadline_ms) fail(s, "standin-runtime-not-found");
        return;
    }
    long worker = 0;
    int started = s->ops->start_worker(s->ops->ctx, s->session_id, s->runtime_uid, s->listener_fd, pidfd, &worker);
    s->ops->close_fd(s->ops->ctx, pidfd);          /* PID 1 keeps no copy of the runtime's pidfd either way */
    if (started != 0) { fail(s, "standin-worker-failed"); return; }
    s->ops->close_fd(s->ops->ctx, s->listener_fd); /* the worker holds the listener now; the socket file stays */
    s->listener_fd = -1;
    s->worker = worker;
    s->state = WG_SI_RUNNING;
    note(s, "standin-worker-started");
}

void wg_standin_child_exited(struct wg_standin *s, long pid) {
    if (s->state != WG_SI_RUNNING || pid != s->worker) return;
    s->worker = 0;
    s->state = WG_SI_FAILED;   /* never restarted: a restart would reset the two-answer budget */
    note(s, "standin-worker-exited");
}

void wg_standin_stop(struct wg_standin *s) {
    if (s->state == WG_SI_RUNNING) s->ops->stop_worker(s->ops->ctx, s->worker);   /* a second stop finds STOPPED and does nothing */
    if (s->listener_fd >= 3) s->ops->close_fd(s->ops->ctx, s->listener_fd);
    s->listener_fd = -1;
    s->worker = 0;
    s->state = WG_SI_STOPPED;
}

int wg_standin_poll_hint(const struct wg_standin *s) { return s->state == WG_SI_LISTENING ? (int)WG_STANDIN_TICK_MS : -1; }
