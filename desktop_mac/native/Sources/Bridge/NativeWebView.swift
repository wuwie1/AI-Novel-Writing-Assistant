import AppKit
import WebKit

final class NativeWebView: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    private(set) var view: WKWebView!
    private let launch: LaunchArguments
    private weak var hostWindow: NSWindow?
    private var quitAlert: NSAlert?
    private lazy var closeGate: DocumentCloseGate = DocumentCloseGate(present: { [weak self] prompt, id in
        if prompt == .document { self?.sendEvent("requestClose", requestId: id) }
        else { self?.confirmQuitWhileLoading(id) }
    }, dismiss: { [weak self] prompt, id, result in
        guard let self else { return }
        if prompt == .window, let sheet = self.quitAlert?.window {
            self.quitAlert = nil
            sheet.sheetParent?.endSheet(sheet, returnCode: .cancel)
        } else if prompt == .document && result == .timedOut && self.isReady {
            self.sendEvent("closeExpired", requestId: id)
        }
    })
    private let protocolVersion = 1
    private var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0" }
    private var dataStoreIdentifier: UUID {
        let raw = SHA256Digest.hex("\(launch.mode)|\(launch.backendIdentity)")
        let s = Array(raw.prefix(32)); let formatted = "\(String(s[0..<8]))-\(String(s[8..<12]))-5\(String(s[13..<16]))-a\(String(s[17..<20]))-\(String(s[20..<32]))"
        return UUID(uuidString: formatted) ?? UUID()
    }
    var rendererState: DocumentCloseGate.Renderer { closeGate.renderer }
    var isReady: Bool { rendererState == .ready }

    init(launch: LaunchArguments, hostWindow: NSWindow) {
        self.launch = launch; self.hostWindow = hostWindow
        super.init()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore(forIdentifier: dataStoreIdentifier)
        let controller = WKUserContentController()
        controller.add(self, name: "aiNovelMac")
        let runtime = "window.__AI_NOVEL_RUNTIME__={mode:'web',apiBaseUrl:'/api',appVersion:\(Self.js(appVersion))};window.__AI_NOVEL_MAC__={protocolVersion:1,mode:\(Self.js(launch.mode)),backendIdentity:\(Self.js(launch.backendIdentity)),postMessage:function(message){window.webkit.messageHandlers.aiNovelMac.postMessage(message)}};"
        controller.addUserScript(WKUserScript(source: runtime, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = controller
        view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self; view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        if #available(macOS 13.3, *) { view.isInspectable = true }
        view.autoresizingMask = [.width, .height]
    }

    func load() { view.load(URLRequest(url: launch.url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30)) }
    func reload() { view.reload() }
    func navigateHistory(_ offset: Int) { if isReady { view.evaluateJavaScript("window.history.go(\(offset < 0 ? -1 : 1))") } }

    func requestClose(_ completion: @escaping (Bool) -> Void) {
        closeGate.begin(quitting: false) { completion($0 == .allowed) }
    }

    func requestQuit(_ completion: @escaping (WindowCloseResult) -> Void) {
        closeGate.begin(quitting: true, completion: completion)
    }

    private func confirmQuitWhileLoading(_ id: String) {
        guard let window = hostWindow else { closeGate.windowDecision(.unavailable, id: id); return }
        guard window.attachedSheet == nil else { closeGate.windowDecision(.pending, id: id); return }
        let alert = NSAlert()
        alert.messageText = "退出 AI Novel？"
        alert.informativeText = "创作页面暂时无法确认保存状态。可保留窗口继续检查，退出可能丢失尚未保存的输入。"
        alert.addButton(withTitle: "保留窗口").keyEquivalent = "\r"
        alert.addButton(withTitle: "退出应用")
        quitAlert = alert
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self, self.quitAlert === alert else { return }
            self.quitAlert = nil
            self.closeGate.windowDecision(response == .alertSecondButtonReturn ? .allowed : .cancelled, id: id)
        }
    }

    func requestSave() {
        guard isReady else { return }
        sendEvent("requestSave", requestId: UUID().uuidString)
    }

    /// WKWebView does not emit visibilitychange when another app takes key focus, so data refresh needs this signal.
    func notifyWindowActivated() {
        guard isReady else { return }
        sendEvent("windowActivated", requestId: UUID().uuidString)
    }

    private func sendEvent(_ type: String, requestId: String) {
        let js = "window.dispatchEvent(new CustomEvent('ai-novel-mac',{detail:{protocolVersion:1,type:\(Self.js(type)),requestId:\(Self.js(requestId))}}));"
        view.evaluateJavaScript(js)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "aiNovelMac", message.frameInfo.isMainFrame,
              let origin = Optional(message.frameInfo.securityOrigin),
              let page = URL(string: "\(origin.protocol)://\(origin.host):\(origin.port)"), sameOrigin(page),
              let body = message.body as? [String: Any],
              body.count <= 8,
              (body["protocolVersion"] as? Int) == protocolVersion,
              let type = body["type"] as? String, type.utf8.count <= 40,
              body.values.allSatisfy({ value in
                  if let string = value as? String { return string.utf8.count <= 4096 }
                  return value is String || value is Int || value is Bool
              }) else { return }
        switch type {
        case "rendererReady": closeGate.documentReady()
        case "closeNeedsAttention":
            guard let id = body["requestId"] as? String, closeGate.awaitsDocument(id), let window = hostWindow else { return }
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        case "closeDecision":
            guard let id = body["requestId"] as? String,
                  let decision = body["decision"] as? String, ["allow", "cancel"].contains(decision) else { return }
            let result: WindowCloseResult
            switch (decision, body["reason"] as? String) {
            case ("allow", nil): result = .allowed
            case ("cancel", nil): result = .cancelled
            case ("cancel", "document_busy"): result = .busy
            case ("cancel", "close_pending"): result = .pending
            default: result = .unavailable
            }
            closeGate.documentDecision(result, id: id)
        case "saveResult": break
        case "openExternal":
            guard let address = body["url"] as? String, address.utf8.count < 4096,
                  let url = URL(string: address), ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil else { return }
            NSWorkspace.shared.open(url)
        default: break
        }
    }

    private func sameOrigin(_ target: URL) -> Bool {
        guard let a = target.host?.lowercased(), let b = launch.url.host?.lowercased() else { return false }
        return target.scheme == launch.url.scheme && a == b && (target.port ?? 80) == (launch.url.port ?? 80)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = action.request.url else { decisionHandler(.cancel); return }
        let ownBlob = target.scheme == "blob" && URL(string: String(target.absoluteString.dropFirst(5))).map(sameOrigin) == true
        if action.shouldPerformDownload && (sameOrigin(target) || ownBlob) { decisionHandler(.download); return }
        if sameOrigin(target), action.targetFrame?.isMainFrame == true, isReady {
            requestClose { allowed in decisionHandler(allowed ? .allow : .cancel) }
            return
        }
        if target.scheme == "about" || sameOrigin(target) { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated, ["http", "https"].contains(target.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(target) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        closeGate.documentCommitted()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard frame.isMainFrame, let window = hostWindow else { completionHandler(false); return }
        let alert = NSAlert(); alert.messageText = "请确认操作"; alert.informativeText = message
        alert.addButton(withTitle: "确认"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard frame.isMainFrame, let window = hostWindow else { completionHandler(); return }
        let alert = NSAlert(); alert.messageText = "AI Novel"; alert.informativeText = message; alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, createWebViewWith _: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures _: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if sameOrigin(url) { webView.load(URLRequest(url: url)) }
        else if ["http", "https"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame _: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = parameters.allowsDirectories; panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: hostWindow ?? NSApp.keyWindow!) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.title = "导出文件"
        panel.message = "选择保存位置"
        panel.prompt = "导出"
        panel.nameFieldLabel = "存储为："
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: hostWindow ?? NSApp.keyWindow!) { completionHandler($0 == .OK ? panel.url : nil) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        closeGate.processTerminated()
        guard let window = hostWindow else { return }
        let alert = NSAlert()
        alert.messageText = "创作页面意外停止"
        alert.informativeText = "可重新打开页面并恢复已保留的章节草稿。尚未保存的其他表单需要重新检查。"
        alert.addButton(withTitle: "重新打开"); alert.addButton(withTitle: "稍后")
        alert.beginSheetModal(for: window) { [weak self] response in if response == .alertFirstButtonReturn { self?.reload() } }
    }

    private static func js(_ value: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [value], options: [.fragmentsAllowed])
        let array = String(data: data, encoding: .utf8)!; return String(array.dropFirst().dropLast())
    }
}
