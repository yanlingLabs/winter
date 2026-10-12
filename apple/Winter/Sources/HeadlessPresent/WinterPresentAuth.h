// Headless presentation — the peer check both sides make on every Mach message (WinterPresentWire.h): who sent it,
// by the kernel's audit token in the message's trailer, checked against a code-signing requirement.
#ifndef WinterPresentAuth_h
#define WinterPresentAuth_h

#import <Foundation/Foundation.h>
#include <bsm/libbsm.h>
#include <mach/mach.h>

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

/// Does the process `token` names satisfy `requirement` (the code-signing requirement language)? On NO, `*why` says
/// why in a short sentence. Validates the running code (`SecCodeCheckValidity`), not a path on disk.
BOOL WinterPresentPeerSatisfies(audit_token_t token, NSString *requirement, NSString *_Nullable *_Nullable why);

/// The same process as an earlier authenticated message: pid AND pidversion (a reused pid never matches).
BOOL WinterPresentSamePeer(audit_token_t a, audit_token_t b);

/// The audit token of a message received with `MACH_RCV_TRAILER_AUDIT` (the trailer follows the message body at its
/// `msgh_size`, rounded up). NO when the trailer is missing or short.
BOOL WinterPresentAuditToken(const mach_msg_header_t *header, audit_token_t *token);

/// A fresh random presentation service name: `com.winter.headless.present.<pid>.<32 hex>`.
NSString *WinterPresentServiceName(void);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END

#endif /* WinterPresentAuth_h */
