/* Test-only single-workspace worker. No Winter integration or credential APIs. */
#include "libkrun.h"
#include <errno.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <mach-o/dyld.h>
#include <netinet/in.h>
#include <pthread.h>
#include <sandbox.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

/* Seatbelt SPI also used by Winter's OfficeHelper bridge. Not a stable public SDK API. */
extern int sandbox_init_with_parameters(const char *, uint64_t, const char *const [], char **);
extern int sandbox_check(pid_t, const char *, int);
extern int32_t krun_enable_cowork_block_fixture_reclaim(uint32_t);
#define FIXTURE_RUN_MODE "--run-raw-block-fixture"

static void require(int yes, const char *operation) {
    if (!yes) { fprintf(stderr, "fixture refused: %s (errno=%d)\n", operation, errno); exit(1); }
}
static void api(int result, const char *operation) {
    if (result < 0) { fprintf(stderr, "fixture failed: %s (%d)\n", operation, result); exit(1); }
}
static void *sample(void *unused) {
    (void)unused;
    for (;;) {
        task_vm_info_data_t info = {0}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
        if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count) == KERN_SUCCESS)
            fprintf(stderr, "{\"kind\":\"host_memory\",\"pid\":%d,\"footprintBytes\":%llu,\"residentBytes\":%llu}\n",
                    getpid(), (unsigned long long)info.phys_footprint, (unsigned long long)info.resident_size);
        sleep(1);
    }
}
int main(int argc, char **argv) {
    require(argc == 6 && (!strcmp(argv[1], FIXTURE_RUN_MODE) || !strcmp(argv[1], "--sandbox-check")), "explicit fixture mode required");
    char executable[4096], resolved[4096], kernel[4096], initramfs[4096], disk[4096]; uint32_t length = sizeof executable;
    require(_NSGetExecutablePath(executable, &length) == 0 && realpath(executable, resolved), "worker path");
    char *slash = strrchr(resolved, '/'); require(slash != NULL, "worker directory"); *slash = 0;
    require(!strcmp(resolved, argv[2]), "fixture must be worker's canonical directory");
    require(snprintf(kernel, sizeof kernel, "%s/kernel", resolved) < (int)sizeof kernel &&
            snprintf(initramfs, sizeof initramfs, "%s/initramfs.cpio", resolved) < (int)sizeof initramfs, "artifact paths");
    require(!strcmp(kernel, argv[3]) && !strcmp(initramfs, argv[4]), "only fixture artifacts allowed");
    require(snprintf(disk,sizeof disk,"%s/fixture.raw",resolved)<(int)sizeof disk && !strcmp(disk,argv[5]),"only fixture RAW disk allowed");
    struct stat before,after;require(lstat(disk,&before)==0 && S_ISREG(before.st_mode) && before.st_nlink==1 && before.st_size==64LL*1024*1024 && (before.st_mode&0777)==0600 && before.st_uid==getuid(),"owned regular bounded disk");
    int disk_probe=open(disk,O_RDWR|O_NOFOLLOW);require(disk_probe>=0 && fstat(disk_probe,&after)==0 && before.st_dev==after.st_dev && before.st_ino==after.st_ino,"disk inode identity");close(disk_probe);
    struct stat artifact;
    require(lstat(kernel, &artifact) == 0 && S_ISREG(artifact.st_mode) &&
            lstat(initramfs, &artifact) == 0 && S_ISREG(artifact.st_mode), "regular fixture artifacts");
    /* Parameterized paths avoid embedding untrusted text in Scheme. No host directory is exported. */
    const char *profile = "(version 1)(deny default)"
        "(allow sysctl-read)(allow process-info* (target self))"
        "(allow file-read* (subpath \"/System\") (subpath \"/usr/lib\") (subpath (param \"FIXTURE\")))"
        "(allow file-read* (literal \"/dev/null\") (literal \"/dev/random\") (literal \"/dev/urandom\"))"
        "(allow file-write* (literal (param \"DISK\")))";
    const char *parameters[] = { "FIXTURE", argv[2], "DISK",disk,NULL };
    char *error = NULL;
    require(sandbox_init_with_parameters(profile, 0, parameters, &error) == 0, error ? error : "sandbox install");
    require(sandbox_check(getpid(), NULL, 0) != 0, "sandbox state");
    /* Refuse to boot if either authority probe escapes the sandbox. No private file is read. */
    int fd = open("/etc/hosts", O_RDONLY);
    require(fd < 0 && errno == EPERM, "host file read denial");
    fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd >= 0) {
        struct sockaddr_in target = { .sin_len = sizeof target, .sin_family = AF_INET,
            .sin_port = htons(9), .sin_addr = { .s_addr = htonl(INADDR_LOOPBACK) } };
        int rc = connect(fd, (struct sockaddr *)&target, sizeof target), denied_errno = errno;
        close(fd); require(rc < 0 && denied_errno == EPERM, "network outbound denial");
    } else require(errno == EPERM, "network socket denial");
    char denied[4096]; require(snprintf(denied, sizeof denied, "%s/denied-write", argv[2]) < (int)sizeof denied, "fixture path length");
    fd = open(denied, O_CREAT | O_WRONLY, 0600);
    require(fd < 0 && errno == EPERM, "filesystem write denial");
    disk_probe=open(disk,O_RDWR|O_NOFOLLOW);require(disk_probe>=0 && fstat(disk_probe,&after)==0 && before.st_dev==after.st_dev && before.st_ino==after.st_ino,"sandbox admits only same raw inode");uint64_t zero=0,readback=1;require(pwrite(disk_probe,&zero,sizeof zero,0)==sizeof zero && pread(disk_probe,&readback,sizeof readback,0)==sizeof readback && readback==0 && fsync(disk_probe)==0 && fcntl(disk_probe,F_FULLFSYNC)==0,"sandbox RAW read/write/full-sync proof");close(disk_probe);
    fprintf(stderr, "{\"kind\":\"sandbox\",\"hostReadDenied\":true,\"networkOutboundDenied\":true,\"unrelatedWritesDenied\":true,\"rawDiskOnly\":true,\"rawReadWriteFullSync\":true}\n");
    if (!strcmp(argv[1], "--sandbox-check")) return 0;
    alarm(120);
    pthread_t sampler; require(pthread_create(&sampler, NULL, sample, NULL) == 0, "sampler thread");
    api(krun_init_log(2, KRUN_LOG_LEVEL_INFO, KRUN_LOG_STYLE_NEVER, KRUN_LOG_OPTION_NO_ENV), "log");
    int ctx = krun_create_ctx(); api(ctx, "context");
    api(krun_set_vm_config(ctx, 2, 768), "bounded configuration");
    api(krun_disable_implicit_vsock(ctx), "disable implicit vsock");
    const char *env[] = { NULL }; api(krun_set_env(ctx, env), "empty environment");
    api(krun_disable_implicit_console(ctx), "disable implicit console");
    api(krun_add_serial_console_default(ctx, -1, 1), "PL011 output-only serial");
    api(krun_set_kernel(ctx, argv[3], KRUN_KERNEL_FORMAT_RAW, argv[4],
        "console=ttyAMA0 keep_bootcon printk.devkmsg=on rdinit=/init panic=1 reboot=k loglevel=4"), "external kernel/initramfs");
    api(krun_enable_cowork_block_fixture_reclaim(ctx), "explicit fixture reclaim opt-in");
    fprintf(stderr,"{\"kind\":\"reclaim_profile\",\"console\":\"PL011\",\"implicitConsole\":false,\"fixtureOnly\":true}\n");
    api(krun_add_disk3(ctx,"fixture-raw",disk,KRUN_DISK_FORMAT_RAW,false,false,2),"one RAW Full-sync disk");

    fprintf(stderr, "{\"kind\":\"worker\",\"pid\":%d,\"vcpus\":2,\"ramMiB\":768,\"networkDevices\":0,\"vsock\":false,\"hostShares\":0}\n", getpid());
    api(krun_start_enter(ctx), "start");
    return 1; /* Successful krun_start_enter owns the process and never returns. */
}
