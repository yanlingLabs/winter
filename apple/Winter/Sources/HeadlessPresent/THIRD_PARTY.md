# Third-party notices — headless presentation

The headless presentation (this folder and `Sources/HeadlessHelper/HeadlessPresentProducer.mm`) is Winter's own
code. It follows techniques published by the projects below. No source file was copied; the code here was written
for Winter. The techniques adapted are named so the lineage stays clear.

| Project | Copyright | License | Used for | Where |
|---|---|---|---|---|
| [flutter_cef](https://github.com/FlutterFlow/flutter_cef) (`packages/flutter_cef_macos/native/cef_host/render_handler.mm`, at 7c7bcb0b2142128d3ad7ff648d03ba92d683d3f2) | Copyright (c) 2026 the flutter_cef authors | MIT | A separate CEF host handing frames to its UI process: producer-allocated IOSurfaces sized to what CEF painted, a Metal blit of CEF's borrowed accelerated frame into an owned surface completed (`waitUntilCompleted`) before `OnAcceleratedPaint` returns, the surface's send right moved to the consumer as a Mach port descriptor (`IOSurfaceCreateMachPort`), a `<select>` popup composited over the view | `HeadlessPresentProducer.mm`, `WinterPresentWire.h` |
| [CEF](https://github.com/chromiumembedded/cef) `tests/cefclient` (`browser_window_osr_mac.mm`, `osr_accessibility_node_mac.mm`, at be1e15d8892c064f0299ba18350236a9b272ce7f) | Copyright (c) 2008-2020 Marshall A. Greenblatt; portions Copyright (c) 2006-2009 Google Inc. | BSD-3-Clause | The macOS off-screen view's input, IME, cursor, drag-and-drop and accessibility handling, adapted for Winter's panel (its direct `CefBrowserHost` calls become messages to the helper) | Winter.app's presentation view |

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
