/*
 * The stand-in provider's lifecycle in PID 1 (STAND-IN IMAGE ONLY; compiled into `init-standin`, never into `init`).
 *
 * The stand-in image answers a conversation's model calls with two canned texts, from inside the guest, so the first real Mac Cowork session can run with no provider,
 * no network and no vsock. This module decides WHEN; init/standin_linux.c does the effects. It is written without I/O so every ordering and every refusal is tested
 * with a recording fake (tests/test_standin.c).
 *
 *   NONE       nothing yet.
 *   LISTENING  the supervisor is ready; the conversation's metadata is written and its listening socket exists at <control dir>/<sid>/provider.sock. A connection from
 *              the runtime would queue there. PID 1 now waits for the runtime process to appear.
 *   RUNNING    the runtime process was found, its pidfd was given to the provider worker, and the worker was started. The worker is NEVER restarted: a restart would
 *              hand the runtime two more canned answers, and the stand-in's contract is exactly two per conversation.
 *   FAILED     anything went wrong. Every failure leaves the guest running and the provider absent, so a model call fails at the socket: it never reaches anything else.
 *   STOPPED    the drain began.
 *
 * Exactly one conversation of the host-query-v1 profile is served; any other set is left unserved (FAILED, "standin-unsupported-set").
 * Portable C11.
 */
#ifndef WG_STANDIN_H
#define WG_STANDIN_H

#include <stddef.h>
#include <stdint.h>

#include "boot.h"

#define WG_STANDIN_LOCATE_MS 180000   /* how long the runtime may take to appear after the supervisor is ready */
#define WG_STANDIN_TICK_MS 50
#define WG_STANDIN_ITEMS_MAX 65536u

struct wg_standin_ops {
    void *ctx;
    long long (*now_ms)(void *ctx);
    void (*log)(void *ctx, const char *code);
    /* write the items JSON (root, 0400) and run the prepare script for this conversation; 0 = metadata.json exists */
    int (*prepare)(void *ctx, const char *session_id, uint32_t runtime_uid, const char *items, size_t items_length);
    /* the listening socket in the conversation's control directory; a descriptor >= 3, or -1 */
    int (*bind_listener)(void *ctx, const char *session_id, uint32_t runtime_uid);
    /* the runtime process of this uid: a pidfd >= 3; 0 = not there yet; -1 = refused (more than one candidate, or it changed while it was checked) */
    int (*find_runtime)(void *ctx, uint32_t runtime_uid);
    /* start the provider worker with the listener and the pidfd; 0 = started (and the pidfd was delivered); *worker is its process id */
    int (*start_worker)(void *ctx, const char *session_id, uint32_t runtime_uid, int listener_fd, int pidfd, long *worker);
    void (*stop_worker)(void *ctx, long worker);
    void (*close_fd)(void *ctx, int fd);
};

enum wg_standin_state { WG_SI_NONE = 0, WG_SI_LISTENING, WG_SI_RUNNING, WG_SI_FAILED, WG_SI_STOPPED };

struct wg_standin {
    const struct wg_standin_ops *ops;
    enum wg_standin_state state;
    char session_id[WG_SESSION_ID_MAX + 1];
    uint32_t runtime_uid;
    char items[WG_STANDIN_ITEMS_MAX + 1];
    size_t items_length;
    int listener_fd;
    long long deadline_ms;
    long worker;
};

void wg_standin_init(struct wg_standin *s, const struct wg_standin_ops *ops);
/* Called with the set before the supervisor starts: copies what is needed later (the set's memory does not outlive the call). 0 = kept. */
int wg_standin_note_set(struct wg_standin *s, const struct wg_conversation_set *set);
/* The supervisor printed its ready line. */
void wg_standin_supervisor_ready(struct wg_standin *s);
/* Advance a waiting conversation; cheap when nothing waits. */
void wg_standin_tick(struct wg_standin *s);
/* A child that PID 1 did not start itself exited. */
void wg_standin_child_exited(struct wg_standin *s, long pid);
/* The drain began, or the supervisor is about to be stopped. Idempotent. */
void wg_standin_stop(struct wg_standin *s);
/* poll() timeout hint in ms: WG_STANDIN_TICK_MS while a conversation waits, -1 otherwise */
int wg_standin_poll_hint(const struct wg_standin *s);

#endif
