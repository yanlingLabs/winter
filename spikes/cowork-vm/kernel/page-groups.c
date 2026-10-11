#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE 1
#define _DEFAULT_SOURCE 1
/* Trusted, bounded guest diagnostic; never invokes a shell, allocates pressure, or dumps PFNs.
 * CLI: page-groups baseline|compare --dir ABS_OWNED_0700_DIR --file baseline.bin --ram-mib 1024
 *      page-groups --self-test (portable: does not open /proc)
 * stdout: one schemaVersion=1 JSON record. Errors are ok=false, never a zero-count fallback.
 * Baseline file is private and contains canonical RAM ranges + OFFLINE/NOPAGE state bytes.
 * Digests are SHA-256 over little-endian range pairs / range pairs followed by state bytes.
 * Linux v6.18 primary references (diagnostic meanings, not host reclamation evidence):
 * https://raw.githubusercontent.com/torvalds/linux/v6.18/fs/proc/page.c
 * https://raw.githubusercontent.com/torvalds/linux/v6.18/include/uapi/linux/kernel-page-flags.h
 * https://raw.githubusercontent.com/torvalds/linux/v6.18/kernel/resource.c
 * https://raw.githubusercontent.com/torvalds/linux/v6.18/drivers/virtio/virtio_balloon.c
 * https://raw.githubusercontent.com/torvalds/linux/v6.18/mm/page_alloc.c
 */
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define PAGE_BYTES UINT64_C(4096)
#define MAX_RAM_BYTES (UINT64_C(1024) * 1024 * 1024)
#define MAX_ENTRIES (MAX_RAM_BYTES / PAGE_BYTES)
#define MAX_RANGES 256
#define FLAGS_CHUNK_BYTES 65536
#define MAX_FLAGS_BYTES (MAX_ENTRIES * 8)
#define MAX_MAP_BYTES 262144
#define MAX_RESERVED_GAP (UINT64_C(128) * 1024 * 1024)
#define GAP_TOLERANCE (UINT64_C(8) * 1024 * 1024)
#define OFFLINE_STATE 1
#define NOPAGE_STATE 2
#define KPF_OFFLINE (UINT64_C(1) << 23)
#define KPF_NOPAGE (UINT64_C(1) << 20)
#define HEADER_BYTES 256
#define DIGEST_BYTES 32
_Static_assert(sizeof(off_t) >= 8, "64-bit file offsets are required");

struct range { uint64_t start, end, first, limit, index; };
struct snapshot {
    struct range ranges[MAX_RANGES]; size_t count;
    uint64_t configured, ram_bytes, mem_kib, entries, flags_read;
    char features[129],device[64];
    uint8_t *states;
};
struct counts {
    uint64_t offline, nopage, covered_groups, excluded_groups, edge_pages, newly_full;
    uint64_t histogram[5], baseline_histogram[5];
    int64_t gap, baseline_gap;
};

/* Self-contained SHA-256: SHA-256 constants and operations from FIPS 180-4, no external library. */
struct sha256 { uint32_t h[8]; uint64_t bytes; size_t used; uint8_t block[64]; };
static uint32_t ror(uint32_t value, unsigned n) { return (value >> n) | (value << (32 - n)); }
static void sha_block(struct sha256 *s, const uint8_t *p) {
    static const uint32_t k[64] = {
        0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
        0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
        0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
        0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
        0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
        0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
        0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
        0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
    };
    uint32_t w[64];
    for (unsigned i = 0; i < 16; i++) w[i] = ((uint32_t)p[i*4] << 24) | ((uint32_t)p[i*4+1] << 16) | ((uint32_t)p[i*4+2] << 8) | p[i*4+3];
    for (unsigned i = 16; i < 64; i++) w[i] = w[i-16] + (ror(w[i-15],7)^ror(w[i-15],18)^(w[i-15]>>3)) + w[i-7] + (ror(w[i-2],17)^ror(w[i-2],19)^(w[i-2]>>10));
    uint32_t a=s->h[0], b=s->h[1], c=s->h[2], d=s->h[3], e=s->h[4], f=s->h[5], g=s->h[6], h=s->h[7];
    for (unsigned i = 0; i < 64; i++) {
        uint32_t t1=h+(ror(e,6)^ror(e,11)^ror(e,25))+((e&f)^((~e)&g))+k[i]+w[i];
        uint32_t t2=(ror(a,2)^ror(a,13)^ror(a,22))+((a&b)^(a&c)^(b&c));
        h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
    }
    s->h[0]+=a; s->h[1]+=b; s->h[2]+=c; s->h[3]+=d; s->h[4]+=e; s->h[5]+=f; s->h[6]+=g; s->h[7]+=h;
}
static void sha_init(struct sha256 *s) {
    *s = (struct sha256){ .h={0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u} };
}
static void sha_update(struct sha256 *s, const void *data, size_t bytes) {
    const uint8_t *p=data; s->bytes += bytes;
    while (bytes) {
        size_t n=64-s->used; if (n>bytes) n=bytes;
        memcpy(s->block+s->used,p,n); s->used+=n; p+=n; bytes-=n;
        if (s->used==64) { sha_block(s,s->block); s->used=0; }
    }
}
static void sha_finish(struct sha256 *s, uint8_t out[32]) {
    uint64_t bits=s->bytes*8; uint8_t one=0x80, zero=0;
    sha_update(s,&one,1); while (s->used!=56) sha_update(s,&zero,1);
    uint8_t length[8]; for (unsigned i=0;i<8;i++) length[7-i]=(uint8_t)(bits>>(i*8));
    sha_update(s,length,8);
    for (unsigned i=0;i<8;i++) for (unsigned j=0;j<4;j++) out[i*4+j]=(uint8_t)(s->h[i]>>(24-j*8));
}
static void put64(uint8_t *p, uint64_t value) { for (unsigned i=0;i<8;i++) p[i]=(uint8_t)(value>>(i*8)); }
static uint64_t get64(const uint8_t *p) { uint64_t value=0; for (unsigned i=0;i<8;i++) value |= (uint64_t)p[i]<<(i*8); return value; }
static void hex_digest(const uint8_t digest[32], char out[65]) {
    static const char hex[]="0123456789abcdef";
    for (unsigned i=0;i<32;i++) { out[i*2]=hex[digest[i]>>4]; out[i*2+1]=hex[digest[i]&15]; } out[64]=0;
}
static void snapshot_digest(const struct snapshot *s, int bitmap, char out[65]) {
    struct sha256 sha; uint8_t pair[16], digest[32]; sha_init(&sha);
    for (size_t i=0;i<s->count;i++) { put64(pair,s->ranges[i].start); put64(pair+8,s->ranges[i].end); sha_update(&sha,pair,sizeof(pair)); }
    if (bitmap) sha_update(&sha,s->states,(size_t)s->entries);
    sha_finish(&sha,digest); hex_digest(digest,out);
}

static int range_order(const void *a, const void *b) {
    const struct range *x=a, *y=b;
    return x->start<y->start ? -1 : x->start>y->start ? 1 : x->end<y->end ? -1 : x->end>y->end;
}
static const char *finish_ranges(struct snapshot *s) {
    if (!s->count) return "ram_map_empty";
    qsort(s->ranges,s->count,sizeof(s->ranges[0]),range_order);
    size_t merged=0;
    for (size_t i=0;i<s->count;i++) {
        struct range r=s->ranges[i];
        if (r.end==UINT64_MAX || r.start>r.end) return "ram_range_overflow";
        if (r.start==0 && r.end==0) return "ram_map_redacted";
        if (merged && r.start<=s->ranges[merged-1].end+1) {
            if (r.end>s->ranges[merged-1].end) s->ranges[merged-1].end=r.end;
        } else s->ranges[merged++]=r;
    }
    s->count=merged; s->ram_bytes=0; s->entries=0;
    for (size_t i=0;i<s->count;i++) {
        struct range *r=&s->ranges[i]; uint64_t bytes=r->end-r->start+1;
        if (bytes>s->configured || s->ram_bytes>s->configured-bytes) return "ram_exceeds_configured";
        s->ram_bytes+=bytes;
        r->first=r->start/PAGE_BYTES+(r->start%PAGE_BYTES!=0);
        r->limit=(r->end+1)/PAGE_BYTES; r->index=s->entries;
        if (r->limit<=r->first) return "ram_range_without_full_page";
        uint64_t entries=r->limit-r->first;
        if (entries>MAX_ENTRIES || s->entries>MAX_ENTRIES-entries || r->limit>(uint64_t)INT64_MAX/8) return "pfn_budget_exceeded";
        s->entries+=entries;
    }
    return s->entries ? NULL : "ram_map_empty";
}
static int hex_number(const char **cursor, uint64_t *out) {
    const char *p=*cursor; uint64_t value=0; unsigned digits=0;
    while (isxdigit((unsigned char)*p)) {
        unsigned char c=(unsigned char)*p++; unsigned digit=c<='9' ? c-'0' : (unsigned)(tolower(c)-'a'+10);
        if (++digits>16 || value>(UINT64_MAX-digit)/16) return 0;
        value=value*16+digit;
    }
    if (!digits) return 0;
    *cursor=p; *out=value; return 1;
}
static const char *map_line(struct snapshot *s, char *line) {
    char *colon=strchr(line,':'); if (!colon) return strstr(line,"System RAM") ? "ram_map_malformed" : NULL;
    char *name=colon+1; while (*name==' ' || *name=='\t') name++;
    size_t n=strlen(name); while (n && (name[n-1]=='\n' || name[n-1]=='\r' || name[n-1]==' ' || name[n-1]=='\t')) name[--n]=0;
    if (strcmp(name,"System RAM")) return NULL;
    const char *p=line; while (*p==' ' || *p=='\t') p++;
    uint64_t start,end;
    if (!hex_number(&p,&start) || *p++!='-' || !hex_number(&p,&end)) return "ram_map_malformed";
    while (*p==' ' || *p=='\t') p++;
    if (p!=colon || s->count==MAX_RANGES) return "ram_map_malformed";
    if (start==0 && end==0) return "ram_map_redacted";
    s->ranges[s->count++]=(struct range){ .start=start,.end=end };
    return NULL;
}
static const char *parse_map(FILE *file, struct snapshot *s) {
    char line[1024]; size_t total=0;
    while (fgets(line,sizeof(line),file)) {
        size_t n=strlen(line); total+=n;
        if (total>MAX_MAP_BYTES || (n==sizeof(line)-1 && line[n-1]!='\n')) return "ram_map_budget_exceeded";
        const char *error=map_line(s,line); if (error) return error;
    }
    if (ferror(file)) return "ram_map_read_failed";
    return finish_ranges(s);
}
static const char *read_map(struct snapshot *s) {
    FILE *file=fopen("/proc/iomem","r"); if (!file) return "ram_map_unavailable";
    const char *error=parse_map(file,s); fclose(file); return error;
}
static int same_ranges(const struct snapshot *a, const struct snapshot *b) {
    if (a->configured!=b->configured || a->count!=b->count || a->entries!=b->entries) return 0;
    for (size_t i=0;i<a->count;i++) if (a->ranges[i].start!=b->ranges[i].start || a->ranges[i].end!=b->ranges[i].end) return 0;
    return 1;
}
static const char *read_memtotal(uint64_t *kib) {
    FILE *file=fopen("/proc/meminfo","r"); if (!file) return "memtotal_unavailable";
    char line[1024]; int found=0; size_t total=0; const char *error=NULL;
    while (fgets(line,sizeof(line),file)) {
        total+=strlen(line); if (total>MAX_MAP_BYTES) { error="memtotal_invalid"; break; }
        if (strncmp(line,"MemTotal:",9)) continue;
        if (found++) { error="memtotal_invalid"; break; }
        char *p=line+9; while (*p==' ' || *p=='\t') p++;
        if (!isdigit((unsigned char)*p)) { error="memtotal_invalid"; break; }
        errno=0; char *end; unsigned long long value=strtoull(p,&end,10);
        while (*end==' ' || *end=='\t') end++;
        if (errno || !value || value>MAX_RAM_BYTES/1024 || strcmp(end,"kB\n")) { error="memtotal_invalid"; break; }
        *kib=(uint64_t)value;
    }
    if (ferror(file) || !found) error="memtotal_invalid";
    fclose(file); return error;
}
static const char *read_balloon_features(struct snapshot *s) {
    DIR *dir=opendir("/sys/bus/virtio/devices"); if (!dir) return "balloon_features_unavailable";
    struct dirent *entry; unsigned seen=0,matching=0; const char *error=NULL;
    while ((entry=readdir(dir))) {
        if (++seen>256) { error="balloon_features_budget_exceeded"; break; }
        if (strncmp(entry->d_name,"virtio",6) || !isdigit((unsigned char)entry->d_name[6])) continue;
        int name_ok=1; for (const char *p=entry->d_name+6;*p;p++) if (!isdigit((unsigned char)*p)) name_ok=0;
        if (!name_ok || strlen(entry->d_name)>=sizeof(s->device)) { error="balloon_features_invalid"; break; }
        char path[256],value[256];
        int n=snprintf(path,sizeof(path),"/sys/bus/virtio/devices/%s/device",entry->d_name);
        if (n<0 || (size_t)n>=sizeof(path)) { error="balloon_features_invalid"; break; }
        FILE *file=fopen(path,"r"); if (!file) { error="balloon_features_unavailable"; break; }
        int got=fgets(value,sizeof(value),file)!=NULL,extra=fgetc(file); fclose(file);
        if (!got || extra!=EOF) { error="balloon_features_invalid"; break; }
        errno=0; char *end; unsigned long number=strtoul(value,&end,0);
        if (errno || (*end!='\n' && *end!=0) || (*end=='\n' && end[1])) { error="balloon_features_invalid"; break; }
        if (number!=5) continue;
        if (++matching!=1) { error="multiple_balloon_devices"; break; }
        n=snprintf(path,sizeof(path),"/sys/bus/virtio/devices/%s/features",entry->d_name);
        if (n<0 || (size_t)n>=sizeof(path)) { error="balloon_features_invalid"; break; }
        file=fopen(path,"r"); if (!file) { error="balloon_features_unavailable"; break; }
        got=fgets(value,sizeof(value),file)!=NULL; extra=fgetc(file); fclose(file);
        if (!got || extra!=EOF) { error="balloon_features_invalid"; break; }
        size_t length=strlen(value); if (length && value[length-1]=='\n') value[--length]=0;
        if (length<6 || length>128) { error="balloon_features_invalid"; break; }
        for (size_t i=0;i<length;i++) if (value[i]!='0' && value[i]!='1') error="balloon_features_invalid";
        if (error) break;
        strcpy(s->features,value); strcpy(s->device,entry->d_name);
    }
    closedir(dir); return error ? error : matching==1 ? NULL : "balloon_features_unavailable";
}
typedef ssize_t (*flags_reader)(void *, void *, size_t, off_t);
static ssize_t system_pread(void *context, void *buffer, size_t bytes, off_t offset) {
    return pread(*(int *)context,buffer,bytes,offset);
}
static const char *read_flags(struct snapshot *s, flags_reader reader, void *context) {
    if (!s->entries || s->entries>MAX_ENTRIES || s->entries*8>MAX_FLAGS_BYTES) return "pfn_budget_exceeded";
    s->states=calloc((size_t)s->entries,1); if (!s->states) return "allocation_failed";
    uint64_t buffer[FLAGS_CHUNK_BYTES/8]; s->flags_read=0;
    for (size_t r=0;r<s->count;r++) {
        const struct range *range=&s->ranges[r];
        for (uint64_t pfn=range->first;pfn<range->limit;) {
            uint64_t n=range->limit-pfn; if (n>FLAGS_CHUNK_BYTES/8) n=FLAGS_CHUNK_BYTES/8;
            size_t bytes=(size_t)n*8;
            if (pfn>(uint64_t)INT64_MAX/8 || s->flags_read>MAX_FLAGS_BYTES-bytes) return "pfn_budget_exceeded";
            ssize_t got;
            do { got=reader(context,buffer,bytes,(off_t)(pfn*8)); } while (got<0 && errno==EINTR);
            // A short record stream is unproven, never padded or interpreted as normal pages.
            if (got<0) return "kpageflags_read_failed";
            if ((size_t)got!=bytes) return "kpageflags_short_read";
            s->flags_read+=bytes;
            for (uint64_t i=0;i<n;i++) s->states[range->index+pfn-range->first+i]=(uint8_t)((buffer[i]&KPF_OFFLINE ? OFFLINE_STATE : 0) | (buffer[i]&KPF_NOPAGE ? NOPAGE_STATE : 0));
            pfn+=n;
        }
    }
    return NULL;
}
static const char *capture(struct snapshot *s) {
    if (sysconf(_SC_PAGESIZE)!=4096) return "unsupported_page_size";
    const char *error=read_balloon_features(s); if (error) return error;
    error=read_map(s); if (error) return error;
    int fd=open("/proc/kpageflags",O_RDONLY|O_CLOEXEC|O_NOFOLLOW); if (fd<0) return "kpageflags_unavailable";
    error=read_flags(s,system_pread,&fd); close(fd); if (error) return error;
    error=read_memtotal(&s->mem_kib); if (error) return error;
    struct snapshot after={ .configured=s->configured };
    error=read_map(&after); if (error) return error;
    if (!same_ranges(s,&after)) return "ram_ranges_changed";
    error=read_balloon_features(&after); if (error) return error;
    return !strcmp(s->features,after.features) && !strcmp(s->device,after.device) ? NULL : "balloon_features_changed";
}
static int64_t reservation_gap(const struct snapshot *s, uint64_t *offline, uint64_t *nopage) {
    *offline=0; *nopage=0;
    for (uint64_t i=0;i<s->entries;i++) {
        if (s->states[i]&NOPAGE_STATE) (*nopage)++;
        else if (s->states[i]&OFFLINE_STATE) (*offline)++;
    }
    return (int64_t)((s->entries-*nopage)*PAGE_BYTES)-(int64_t)(s->mem_kib*1024)-(s->features[2]=='1' ? 0 : (int64_t)(*offline*PAGE_BYTES));
}
static void compare_counts(const struct snapshot *baseline, const struct snapshot *current, struct counts *out) {
    memset(out,0,sizeof(*out)); uint64_t old_offline,old_nopage;
    out->gap=reservation_gap(current,&out->offline,&out->nopage);
    out->baseline_gap=reservation_gap(baseline,&old_offline,&old_nopage);
    for (size_t r=0;r<current->count;r++) {
        const struct range *range=&current->ranges[r]; uint64_t group=(range->first+3)/4*4;
        uint64_t full=(range->limit>group ? (range->limit-group)/4 : 0);
        out->edge_pages+=(range->limit-range->first)-full*4;
        for (uint64_t pfn=group;pfn+4<=range->limit;pfn+=4) {
            unsigned before=0,after=0; int exclude=0;
            for (unsigned j=0;j<4;j++) {
                uint64_t index=range->index+pfn-range->first+j;
                uint8_t a=baseline->states[index],b=current->states[index];
                exclude |= ((a|b)&NOPAGE_STATE)!=0;
                before+=(a&OFFLINE_STATE)!=0; after+=(b&OFFLINE_STATE)!=0;
            }
            out->covered_groups++;
            if (exclude) { out->excluded_groups++; continue; }
            out->histogram[after]++; out->baseline_histogram[before]++;
            if (before==0 && after==4) out->newly_full++;
        }
    }
}

static int trusted_directory(const char *path) {
    if (!path || path[0]!='/' || strlen(path)>PATH_MAX-1) return -1;
    char copy[PATH_MAX]; strcpy(copy,path);
    int fd=open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC); if (fd<0) return -1;
    char *save=NULL,*part=strtok_r(copy,"/",&save);
    if (!part) { close(fd); return -1; }
    while (part) {
        if (!strcmp(part,".") || !strcmp(part,"..")) { close(fd); return -1; }
        int next=openat(fd,part,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW); close(fd); if (next<0) return -1;
        fd=next; part=strtok_r(NULL,"/",&save);
    }
    struct stat st;
    if (fstat(fd,&st) || !S_ISDIR(st.st_mode) || st.st_uid!=geteuid() || (st.st_mode&0777)!=0700) { close(fd); return -1; }
    return fd;
}
static int safe_filename(const char *name) {
    size_t n=name ? strlen(name) : 0;
    if (!n || n>64 || !isalnum((unsigned char)name[0])) return 0;
    for (size_t i=1;i<n;i++) if (!isalnum((unsigned char)name[i]) && name[i]!='.' && name[i]!='-' && name[i]!='_') return 0;
    return 1;
}
static int exact_io(int fd, void *buffer, size_t bytes, int writing) {
    uint8_t *p=buffer;
    while (bytes) {
        ssize_t n=writing ? write(fd,p,bytes) : read(fd,p,bytes);
        if (n<0 && errno==EINTR) continue;
        if (n<=0) return 0;
        p+=n; bytes-=(size_t)n;
    }
    return 1;
}
static uint8_t *encode_snapshot(const struct snapshot *s, size_t *bytes) {
    *bytes=HEADER_BYTES+s->count*16+(size_t)s->entries+DIGEST_BYTES;
    uint8_t *data=calloc(*bytes,1); if (!data) return NULL;
    memcpy(data,"WPGMAP01",8); put64(data+8,s->configured); put64(data+16,s->mem_kib); put64(data+24,s->count); put64(data+32,s->entries);
    put64(data+40,strlen(s->features)); put64(data+48,strlen(s->device));
    memcpy(data+56,s->features,strlen(s->features)); memcpy(data+184,s->device,strlen(s->device));
    for (size_t i=0;i<s->count;i++) { put64(data+HEADER_BYTES+i*16,s->ranges[i].start); put64(data+HEADER_BYTES+i*16+8,s->ranges[i].end); }
    memcpy(data+HEADER_BYTES+s->count*16,s->states,(size_t)s->entries);
    struct sha256 sha; sha_init(&sha); sha_update(&sha,data,*bytes-DIGEST_BYTES); sha_finish(&sha,data+*bytes-DIGEST_BYTES);
    return data;
}
static const char *write_baseline(int dir, const char *name, const struct snapshot *s) {
    size_t bytes; uint8_t *data=encode_snapshot(s,&bytes); if (!data) return "allocation_failed";
    int fd=openat(dir,name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
    if (fd<0) { free(data); return "baseline_create_refused"; }
    struct stat st; const char *error=NULL;
    if (fchmod(fd,0600) || fstat(fd,&st) || !S_ISREG(st.st_mode) || st.st_uid!=geteuid() || st.st_nlink!=1 || (st.st_mode&0777)!=0600) error="baseline_permissions_invalid";
    if (!error && (!exact_io(fd,data,bytes,1) || fsync(fd))) error="baseline_write_failed";
    if (close(fd) && !error) error="baseline_write_failed";
    if (error) unlinkat(dir,name,0);
    else if (fsync(dir)) error="baseline_write_failed";
    free(data); return error;
}
static const char *decode_snapshot(const uint8_t *data, size_t bytes, struct snapshot *s) {
    if (bytes<HEADER_BYTES+DIGEST_BYTES || memcmp(data,"WPGMAP01",8)) return "baseline_corrupt";
    uint64_t count=get64(data+24),entries=get64(data+32);
    if (!count || count>MAX_RANGES || !entries || entries>MAX_ENTRIES || bytes!=HEADER_BYTES+count*16+entries+DIGEST_BYTES || get64(data+8)!=s->configured) return "baseline_corrupt";
    uint8_t digest[32]; struct sha256 sha; sha_init(&sha); sha_update(&sha,data,bytes-DIGEST_BYTES); sha_finish(&sha,digest);
    if (memcmp(digest,data+bytes-DIGEST_BYTES,32)) return "baseline_corrupt";
    uint64_t features=get64(data+40),device=get64(data+48);
    if (features<6 || features>128 || device<=6 || device>=sizeof(s->device)) return "baseline_corrupt";
    memcpy(s->features,data+56,(size_t)features); s->features[features]=0;
    memcpy(s->device,data+184,(size_t)device); s->device[device]=0;
    for (uint64_t i=0;i<features;i++) if (s->features[i]!='0' && s->features[i]!='1') return "baseline_corrupt";
    if (strncmp(s->device,"virtio",6)) return "baseline_corrupt";
    for (const char *p=s->device+6;*p;p++) if (!isdigit((unsigned char)*p)) return "baseline_corrupt";
    s->count=(size_t)count; s->mem_kib=get64(data+16);
    if (!s->mem_kib || s->mem_kib>MAX_RAM_BYTES/1024) return "baseline_corrupt";
    for (size_t i=0;i<s->count;i++) {
        s->ranges[i]=(struct range){ .start=get64(data+HEADER_BYTES+i*16),.end=get64(data+HEADER_BYTES+i*16+8) };
        if (i && (s->ranges[i-1].end==UINT64_MAX || s->ranges[i].start<=s->ranges[i-1].end+1)) return "baseline_corrupt";
    }
    const char *error=finish_ranges(s); if (error || s->entries!=entries) return "baseline_corrupt";
    s->states=malloc((size_t)entries); if (!s->states) return "allocation_failed";
    memcpy(s->states,data+HEADER_BYTES+count*16,(size_t)entries);
    for (uint64_t i=0;i<entries;i++) if (s->states[i]>3) return "baseline_corrupt";
    return NULL;
}
static const char *load_baseline(int dir, const char *name, struct snapshot *s) {
    int fd=openat(dir,name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC); if (fd<0) return "baseline_open_refused";
    struct stat st; const char *error=NULL;
    if (fstat(fd,&st) || !S_ISREG(st.st_mode) || st.st_uid!=geteuid() || st.st_nlink!=1 || (st.st_mode&0777)!=0600) error="baseline_permissions_invalid";
    size_t max=HEADER_BYTES+MAX_RANGES*16+(size_t)MAX_ENTRIES+DIGEST_BYTES;
    if (!error && (st.st_size<HEADER_BYTES+DIGEST_BYTES || (uint64_t)st.st_size>max)) error="baseline_corrupt";
    uint8_t *data=NULL;
    if (!error) {
        data=malloc((size_t)st.st_size); if (!data) error="allocation_failed";
        else if (!exact_io(fd,data,(size_t)st.st_size,0)) error="baseline_read_failed";
        else { uint8_t extra; if (read(fd,&extra,1)!=0) error="baseline_corrupt"; }
    }
    if (!error) error=decode_snapshot(data,(size_t)st.st_size,s);
    free(data); close(fd); return error;
}
static void emit_error(const char *operation, const char *error) {
    printf("{\"schemaVersion\":1,\"ok\":false,\"operation\":\"%s\",\"error\":\"%s\"}\n",operation,error);
}
static int coverage_valid(const struct snapshot *baseline, const struct snapshot *current, const struct counts *counts, int comparing) {
    if (baseline->mem_kib*1024>baseline->ram_bytes || current->mem_kib*1024>current->ram_bytes || counts->baseline_gap<0 || (uint64_t)counts->baseline_gap>MAX_RESERVED_GAP) return 0;
    int64_t delta=counts->gap-counts->baseline_gap;
    return comparing ? delta>=-(int64_t)GAP_TOLERANCE && delta<=(int64_t)GAP_TOLERANCE : counts->gap>=0 && (uint64_t)counts->gap<=MAX_RESERVED_GAP;
}
static void emit_counts(const char *operation, const struct snapshot *baseline, const struct snapshot *current, const struct counts *c, int valid) {
    char ranges[65],before[65],after[65]; snapshot_digest(current,0,ranges); snapshot_digest(baseline,1,before); snapshot_digest(current,1,after);
    printf("{\"schemaVersion\":1,\"ok\":%s,\"operation\":\"%s\",\"error\":%s,\"coverageValidated\":%s,\"atomicSnapshot\":false,"
        "\"pageSize\":4096,\"configuredRamBytes\":%" PRIu64 ",\"systemRamBytes\":%" PRIu64 ",\"coveredRamBytes\":%" PRIu64 ",\"memTotalKiB\":%" PRIu64 ",\"baselineMemTotalKiB\":%" PRIu64 ","
        "\"rangeCount\":%zu,\"pfnEntries\":%" PRIu64 ",\"flagsBytesRead\":%" PRIu64 ",\"rangeDigest\":\"%s\",\"baselineBitmapDigest\":\"%s\",\"currentBitmapDigest\":\"%s\","
        "\"offlinePages\":%" PRIu64 ",\"noPagePages\":%" PRIu64 ",\"covered16KiBGroups\":%" PRIu64 ",\"excludedNoPageGroups\":%" PRIu64 ",\"unalignedEdgePages\":%" PRIu64 ","
        "\"offlineHistogram\":[%" PRIu64 ",%" PRIu64 ",%" PRIu64 ",%" PRIu64 ",%" PRIu64 "],"
        "\"baselineOfflineHistogram\":[%" PRIu64 ",%" PRIu64 ",%" PRIu64 ",%" PRIu64 ",%" PRIu64 "],"
        "\"balloonDevice\":\"%s\",\"balloonFeatures\":\"%s\",\"featureBitOrder\":\"least-feature-index-first\",\"deflateOnOOM\":%s,"
        "\"newlyFullOffline16KiBGroups\":%" PRIu64 ",\"newlyFullOfflineBytes\":%" PRIu64 ",\"reservationGapBytes\":%" PRId64 ",\"baselineReservationGapBytes\":%" PRId64 ",\"coverageToleranceBytes\":%" PRIu64 ",\"digestAlgorithm\":\"sha256\",\"hostReclaimVerified\":false}\n",
        valid?"true":"false",operation,valid?"null":"\"coverage_inconsistent\"",valid?"true":"false",
        current->configured,current->ram_bytes,current->entries*PAGE_BYTES,current->mem_kib,baseline->mem_kib,
        current->count,current->entries,current->flags_read,ranges,before,after,c->offline,c->nopage,c->covered_groups,c->excluded_groups,c->edge_pages,
        c->histogram[0],c->histogram[1],c->histogram[2],c->histogram[3],c->histogram[4],
        c->baseline_histogram[0],c->baseline_histogram[1],c->baseline_histogram[2],c->baseline_histogram[3],c->baseline_histogram[4],
        current->device,current->features,current->features[2]=='1'?"true":"false",
        c->newly_full,c->newly_full*16384,c->gap,c->baseline_gap,GAP_TOLERANCE);
}

static int self_test(void);
int main(int argc, char **argv) {
    if (argc==2 && !strcmp(argv[1],"--self-test")) return self_test();
    const char *operation=argc>1 && !strcmp(argv[1],"baseline") ? "baseline" : argc>1 && !strcmp(argv[1],"compare") ? "compare" : "invalid";
    const char *dir=NULL,*file=NULL; uint64_t ram_mib=0;
    if (!strcmp(operation,"invalid") || argc!=8) { emit_error(operation,"invalid_arguments"); return 1; }
    for (int i=2;i<argc;i+=2) {
        if (!strcmp(argv[i],"--dir") && !dir) dir=argv[i+1];
        else if (!strcmp(argv[i],"--file") && !file) file=argv[i+1];
        else if (!strcmp(argv[i],"--ram-mib") && !ram_mib) {
            const char *p=argv[i+1]; if (!*p) { emit_error(operation,"invalid_arguments"); return 1; }
            for (const char *q=p;*q;q++) if (!isdigit((unsigned char)*q)) { emit_error(operation,"invalid_arguments"); return 1; }
            errno=0; char *end; unsigned long long value=strtoull(p,&end,10);
            if (errno || *end || value<1 || value>1024) { emit_error(operation,"invalid_arguments"); return 1; }
            ram_mib=(uint64_t)value;
        } else { emit_error(operation,"invalid_arguments"); return 1; }
    }
    if (!dir || !safe_filename(file) || !ram_mib) { emit_error(operation,"invalid_arguments"); return 1; }
    int directory=trusted_directory(dir); if (directory<0) { emit_error(operation,"trusted_directory_refused"); return 1; }
    struct snapshot current={ .configured=ram_mib*1024*1024 },baseline={ .configured=ram_mib*1024*1024 };
    int comparing=!strcmp(operation,"compare"); const char *error=comparing ? load_baseline(directory,file,&baseline) : NULL;
    if (!error) error=capture(&current);
    if (!error && comparing && !same_ranges(&baseline,&current)) error="ram_ranges_changed";
    if (!error && comparing && (strcmp(baseline.features,current.features) || strcmp(baseline.device,current.device))) error="balloon_features_changed";
    if (error) { emit_error(operation,error); free(current.states); free(baseline.states); close(directory); return 1; }
    const struct snapshot *old=comparing ? &baseline : &current;
    struct counts counts; compare_counts(old,&current,&counts); int valid=coverage_valid(old,&current,&counts,comparing);
    if (valid && !comparing) error=write_baseline(directory,file,&current);
    if (error) emit_error(operation,error); else emit_counts(operation,old,&current,&counts,valid);
    free(current.states); free(baseline.states); close(directory); return valid && !error ? 0 : 1;
}

/* Tests exercise the exact production parser, reader bounds, group counting and private-file codec.
 * Inputs are strings and injected flag readers, never the host /proc filesystem. */
static unsigned tests;
#define CHECK(condition) do { tests++; if (!(condition)) { fprintf(stderr,"self-test assertion %u failed at source line %d\n",tests,__LINE__); emit_error("self-test","assertion_failed"); return 1; } } while (0)
static const char *fixture_map(const char *text, struct snapshot *s) {
    FILE *f=tmpfile(); if (!f) return "fixture_io_failed";
    fwrite(text,1,strlen(text),f); rewind(f); const char *error=parse_map(f,s); fclose(f); return error;
}
struct fake_reader { uint64_t calls,bytes; int bad_bounds,short_read,interrupt_once; struct snapshot *map; };
static ssize_t fixture_flags(void *context, void *buffer, size_t bytes, off_t offset) {
    struct fake_reader *f=context;
    if (f->interrupt_once) { f->interrupt_once=0; errno=EINTR; return -1; }
    f->calls++; f->bytes+=bytes;
    uint64_t first=(uint64_t)offset/8,limit=first+bytes/8; int contained=0;
    for (size_t r=0;r<f->map->count;r++) if (first>=f->map->ranges[r].first && limit<=f->map->ranges[r].limit) contained=1;
    if (offset<0 || offset%8 || bytes>FLAGS_CHUNK_BYTES || bytes%8 || !contained || f->bytes>MAX_FLAGS_BYTES) f->bad_bounds=1;
    memset(buffer,0,bytes);
    return f->short_read ? (ssize_t)bytes-8 : (ssize_t)bytes;
}
static int self_test(void) {
    struct sha256 sha; uint8_t hash[32]; char hex[65]; sha_init(&sha); sha_update(&sha,"abc",3); sha_finish(&sha,hash); hex_digest(hash,hex);
    CHECK(!strcmp(hex,"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    sha_init(&sha); sha_finish(&sha,hash); hex_digest(hash,hex);
    CHECK(!strcmp(hex,"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
    struct snapshot s={ .configured=MAX_RAM_BYTES };
    CHECK(!fixture_map("00000000-00000fff : Reserved\n80000000-80007fff : System RAM\n  80008000-8000ffff : System RAM\n80004000-8000bfff : System RAM\n90000000-90000fff : System RAM Extra\n",&s));
    CHECK(s.count==1 && s.entries==16 && s.ram_bytes==65536 && s.ranges[0].first==UINT64_C(0x80000));
    struct snapshot partial={ .configured=MAX_RAM_BYTES };
    CHECK(!fixture_map("80000001-80004ffe : System RAM\n",&partial));
    CHECK(partial.ranges[0].first==UINT64_C(0x80001) && partial.entries==3);
    const char *invalid[]={"00000000-00000000 : System RAM\n", "80000000-8000ffff : System RAM Extra\n", "fffffffffffffffe-ffffffffffffffff : System RAM\n", "80001000-80000000 : System RAM\n", "+80000000-8000ffff : System RAM\n", "80000000-8000ffffx : System RAM\n", "80000000-10000000000000000 : System RAM\n", "00001000-00001fff : System RAM\n00000000-00000000 : System RAM\n"};
    for (size_t i=0;i<sizeof(invalid)/sizeof(invalid[0]);i++) { struct snapshot bad={ .configured=MAX_RAM_BYTES }; CHECK(fixture_map(invalid[i],&bad)!=NULL); }
    struct snapshot too_large={ .configured=MAX_RAM_BYTES };
    CHECK(fixture_map("80000000-c0000fff : System RAM\n",&too_large)!=NULL);
    struct snapshot big={ .configured=MAX_RAM_BYTES };
    CHECK(!fixture_map("8000000000-803fffffff : System RAM\n",&big));
    struct fake_reader reader={ .map=&big,.interrupt_once=1 };
    CHECK(!read_flags(&big,fixture_flags,&reader));
    CHECK(!reader.bad_bounds && reader.calls==32 && reader.bytes==MAX_FLAGS_BYTES && big.entries==MAX_ENTRIES);
    free(big.states);
    struct snapshot holes={ .configured=MAX_RAM_BYTES };
    CHECK(!fixture_map("80000000-80007fff : System RAM\n90000000-90007fff : System RAM\n",&holes));
    reader=(struct fake_reader){ .map=&holes }; CHECK(!read_flags(&holes,fixture_flags,&reader));
    CHECK(reader.calls==2 && reader.bytes==128 && !reader.bad_bounds); free(holes.states);
    reader=(struct fake_reader){ .map=&s,.short_read=1 }; CHECK(read_flags(&s,fixture_flags,&reader)!=NULL); free(s.states); s.states=NULL;
    struct snapshot base={ .configured=MAX_RAM_BYTES },now={ .configured=MAX_RAM_BYTES };
    strcpy(base.features,"000001"); strcpy(now.features,"000001"); strcpy(base.device,"virtio0"); strcpy(now.device,"virtio0");
    CHECK(!fixture_map("80001000-80011fff : System RAM\n",&base));
    CHECK(!fixture_map("80001000-80011fff : System RAM\n",&now));
    base.states=calloc((size_t)base.entries,1); now.states=calloc((size_t)now.entries,1); CHECK(base.states && now.states);
    base.mem_kib=base.entries*4; now.mem_kib=base.mem_kib;
    // Absolute aligned groups begin at PFNs ...004, ...008, ...00c; first/last edge pages excluded.
    for (unsigned i=3;i<7;i++) now.states[i]=OFFLINE_STATE;
    for (unsigned i=7;i<11;i++) now.states[i]=OFFLINE_STATE;
    base.states[7]=OFFLINE_STATE; // Previously partial, so this group is not newly fully offline.
    now.states[11]=OFFLINE_STATE|NOPAGE_STATE; // NOPAGE excludes the whole third group.
    struct counts c; compare_counts(&base,&now,&c);
    CHECK(c.covered_groups==3 && c.excluded_groups==1 && c.edge_pages==5 && c.newly_full==1);
    CHECK(c.histogram[4]==2 && c.baseline_histogram[0]==1 && c.baseline_histogram[1]==1 && c.offline==8 && c.nopage==1);
    base.states[11]=NOPAGE_STATE; now.states[11]=OFFLINE_STATE;
    compare_counts(&base,&now,&c); CHECK(c.excluded_groups==1 && c.newly_full==1);
    base.states[11]=0; now.states[11]=OFFLINE_STATE|NOPAGE_STATE;
    // Stable reservation accounting permits a lower MemTotal after balloon inflation.
    base.states[7]=0; base.mem_kib=64; now.mem_kib=28;
    compare_counts(&base,&now,&c); CHECK(c.baseline_gap==4096 && c.gap==4096 && coverage_valid(&base,&now,&c,1));
    c.gap=c.baseline_gap+(int64_t)GAP_TOLERANCE+1; CHECK(!coverage_valid(&base,&now,&c,1));
    base.features[2]='1'; now.features[2]='1'; now.mem_kib=base.mem_kib-4;
    compare_counts(&base,&now,&c); CHECK(c.gap==c.baseline_gap && coverage_valid(&base,&now,&c,1));
    size_t bytes; uint8_t *encoded=encode_snapshot(&base,&bytes); CHECK(encoded!=NULL);
    struct snapshot decoded={ .configured=MAX_RAM_BYTES }; CHECK(!decode_snapshot(encoded,bytes,&decoded));
    CHECK(same_ranges(&base,&decoded) && !memcmp(base.states,decoded.states,(size_t)base.entries));
    free(decoded.states); decoded.states=NULL;
    encoded[bytes-1]^=1; CHECK(decode_snapshot(encoded,bytes,&decoded)!=NULL); encoded[bytes-1]^=1;
    CHECK(decode_snapshot(encoded,bytes-1,&decoded)!=NULL);
    now.ranges[0].start++; CHECK(!same_ranges(&base,&now));
    free(encoded); free(base.states); free(now.states);
    struct snapshot histogram={ .configured=MAX_RAM_BYTES },empty={ .configured=MAX_RAM_BYTES };
    CHECK(!fixture_map("80000000-80013fff : System RAM\n",&histogram));
    CHECK(!fixture_map("80000000-80013fff : System RAM\n",&empty));
    histogram.states=calloc(20,1); empty.states=calloc(20,1); CHECK(histogram.states && empty.states);
    for (unsigned group=0;group<5;group++) for (unsigned j=0;j<group;j++) histogram.states[group*4+j]=OFFLINE_STATE;
    compare_counts(&empty,&histogram,&c);
    for (unsigned group=0;group<5;group++) CHECK(c.histogram[group]==1);
    CHECK(c.newly_full==1 && c.covered_groups==5 && c.excluded_groups==0 && c.edge_pages==0);
    free(histogram.states); free(empty.states);
    char temp[]="/tmp/winter-page-groups-selftest-XXXXXX"; CHECK(mkdtemp(temp)!=NULL);
    char canonical[PATH_MAX]; CHECK(realpath(temp,canonical)!=NULL);
    int dir=trusted_directory(canonical); CHECK(dir>=0);
    CHECK(safe_filename("baseline.bin") && !safe_filename("../baseline") && !safe_filename("/baseline") && !safe_filename(".."));
    s.states=calloc((size_t)s.entries,1); s.mem_kib=s.entries*4; strcpy(s.features,"001001"); strcpy(s.device,"virtio0"); CHECK(s.states!=NULL);
    CHECK(!write_baseline(dir,"baseline.bin",&s));
    CHECK(write_baseline(dir,"baseline.bin",&s)!=NULL);
    struct snapshot loaded={ .configured=MAX_RAM_BYTES }; CHECK(!load_baseline(dir,"baseline.bin",&loaded)); free(loaded.states);
    CHECK(!fchmodat(dir,"baseline.bin",0644,0)); CHECK(load_baseline(dir,"baseline.bin",&loaded)!=NULL);
    CHECK(!unlinkat(dir,"baseline.bin",0)); CHECK(!symlinkat("outside",dir,"baseline.bin"));
    CHECK(load_baseline(dir,"baseline.bin",&loaded)!=NULL && write_baseline(dir,"baseline.bin",&s)!=NULL);
    CHECK(!unlinkat(dir,"baseline.bin",0)); close(dir); CHECK(!rmdir(canonical)); free(s.states);
    printf("{\"schemaVersion\":1,\"ok\":true,\"operation\":\"self-test\",\"assertions\":%u,\"procReads\":0,\"rawPFNsEmitted\":false}\n",tests);
    return 0;
}
