import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private(set) var launch: LaunchArguments!
    private(set) var window: NSWindow!
    private var web: NativeWebView!
    private var socket: NativeCommandSocket!
    private var socketCloseApproved = false

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
        if socketCloseApproved { socketCloseApproved = false; return .terminateNow }
        guard web?.isReady == true else { return .terminateNow }
        web.requestClose { [weak self] allowed in
            guard let self else { return }
            if allowed { self.socket.replyToPendingClose(ok: true); sender.reply(toApplicationShouldTerminate: true) }
            else { self.socket.replyToPendingClose(ok: false); sender.reply(toApplicationShouldTerminate: false) }
        }
        return .terminateLater
    }

    func windowShouldClose(_: NSWindow) -> Bool {
        guard web.isReady else { return false }
        web.requestClose { [weak self] allowed in
            guard let self, allowed else { self?.socket.replyToPendingClose(ok: false); return }
            self.socket.replyToPendingClose(ok: true)
            self.window.orderOut(nil)
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
        guard web?.isReady == true else { return }
        web.requestClose { [weak self] allowed in if allowed { self?.web.reload() } }
    }

    @objc private func backFromMenu(_: Any?) { web?.navigateHistory(-1) }
    @objc private func forwardFromMenu(_: Any?) { web?.navigateHistory(1) }

    @objc private func restoreVisibleFrame() {
        guard let window, let screen = window.screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        var frame = window.frame
        frame.size.width = min(frame.width, visible.width)
        frame.size.height = min(frame.height, visible.height)
        frame.origin.x = min(max(frame.origin.x, visible.minX), visible.maxX - frame.width)
        frame.origin.y = min(max(frame.origin.y, visible.minY), visible.maxY - frame.height)
        if frame != window.frame { window.setFrame(frame, display: true) }
        window.contentView?.needsDisplay = true
    }

    private func showFatal(_ message: String) {
        let alert = NSAlert(); alert.alertStyle = .critical; alert.messageText = "无法启动 AI Novel"; alert.informativeText = message
        alert.runModal(); NSApp.terminate(nil)
    }
}

extension AppDelegate: NativeSocketDelegate {
    var socketStatus: [String: Any] {
        ["pid": ProcessInfo.processInfo.processIdentifier, "repo": launch.repoPath, "mode": launch.mode, "backendIdentity": launch.backendIdentity, "rendererReady": web?.isReady ?? false]
    }
    func focusWindow() { if window == nil { createWindow(); web.load() }; window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func requestSocketClose(_ reply: @escaping (Bool) -> Void) {
        guard web?.isReady == true else { reply(false); return }
        web.requestClose { [weak self] allowed in
            self?.socket.replyToPendingClose(ok: allowed)
            reply(allowed)
        }
    }
    func terminateAfterSocketClose() { socketCloseApproved = true; NSApp.terminate(nil) }
}
