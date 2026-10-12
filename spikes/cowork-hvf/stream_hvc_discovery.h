#ifndef COWORK_STREAM_HVC_DISCOVERY_H
#define COWORK_STREAM_HVC_DISCOVERY_H
/* Fixture-only rules from pinned Linux6.18.35 hvc/virtio-console/TTY sources.
 * Class slots are not connected HVC instances. Probe callbacks must use nonblocking opens. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#define STREAM_HVC_SLOTS 8U
struct stream_hvc_identity { unsigned console_index,class_slots,connected_slots;char console[32],port[32];int fd; };
typedef int (*stream_hvc_probe)(const char *,unsigned,unsigned,unsigned,void *);
typedef void (*stream_hvc_diagnostic)(unsigned,unsigned,unsigned,int,void *);
static inline int stream_identity_path(char *path,size_t capacity,const char *root,const char *name,const char *leaf){
    int n=snprintf(path,capacity,"%s/%s%s%s",root,name,leaf[0]?"/":"",leaf);
    return n>=0 && (size_t)n<capacity?0:-ENAMETOOLONG;
}
static inline int stream_identity_read(const char *path,char *value,size_t capacity){
    int fd=open(path,O_RDONLY|O_CLOEXEC);if(fd<0)return -errno;
    ssize_t n=read(fd,value,capacity-1);int saved=errno;close(fd);
    if(n<0)return -saved;if((size_t)n==capacity-1)return -EOVERFLOW;
    value[n]=0;value[strcspn(value,"\n")]=0;return 0;
}
static inline int stream_identity_index(const char *name,const char *prefix,unsigned *value){
    size_t length=strlen(prefix);if(strncmp(name,prefix,length) || !name[length])return -EINVAL;
    for(const char *p=name+length;*p;p++)if(*p<'0'||*p>'9')return -EINVAL;
    errno=0;char *end=NULL;unsigned long parsed=strtoul(name+length,&end,10);
    if(errno || !end || *end || parsed>1023)return -EINVAL;*value=(unsigned)parsed;return 0;
}
static inline int stream_single_console_features(const char *features){
    if(strlen(features)!=128)return 0;
    for(unsigned bit=0;bit<128;bit++)if(features[bit]!=(bit==32?'1':'0'))return 0;
    return 1; /* VERSION_1 only: no MULTIPORT, SIZE, control queues or extra data ports. */
}
static inline int stream_discover_hvc(const char *virtio_root,const char *ports_root,const char *tty_root,
                                     stream_hvc_probe probe,stream_hvc_diagnostic diagnostic,void *opaque,
                                     struct stream_hvc_identity *identity){
    memset(identity,0,sizeof *identity);identity->fd=-1;
    char path[1024],value[200],console_path[PATH_MAX],parent[PATH_MAX];unsigned devices=0,consoles=0,ports=0;
    DIR *directory=opendir(virtio_root);if(!directory)return -errno;struct dirent *entry;int result=0;
    while((entry=readdir(directory))){
        if(entry->d_name[0]=='.')continue;if(++devices>16){result=-EOVERFLOW;break;}
        unsigned index;if(stream_identity_index(entry->d_name,"virtio",&index)){result=-EINVAL;break;}
        if((result=stream_identity_path(path,sizeof path,virtio_root,entry->d_name,"device")) || (result=stream_identity_read(path,value,sizeof value)))break;
        if(strcmp(value,"0x0003"))continue;if(++consoles!=1){result=-EEXIST;break;}
        identity->console_index=index;snprintf(identity->console,sizeof identity->console,"virtio%u",index);
        if((result=stream_identity_path(path,sizeof path,virtio_root,entry->d_name,"features")) || (result=stream_identity_read(path,value,sizeof value)))break;
        if(!stream_single_console_features(value)){result=-EPROTO;break;}
        if((result=stream_identity_path(path,sizeof path,virtio_root,entry->d_name,"driver")))break;
        if(!realpath(path,parent)){result=-errno;break;}
        const char *driver=strrchr(parent,'/');if(!driver || strcmp(driver+1,"virtio_console")){result=-EPROTO;break;}
        if((result=stream_identity_path(path,sizeof path,virtio_root,entry->d_name,"")))break;
        if(!realpath(path,console_path)){result=-errno;break;}
    }
    closedir(directory);if(result)return result;if(consoles!=1)return -ENODEV;
    snprintf(identity->port,sizeof identity->port,"vport%up0",identity->console_index);
    directory=opendir(ports_root);if(!directory)return -errno;
    while((entry=readdir(directory))){
        if(entry->d_name[0]=='.')continue;if(++ports>1 || strcmp(entry->d_name,identity->port)){result=-EPROTO;break;}
        if((result=stream_identity_path(path,sizeof path,ports_root,entry->d_name,"device")))break;
        if(!realpath(path,parent)){result=-errno;break;}if(strcmp(parent,console_path)){result=-EPROTO;break;}
    }
    closedir(directory);if(result)return result;if(ports!=1)return -ENODEV;
    unsigned seen=0;directory=opendir(tty_root);if(!directory)return -errno;
    while((entry=readdir(directory))){
        if(strncmp(entry->d_name,"hvc",3))continue;
        unsigned index;if(stream_identity_index(entry->d_name,"hvc",&index) || index>=STREAM_HVC_SLOTS || seen&(1U<<index)){result=-EPROTO;break;}
        seen|=1U<<index;identity->class_slots++;
        if((result=stream_identity_path(path,sizeof path,tty_root,entry->d_name,"dev")) || (result=stream_identity_read(path,value,sizeof value)))break;
        unsigned major=0,minor=0;char extra=0;if(sscanf(value,"%u:%u%c",&major,&minor,&extra)!=2 || major!=229 || minor!=index){result=-EPROTO;break;}
        int fd=probe(entry->d_name,index,major,minor,opaque);if(diagnostic)diagnostic(index,major,minor,fd>=0?0:fd,opaque);
        if(fd==-ENODEV)continue;if(fd<0){result=fd;break;}
        identity->connected_slots++;
        if(index!=0 || identity->connected_slots!=1){close(fd);result=-EEXIST;break;}
        identity->fd=fd;
    }
    closedir(directory);
    if(!result && (identity->class_slots!=STREAM_HVC_SLOTS || seen!=255 || identity->connected_slots!=1))result=-ENODEV;
    if(result && identity->fd>=0){close(identity->fd);identity->fd=-1;}
    return result;
}
#endif
