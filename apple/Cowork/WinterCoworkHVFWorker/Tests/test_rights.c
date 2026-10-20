/* The bounded rights collector, on SYNTHETIC control buffers: no sockets. Every case that a real receiver can only reach by kernel
 * accident (a header the kernel left at the sender's length, a second rights item, a wrong level or type, a payload that is not whole
 * descriptors) is built by hand here, with real descriptors, so a descriptor that is closed WRONGLY or LEFT OPEN is visible.
 *
 * Over-reads are caught three ways: the control buffer is a malloc of EXACTLY msg_controllen bytes (AddressSanitizer faults on any read past
 * it), the bytes just after it hold the numbers of real "sentinel" descriptors that must never be closed (they survive a non-sanitised run),
 * and the headers are walked once. */
#include "Rights.h"
#include "test_support.h"

#include <errno.h>
#include <netinet/in.h>
#include <sys/socket.h>

typedef struct { unsigned char *buffer; size_t length; } synthetic;

static int open_one(void) {
    int fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
    CHECK(fd >= 3);
    return fd;
}
static bool is_open(int fd) { return fcntl(fd, F_GETFD) >= 0; }

/* A control buffer in an allocation of EXACTLY `length` bytes: AddressSanitizer faults on any read past it. */
static synthetic make_buffer(size_t length) {
    synthetic s = { calloc(1, length), length };
    return s;
}
static void finish_buffer(synthetic *s) { free(s->buffer); }
static struct cmsghdr *header_at(synthetic *s, size_t offset, int level, int type, size_t cmsg_len) {
    struct cmsghdr *h = (struct cmsghdr *)(void *)(s->buffer + offset);
    h->cmsg_level = level;
    h->cmsg_type = type;
    h->cmsg_len = (socklen_t)cmsg_len;
    return h;
}
static void put_fds(struct cmsghdr *h, const int *fds, size_t count) { memcpy(CMSG_DATA(h), fds, count * sizeof(int)); }

static cw_rights_result collect_bytes(unsigned char *bytes, size_t controllen, int *fds, size_t capacity) {
    struct msghdr message;
    memset(&message, 0, sizeof message);
    message.msg_control = bytes;
    message.msg_controllen = (socklen_t)controllen;
    cw_rights_result result;
    cw_rights_collect(&message, fds, capacity, &result);
    return result;
}
static cw_rights_result collect(const synthetic *s, size_t controllen, int *fds, size_t capacity) { return collect_bytes(s->buffer, controllen, fds, capacity); }

static void one_header(void) {
    int fds[3] = { open_one(), open_one(), open_one() }, out[8];
    synthetic s = make_buffer(CMSG_SPACE(sizeof fds));
    struct cmsghdr *h = header_at(&s, 0, SOL_SOCKET, SCM_RIGHTS, CMSG_LEN(sizeof fds));
    put_fds(h, fds, 3);
    cw_rights_result r = collect(&s, s.length, out, 8);
    CHECK(r.count == 3 && r.closed == 0 && !r.malformed && !r.truncated);
    CHECK(out[0] == fds[0] && out[1] == fds[1] && out[2] == fds[2]);
    for (int i = 0; i < 3; i++) { CHECK(is_open(fds[i])); close(fds[i]); }
    finish_buffer(&s);
}

static void nothing_to_walk(void) {
    int out[2];
    struct msghdr message;
    memset(&message, 0, sizeof message);
    cw_rights_result r;
    cw_rights_collect(&message, out, 2, &r);
    CHECK(r.count == 0 && !r.malformed && !r.truncated);
    unsigned char tiny[2];
    message.msg_control = tiny;
    message.msg_controllen = sizeof tiny; /* shorter than a header */
    cw_rights_collect(&message, out, 2, &r);
    CHECK(r.count == 0 && !r.truncated);
}

/* I23: a header that is not SOL_SOCKET / SCM_RIGHTS is never read as descriptors. */
static void wrong_level_or_type(void) {
    int fd = open_one(), out[4];
    const struct { int level; int type; } cases[] = { { SOL_SOCKET, SCM_CREDS }, { SOL_SOCKET, SCM_TIMESTAMP }, { IPPROTO_IP, SCM_RIGHTS }, { 0, 0 } };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        synthetic s = make_buffer(CMSG_SPACE(sizeof(int)));
        struct cmsghdr *h = header_at(&s, 0, cases[i].level, cases[i].type, CMSG_LEN(sizeof(int)));
        put_fds(h, &fd, 1);
        cw_rights_result r = collect(&s, s.length, out, 4);
        CHECK(r.malformed && r.count == 0 && !r.truncated);
        CHECK(is_open(fd)); /* it was not mistaken for a descriptor and closed */
        finish_buffer(&s);
    }
    close(fd);
}

/* I24: a payload that is not a whole number of descriptors is malformed (and only the whole ones are read). */
static void payload_not_a_multiple_of_an_int(void) {
    int fd = open_one(), out[4];
    synthetic s = make_buffer(CMSG_SPACE(2 * sizeof(int)));
    struct cmsghdr *h = header_at(&s, 0, SOL_SOCKET, SCM_RIGHTS, CMSG_LEN(sizeof(int) + 2));
    put_fds(h, &fd, 1);
    cw_rights_result r = collect(&s, s.length, out, 4);
    CHECK(r.malformed && r.count == 1 && out[0] == fd && !r.truncated);
    finish_buffer(&s);
    close(fd);
    /* and 3 bytes is not even one descriptor */
    synthetic t = make_buffer(CMSG_SPACE(4));
    header_at(&t, 0, SOL_SOCKET, SCM_RIGHTS, CMSG_LEN(3));
    r = collect(&t, t.length, out, 4);
    CHECK(r.malformed && r.count == 0);
    finish_buffer(&t);
}

/* I25 and I25b: more descriptors than the capacity are CLOSED on the spot (not leaked) and the datagram is malformed. */
static void over_capacity(void) {
    int fds[5], out[4];
    for (int i = 0; i < 5; i++) fds[i] = open_one();
    synthetic s = make_buffer(CMSG_SPACE(sizeof fds));
    struct cmsghdr *h = header_at(&s, 0, SOL_SOCKET, SCM_RIGHTS, CMSG_LEN(sizeof fds));
    put_fds(h, fds, 5);
    cw_rights_result r = collect(&s, s.length, out, 2);
    CHECK(r.count == 2 && r.closed == 3 && r.malformed && !r.truncated);
    CHECK(out[0] == fds[0] && out[1] == fds[1] && is_open(fds[0]) && is_open(fds[1])); /* the two kept are untouched */
    for (int i = 2; i < 5; i++) CHECK(!is_open(fds[i]));                               /* the other three are closed, not leaked */
    close(fds[0]); close(fds[1]);
    finish_buffer(&s);
    /* A second rights item (which the kernel will not send, but a buffer can hold) is counted against the same capacity. */
    int a[2] = { open_one(), open_one() }, b[2] = { open_one(), open_one() };
    size_t first = CMSG_SPACE(sizeof a);
    synthetic t = make_buffer(first + CMSG_SPACE(sizeof b));
    put_fds(header_at(&t, 0, SOL_SOCKET, SCM_RIGHTS, CMSG_LEN(sizeof a)), a, 2);
    put_fds(header_at(&t, first, SOL_SOCKET, SCM_RIGHTS, CMSG_LEN(sizeof b)), b, 2);
    r = collect(&t, t.length, out, 3);
    CHECK(r.count == 3 && r.closed == 1 && r.malformed);
    CHECK(is_open(a[0]) && is_open(a[1]) && is_open(b[0]) && !is_open(b[1]));
    close(a[0]); close(a[1]); close(b[0]);
    finish_buffer(&t);
}

/* The macOS truncation: cmsg_len is the SENDER's (92 for 20 descriptors) but the buffer holds 16. Only the 16 are read; nothing beyond. */
static void truncated_header(void) {
    int visible[16], out[32];
    for (int i = 0; i < 16; i++) visible[i] = open_one();
    size_t visible_length = CMSG_LEN(16 * sizeof(int)); /* the header and 16 ints, nothing more */
    /* (a) The bytes the header CLAIMS but the buffer does not hold are four real "sentinel" descriptors sitting right after it in memory. */
    int sentinels[4];
    for (int i = 0; i < 4; i++) sentinels[i] = open_one();
    unsigned char *big = calloc(1, CMSG_LEN(20 * sizeof(int)));
    struct cmsghdr *h = (struct cmsghdr *)(void *)big;
    h->cmsg_level = SOL_SOCKET;
    h->cmsg_type = SCM_RIGHTS;
    h->cmsg_len = (socklen_t)CMSG_LEN(20 * sizeof(int)); /* the sender's length */
    memcpy(CMSG_DATA(h), visible, sizeof visible);
    memcpy(CMSG_DATA(h) + sizeof visible, sentinels, sizeof sentinels);
    cw_rights_result r = collect_bytes(big, visible_length, out, 32); /* msg_controllen says 16 ints fit */
    CHECK(r.truncated);
    CHECK(r.count == 16 && r.closed == 0);
    for (int i = 0; i < 16; i++) CHECK(out[i] == visible[i]);
    for (int i = 0; i < 4; i++) CHECK(is_open(sentinels[i])); /* what lies beyond the buffer was never read, so never closed */
    for (int i = 0; i < 4; i++) close(sentinels[i]);
    free(big);
    for (int i = 0; i < 16; i++) close(visible[i]);
    /* (b) The same header in an allocation of exactly the control length (placeholders, never real descriptors): an over-read is an AddressSanitizer fault. */
    synthetic exact = make_buffer(visible_length);
    int placeholders[16];
    for (int i = 0; i < 16; i++) placeholders[i] = -1;
    put_fds(header_at(&exact, 0, SOL_SOCKET, SCM_RIGHTS, CMSG_LEN(20 * sizeof(int))), placeholders, 16);
    r = collect(&exact, exact.length, out, 32);
    CHECK(r.truncated && r.count == 16);
    finish_buffer(&exact);
    /* A header that starts inside the buffer but whose DATA starts at or past its end holds no descriptors at all. */
    synthetic t = make_buffer(sizeof(struct cmsghdr));
    header_at(&t, 0, SOL_SOCKET, SCM_RIGHTS, CMSG_LEN(8 * sizeof(int)));
    r = collect(&t, t.length, out, 8);
    CHECK(r.truncated && r.count == 0);
    finish_buffer(&t);
}

/* A length below a header's own size would make CMSG_NXTHDR stand still; zero must end the walk. */
static void degenerate_lengths(void) {
    int out[4];
    for (size_t bad = 0; bad < CMSG_LEN(0); bad += 4) {
        synthetic s = make_buffer(CMSG_SPACE(8));
        header_at(&s, 0, SOL_SOCKET, SCM_RIGHTS, bad);
        cw_rights_result r = collect(&s, s.length, out, 4);
        CHECK(r.malformed && r.count == 0);
        finish_buffer(&s);
    }
}

/* Headers that keep coming are walked a bounded number of times. */
static void many_headers(void) {
    int fd = open_one(), out[64];
    size_t one = CMSG_SPACE(sizeof(int));
    synthetic s = make_buffer(one * 20);
    for (size_t i = 0; i < 20; i++) put_fds(header_at(&s, i * one, SOL_SOCKET, SCM_RIGHTS, CMSG_LEN(sizeof(int))), &fd, 1);
    cw_rights_result r = collect(&s, s.length, out, 64);
    CHECK(r.count <= 8); /* CW_RIGHTS_MAX_HEADERS: more than the kernel will ever send */
    CHECK(r.count >= 1);
    for (size_t i = 0; i < r.count; i++) (void)i;
    finish_buffer(&s);
    close(fd);
}

int main(void) {
    int before = cw_test_open_descriptors();
    one_header();
    nothing_to_walk();
    wrong_level_or_type();
    payload_not_a_multiple_of_an_int();
    over_capacity();
    truncated_header();
    degenerate_lengths();
    many_headers();
    CHECK(cw_test_open_descriptors() == before);
    return cw_test_finish("test_rights");
}
