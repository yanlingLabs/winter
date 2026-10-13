import AppKit
import Foundation

/// The CEF half of `HeadlessCEFDriver` — app target only (it needs the bridging header's `WinterCEF*`).
extension HeadlessCEFDriver {
    static let production = HeadlessCEFDriver(
        create: { key, url, sessionId in WinterCEFCreateWindowlessBrowser(key, url, sessionId) },
        browserIdentifier: { Int(WinterCEFBrowserIdentifierForParent($0)) },
        sendCDP: { key, method, params, session, completion in
            // Winter.app's own door (one for both apps): an empty session is the tab's own; the call is registered
            // before it is sent, and a child session's result is settled from the raw stream.
            WinterCEFSendCDP(key, method, params, session ?? "") { status, payload in
                completion(HeadlessCEFDriver.status(status), payload ?? "{}")
            }
        },
        setEventObserver: { key, observer in
            WinterCEFSetDevToolsEventObserver(key, observer.map { observe in
                { method, params, session in observe(method ?? "", params ?? Data("{}".utf8), session) }
            })
        },
        setCrashObserver: { WinterCEFSetRendererCrashObserver($0, $1) },
        setStateObserver: { key, observer in
            WinterCEFSetStateObserver(key, observer.map { observe in
                { state in
                    guard let state else { return }
                    observe(state.url ?? "", state.title ?? "", state.isLoading)
                }
            })
        },
        lockNativeUI: { key in
            let all: WinterCEFAutomationNativeUI = [.holdsJSDialogs, .deniesPermissions, .cancelsFileChooser,
                                                    .cancelsDownloads, .suppressesContextMenus, .swallowsUnhandledKeys,
                                                    .refusesFocus, .exitsFullscreen]
            WinterCEFSetAutomationNativeUI(key, all.rawValue)
        },
        resolveHeldDialog: { key, action, prompt in
            let cefAction: WinterCEFHeldDialogAction
            switch action {
            case .accept: cefAction = .accept
            case .dismiss: cefAction = .dismiss
            case .drop: cefAction = .drop
            }
            return WinterCEFResolveHeldDialog(key, cefAction, prompt ?? "")
        },
        close: { WinterCEFCloseBrowser($0) },
        disposeContext: { WinterCEFHeadlessDisposeContext($0) },
        setNoticeObserver: { observer in
            WinterCEFHeadlessSetNoticeObserver(observer.map { observe in
                { browserId, kind in observe(Int(browserId), kind.map { String(cString: $0) } ?? "") }
            })
        },
        setPopupAdopter: { adopter in
            WinterCEFHeadlessSetPopupAdopter(adopter.map { adopt in
                { openerId, url in adopt(Int(openerId), url ?? "") }
            })
        },
        setClosedObserver: { observer in
            WinterCEFHeadlessSetClosedObserver(observer.map { observe in { browserId in observe(Int(browserId)) } })
        },
        setViewObserver: { observer in
            WinterCEFHeadlessSetViewObserver(observer.map { observe in
                { browserId, width, height, scale in observe(Int(browserId), Int(width), Int(height), scale) }
            })
        },
        present: { key, browserId, request, started, ended in
            let presenter = WinterHeadlessPresenter(key: key, browserId: Int32(browserId), nonce: request.nonce,
                                                    viewerRequirement: request.viewerRequirement, control: request.control,
                                                    scale: request.scale, uploadsDir: request.uploadDir,
                                                    started: { started() }, ended: { ended($0) })
            var error: NSString?
            guard let service = presenter.startWithError(&error) else {
                return .failure(HeadlessPresentFailure(message: (error as String?) ?? "the presentation could not start"))
            }
            return .success((service: service, handle: presenter))
        },
        unpresent: { handle in
            guard let presenter = handle as? WinterHeadlessPresenter else { return [:] }
            presenter.stop()
            return presenter.stats.mapValues { $0.doubleValue }
        },
        setControl: { handle, control in (handle as? WinterHeadlessPresenter)?.control = control })

    static func status(_ status: WinterCEFCDPStatus) -> HeadlessCDPStatus {
        switch status {
        case .OK: return .ok
        case .protocolError: return .protocolError
        case .notLive: return .notLive
        case .gone: return .gone
        case .refused: return .refused
        @unknown default: return .refused
        }
    }
}
