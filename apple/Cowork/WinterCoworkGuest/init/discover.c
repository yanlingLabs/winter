#define _GNU_SOURCE
#include "discover.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#ifndef PATH_MAX
#define PATH_MAX 4096
#endif
#ifdef __linux__
#include <sys/sysmacros.h>
#else
#include <sys/types.h>
#endif

static int examine(const struct wg_discover_env *env, const char *path, struct stat *st) {
    return env->stat_node ? env->stat_node(path, st, env->ctx) : stat(path, st);
}

static void say(char *why, size_t capacity, const char *code) {
    if (why && capacity) snprintf(why, capacity, "%s", code);
}

static int read_line(const char *path, char *value, size_t capacity) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -errno;
    ssize_t n = read(fd, value, capacity - 1);
    int saved = errno;
    close(fd);
    if (n < 0) return -saved;
    if ((size_t)n == capacity - 1) return -EOVERFLOW;
    value[n] = '\0';
    value[strcspn(value, "\n")] = '\0';
    return 0;
}

static int join(char *out, size_t capacity, const char *a, const char *b, const char *c) {
    int n = snprintf(out, capacity, "%s%s%s%s%s", a, b[0] ? "/" : "", b, c[0] ? "/" : "", c);
    return (n < 0 || (size_t)n >= capacity) ? -1 : 0;
}

static int name_ok(const char *name) {
    size_t length = strlen(name);
    if (length == 0 || length >= 32) return 0;
    for (size_t i = 0; i < length; i++)
        if (!((name[i] >= 'a' && name[i] <= 'z') || (name[i] >= '0' && name[i] <= '9'))) return 0;
    return 1;
}

static int parse_dev(const char *text, unsigned *major_out, unsigned *minor_out) {
    unsigned a, b;
    char extra = 0;
    if (sscanf(text, "%u:%u%c", &a, &b, &extra) != 2) return -1;
    *major_out = a; *minor_out = b;
    return 0;
}

/* The basename of a symlink's target ("../../../bus/virtio" -> "virtio"). */
static int link_basename(const char *path, char *out, size_t capacity) {
    char target[PATH_MAX];
    ssize_t n = readlink(path, target, sizeof target - 1);
    if (n < 0) return -1;
    target[n] = '\0';
    const char *base = strrchr(target, '/');
    base = base ? base + 1 : target;
    if (snprintf(out, capacity, "%s", base) >= (int)capacity) return -1;
    return 0;
}

enum wg_discover_status wg_find_disks(const struct wg_discover_env *env, struct wg_disk *data, struct wg_disk *environment,
                                      char *why, size_t why_capacity) {
    const char *sys_root = env->sys_root, *dev_root = env->dev_root;
    char path[PATH_MAX];
    if (join(path, sizeof path, sys_root, "block", "") != 0) { say(why, why_capacity, "path"); return WG_DISCOVER_REFUSED; }
    DIR *directory = opendir(path);
    if (!directory) { say(why, why_capacity, "no-block-class"); return WG_DISCOVER_NOT_YET; }
    memset(data, 0, sizeof *data);
    memset(environment, 0, sizeof *environment);
    int have_data = 0, have_environment = 0, virtio_disks = 0;
    enum wg_discover_status result = WG_DISCOVER_OK;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL && result == WG_DISCOVER_OK) {
        if (entry->d_name[0] == '.') continue;
        char subsystem[PATH_MAX], base[64];
        if (join(subsystem, sizeof subsystem, path, entry->d_name, "device/subsystem") != 0) continue;
        if (link_basename(subsystem, base, sizeof base) != 0 || strcmp(base, "virtio") != 0) continue; /* loop, ram, dm, ...: not ours */
        if (!name_ok(entry->d_name)) { say(why, why_capacity, "block-name"); result = WG_DISCOVER_REFUSED; break; }
        if (++virtio_disks > 2) { say(why, why_capacity, "extra-virtio-disk"); result = WG_DISCOVER_REFUSED; break; }
        char file[PATH_MAX], serial[64], devtext[64];
        struct wg_disk disk;
        memset(&disk, 0, sizeof disk);
        if (join(file, sizeof file, path, entry->d_name, "serial") != 0 || read_line(file, serial, sizeof serial) != 0) {
            say(why, why_capacity, "no-serial"); result = WG_DISCOVER_NOT_YET; break;
        }
        if (join(file, sizeof file, path, entry->d_name, "dev") != 0 || read_line(file, devtext, sizeof devtext) != 0 || parse_dev(devtext, &disk.major, &disk.minor) != 0) {
            say(why, why_capacity, "no-dev"); result = WG_DISCOVER_NOT_YET; break;
        }
        snprintf(disk.name, sizeof disk.name, "%s", entry->d_name);
        snprintf(disk.serial, sizeof disk.serial, "%s", serial);
        if (join(disk.node, sizeof disk.node, dev_root, entry->d_name, "") != 0) { result = WG_DISCOVER_REFUSED; break; }
        struct wg_disk *slot = NULL;
        int *have = NULL;
        if (strcmp(serial, WG_DATA_SERIAL) == 0) { slot = data; have = &have_data; }
        else if (strcmp(serial, WG_ENVIRONMENT_SERIAL) == 0) { slot = environment; have = &have_environment; }
        else { say(why, why_capacity, "unexpected-virtio-disk"); result = WG_DISCOVER_REFUSED; break; }
        if (*have) { say(why, why_capacity, "duplicate-serial"); result = WG_DISCOVER_REFUSED; break; }
        *slot = disk;
        *have = 1;
        /* The node must exist and be exactly this block device (devtmpfs may lag the sysfs entry). */
        struct stat st;
        if (examine(env, disk.node, &st) != 0) { say(why, why_capacity, "node-missing"); result = WG_DISCOVER_NOT_YET; break; }
        if (!S_ISBLK(st.st_mode) || (unsigned)major(st.st_rdev) != disk.major || (unsigned)minor(st.st_rdev) != disk.minor) {
            say(why, why_capacity, "node-identity"); result = WG_DISCOVER_REFUSED; break;
        }
    }
    closedir(directory);
    if (result != WG_DISCOVER_OK) return result;
    if (!have_data || !have_environment) { say(why, why_capacity, "disk-missing"); return WG_DISCOVER_NOT_YET; }
    return WG_DISCOVER_OK;
}

/* Fixed identity of the admitted generic port: VERSION_1 (bit 32) and MULTIPORT (bit 1) only, 128 feature characters. */
static int single_console_features(const char *features) {
    if (strlen(features) != 128) return 0;
    for (unsigned bit = 0; bit < 128; bit++)
        if (features[bit] != ((bit == 32 || bit == 1) ? '1' : '0')) return 0;
    return 1;
}

enum wg_discover_status wg_find_port(const struct wg_discover_env *env, struct wg_port *port, char *why, size_t why_capacity) {
    const char *sys_root = env->sys_root, *dev_root = env->dev_root;
    char devices[PATH_MAX], path[PATH_MAX], value[200], console_real[PATH_MAX], parent[PATH_MAX];
    memset(port, 0, sizeof *port);
    if (join(devices, sizeof devices, sys_root, "bus/virtio/devices", "") != 0) { say(why, why_capacity, "path"); return WG_DISCOVER_REFUSED; }
    DIR *directory = opendir(devices);
    if (!directory) { say(why, why_capacity, "no-virtio-bus"); return WG_DISCOVER_NOT_YET; }
    unsigned count = 0, consoles = 0, console_index = 0;
    enum wg_discover_status result = WG_DISCOVER_OK;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (entry->d_name[0] == '.') continue;
        if (++count > 16) { say(why, why_capacity, "too-many-virtio-devices"); result = WG_DISCOVER_REFUSED; break; }
        unsigned index;
        char extra = 0;
        if (sscanf(entry->d_name, "virtio%u%c", &index, &extra) != 1) { say(why, why_capacity, "virtio-name"); result = WG_DISCOVER_REFUSED; break; }
        if (join(path, sizeof path, devices, entry->d_name, "device") != 0 || read_line(path, value, sizeof value) != 0) continue;
        if (strcmp(value, "0x0003") != 0) continue;
        if (++consoles != 1) { say(why, why_capacity, "second-console"); result = WG_DISCOVER_REFUSED; break; }
        console_index = index;
        if (join(path, sizeof path, devices, entry->d_name, "features") != 0 || read_line(path, value, sizeof value) != 0 || !single_console_features(value)) {
            say(why, why_capacity, "console-features"); result = WG_DISCOVER_REFUSED; break;
        }
        char driver[64];
        if (join(path, sizeof path, devices, entry->d_name, "driver") != 0 || link_basename(path, driver, sizeof driver) != 0) {
            say(why, why_capacity, "console-not-bound"); result = WG_DISCOVER_NOT_YET; break;
        }
        if (strcmp(driver, "virtio_console") != 0) { say(why, why_capacity, "console-driver"); result = WG_DISCOVER_REFUSED; break; }
        if (join(path, sizeof path, devices, entry->d_name, "") != 0 || !realpath(path, console_real)) { say(why, why_capacity, "console-path"); result = WG_DISCOVER_REFUSED; break; }
    }
    closedir(directory);
    if (result != WG_DISCOVER_OK) return result;
    if (consoles != 1) { say(why, why_capacity, "no-console"); return WG_DISCOVER_NOT_YET; }

    char ports[PATH_MAX], want[32];
    snprintf(want, sizeof want, "vport%up0", console_index);
    if (join(ports, sizeof ports, sys_root, "class/virtio-ports", "") != 0) { say(why, why_capacity, "path"); return WG_DISCOVER_REFUSED; }
    directory = opendir(ports);
    if (!directory) { say(why, why_capacity, "no-ports-class"); return WG_DISCOVER_NOT_YET; }
    unsigned seen = 0;
    while ((entry = readdir(directory)) != NULL) {
        if (entry->d_name[0] == '.') continue;
        if (++seen > 1 || strcmp(entry->d_name, want) != 0) { say(why, why_capacity, "port-inventory"); result = WG_DISCOVER_REFUSED; break; }
        if (join(path, sizeof path, ports, entry->d_name, "device") != 0 || !realpath(path, parent) || strcmp(parent, console_real) != 0) {
            say(why, why_capacity, "port-parent"); result = WG_DISCOVER_REFUSED; break;
        }
        if (join(path, sizeof path, ports, entry->d_name, "dev") != 0 || read_line(path, value, sizeof value) != 0 ||
            parse_dev(value, &port->major, &port->minor) != 0 || port->major == 0 || port->minor != 0) {
            say(why, why_capacity, "port-dev"); result = WG_DISCOVER_REFUSED; break;
        }
        snprintf(port->name, sizeof port->name, "%s", entry->d_name);
    }
    closedir(directory);
    if (result != WG_DISCOVER_OK) return result;
    if (seen != 1) { say(why, why_capacity, "no-port"); return WG_DISCOVER_NOT_YET; }
    if (join(port->node, sizeof port->node, dev_root, port->name, "") != 0) { say(why, why_capacity, "path"); return WG_DISCOVER_REFUSED; }
    struct stat st;
    if (examine(env, port->node, &st) != 0) { say(why, why_capacity, "node-missing"); return WG_DISCOVER_NOT_YET; }
    if (!S_ISCHR(st.st_mode) || (unsigned)major(st.st_rdev) != port->major || (unsigned)minor(st.st_rdev) != port->minor) { say(why, why_capacity, "node-identity"); return WG_DISCOVER_REFUSED; }
    return WG_DISCOVER_OK;
}
