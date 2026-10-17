#include "Envelope.h"

#include "Rights.h"

#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>

const char *cw_error_name(int code) {
    switch (code) {
    case CW_OK: return "ok";
    case CW_E_MALFORMED: return "malformed";
    case CW_E_OVERSIZE: return "oversize";
    case CW_E_VERSION: return "version";
    case CW_E_UNKNOWN_TYPE: return "unknown_type";
    case CW_E_BAD_FIELD: return "bad_field";
    case CW_E_BAD_DIRECTION: return "bad_direction";
    case CW_E_BAD_RIGHTS: return "bad_rights";
    case CW_E_RESERVED_CLASS: return "reserved_class";
    case CW_E_BAD_SEQUENCE: return "bad_sequence";
    case CW_E_EOF: return "eof";
    case CW_E_IO: return "io";
    case CW_E_CTRUNC: return "ctrunc";
    default: return "unknown";
    }
}

/* ---- little-endian helpers --------------------------------------------------------------------------------------------- */

static uint16_t le16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t le32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint64_t le64(const uint8_t *p) { return (uint64_t)le32(p) | ((uint64_t)le32(p + 4) << 32); }
static void put32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
static void put64(uint8_t *p, uint64_t v) { put32(p, (uint32_t)v); put32(p + 4, (uint32_t)(v >> 32)); }

void cw_scope_payload_digest(const uint8_t payload[CW_ENV_SCOPE_BYTES], uint8_t out[32]) {
    CC_SHA256(payload, (CC_LONG)CW_ENV_SCOPE_BYTES, out);
}

/* ---- field validators -------------------------------------------------------------------------------------------------- */

static bool is_alnum(char c) { return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }

bool cw_valid_token(const char *text) {
    if (text == NULL || !is_alnum(text[0])) return false;
    size_t length = 1;
    for (; text[length] != 0; length++) {
        char c = text[length];
        if (!(is_alnum(c) || c == '_' || c == '-')) return false;
        if (length >= 63) return false; /* the 64th character would leave no NUL in the field */
    }
    return length <= 63;
}

/* A name that fills its field (no NUL), is empty, has a non-zero byte after its NUL, or is not a token is refused. */
static bool read_name(const uint8_t *field, char out[CW_ENV_NAME_FIELD]) {
    const uint8_t *nul = memchr(field, 0, CW_ENV_NAME_FIELD);
    if (nul == NULL || nul == field) return false;
    size_t length = (size_t)(nul - field);
    for (size_t i = length; i < CW_ENV_NAME_FIELD; i++) if (field[i] != 0) return false;
    memcpy(out, field, length);
    out[length] = 0;
    return cw_valid_token(out);
}

static bool write_name(uint8_t *field, const char *text) {
    if (!cw_valid_token(text)) return false;
    memset(field, 0, CW_ENV_NAME_FIELD);
    memcpy(field, text, strlen(text));
    return true;
}

static bool volume_ok(const cw_volume_identity *v) {
    if (v->capacity_bytes > CW_MAX_SAFE_INTEGER) return false;
    if (v->mode != CW_VOLUME_MODE) return false;
    if (v->capacity_bytes < CW_VOLUME_MIN_BYTES || v->capacity_bytes > CW_VOLUME_MAX_BYTES) return false;
    return v->capacity_bytes % CW_VOLUME_ALIGN == 0;
}
/* The same-pair alias refusal of the fixture handoff: one file may never back both disks. */
static bool distinct_files(const cw_volume_identity *a, const cw_volume_identity *b) {
    return !(a->device == b->device && a->inode == b->inode);
}
static bool scope_ok(const cw_scope *s) {
    return s->lease_epoch >= 1 && s->lease_epoch <= 0xffffffffull && s->vcpus == CW_VCPUS
        && s->memory_mib >= CW_SCOPE_MIN_MEMORY_MIB && s->memory_mib <= CW_SCOPE_MAX_MEMORY_MIB;
}

/* ---- payload codecs ---------------------------------------------------------------------------------------------------- */

static bool decode_scope(const uint8_t *p, cw_scope *s) {
    memset(s, 0, sizeof *s);
    for (size_t i = 368; i < CW_ENV_SCOPE_BYTES; i++) if (p[i] != 0) return false;
    if (!read_name(p + 0, s->workspace_id) || !read_name(p + 64, s->incarnation_id)
        || !read_name(p + 128, s->controller_instance_id) || !read_name(p + 192, s->worker_instance_id)
        || !read_name(p + 256, s->admission_id)) return false;
    memcpy(s->runtime_image_digest, p + 320, 32);
    s->lease_epoch = le64(p + 352);
    s->vcpus = le32(p + 360);
    s->memory_mib = le32(p + 364);
    if (!scope_ok(s)) return false;
    cw_scope_payload_digest(p, s->digest);
    return true;
}
static bool encode_scope(const cw_scope *s, uint8_t *p) {
    if (!scope_ok(s)) return false;
    memset(p, 0, CW_ENV_SCOPE_BYTES);
    if (!write_name(p + 0, s->workspace_id) || !write_name(p + 64, s->incarnation_id)
        || !write_name(p + 128, s->controller_instance_id) || !write_name(p + 192, s->worker_instance_id)
        || !write_name(p + 256, s->admission_id)) return false;
    memcpy(p + 320, s->runtime_image_digest, 32);
    put64(p + 352, s->lease_epoch);
    put32(p + 360, s->vcpus);
    put32(p + 364, s->memory_mib);
    return true;
}

static void read_volume(const uint8_t *p, cw_volume_identity *v) {
    v->device = le64(p);
    v->inode = le64(p + 8);
    v->capacity_bytes = le64(p + 16);
    v->uid = le32(p + 24);
    v->mode = le32(p + 28);
}
static void write_volume(uint8_t *p, const cw_volume_identity *v) {
    put64(p, v->device);
    put64(p + 8, v->inode);
    put64(p + 16, v->capacity_bytes);
    put32(p + 24, v->uid);
    put32(p + 28, v->mode);
}

static bool decode_volumes(const uint8_t *p, cw_volumes *v) {
    memset(v, 0, sizeof *v);
    if (le32(p) != 1 || le32(p + 4) != 0) return false;
    memcpy(v->scope_digest, p + 8, 32);
    read_volume(p + 40, &v->data);
    read_volume(p + 72, &v->environment);
    return volume_ok(&v->data) && volume_ok(&v->environment) && distinct_files(&v->data, &v->environment);
}
static bool encode_volumes(const cw_volumes *v, uint8_t *p) {
    if (!volume_ok(&v->data) || !volume_ok(&v->environment) || !distinct_files(&v->data, &v->environment)) return false;
    memset(p, 0, CW_ENV_VOLUMES_BYTES);
    put32(p, 1);
    memcpy(p + 8, v->scope_digest, 32);
    write_volume(p + 40, &v->data);
    write_volume(p + 72, &v->environment);
    return true;
}

static bool drain_ok(const cw_drain *d) {
    return (d->origin == CW_ORIGIN_HOST_STOP || d->origin == CW_ORIGIN_OWNER_LOSS) && d->budget_ms <= CW_DRAIN_BUDGET_CEILING_MS;
}
static bool decode_drain(const uint8_t *p, cw_drain *d) {
    memset(d, 0, sizeof *d);
    memcpy(d->stop_nonce, p, 16);
    d->budget_ms = le32(p + 16);
    d->origin = le32(p + 20);
    if (le32(p + 24) != 0) return false;
    return drain_ok(d);
}
static bool encode_drain(const cw_drain *d, uint8_t *p) {
    if (!drain_ok(d)) return false;
    memset(p, 0, CW_ENV_DRAIN_BYTES);
    memcpy(p, d->stop_nonce, 16);
    put32(p + 16, d->budget_ms);
    put32(p + 20, d->origin);
    return true;
}

static bool status_ok(const cw_status *s) {
    if (s->state < CW_STATUS_SANDBOXED || s->state > CW_STATUS_GUEST_FAULT) return false;
    for (int i = 0; i < 2; i++) if (s->requested[i] > CW_MAX_SAFE_INTEGER || s->completed[i] > CW_MAX_SAFE_INTEGER) return false;
    return true;
}
static bool decode_status(const uint8_t *p, cw_status *s) {
    memset(s, 0, sizeof *s);
    s->state = le32(p);
    if (le32(p + 4) != 0) return false;
    for (int i = 0; i < 2; i++) { s->requested[i] = le64(p + 8 + 16 * i); s->completed[i] = le64(p + 16 + 16 * i); }
    return status_ok(s);
}
static bool encode_status(const cw_status *s, uint8_t *p) {
    if (!status_ok(s)) return false;
    memset(p, 0, CW_ENV_STATUS_BYTES);
    put32(p, s->state);
    for (int i = 0; i < 2; i++) { put64(p + 8 + 16 * i, s->requested[i]); put64(p + 16 + 16 * i, s->completed[i]); }
    return true;
}

static bool fault_ok(uint32_t code) { return code >= CW_FAULT_BAD_SCOPE && code <= CW_FAULT_SECOND_DRAIN; }

static size_t payload_length(cw_env_kind kind) {
    switch (kind) {
    case CW_ENV_SCOPE: return CW_ENV_SCOPE_BYTES;
    case CW_ENV_VOLUMES: return CW_ENV_VOLUMES_BYTES;
    case CW_ENV_DRAIN: return CW_ENV_DRAIN_BYTES;
    case CW_ENV_STATUS: return CW_ENV_STATUS_BYTES;
    case CW_ENV_FAULT: return CW_ENV_FAULT_BYTES;
    }
    return 0;
}
static cw_env_direction kind_direction(cw_env_kind kind) {
    return (kind == CW_ENV_STATUS || kind == CW_ENV_FAULT) ? CW_ENV_TO_LAUNCHER : CW_ENV_TO_WORKER;
}

size_t cw_env_encode(const cw_envelope *e, uint8_t *out, size_t capacity) {
    if (e->seq < 1) return 0;
    size_t length = payload_length(e->kind);
    if (length == 0 || capacity < CW_ENV_HEADER + length) return 0;
    uint8_t *body = out + CW_ENV_HEADER;
    bool ok = false;
    switch (e->kind) {
    case CW_ENV_SCOPE: ok = encode_scope(&e->u.scope, body); break;
    case CW_ENV_VOLUMES: ok = encode_volumes(&e->u.volumes, body); break;
    case CW_ENV_DRAIN: ok = encode_drain(&e->u.drain, body); break;
    case CW_ENV_STATUS: ok = encode_status(&e->u.status, body); break;
    case CW_ENV_FAULT:
        ok = fault_ok(e->u.fault);
        if (ok) { memset(body, 0, CW_ENV_FAULT_BYTES); put32(body, e->u.fault); }
        break;
    }
    if (!ok) return 0;
    memcpy(out, "WEV1", 4);
    out[4] = 1;
    out[5] = (uint8_t)e->kind;
    out[6] = 0;
    out[7] = 0;
    put32(out + 8, e->seq);
    put32(out + 12, (uint32_t)length);
    return CW_ENV_HEADER + length;
}

int cw_env_parse(const uint8_t *bytes, size_t length, size_t rights, cw_env_direction direction, cw_envelope *out) {
    memset(out, 0, sizeof *out);
    if (length < CW_ENV_HEADER) return CW_E_MALFORMED;
    if (memcmp(bytes, "WEV1", 4) != 0) return CW_E_MALFORMED;
    if (bytes[4] != 1) return CW_E_VERSION;
    uint8_t kind_byte = bytes[5];
    if (kind_byte < CW_ENV_SCOPE || kind_byte > CW_ENV_FAULT || le16(bytes + 6) != 0) return CW_E_UNKNOWN_TYPE;
    cw_env_kind kind = (cw_env_kind)kind_byte;
    if (kind_direction(kind) != direction) return CW_E_BAD_DIRECTION;
    uint32_t seq = le32(bytes + 8), declared = le32(bytes + 12);
    if (seq < 1) return CW_E_BAD_SEQUENCE;
    if (declared != payload_length(kind) || length != CW_ENV_HEADER + (size_t)declared) return CW_E_MALFORMED;
    if (rights != (kind == CW_ENV_VOLUMES ? 2u : 0u)) return CW_E_BAD_RIGHTS;
    const uint8_t *body = bytes + CW_ENV_HEADER;
    out->kind = kind;
    out->seq = seq;
    bool ok = false;
    switch (kind) {
    case CW_ENV_SCOPE: ok = decode_scope(body, &out->u.scope); break;
    case CW_ENV_VOLUMES: ok = decode_volumes(body, &out->u.volumes); break;
    case CW_ENV_DRAIN: ok = decode_drain(body, &out->u.drain); break;
    case CW_ENV_STATUS: ok = decode_status(body, &out->u.status); break;
    case CW_ENV_FAULT:
        out->u.fault = le32(body);
        ok = le32(body + 4) == 0 && fault_ok(out->u.fault);
        break;
    }
    if (!ok) { memset(out, 0, sizeof *out); return CW_E_BAD_FIELD; }
    /* Exact re-serialization, as for every other format in the contract. */
    uint8_t again[CW_ENV_MAX_BYTES];
    size_t again_length = cw_env_encode(out, again, sizeof again);
    if (again_length != length || memcmp(again, bytes, length) != 0) { memset(out, 0, sizeof *out); return CW_E_MALFORMED; }
    return CW_OK;
}

/* ---- receiving --------------------------------------------------------------------------------------------------------- */

void cw_inbound_close_fds(cw_inbound *in) {
    for (size_t i = 0; i < in->fd_count; i++) close(in->fds[i]);
    in->fd_count = 0;
}

int cw_env_recv(int channel, cw_inbound *in, int timeout_ms) {
    in->length = 0;
    in->fd_count = 0;
    in->refused_fds = 0;
    if (timeout_ms >= 0) {
        struct pollfd wait = { .fd = channel, .events = POLLIN, .revents = 0 };
        int ready = poll(&wait, 1, timeout_ms);
        if (ready == 0) return CW_RECV_TIMEOUT;
        if (ready < 0) return errno == EINTR ? CW_RECV_AGAIN : CW_RECV_REFUSED;
        /* POLLHUP, POLLERR and POLLIN all fall through: recvmsg says which. */
    }
    union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(CW_FD_CAPACITY * sizeof(int))]; } ancillary;
    memset(&ancillary, 0, sizeof ancillary);
    struct iovec io = { .iov_base = in->bytes, .iov_len = sizeof in->bytes };
    struct msghdr message;
    memset(&message, 0, sizeof message);
    message.msg_iov = &io;
    message.msg_iovlen = 1;
    message.msg_control = ancillary.bytes;
    message.msg_controllen = sizeof ancillary;
    ssize_t received = recvmsg(channel, &message, MSG_DONTWAIT);
    if (received < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return CW_RECV_AGAIN;
        if (errno == ECONNRESET || errno == ENOTCONN || errno == EPIPE) return CW_RECV_GONE;
        return CW_RECV_REFUSED;
    }
    /* The headers are walked only through the bounded collector: macOS leaves cmsg_len at the sender's length when the buffer was too small. */
    cw_rights_result rights;
    cw_rights_collect(&message, in->fds, CW_FD_CAPACITY, &rights);
    in->fd_count = rights.count;
    /* On macOS a truncated control buffer has installed descriptors that nobody can see. Close what is visible and let the caller exit:
     * nothing may be acknowledged, and process exit is descriptor cleanup, never a release. */
    if ((message.msg_flags & MSG_CTRUNC) || rights.truncated) { cw_inbound_close_fds(in); return CW_RECV_CTRUNC; }
    bool bad = rights.malformed;
    if (message.msg_flags & MSG_TRUNC) bad = true;
    for (size_t i = 0; i < in->fd_count; i++) {
        int flags = fcntl(in->fds[i], F_GETFD);
        if (in->fds[i] < 3 || flags < 0 || fcntl(in->fds[i], F_SETFD, flags | FD_CLOEXEC) < 0) bad = true;
    }
    if (bad) {
        in->refused_fds = in->fd_count + rights.closed;
        cw_inbound_close_fds(in);
        return CW_RECV_REFUSED;
    }
    in->length = (size_t)received;
    return CW_RECV_OK;
}

/* ---- sending ----------------------------------------------------------------------------------------------------------- */

void cw_l2_out_init(cw_l2_out *out, int fd) {
    out->fd = fd;
    out->seq = 0;
    out->gone = false;
    pthread_mutex_init(&out->lock, NULL);
}

static int l2_send_locked(cw_l2_out *out, cw_envelope *envelope, int attempts) {
    if (out->gone) return -1;
    envelope->seq = out->seq + 1;
    uint8_t datagram[CW_ENV_MAX_BYTES];
    size_t length = cw_env_encode(envelope, datagram, sizeof datagram);
    if (length == 0) return -1;
    for (int attempt = 0; attempt < attempts; attempt++) {
        ssize_t sent = send(out->fd, datagram, length, MSG_DONTWAIT);
        if (sent == (ssize_t)length) { out->seq = envelope->seq; return 0; }
        if (sent >= 0) return -1;
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == ENOBUFS) {
            if (attempts == 1) return -1; /* the bounded variant never waits */
            struct pollfd wait = { .fd = out->fd, .events = POLLOUT, .revents = 0 };
            (void)poll(&wait, 1, 100);
            continue;
        }
        if (errno == EINTR) continue;
        if (errno == EDESTADDRREQ || errno == ECONNRESET || errno == EPIPE || errno == ENOTCONN) out->gone = true;
        return -1;
    }
    return -1;
}

int cw_l2_send_status(cw_l2_out *out, uint32_t state, const uint64_t requested[2], const uint64_t completed[2]) {
    cw_envelope envelope;
    memset(&envelope, 0, sizeof envelope);
    envelope.kind = CW_ENV_STATUS;
    envelope.u.status.state = state;
    for (int i = 0; i < 2; i++) {
        envelope.u.status.requested[i] = requested != NULL ? requested[i] : 0;
        envelope.u.status.completed[i] = completed != NULL ? completed[i] : 0;
    }
    pthread_mutex_lock(&out->lock);
    int result = l2_send_locked(out, &envelope, 20);
    pthread_mutex_unlock(&out->lock);
    return result;
}

int cw_l2_send_fault(cw_l2_out *out, uint32_t code) {
    cw_envelope envelope;
    memset(&envelope, 0, sizeof envelope);
    envelope.kind = CW_ENV_FAULT;
    envelope.u.fault = code;
    pthread_mutex_lock(&out->lock);
    int result = l2_send_locked(out, &envelope, 20);
    pthread_mutex_unlock(&out->lock);
    return result;
}

int cw_l2_send_status_once(cw_l2_out *out, uint32_t state, const uint64_t requested[2], const uint64_t completed[2]) {
    cw_envelope envelope;
    memset(&envelope, 0, sizeof envelope);
    envelope.kind = CW_ENV_STATUS;
    envelope.u.status.state = state;
    for (int i = 0; i < 2; i++) {
        envelope.u.status.requested[i] = requested != NULL ? requested[i] : 0;
        envelope.u.status.completed[i] = completed != NULL ? completed[i] : 0;
    }
    if (pthread_mutex_trylock(&out->lock) != 0) return -1;
    int result = l2_send_locked(out, &envelope, 1);
    pthread_mutex_unlock(&out->lock);
    return result;
}
