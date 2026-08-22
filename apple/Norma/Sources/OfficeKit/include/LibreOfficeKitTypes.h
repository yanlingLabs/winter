/* -*- Mode: C; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/*
 * This file is part of the LibreOffice project.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

#ifndef INCLUDED_LIBREOFFICEKIT_LIBREOFFICEKIT_TYPES_H
#define INCLUDED_LIBREOFFICEKIT_LIBREOFFICEKIT_TYPES_H

#ifdef __cplusplus
extern "C" {
#endif

/** @see lok::Office::registerCallback().
    @since LibreOffice 6.0
 */
typedef void (*LibreOfficeKitCallback)(int nType, const char* pPayload, void* pData);

/** @see lok::Office::runLoop().
    @since LibreOffice 6.3
 */
typedef int (*LibreOfficeKitPollCallback)(void* pData, int timeoutUs);
typedef void (*LibreOfficeKitWakeCallback)(void* pData);

/// @see lok::Office::registerAnyInputCallback()
typedef bool (*LibreOfficeKitAnyInputCallback)(void* pData, int nMostUrgentPriority);

/// office-agent-tools T3 review (C1-split) — RESTORED. Missing from this vendored copy (Stage A,
/// never updated) even though the real compiled engine's `_LibreOfficeKitClass` has the member
/// that uses it (`registerFileSaveDialogCallback`, `LibreOfficeKit.h`'s own struct) — see that
/// member's own header in `LibreOfficeKit.h` for the live-verified evidence (dladdr resolution
/// against a real running kit, not assumed from this header's own prior omission).
/// @see lok::Office::registerFileSaveDialogCallback()
typedef void (*LibreOfficeKitFileSaveDialogCallback)(const char* pSuggestedUri, char* pResultUri,
                                                      size_t nResultUri);

#ifdef __cplusplus
}
#endif

#endif // INCLUDED_LIBREOFFICEKIT_LIBREOFFICEKIT_TYPES_H

/* vim:set shiftwidth=4 softtabstop=4 expandtab: */
