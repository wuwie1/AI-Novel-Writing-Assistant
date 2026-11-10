import Foundation

enum WindowCloseResult: String {
    case allowed, cancelled
    case busy = "document_busy"
    case pending = "close_pending"
    case unavailable = "renderer_unavailable"
    case timedOut = "close_timeout"

    func socketReply(requestID: String) -> [String: Any] {
        var reply: [String: Any] = ["ok": self == .allowed, "cancelled": self == .cancelled, "requestId": requestID]
        if self != .allowed && self != .cancelled { reply["error"] = rawValue }
        return reply
    }
}

/// Owned by the main thread. Only WebKit can establish that the live editing process is gone.
final class DocumentCloseGate {
    enum Renderer: String { case loading, ready, terminated }
    enum Prompt { case document, window }
    private struct Request {
        let id: String
        var prompt: Prompt
        let complete: (WindowCloseResult) -> Void
    }

    private(set) var renderer = Renderer.loading
    private var request: Request?
    private let present: (Prompt, String) -> Void
    private let dismiss: (Prompt, String, WindowCloseResult) -> Void

    init(present: @escaping (Prompt, String) -> Void, dismiss: @escaping (Prompt, String, WindowCloseResult) -> Void) {
        self.present = present
        self.dismiss = dismiss
    }

    func documentCommitted() {
        renderer = .loading
        if request?.prompt == .document { finish(.unavailable) }
    }

    func documentReady() {
        if renderer != .terminated { renderer = .ready }
    }

    func processTerminated() {
        renderer = .terminated
        finish(.unavailable)
    }

    func begin(quitting: Bool, completion: @escaping (WindowCloseResult) -> Void) {
        guard request == nil else { completion(.pending); return }
        if renderer == .terminated { completion(quitting ? .allowed : .unavailable); return }
        guard renderer == .ready || quitting else { completion(.unavailable); return }
        let id = UUID().uuidString
        let prompt: Prompt = renderer == .ready ? .document : .window
        request = Request(id: id, prompt: prompt, complete: completion)
        DispatchQueue.main.asyncAfter(deadline: .now() + 55) { [weak self] in self?.expire(id) }
        present(prompt, id)
    }

    func awaitsDocument(_ id: String) -> Bool { request?.id == id && request?.prompt == .document }

    func documentDecision(_ result: WindowCloseResult, id: String) {
        if awaitsDocument(id) { finish(result) }
    }

    func windowDecision(_ result: WindowCloseResult, id: String) {
        guard request?.id == id, request?.prompt == .window else { return }
        if result == .allowed && renderer == .ready {
            // A slow page can finish loading while the native confirmation is open.
            request?.prompt = .document
            present(.document, id)
        } else { finish(result) }
    }

    func expire(_ id: String) {
        if request?.id == id { finish(.timedOut) }
    }

    private func finish(_ result: WindowCloseResult) {
        guard let current = request else { return }
        request = nil
        dismiss(current.prompt, current.id, result)
        current.complete(result)
    }
}
