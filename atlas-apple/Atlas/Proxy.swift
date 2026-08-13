import Foundation

// The page hands its Atlas session token down via POST /local/session — it
// lives in the webview's localStorage, which native code cannot read. Kept in
// memory only, never written to disk: same rule as the Electron shell.
final class TokenStore {
    static let shared = TokenStore()
    private let lock = NSLock()
    private var value: String?
    var token: String? {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); defer { lock.unlock() }; value = newValue }
    }
}

// /canvas-proxy and /finance-api, forwarded to the Atlas server's uiapi with
// the session token attached — the Swift twin of atlas-ui/server/remote.js.
// The token rides x-atlas-token, never Authorization: that header carries the
// Canvas PAT and must reach instructure.com untouched.
enum Uiapi {
    // Same default and override knob as remote.js on the Mac.
    static let base = ProcessInfo.processInfo.environment["ATLAS_UIAPI_BASE"]
        ?? "https://sync.myatlasapp.net/uiapi"

    // Hop-by-hop and transport headers that must not be copied in either
    // direction. content-length/encoding are recomputed: URLSession decompresses
    // responses, so the upstream values would be lies.
    private static let skip: Set<String> = [
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailer", "transfer-encoding", "upgrade", "host",
        "content-length", "content-encoding", "accept-encoding",
    ]

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 120
        c.httpCookieAcceptPolicy = .never
        c.httpShouldSetCookies = false
        return URLSession(configuration: c)
    }()

    static func forward(_ req: HTTPRequest) async -> HTTPResponse {
        guard let token = TokenStore.shared.token else {
            // Matches remote.js: the page shares the token right after boot, so
            // this only answers pre-login or logged-out requests.
            return .json(503, ["error": "not signed in on this device"])
        }
        guard let url = URL(string: base + req.target) else {
            return .json(400, ["error": "bad target"])
        }
        var out = URLRequest(url: url)
        out.httpMethod = req.method
        if !req.body.isEmpty { out.httpBody = req.body }
        for (k, v) in req.headers where !skip.contains(k) {
            out.setValue(v, forHTTPHeaderField: k)
        }
        out.setValue(token, forHTTPHeaderField: "x-atlas-token")
        do {
            let (data, resp) = try await session.data(for: out)
            guard let http = resp as? HTTPURLResponse else {
                return .json(502, ["error": "non-http response"])
            }
            var headers: [(String, String)] = []
            for (k, v) in http.allHeaderFields {
                guard let name = k as? String, let val = v as? String,
                      !skip.contains(name.lowercased()) else { continue }
                headers.append((name, val))
            }
            return HTTPResponse(status: http.statusCode, headers: headers, body: data)
        } catch {
            return .json(502, ["error": "atlas server unreachable: \(error.localizedDescription)"])
        }
    }
}
