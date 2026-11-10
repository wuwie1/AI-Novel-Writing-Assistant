import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private(set) var launch: LaunchArguments!
    private(set) var window: NSWindow!
    private var web: NativeWebView!
    private var socket: NativeCommandSocket!
    private var terminationApproved = false
    private var frameRecovery = WindowFrameRecovery()

    func applicationDidFinishLaunching(_: Notification) {
        do {
            launch = try LaunchArguments.parse(CommandLine.arguments)
            socket = try NativeCommandSocket(path: launch.socketPath, delegate: self)
            installMenu()
            createWindow()
            try socket.start()
            web.load()
            NotificationCenter.default.addObserver(self, selector: #selector(restoreVisibleFrame), name: NSApplication.didChangeScreenParametersNotification, object: nil)
            NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(restoreVisibleFrame), name: NSWorkspace.didWakeNotification, object: nil)
            NSApp.activate(ignoringOtherApps: true)
        } catch { showFatal(error.localizedDescription) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { false }
    func applicationWillTerminate(_: Notification) { socket?.stop() }

    func applicationShouldHandleReopen(_: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if window == nil { createWindow(); web.load() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminationApproved { terminationApproved = false; return .terminateNow }
        guard let web else { return .terminateNow }
        DispatchQueue.main.async {
            web.requestQuit { result in sender.reply(toApplicationShouldTerminate: result == .allowed) }
        }
        return .terminateLater
    }

    func windowShouldClose(_: NSWindow) -> Bool {
        guard web.isReady else { return false }
        web.requestClose { [weak self] allowed in
            if allowed { self?.window.orderOut(nil) }
        }
        return false
    }

    private func createWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "AI Novel"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 390, height: 600)
        window.tabbingMode = .disallowed
        let frameName = "AINovelMac.\(launch.mode).\(launch.backendIdentity.prefix(16))"
        let restored = window.setFrameUsingName(frameName)
        window.setFrameAutosaveName(frameName)
        web = NativeWebView(launch: launch, hostWindow: window)
        window.contentView = web.view
        window.delegate = self
        if !restored { window.center() }
        restoreVisibleFrame()
        window.makeKeyAndOrderFront(nil)
    }

    private func installMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 AI Novel", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 AI Novel", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu; menu.addItem(appItem)
        let editItem = NSMenuItem(); let edit = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("重做", "redo:", "Z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = edit; menu.addItem(editItem); NSApp.mainMenu = menu
        let fileItem = NSMenuItem(); let file = NSMenu(title: "文件")
        file.addItem(withTitle: "保存", action: #selector(saveFromMenu(_:)), keyEquivalent: "s")
        file.addItem(withTitle: "重新加载", action: #selector(reloadFromMenu(_:)), keyEquivalent: "r")
        file.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file; menu.insertItem(fileItem, at: 1)
        let navigationItem = NSMenuItem(); let navigation = NSMenu(title: "导航")
        navigation.addItem(withTitle: "后退", action: #selector(backFromMenu(_:)), keyEquivalent: "[")
        navigation.addItem(withTitle: "前进", action: #selector(forwardFromMenu(_:)), keyEquivalent: "]")
        navigationItem.submenu = navigation; menu.addItem(navigationItem)
    }

    @objc private func saveFromMenu(_: Any?) { web?.requestSave() }

    @objc private func reloadFromMenu(_: Any?) {
        guard let web, web.isReady || web.rendererState == .terminated else { return }
        web.reload()
    }

    @objc private func backFromMenu(_: Any?) { web?.navigateHistory(-1) }
    @objc private func forwardFromMenu(_: Any?) { web?.navigateHistory(1) }

    func windowDidBecomeKey(_: Notification) { web?.notifyWindowActivated() }
    func windowWillEnterFullScreen(_: Notification) { frameRecovery.isTransitioningFullScreen = true }
    func windowWillExitFullScreen(_: Notification) { frameRecovery.isTransitioningFullScreen = true }
    func windowDidEnterFullScreen(_: Notification) { frameRecovery.isTransitioningFullScreen = false }
    func windowDidFailToExitFullScreen(_: NSWindow) { frameRecovery.isTransitioningFullScreen = false }

    func windowDidExitFullScreen(_: Notification) {
        frameRecovery.isTransitioningFullScreen = false
        restoreVisibleFrame()
    }

    func windowDidFailToEnterFullScreen(_: NSWindow) {
        frameRecovery.isTransitioningFullScreen = false
        restoreVisibleFrame()
    }

    func windowDidChangeOcclusionState(_: Notification) {
        guard window.occlusionState.contains(.visible), let content = window.contentView else { return }
        content.layoutSubtreeIfNeeded()
        content.needsDisplay = true
    }

    @objc private func restoreVisibleFrame() {
        guard let window, let screen = window.screen ?? NSScreen.main else { return }
        if let adjusted = frameRecovery.adjustedFrame(window.frame, within: screen.visibleFrame, styleMask: window.styleMask) {
            window.setFrame(adjusted, display: true)
        }
    }

    private func showFatal(_ message: String) {
        let alert = NSAlert(); alert.alertStyle = .critical; alert.messageText = "无法启动 AI Novel"; alert.informativeText = message
        alert.runModal()
        terminationApproved = true  // Startup failed before any workspace was loaded.
        NSApp.terminate(nil)
    }
}

extension AppDelegate: NativeSocketDelegate {
    var socketStatus: [String: Any] {
        ["pid": ProcessInfo.processInfo.processIdentifier, "repo": launch.repoPath, "mode": launch.mode, "backendIdentity": launch.backendIdentity, "rendererReady": web?.isReady ?? false, "rendererState": web.rendererState.rawValue]
    }
    func focusWindow() { if window == nil { createWindow(); web.load() }; window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func requestSocketClose(_ reply: @escaping (WindowCloseResult) -> Void) { web.requestQuit(reply) }
    func terminateAfterSocketClose() { terminationApproved = true; NSApp.terminate(nil) }
}
