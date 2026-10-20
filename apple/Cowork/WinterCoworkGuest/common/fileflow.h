/*
 * The guest file channel's own flow rule (contract revision 3, section 6.2; vectors/runtime-flow.json `fileCases`). Portable C11, no I/O.
 *
 * FILE_IN carries request lines down and FILE_OUT carries response lines up, on conversation 0. They have their OWN bound and never touch the runtime IN count:
 *   * at most WG_FILE_IN_FLIGHT request lines are outstanding (a request is answered when a FILE_OUT response line's newline arrives);
 *   * a request line is at most WG_FILE_REQUEST_BYTES with its newline, a response line at most WG_FILE_RESPONSE_BYTES with its newline;
 *   * a response byte with no request outstanding cannot be attributed (BAD_FIELD).
 * Bytes are counted as they arrive, so a line split across frames counts once. A refusal is final: the caller ends the stream.
 * The header is compiled only for an image that declares `file-channel-v1` (WG_FILE_CHANNEL_V1); the relay and the tests include it under that flag.
 */
#ifndef WG_FILEFLOW_H
#define WG_FILEFLOW_H

#include <stddef.h>
#include <stdint.h>

#include "wmx.h"

#define WG_FILE_IN_FLIGHT 4u
#define WG_FILE_REQUEST_BYTES 16384u
#define WG_FILE_RESPONSE_BYTES 393216u

struct wg_fileflow {
    unsigned outstanding;       /* request lines sent whose response line has not ended */
    size_t request_line;        /* bytes of the request line in progress, newline included */
    size_t response_line;       /* bytes of the response line in progress, newline included */
};

void wg_fileflow_init(struct wg_fileflow *flow);
/* FILE_IN bytes arriving from the host. WMX_OK, or WMX_OVERSIZE (a fifth outstanding request, or a line over the limit). On a refusal the state is unspecified. */
enum wmx_status wg_fileflow_request(struct wg_fileflow *flow, const uint8_t *bytes, size_t length);
/* FILE_OUT bytes leaving for the host. WMX_OK, WMX_BAD_FIELD (a byte with no request outstanding) or WMX_OVERSIZE (a line over the limit). */
enum wmx_status wg_fileflow_response(struct wg_fileflow *flow, const uint8_t *bytes, size_t length);

#endif
