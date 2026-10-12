#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
int kb_pipe(int fds[2]);
int kb_channel(int fds[2]);
typedef struct kb_owned_child kb_owned_child;
enum { KB_OWNED_RUNNING=0, KB_CONFIRMED_EXIT=1, KB_TERMINATION_UNCERTAIN=2, KB_LOST_OWNERSHIP=3 };
typedef struct { int state, status, error, timed_out, kill_sent; } kb_wait_result;
/* No caller-supplied PID: handles originate only from this fixture's spawn. */
int kb_spawn_owned(const char *path, const char *mode, int input, int output, kb_owned_child **child);
pid_t kb_owned_pid(const kb_owned_child *child);
kb_wait_result kb_resume_owned(kb_owned_child *child);
kb_wait_result kb_wait_owned(kb_owned_child *child, int milliseconds, int reap_milliseconds);
void kb_owned_destroy(kb_owned_child *child);
/* Deterministic syscall doubles, with no real PID/signal operations. */
int kb_fixture_wait_scenario(int scenario);
int kb_fixture_read_deadline_scenario(int scenario);
int kb_fixture_spawn_policy_refused(void);
int kb_recv_packet(int fd, void *bytes, size_t capacity, int milliseconds);
int kb_send_packet(int fd, const void *bytes, size_t length);
int kb_peer_pid(int fd, pid_t *pid);
int kb_write_all(int fd, const void *bytes, size_t length);
int kb_read_bounded(int fd, void *bytes, size_t capacity, int milliseconds);
int kb_read_line(int fd, void *bytes, size_t capacity, int milliseconds);
int kb_fixture_sandbox(void);
int kb_extra_fds(void);
int kb_file_denied(const char *path);
int kb_network_denied(void);
int kb_exec_denied(void);
int kb_security_service_denied(void);
void kb_wipe(void *bytes, size_t length);
