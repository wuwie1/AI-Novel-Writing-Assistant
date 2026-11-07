import Foundation

struct LaunchArguments {
    let url: URL
    let repoPath: String
    let mode: String
    let backendIdentity: String
    let socketPath: String

    static func parse(_ args: [String]) throws -> LaunchArguments {
        var values: [String: String] = [:]
        var index = 1
        while index < args.count {
            let key = args[index]
            guard ["--url", "--repo", "--mode", "--backend-identity", "--socket"].contains(key), index + 1 < args.count else {
                throw NativeError("启动参数不完整：\(key)")
            }
            values[key] = args[index + 1]; index += 2
        }
        guard let address = values["--url"], let url = URL(string: address),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host?.lowercased(), ["127.0.0.1", "localhost", "::1"].contains(host),
              url.user == nil, url.password == nil, url.port != nil,
              let repo = values["--repo"], repo.hasPrefix("/"),
              let mode = values["--mode"], ["local", "remote"].contains(mode),
              let identity = values["--backend-identity"], identity.range(of: "^[a-fA-F0-9]{16,128}$", options: .regularExpression) != nil,
              let socket = values["--socket"], socket.hasPrefix("/tmp/ai-novel-mac-"), socket.utf8.count < 104 else {
            throw NativeError("需要有效的 loopback URL、仓库路径、模式、后端身份哈希和 Unix socket 路径。")
        }
        return LaunchArguments(url: url, repoPath: URL(fileURLWithPath: repo).standardizedFileURL.path, mode: mode, backendIdentity: identity.lowercased(), socketPath: socket)
    }
}

struct NativeError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}
