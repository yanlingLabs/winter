#include <glib.h>
#include <libintl.h>
#define PCRE2_CODE_UNIT_WIDTH 8
#include <pcre2.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    assert(glib_major_version == 2 && glib_minor_version == 90 && glib_micro_version == 0);
    assert(libintl_version == 0x010000 && LIBINTL_VERSION == 0x010000);
    char version[128] = {0};
    assert(pcre2_config(PCRE2_CONFIG_VERSION, version) > 0);
    assert(strncmp(version, "10.49 ", 6) == 0);
    assert(g_regex_match_simple("^fixture-[0-9]+$", "fixture-42", 0, 0));
    assert(!g_regex_match_simple("^fixture-[0-9]+$", "unexpected", 0, 0));
    assert(strcmp(gettext("packaging-fixture"), "packaging-fixture") == 0);
    puts("{\"relocatedDependencies\":true,\"glib\":\"2.90.0\",\"libintl\":\"1.0\",\"pcre2\":\"10.49\"}");
    return 0;
}
