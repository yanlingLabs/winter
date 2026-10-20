#include "Rights.h"

#include <string.h>
#include <unistd.h>

/* More headers than this cannot arrive: the kernel refuses to send two rights items in one message. */
#define CW_RIGHTS_MAX_HEADERS 8u

void cw_rights_collect(const struct msghdr *message, int *fds, size_t capacity, cw_rights_result *result) {
    memset(result, 0, sizeof *result);
    const unsigned char *base = message->msg_control;
    if (base == NULL || message->msg_controllen < sizeof(struct cmsghdr)) return;
    const unsigned char *end = base + message->msg_controllen;
    unsigned seen = 0;
    for (struct cmsghdr *header = CMSG_FIRSTHDR(message); header != NULL && seen < CW_RIGHTS_MAX_HEADERS; header = CMSG_NXTHDR(message, header), seen++) {
        const unsigned char *at = (const unsigned char *)header;
        /* The header itself must lie inside the buffer. */
        if (at < base || (size_t)(end - at) < sizeof(struct cmsghdr)) { result->malformed = true; break; }
        /* A length below the header's own size cannot be walked past (CMSG_NXTHDR would not advance). */
        if (header->cmsg_len < CMSG_LEN(0)) { result->malformed = true; break; }
        const unsigned char *data = (const unsigned char *)CMSG_DATA(header);
        size_t available = data <= end ? (size_t)(end - data) : 0;
        size_t declared = (size_t)header->cmsg_len - CMSG_LEN(0);
        if (declared > available) result->truncated = true; /* the kernel's cmsg_len is the sender's, not what fits */
        if (header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS) { result->malformed = true; continue; }
        size_t payload = declared < available ? declared : available;
        if (!result->truncated && payload % sizeof(int) != 0) result->malformed = true;
        for (size_t i = 0; i < payload / sizeof(int); i++) {
            int fd;
            memcpy(&fd, data + i * sizeof fd, sizeof fd);
            if (result->count < capacity) fds[result->count++] = fd;
            else { (void)close(fd); result->closed++; result->malformed = true; }
        }
    }
}
