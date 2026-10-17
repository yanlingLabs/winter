/*
 * Private in-guest message framing between PID 1, the relay and the bootstrap helper (N2 slice S5).
 *
 * These links are PIPES, never AF_UNIX sockets: a pipe cannot carry SCM_RIGHTS, so the "plain read installs descriptors"
 * hazard of the host links cannot exist here, and no receiver needs a control buffer. Messages are length prefixed because a
 * pipe has no record boundaries:
 *
 *    0 1 tag    1 3 zero    4 4 payload length (little endian)    8 .. payload
 *
 * A non-zero reserved byte, a tag the receiver did not list, or a length above the receiver's ceiling ends the link.
 * Portable C11; the native macOS tests compile it as is.
 */
#ifndef WG_CTL_H
#define WG_CTL_H

#include <stddef.h>
#include <stdint.h>

#define CTL_HEADER_BYTES 8u
#define CTL_MAX_PAYLOAD 65536u

/* relay -> init */
#define CTL_BOOTSTRAP_DOWN 'P' /* one bootstrap-class payload from the host, byte for byte (at most WMX_GUEST_MAX_BOOTSTRAP_DOWN) */
#define CTL_DRAIN 'D'          /* 32 hex nonce chars, u32 budgetMs (LE), u8 origin (0 host-stop, 1 owner-loss): 37 bytes */
#define CTL_RELAY_FATAL 'F'    /* one byte: the wmx_status of the violation that ended the stream */
#define CTL_FLUSHED 'f'        /* the halting frame has been consumed by the host (empty payload) */
/* init -> relay */
#define CTL_BOOTSTRAP_UP 'U'   /* one bootstrap-class payload to frame and send */
#define CTL_DRAIN_ACK 'K'      /* 32 hex nonce chars */
#define CTL_HALTING 'H'        /* 32 hex nonce chars */
#define CTL_RUNTIME_GO 'G'     /* empty: the runtime FIFOs have a consumer, runtime frames are now admitted */
/* bootstrap helper -> init */
#define CTL_HELPER_UP 'B'      /* a bootstrap-class payload for the host */
#define CTL_HELPER_REPLAY 'Q'  /* "data" or "environment": replay this volume's journal by a kernel mount */
#define CTL_HELPER_MOUNT 'M'   /* 36 char data UUID, 36 char environment UUID: mount both now */
#define CTL_HELPER_DONE 'E'    /* empty: the exchange finished, exit follows */
/* init -> bootstrap helper */
#define CTL_HELPER_DOWN 'b'    /* a bootstrap-class payload from the host */
#define CTL_REPLAY_RESULT 'q'  /* one byte, 1 = the replay mounted, flushed and unmounted cleanly */
#define CTL_MOUNT_RESULT 'm'   /* one byte, 1 = both filesystems are mounted */

#define CTL_DRAIN_PAYLOAD_BYTES 37u

size_t ctl_encode(uint8_t *out, size_t capacity, uint8_t tag, const void *payload, size_t length);

struct ctl_reader {
    uint8_t header[CTL_HEADER_BYTES];
    size_t have;
    int in_payload;
    int dead;
    uint8_t tag;
    uint32_t length;
    uint8_t *payload;
    size_t capacity;
    const char *allowed; /* the tags this end accepts */
};
void ctl_reader_init(struct ctl_reader *reader, uint8_t *payload_buffer, size_t capacity, const char *allowed_tags);
enum ctl_event { CTL_NEED_MORE = 0, CTL_MESSAGE = 1, CTL_BAD = 2 };
/* Same contract as wmx_rx_feed: at most one message per call, a finished message is released by the next call. */
enum ctl_event ctl_reader_feed(struct ctl_reader *reader, const uint8_t *data, size_t length, size_t *consumed);

#endif
