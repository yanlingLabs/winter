#include "fileflow.h"

void wg_fileflow_init(struct wg_fileflow *flow) {
    flow->outstanding = 0;
    flow->request_line = 0;
    flow->response_line = 0;
}

enum wmx_status wg_fileflow_request(struct wg_fileflow *flow, const uint8_t *bytes, size_t length) {
    for (size_t i = 0; i < length; i++) {
        if (++flow->request_line > WG_FILE_REQUEST_BYTES) return WMX_OVERSIZE;
        if (bytes[i] == '\n') {
            if (++flow->outstanding > WG_FILE_IN_FLIGHT) return WMX_OVERSIZE;
            flow->request_line = 0;
        }
    }
    return WMX_OK;
}

enum wmx_status wg_fileflow_response(struct wg_fileflow *flow, const uint8_t *bytes, size_t length) {
    for (size_t i = 0; i < length; i++) {
        if (flow->outstanding == 0) return WMX_BAD_FIELD;
        if (++flow->response_line > WG_FILE_RESPONSE_BYTES) return WMX_OVERSIZE;
        if (bytes[i] == '\n') {
            flow->outstanding--;
            flow->response_line = 0;
        }
    }
    return WMX_OK;
}
