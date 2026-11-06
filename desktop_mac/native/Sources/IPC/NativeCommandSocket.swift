import Darwin
import Foundation
import AppKit

protocol NativeSocketDelegate: AnyObject {
    var socketStatus: [String: Any] { get }
    func focusWindow()
    func requestSocketClose(_ reply: @escaping (Bool) -> Void)
    func terminateAfterSocketClose()
}

final class NativeCommandSocket {
    private let path: String
    private weak var delegate: NativeSocketDelegate?
    private var source: DispatchSourceRead?
    private var pendingCloseFD: Int32?

    init(path: String, delegate: NativeSocketDelegate) throws {
        self.path = path; self.delegate = delegate
        try prepareParent()
    }

    func start() throws {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NativeError("无法创建本机控制 socket（\(errno)）。") }
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { close(fd); throw NativeError("本机控制 socket 路径过长。") }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in raw.copyBytes(from: bytes) }
        let result = withUnsafePointer(to: &address) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard result == 0 else { close(fd); throw NativeError("无法绑定本机控制 socket（\(errno)）。") }
        chmod(path, S_IRUSR | S_IWUSR)
        guard listen(fd, 8) == 0 else { close(fd); unlink(path); throw NativeError("无法监听本机控制 socket（\(errno)）。") }
        let readSource = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        readSource.setEventHandler { [weak self] in self?.acceptOne(fd) }
        readSource.setCancelHandler { close(fd) }
        source = readSource; readSource.resume()
    }

    func replyToPendingClose(ok: Bool) {
        guard let fd = pendingCloseFD else { return }
        pendingCloseFD = nil
        writeJSON(["ok": ok, "cancelled": !ok, "requestId": queuedRequestID], to: fd)
        if ok { DispatchQueue.main.async { self.delegate?.terminateAfterSocketClose() } }
    }

    func stop() {
        source?.cancel(); source = nil
        var st = stat()
        if lstat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFSOCK, st.st_uid == getuid() { unlink(path) }
    }

    private func prepareParent() throws {
        let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
        var st = stat()
        if lstat(parent, &st) == 0 {
            guard (st.st_mode & S_IFMT) == S_IFDIR, st.st_uid == getuid(), (st.st_mode & 0o077) == 0 else {
                throw NativeError("本机控制目录所有者或权限不安全：\(parent)")
            }
        } else {
            guard mkdir(parent, 0o700) == 0 else { throw NativeError("无法创建本机控制目录（\(errno)）。") }
        }
        if lstat(path, &st) == 0 {
            guard (st.st_mode & S_IFMT) == S_IFSOCK, st.st_uid == getuid() else { throw NativeError("拒绝替换非本应用拥有的 socket 路径。") }
            let probe = probeExistingSocket()
            if probe.connected { throw NativeError("本仓库的 AI Novel Mac 已运行，拒绝替换其控制 socket。") }
            guard probe.error == ECONNREFUSED || probe.error == ENOENT else { throw NativeError("无法确认遗留 socket 已失效（\(probe.error)）。") }
            guard unlink(path) == 0 else { throw NativeError("无法移除本应用遗留 socket（\(errno)）。") }
        } else if errno != ENOENT { throw NativeError("无法检查本机控制 socket 路径（\(errno)）。") }
    }

    private func probeExistingSocket() -> (connected: Bool, error: Int32) {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return (false, errno) }
        defer { close(fd) }
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { return (false, ENAMETOOLONG) }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        let result = withUnsafePointer(to: &address) { ptr in ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        if result == 0 { return (true, 0) }
        return (false, errno)
    }

    private func acceptOne(_ serverFD: Int32) {
        let fd = accept(serverFD, nil, nil)
        guard fd >= 0 else { return }
        var noSigPipe: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 1, tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var buffer = [UInt8](repeating: 0, count: 4097)
        let count = read(fd, &buffer, 4096)
        guard count > 0, count <= 4096,
              let line = String(bytes: buffer.prefix(count), encoding: .utf8)?.split(separator: "\n").first,
              let data = String(line).data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              (request["protocolVersion"] as? Int) == 1,
              let command = request["command"] as? String,
              let requestID = request["requestId"] as? String, requestID.utf8.count <= 128 else {
            writeJSON(["ok": false, "error": "invalid_request"], to: fd); return
        }
        switch command {
        case "status":
            var value = delegate?.socketStatus ?? [:]; value["ok"] = true; value["requestId"] = requestID; value["protocolVersion"] = 1
            writeJSON(value, to: fd)
        case "focus": delegate?.focusWindow(); writeJSON(["ok": true, "requestId": requestID], to: fd)
        case "close":
            guard pendingCloseFD == nil else { writeJSON(["ok": false, "error": "close_pending", "requestId": requestID], to: fd); return }
            pendingCloseFD = fd
            queuedRequestID = requestID
            delegate?.requestSocketClose { [weak self] allowed in
                guard let self else { return }
                self.replyToPendingClose(ok: allowed)
            }
        default: writeJSON(["ok": false, "error": "unsupported_command", "requestId": requestID], to: fd)
        }
    }

    private var queuedRequestID = ""
    private func writeJSON(_ object: [String: Any], to fd: Int32) {
        var value = object
        if let id = value["requestId"] as? String, id.isEmpty { value["requestId"] = queuedRequestID }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { close(fd); return }
        var bytes = data; bytes.append(0x0a)
        bytes.withUnsafeBytes { raw in _ = Darwin.write(fd, raw.baseAddress, raw.count) }
        close(fd)
    }
}
