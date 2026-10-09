# Third-party notices — WinterCUCore

WinterCUCore is Winter's own code. Its background-input recipes for macOS follow techniques published
by the projects below, all MIT-licensed. No source file was copied; the Swift here was written for this
package. The techniques adapted are named so the lineage stays clear.

| Project | Copyright | Used for | Where |
|---|---|---|---|
| [cua-driver](https://github.com/trycua/cua) (`libs/cua-driver`) | Copyright (c) 2025 Cua AI, Inc. | Posting through SkyLight's `SLEventPostToPid` with a public fallback; the keyboard authentication envelope (`SLSEventAuthenticationMessage`, guarded by `class_respondsToSelector` for macOS 14); the Chromium click sequence: mouse-moved primer, off-screen (-1,-1) primer click, then the target clicks; the window-routing event fields (51/91/92), the click-group field (58) and `CGEventSetWindowLocation` | `Sources/WinterCUCore/Input/SkyLight.swift`, `Input/EventSynth.swift` |
| [yabai](https://github.com/koekeishiya/yabai) | Copyright (c) 2019 Åsmund Vikane | Focus without raise: the 248-byte event record (bytes 0x04/0x08, the window id at 0x3c, the focus/defocus byte at 0x8a) posted with `SLPSPostEventRecordTo` | `Input/SkyLight.swift` (`focusRecord`, `focusWithoutRaise`, `restoreFocus`) |
| [Peekaboo](https://github.com/steipete/Peekaboo) | Copyright (c) 2025 Peter Steinberger | The background input ladder (AX actions first, then pid/window-routed events, never the global event tap); `verify_state`-style bounded polling instead of fixed sleeps; one-shot desktop-independent window capture with a short-lived filter cache | `Core/CUCore+Act.swift`, `Settle/SettleMachine.swift`, `Capture/Capture.swift` |

## MIT License (applies to each project above)

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
