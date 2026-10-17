/* The fixture's handoff harness (spikes/cowork-hvf/workspace_fd_handoff_test.c at 9a588735), extended to the production envelope
 * receiver and the mux reader. Built twice, with CW_FD_CAPACITY 256 (production) and 16, so the 20-descriptor case is ordinary
 * input in one build and a truncated control buffer in the other. In-process socketpairs only: no VM, no sandbox, no HVF.
 *
 * What this pins (HARD rule, verified on macOS by S1): a plain read() or recv() on an AF_UNIX socket installs any SCM_RIGHTS
 * descriptors the peer attached. Every reader here uses recvmsg with a control buffer, closes what it did not ask for, and a
 * truncated control buffer is fatal (the caller exits 79). */
#include "AdmittedVolumes.h"
#include "Envelope.h"
#include "Mux.h"
#include "test_support.h"
#include "vectors.h"

#include <errno.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>

#define CTRUNC_EXIT 79

static void send_with_fds(int channel, const uint8_t *body, size_t length, int fd, int count) {
    union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(300 * sizeof(int))]; } rights;
    memset(&rights, 0, sizeof rights);
    struct iovec io = { .iov_base = (void *)(uintptr_t)body, .iov_len = length };
    struct msghdr message;
    memset(&message, 0, sizeof message);
    message.msg_iov = &io;
    message.msg_iovlen = 1;
    if (count > 0) {
        message.msg_control = rights.bytes;
        message.msg_controllen = CMSG_SPACE((size_t)count * sizeof(int));
        struct cmsghdr *header = CMSG_FIRSTHDR(&message);
        header->cmsg_level = SOL_SOCKET;
        header->cmsg_type = SCM_RIGHTS;
        header->cmsg_len = CMSG_LEN((size_t)count * sizeof(int));
        for (int i = 0; i < count; i++) memcpy((unsigned char *)CMSG_DATA(header) + (size_t)i * sizeof fd, &fd, sizeof fd);
    }
    ssize_t sent = sendmsg(channel, &message, 0);
    if (sent != (ssize_t)length) { fprintf(stderr, "sendmsg failed: %zd errno=%d\n", sent, errno); cw_test_failures++; }
}

static const uint8_t *volumes_body(size_t *length) {
    for (size_t i = 0; i < ENV_VECTOR_COUNT; i++) if (strcmp(env_vectors[i].name, "volumes-two-descriptors") == 0) { *length = env_vectors[i].length; return env_vectors[i].bytes; }
    *length = 0;
    return NULL;
}

static void channel_admission(void) {
    /* A stream socketpair is not an L2 channel. */
    int wrong[2];
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, wrong) == 0);
    CHECK(fcntl(wrong[1], F_SETFD, FD_CLOEXEC) == 0);
    CHECK(cw_channel_admit(wrong[1], SOCK_DGRAM) == -1);
    CHECK(cw_channel_admit(wrong[1], SOCK_STREAM) == 0);       /* it IS a valid L3 end */
    close(wrong[0]); close(wrong[1]);
    /* NAMED datagram sockets (a reachable path) are refused: only an unnamed socketpair end is admitted. */
    char directory[] = "/tmp/cw-handoff-XXXXXX";
    CHECK(mkdtemp(directory) != NULL);
    int named[2];
    struct sockaddr_un names[2];
    memset(names, 0, sizeof names);
    for (int i = 0; i < 2; i++) {
        named[i] = socket(AF_UNIX, SOCK_DGRAM, 0);
        CHECK(named[i] >= 3);
        CHECK(fcntl(named[i], F_SETFD, FD_CLOEXEC) == 0);
        names[i].sun_family = AF_UNIX;
        CHECK(snprintf(names[i].sun_path, sizeof names[i].sun_path, "%s/%d", directory, i) < (int)sizeof names[i].sun_path);
        CHECK(bind(named[i], (struct sockaddr *)&names[i], sizeof names[i]) == 0);
    }
    CHECK(connect(named[0], (struct sockaddr *)&names[1], sizeof names[1]) == 0);
    CHECK(connect(named[1], (struct sockaddr *)&names[0], sizeof names[0]) == 0);
    CHECK(cw_channel_admit(named[1], SOCK_DGRAM) == -1);
    /* Refusing the channel reads nothing: the datagram is still queued. */
    CHECK(send(named[0], "q", 1, 0) == 1);
    int unread = 0;
    socklen_t size = sizeof unread;
    CHECK(getsockopt(named[1], SOL_SOCKET, SO_NREAD, &unread, &size) == 0 && unread == 1);
    for (int i = 0; i < 2; i++) { close(named[i]); unlink(names[i].sun_path); }
    rmdir(directory);
    /* The real thing: an unnamed pair, CLOEXEC restored, a descriptor number of 3 or more. */
    int pair[2];
    CHECK(socketpair(AF_UNIX, SOCK_DGRAM, 0, pair) == 0);
    CHECK(cw_channel_admit(pair[1], SOCK_DGRAM) == -1); /* exec-inherited state (no CLOEXEC) must be restored first */
    CHECK(fcntl(pair[1], F_SETFD, FD_CLOEXEC) == 0);
    CHECK(cw_channel_admit(pair[1], SOCK_DGRAM) == 0);
    CHECK(cw_channel_admit(pair[1], SOCK_STREAM) == -1);
    CHECK(cw_channel_admit(-1, SOCK_DGRAM) == -1);
    CHECK(cw_channel_admit(1, SOCK_DGRAM) == -1);
    int not_a_socket = open("/dev/null", O_RDONLY | O_CLOEXEC);
    CHECK(cw_channel_admit(not_a_socket, SOCK_DGRAM) == -1);
    close(not_a_socket);
    close(pair[0]); close(pair[1]);
}

/* Runs in a child so that the truncated-control-buffer case may end the process the way the worker does. */
static int exercise(void) {
    cw_test_failures = 0; /* the child counts its own checks */
    size_t body_length = 0;
    const uint8_t *body = volumes_body(&body_length);
    int sockets[2];
    CHECK(socketpair(AF_UNIX, SOCK_DGRAM, 0, sockets) == 0);
    int fd = open("/dev/null", O_RDWR);
    CHECK(fd >= 3);

    /* The receiver reports what arrived; counting the descriptors is the parser's job (VOLUMES wants exactly 2). */
    const int counts[] = { 2, 0, 1, 3, 15 };
    for (size_t i = 0; i < sizeof counts / sizeof counts[0]; i++) {
        int before = cw_test_open_descriptors();
        send_with_fds(sockets[0], body, body_length, fd, counts[i]);
        cw_inbound in;
        CHECK(cw_env_recv(sockets[1], &in, 1000) == CW_RECV_OK);
        CHECK(in.length == body_length && memcmp(in.bytes, body, body_length) == 0);
        CHECK(in.fd_count == (size_t)counts[i]);
        for (size_t k = 0; k < in.fd_count; k++) {
            CHECK(in.fds[k] >= 3);
            CHECK(fcntl(in.fds[k], F_GETFD) & FD_CLOEXEC);
        }
        cw_envelope e;
        CHECK(cw_env_parse(in.bytes, in.length, in.fd_count, CW_ENV_TO_WORKER, &e) == (counts[i] == 2 ? CW_OK : CW_E_BAD_RIGHTS));
        cw_inbound_close_fds(&in);
        CHECK(cw_test_open_descriptors() == before);
        CHECK(fcntl(fd, F_GETFD) >= 0);
    }
    /* A datagram longer than the receive buffer is refused whole, and its descriptors are closed. */
    {
        uint8_t big[CW_ENV_MAX_BYTES + 200];
        memset(big, 0x41, sizeof big);
        int before = cw_test_open_descriptors();
        send_with_fds(sockets[0], big, sizeof big, fd, 2);
        cw_inbound in;
        CHECK(cw_env_recv(sockets[1], &in, 1000) == CW_RECV_REFUSED);
        CHECK(in.fd_count == 0 && cw_test_open_descriptors() == before);
    }
    /* Waiting: not yet (TIMEOUT), not at all (AGAIN). */
    cw_inbound in;
    CHECK(cw_env_recv(sockets[1], &in, 20) == CW_RECV_TIMEOUT);
    CHECK(cw_env_recv(sockets[1], &in, -1) == CW_RECV_AGAIN);
    /* An empty datagram is a datagram (a malformed envelope), not an end of file. */
    CHECK(send(sockets[0], "", 0, 0) == 0);
    CHECK(cw_env_recv(sockets[1], &in, 1000) == CW_RECV_OK && in.length == 0);
    /* The peer closing is reported once (macOS latches ECONNRESET one time), and the caller must latch it. */
    close(sockets[0]);
    CHECK(cw_env_recv(sockets[1], &in, 1000) == CW_RECV_GONE);
    close(sockets[1]);

    /* LAST, because it may end the process: twenty descriptors. Ordinary input when the control buffer holds 256; a truncated
     * control buffer, and so the worker's exit 79, when it holds 16. */
    CHECK(socketpair(AF_UNIX, SOCK_DGRAM, 0, sockets) == 0);
    int before = cw_test_open_descriptors();
    send_with_fds(sockets[0], body, body_length, fd, 20);
    int rc = cw_env_recv(sockets[1], &in, 1000);
    if (CW_FD_CAPACITY < 20) {
        /* Whatever is visible has been closed; the worker exits at once, acknowledging nothing. Descriptors the kernel installed
         * but did not disclose cannot be closed by anyone: that is why this is terminal. */
        CHECK(rc == CW_RECV_CTRUNC && in.fd_count == 0);
        fprintf(stderr, "ctrunc case: 20 descriptors sent, buffer holds %d, open descriptors before %d after %d\n", CW_FD_CAPACITY, before, cw_test_open_descriptors());
        return cw_test_failures != 0 ? 1 : CTRUNC_EXIT;
    }
    CHECK(rc == CW_RECV_OK && in.fd_count == 20);
    cw_inbound_close_fds(&in);
    CHECK(cw_test_open_descriptors() == before);
    close(sockets[0]);
    close(sockets[1]);
    close(fd);
    return cw_test_failures != 0 ? 1 : 0;
}

/* The same rule on a mux stream, in its own child: a descriptor is closed and refused; a truncated control buffer is fatal. */
static int stream_exercise(void) {
    cw_test_failures = 0;
    int stream[2];
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, stream) == 0);
    fcntl(stream[1], F_SETFL, fcntl(stream[1], F_GETFL) | O_NONBLOCK);
    int victim = open("/dev/null", O_RDONLY);
    static cw_mux_reader reader;
    cw_mux_reader_reset(&reader);
    uint8_t ping[CW_MUX_HEADER + 24];
    uint8_t payload[24];
    memcpy(payload, "{\"v\":1,\"t\":\"ping\",\"n\":7}", 24);
    size_t ping_length = cw_mux_encode(CW_CLASS_CONTROL, 1, payload, 24, ping, sizeof ping);
    CHECK(ping_length == sizeof ping);
    int before = cw_test_open_descriptors();
    send_with_fds(stream[0], ping, 1, victim, 5);
    CHECK(cw_mux_reader_pump(&reader, stream[1]) == -CW_E_BAD_RIGHTS);
    CHECK(cw_test_open_descriptors() == before);
    if (CW_FD_CAPACITY < 20) {
        cw_mux_reader_reset(&reader);
        send_with_fds(stream[0], ping, 1, victim, 20);
        int rc = cw_mux_reader_pump(&reader, stream[1]);
        CHECK(rc == -CW_E_CTRUNC);
        return cw_test_failures != 0 ? 1 : CTRUNC_EXIT; /* the worker exits 79 here */
    }
    close(victim);
    close(stream[0]);
    close(stream[1]);
    return cw_test_failures != 0 ? 1 : 0;
}

/* The same input through the whole intake: twenty descriptors with VOLUMES. With a 16 slot control buffer that is a truncated
 * control buffer; with 256 slots it is simply the wrong number of descriptors. Both end silently with exit 79, and the reason
 * says which one it was, so a mapping that sent CTRUNC down the ordinary-fault path would be caught here. */
static int intake_fake_sandbox(void *context) { (void)context; return 0; }
static int intake_exercise(void) {
    cw_test_failures = 0;
    const cw_env_vector *scope = NULL, *volumes = NULL;
    for (size_t i = 0; i < ENV_VECTOR_COUNT; i++) {
        if (strcmp(env_vectors[i].name, "scope") == 0) scope = &env_vectors[i];
        if (strcmp(env_vectors[i].name, "volumes-two-descriptors") == 0) volumes = &env_vectors[i];
    }
    int pair[2];
    CHECK(socketpair(AF_UNIX, SOCK_DGRAM, 0, pair) == 0);
    int fd = open("/dev/null", O_RDWR);
    send_with_fds(pair[0], scope->bytes, scope->length, fd, 0);
    send_with_fds(pair[0], volumes->bytes, volumes->length, fd, 20);
    cw_intake_config config = { intake_fake_sandbox, NULL, 1000, 1000, geteuid(), { 2, 768, 1024 } };
    cw_intake_result result;
    int before = cw_test_open_descriptors();
    cw_intake_run(&config, pair[1], &result);
    CHECK(result.outcome == CW_INTAKE_SILENT_EXIT && result.exit_code == CW_EXIT_RIGHTS);
    CHECK(result.fds[0] == -1 && result.fds[1] == -1 && !result.volumes_accepted);
    if (CW_FD_CAPACITY < 20) CHECK_STR(result.reason, "truncated control buffer");
    else { CHECK_STR(result.reason, "descriptor count"); CHECK(cw_test_open_descriptors() == before); }
    return cw_test_failures != 0 ? 1 : (result.outcome == CW_INTAKE_SILENT_EXIT ? CTRUNC_EXIT : 0); /* the worker exits 79 here in both builds */
}

/* A valid unnamed datagram socketpair end that happens to sit at descriptor 0, 1 or 2 is still refused: the launcher owns those. */
static int low_descriptor_exercise(void) {
    cw_test_failures = 0;
    int pair[2];
    CHECK(socketpair(AF_UNIX, SOCK_DGRAM, 0, pair) == 0);
    CHECK(fcntl(pair[1], F_SETFD, FD_CLOEXEC) == 0);
    CHECK(cw_channel_admit(pair[1], SOCK_DGRAM) == 0);   /* admitted where it is ... */
    CHECK(dup2(pair[1], 2) == 2);
    CHECK(fcntl(2, F_SETFD, FD_CLOEXEC) == 0);
    CHECK(cw_channel_admit(2, SOCK_DGRAM) == -1);        /* ... refused as descriptor 2 */
    return cw_test_failures != 0 ? 1 : 0;
}

static int run_child(int (*body)(void)) {
    fflush(NULL);
    pid_t child = fork();
    CHECK(child >= 0);
    if (child == 0) _exit(body());
    int status = 0;
    CHECK(waitpid(child, &status, 0) == child);
    CHECK(WIFEXITED(status));
    return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

int main(void) {
    channel_admission();
    if (cw_test_failures != 0) return cw_test_finish("test_handoff(admission)");
    int expected = CW_FD_CAPACITY < 20 ? CTRUNC_EXIT : 0;
    CHECK(run_child(low_descriptor_exercise) == 0);
    int datagram = run_child(exercise), stream = run_child(stream_exercise), intake = run_child(intake_exercise);
    if (intake != CTRUNC_EXIT) fprintf(stderr, "intake child exited %d, wanted %d\n", intake, CTRUNC_EXIT);
    CHECK(intake == CTRUNC_EXIT);
    if (datagram != expected) fprintf(stderr, "datagram child exited %d, wanted %d (capacity %d)\n", datagram, expected, CW_FD_CAPACITY);
    if (stream != expected) fprintf(stderr, "stream child exited %d, wanted %d (capacity %d)\n", stream, expected, CW_FD_CAPACITY);
    CHECK(datagram == expected);
    CHECK(stream == expected);
    printf("capacity %d: truncated ancillary path %s; no VM started\n", CW_FD_CAPACITY, expected != 0 ? "ended the process with exit 79" : "did not occur");
    return cw_test_finish(CW_FD_CAPACITY == 256 ? "test_handoff[256]" : "test_handoff[16]");
}
