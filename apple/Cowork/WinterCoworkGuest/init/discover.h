/*
 * Device discovery for PID 1 (N2 slice S5): the single virtio-console port and the two virtio block disks, found by what
 * the kernel publishes, never by probe order.
 *
 *   * disks: every virtio-blk entry in <sys>/block must carry the serial `winter-data` or `winter-environment`, each exactly
 *     once, and there must be exactly two. Anything else on the virtio bus that looks like a disk is a refusal. Non-virtio
 *     block devices (loop, ram) are not ours and are ignored.
 *   * port: exactly one virtio console device (id 0x0003) bound to the virtio_console driver with exactly the
 *     VERSION_1+MULTIPORT feature bits the admitted device exposes, and exactly one port `vport<N>p0` below it.
 * The roots are parameters so the native tests can point them at a fake sysfs tree. Portable POSIX.
 */
#ifndef WG_DISCOVER_H
#define WG_DISCOVER_H

#include <stddef.h>
#include <sys/stat.h>

#define WG_DATA_SERIAL "winter-data"
#define WG_ENVIRONMENT_SERIAL "winter-environment"

struct wg_disk {
    char name[32];    /* kernel name, e.g. vda */
    char node[256];   /* <dev_root>/<name> */
    unsigned major, minor;
    char serial[64];
};

struct wg_port {
    char name[32];    /* vport0p0 */
    char node[256];   /* <dev_root>/<name> */
    unsigned major, minor;
};

enum wg_discover_status {
    WG_DISCOVER_OK = 0,
    WG_DISCOVER_NOT_YET,      /* what we need is not there (yet): the caller may retry shortly */
    WG_DISCOVER_REFUSED       /* what is there is wrong: never retry */
};

/* Where to look. `stat_node` is how the device node is examined (NULL = stat(2)); the native tests substitute a table because an
 * unprivileged process cannot create a block or character device node. */
struct wg_discover_env {
    const char *sys_root;
    const char *dev_root;
    int (*stat_node)(const char *path, struct stat *st, void *ctx);
    void *ctx;
};

/* `why` receives a short fixed code (no paths, no serial numbers beyond the two expected ones). */
enum wg_discover_status wg_find_disks(const struct wg_discover_env *env, struct wg_disk *data, struct wg_disk *environment,
                                      char *why, size_t why_capacity);
enum wg_discover_status wg_find_port(const struct wg_discover_env *env, struct wg_port *port, char *why, size_t why_capacity);

#endif
