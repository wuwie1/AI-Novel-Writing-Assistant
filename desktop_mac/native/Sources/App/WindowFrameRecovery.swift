import AppKit

struct WindowFrameRecovery {
    // AppKit can change the style mask before a full-screen animation finishes.
    var isTransitioningFullScreen = false

    func adjustedFrame(_ frame: NSRect, within visibleFrame: NSRect, styleMask: NSWindow.StyleMask) -> NSRect? {
        guard !isTransitioningFullScreen, !styleMask.contains(.fullScreen), !visibleFrame.isEmpty else { return nil }
        var adjusted = frame
        adjusted.size.width = min(frame.width, visibleFrame.width)
        adjusted.size.height = min(frame.height, visibleFrame.height)
        adjusted.origin.x = min(max(frame.minX, visibleFrame.minX), visibleFrame.maxX - adjusted.width)
        adjusted.origin.y = min(max(frame.minY, visibleFrame.minY), visibleFrame.maxY - adjusted.height)
        return adjusted == frame ? nil : adjusted
    }
}
