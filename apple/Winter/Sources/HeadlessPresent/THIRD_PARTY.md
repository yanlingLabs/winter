# Third-party notices — headless presentation

The headless presentation (this folder and `Sources/HeadlessHelper/HeadlessPresentProducer.mm`) is Winter's own
code. It follows techniques published by the projects below; the techniques adapted are named so the lineage stays
clear. No source FILE was copied — but the key-code tables in `HeadlessPresentKeys.swift` were TRANSCRIBED from
Chromium's and CEF's (their data, re-typed into Swift), and the BSD notices for them are kept below, as their licenses
require. This file ships in Winter.app and in Winter Headless (`Contents/Resources/THIRD_PARTY.md`).

| Project | Copyright | License | Used for | Where |
|---|---|---|---|---|
| [flutter_cef](https://github.com/FlutterFlow/flutter_cef) (`packages/flutter_cef_macos/native/cef_host/render_handler.mm`, at 7c7bcb0b2142128d3ad7ff648d03ba92d683d3f2) | Copyright (c) 2026 the flutter_cef authors | MIT | A separate CEF host handing frames to its UI process: producer-allocated IOSurfaces sized to what CEF painted, a Metal blit of CEF's borrowed accelerated frame into an owned surface completed (`waitUntilCompleted`) before `OnAcceleratedPaint` returns, the surface's send right moved to the consumer as a Mach port descriptor (`IOSurfaceCreateMachPort`), a `<select>` popup composited over the view | `HeadlessPresentProducer.mm`, `WinterPresentWire.h` |
| [CEF](https://github.com/chromiumembedded/cef) `tests/cefclient` (`browser/browser_window_osr_mac.mm`, `browser/text_input_client_osr_mac.mm`, at be1e15d8892c064f0299ba18350236a9b272ce7f) | Copyright (c) 2008-2020 Marshall A. Greenblatt; portions Copyright (c) 2006-2009 Google Inc.; portions Copyright 2013 The Chromium Authors | BSD-3-Clause | The macOS off-screen view's input handling, adapted for Winter's panel (its direct `CefBrowserHost` calls become messages to the helper): mouse presses, moves, drags, the mouse leaving and scrolling; the key event's fields (character, unmodified character, native key code) and `EVENTFLAG` modifiers, including which modifier key a `flagsChanged` event released and which keys are the keypad's; the input method's key-down state machine (text inserted, marked text set or cleared while a key is handled, then one char event, committed text, a composition update, or the composition finished or cancelled) and the `NSTextInputClient` methods behind it; the candidate window's rect from the composition's character bounds; the edit commands from the responder chain. Its `osr_accessibility_node_mac.mm` was read and NOT used — there is no accessibility tree on the presentation wire, so the view is one element; its drag-and-drop (a native drag session) was not adapted — an in-page drag runs inside the browser through CEF's own drag target and source calls, Winter's own code in `WinterCEF.mm` | `HeadlessPresentView.swift`, `HeadlessPresentKeys.swift`, `HeadlessPresentGeometry.swift` |
| [Chromium](https://chromium.googlesource.com/chromium/src) `ui/events/keycodes/keyboard_code_conversion_mac.mm` | Copyright 2012 The Chromium Authors | BSD-3-Clause | The rule for a Mac key event's Windows key code (a key off the keypad by its character, then its unmodified character, else by its physical key code) and the mapping tables behind it (macOS key codes and US-layout characters to `VK_*` codes), transcribed into Winter's own table | `HeadlessPresentKeys.swift` |

## MIT License (flutter_cef)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.

## BSD 3-Clause License (CEF)

Copyright (c) 2008-2020 Marshall A. Greenblatt. Portions Copyright (c) 2006-2009 Google Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided
that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the
   following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and
   the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of Google Inc. nor the name Chromium Embedded Framework nor the names of its
   contributors may be used to endorse or promote products derived from this software without specific
   prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED
WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE
OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH
DAMAGE.

## BSD 3-Clause License (Chromium)

Copyright 2012 The Chromium Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided
that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the
   following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and
   the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of Google LLC nor the names of its contributors may be used to endorse or promote
   products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED
WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE
OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH
DAMAGE.
