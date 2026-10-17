#import "WinterPresentAuth.h"

#include <mach/notify.h>

#import <Security/Security.h>
#include <unistd.h>

BOOL WinterPresentPeerSatisfies(audit_token_t token, NSString *requirement, NSString **why) {
  if (requirement.length == 0) {
    if (why) *why = @"no requirement to check the peer against";
    return NO;
  }
  NSData *audit = [NSData dataWithBytes:&token length:sizeof(token)];
  SecCodeRef code = NULL;
  OSStatus status = SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef) @{(__bridge id)kSecGuestAttributeAudit : audit},
                                                   kSecCSDefaultFlags, &code);
  if (status != errSecSuccess || code == NULL) {
    if (why) *why = [NSString stringWithFormat:@"the peer's code could not be found (%d)", (int)status];
    return NO;
  }
  SecRequirementRef req = NULL;
  status = SecRequirementCreateWithString((__bridge CFStringRef)requirement, kSecCSDefaultFlags, &req);
  if (status != errSecSuccess || req == NULL) {
    CFRelease(code);
    if (why) *why = [NSString stringWithFormat:@"the requirement does not parse (%d)", (int)status];
    return NO;
  }
  status = SecCodeCheckValidity(code, kSecCSDefaultFlags, req);
  CFRelease(req);
  CFRelease(code);
  if (status != errSecSuccess) {
    if (why) *why = [NSString stringWithFormat:@"the peer does not satisfy the requirement (%d)", (int)status];
    return NO;
  }
  return YES;
}

BOOL WinterPresentSamePeer(audit_token_t a, audit_token_t b) {
  return audit_token_to_pid(a) == audit_token_to_pid(b) && audit_token_to_pidversion(a) == audit_token_to_pidversion(b);
}

BOOL WinterPresentAuditToken(const mach_msg_header_t *header, audit_token_t *token) {
  const mach_msg_size_t at = (header->msgh_size + 3) & ~3u;
  const mach_msg_audit_trailer_t *trailer = (const mach_msg_audit_trailer_t *)((const uint8_t *)header + at);
  if (trailer->msgh_trailer_type != MACH_MSG_TRAILER_FORMAT_0 || trailer->msgh_trailer_size < sizeof(mach_msg_audit_trailer_t)) {
    return NO;
  }
  *token = trailer->msgh_audit;
  return YES;
}

BOOL WinterPresentKernelDeadName(const mach_msg_header_t *header, mach_port_name_t *name) {
  if (header->msgh_id != MACH_NOTIFY_DEAD_NAME) return NO;
  if (header->msgh_size < sizeof(mach_dead_name_notification_t) - sizeof(mach_msg_format_0_trailer_t)) return NO;
  audit_token_t token;
  if (!WinterPresentAuditToken(header, &token) || audit_token_to_pid(token) != 0) return NO;
  *name = ((const mach_dead_name_notification_t *)header)->not_port;
  return *name != MACH_PORT_NULL;
}

NSString *WinterPresentServiceName(void) {
  uint8_t bytes[16];
  arc4random_buf(bytes, sizeof(bytes));
  NSMutableString *hex = [NSMutableString stringWithCapacity:32];
  for (size_t i = 0; i < sizeof(bytes); i++) [hex appendFormat:@"%02x", bytes[i]];
  return [NSString stringWithFormat:@"com.winter.headless.present.%d.%@", getpid(), hex];
}
