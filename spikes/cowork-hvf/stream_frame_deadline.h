#ifndef COWORK_STREAM_FRAME_DEADLINE_H
#define COWORK_STREAM_FRAME_DEADLINE_H
#include <time.h>
/* Absolute CLOCK_MONOTONIC comparison. Equality expires; nanoseconds are significant. */
static inline int stream_frame_expired(struct timespec now,struct timespec deadline) {
    return now.tv_sec>deadline.tv_sec || (now.tv_sec==deadline.tv_sec && now.tv_nsec>=deadline.tv_nsec);
}
#endif
