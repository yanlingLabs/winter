#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
int kb_pipe(int fds[2]);
int kb_channel(int fds[2]);
int kb_spawn_suspended(const char *path, const char *mode, int input, int output, pid_t *pid);
int kb_resume(pid_t pid);
int kb_wait_owned(pid_t pid, int milliseconds);
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
