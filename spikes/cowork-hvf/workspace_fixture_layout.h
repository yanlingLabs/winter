#ifndef WINTER_WORKSPACE_FIXTURE_LAYOUT_H
#define WINTER_WORKSPACE_FIXTURE_LAYOUT_H
#define WORKSPACE_DATA_BYTES (64ULL*1024*1024)
#define WORKSPACE_ENVIRONMENT_BYTES (80ULL*1024*1024)
static const char *const workspace_serials[2]={"winter-data","winter-environment"};
static const unsigned long long workspace_capacities[2]={WORKSPACE_DATA_BYTES,WORKSPACE_ENVIRONMENT_BYTES};
#endif
