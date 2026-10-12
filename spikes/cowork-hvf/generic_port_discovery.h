#ifndef COWORK_GENERIC_PORT_DISCOVERY_H
#define COWORK_GENERIC_PORT_DISCOVERY_H
/* Fixture-only fixed generic port identity from the pinned Linux6.18.35 virtio-console source. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
struct generic_port_identity { unsigned console_index,major,minor;char console[32],port[32]; };
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
    for(unsigned bit=0;bit<128;bit++)if(features[bit]!=(bit==32 || bit==1?'1':'0'))return 0;
    return 1; /* VERSION_1+MULTIPORT only: exactly one generic port, four bounded queues. */
}
static inline int generic_port_discover(const char *virtio_root,const char *ports_root,struct generic_port_identity *identity){
    memset(identity,0,sizeof *identity);
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
    if((result=stream_identity_path(path,sizeof path,ports_root,identity->port,"dev")) || (result=stream_identity_read(path,value,sizeof value)))return result;
    char extra=0;if(sscanf(value,"%u:%u%c",&identity->major,&identity->minor,&extra)!=2 || !identity->major || identity->minor!=0)return -EPROTO;
    return 0;
}
#endif
