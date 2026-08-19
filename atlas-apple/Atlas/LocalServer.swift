import Foundation
import Network
#if os(macOS)
import AppKit
#endif

// The app's own web host: WKWebView loads http://127.0.0.1:5180, the same
// fixed loopback origin the Electron shell uses. The port is part of the
// page's identity — Google checks it against the OAuth client's authorized
// JavaScript origins, and the webview's localStorage (all Atlas state) is
// keyed to it — so it must not drift between launches or platforms.
//
// Deliberately Connection: close on every response (and forced onto sidecar
// requests): one request per TCP connection keeps the parser trivial and costs
// nothing on loopback.

struct HTTPRequest {
    let method: String
    let target: String              // path + query, as sent on the wire
    let headers: [String: String]   // names lowercased, last wins
    var body: Data
    var path: String {
        if let q = target.firstIndex(of: "?") { return String(target[..<q]) }
        return target
    }
}

struct HTTPResponse {
    var status: Int
    var headers: [(String, String)] = []
    var body: Data = Data()

    static func json(_ status: Int, _ obj: [String: String]) -> HTTPResponse {
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
        return HTTPResponse(status: status, headers: [("Content-Type", "application/json")], body: data)
    }

    func serialize() -> Data {
        let reasons: [Int: String] = [
            200: "OK", 204: "No Content", 400: "Bad Request", 403: "Forbidden",
            404: "Not Found", 405: "Method Not Allowed", 411: "Length Required",
            413: "Payload Too Large", 431: "Request Header Fields Too Large",
            500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
        ]
        var head = "HTTP/1.1 \(status) \(reasons[status] ?? "OK")\r\n"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        if status != 204 { head += "Content-Length: \(body.count)\r\n" }
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        return out
    }
}

final class LocalServer {
    static let shared = LocalServer()
    static let preferredPort: UInt16 = 5180

    // Mac-only plugin backends, spliced raw to the Node sidecar (503 without one).
    static let sidecarPrefixes = ["/graph-api", "/notes-api", "/study-api"]
    // Forwarded to the Atlas server's uiapi with the session token.
    static let proxyPrefixes = ["/canvas-proxy", "/finance-api", "/notes-sync"]

    // Claude subscription-OAuth (PKCE) — the token exchange must carry the
    // code_verifier and can't run in the browser (CORS), so LocalServer brokers
    // it natively on both platforms. Same client as the server broker.
    static let oauthClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

    private let queue = DispatchQueue(label: "atlas.localserver")
    private var listener: NWListener?
    private(set) var port: UInt16 = 0
    var origin: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    // Set by the AtlasWebView Coordinator: delivers an OAuth code that the
    // system browser dropped on our loopback callback into the app's webview.
    // Invoked on the main thread with (provider, code, state), already URL-decoded.
    var onOAuthCallback: ((String, String, String) -> Void)?

    func start() throws -> UInt16 {
        do { port = try listen(on: Self.preferredPort) } catch {
            // ponytail: another Atlas (the Electron app) holds 5180 — run on any
            // free port so the app still works; only Google sign-in breaks that
            // launch (unregistered origin), same trade the Electron host makes.
            NSLog("atlas: port \(Self.preferredPort) busy — Google sign-in will fail this launch")
            port = try listen(on: 0)
        }
        return port
    }

    private func listen(on requested: UInt16) throws -> UInt16 {
        let params = NWParameters.tcp
        let port: NWEndpoint.Port = requested == 0 ? .any : NWEndpoint.Port(rawValue: requested)!
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
        let l = try NWListener(using: params)
        var result: Result<UInt16, Error>?
        let ready = DispatchSemaphore(value: 0)
        l.stateUpdateHandler = { state in
            switch state {
            case .ready: result = .success(l.port?.rawValue ?? 0); ready.signal()
            case .failed(let e): result = .failure(e); ready.signal()
            default: break
            }
        }
        l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        l.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
        guard case .success(let bound)? = result else {
            l.cancel()
            if case .failure(let e)? = result { throw e }
            throw POSIXError(.ETIMEDOUT)
        }
        l.stateUpdateHandler = { state in
            if case .failed(let e) = state { NSLog("atlas: local server listener failed: \(e)") }
        }
        listener = l
        return bound
    }

    // ---- per-connection state machine ---------------------------------------

    // .serving: body fully read, a handler is running (possibly async, e.g. the
    // uiapi proxy await) — the request must not be dispatched a second time if
    // more bytes land on the connection before the handler answers.
    private enum Mode { case head, body, serving, spliceWait, spliced, done }

    private final class Conn {
        let conn: NWConnection
        var buffer = Data()
        var mode: Mode = .head
        var request: HTTPRequest?
        var headLength = 0
        var bodyNeeded = 0
        var upstream: NWConnection?
        init(_ c: NWConnection) { conn = c }
    }

    private func accept(_ nw: NWConnection) {
        let ctx = Conn(nw)
        nw.start(queue: queue)
        receive(ctx)
    }

    private func receive(_ ctx: Conn) {
        ctx.conn.receive(minimumIncompleteLength: 1, maximumLength: 128 * 1024) { [weak self] data, _, complete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                if ctx.mode == .spliced {
                    ctx.upstream?.send(content: data, completion: .contentProcessed { _ in })
                } else if ctx.mode != .done {
                    ctx.buffer.append(data)
                    self.advance(ctx)
                }
            }
            if complete || error != nil {
                // Client is done sending; a spliced upstream needs the FIN too.
                if let up = ctx.upstream {
                    up.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .idempotent)
                } else if ctx.mode == .head || ctx.mode == .body {
                    ctx.conn.cancel()
                }
                return
            }
            self.receive(ctx)
        }
    }

    private func advance(_ ctx: Conn) {
        if ctx.mode == .head {
            guard let headEnd = ctx.buffer.firstRange(of: Data("\r\n\r\n".utf8)) else {
                if ctx.buffer.count > 64 * 1024 { respond(ctx, HTTPResponse(status: 431)) }
                return
            }
            let headData = ctx.buffer.subdata(in: 0..<headEnd.lowerBound)
            ctx.headLength = headEnd.upperBound
            guard let req = Self.parseHead(headData) else {
                respond(ctx, HTTPResponse(status: 400))
                return
            }
            // Sidecar-owned prefixes take the raw-splice path: the request
            // (uploads included) streams through untouched, and so does the
            // response (SSE included).
            if Self.sidecarPrefixes.contains(where: { Self.boundaryMatch(req.target, $0) }) {
                if let port = Self.sidecarPort() {
                    ctx.mode = .spliceWait
                    splice(ctx, to: port)
                } else {
                    respond(ctx, .json(503, ["error": "not available on this device"]))
                }
                return
            }
            if req.headers["transfer-encoding"] != nil {
                respond(ctx, HTTPResponse(status: 411))
                return
            }
            ctx.bodyNeeded = Int(req.headers["content-length"] ?? "0") ?? 0
            // A negative length would make `total` (below) fall behind headLength
            // and trap the process on the subdata range — reject it as malformed.
            if ctx.bodyNeeded < 0 {
                respond(ctx, HTTPResponse(status: 400))
                return
            }
            if ctx.bodyNeeded > 32 * 1024 * 1024 {
                respond(ctx, HTTPResponse(status: 413))
                return
            }
            ctx.request = req
            ctx.mode = .body
        }
        guard ctx.mode == .body, var req = ctx.request else { return }
        let total = ctx.headLength + ctx.bodyNeeded
        guard ctx.buffer.count >= total else { return }
        req.body = ctx.buffer.subdata(in: ctx.headLength..<total)
        // Leave .body before dispatch so a client that keeps sending (past its
        // own Content-Length, or pipelined) can't re-enter advance() and fire a
        // second handler — an async proxy dispatch stays pending here for the
        // whole upstream round-trip.
        ctx.mode = .serving
        dispatch(req, ctx)
    }

    static func parseHead(_ data: Data) -> HTTPRequest? {
        let text = String(decoding: data, as: UTF8.self)
        var lines = text.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let parts = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[2].hasPrefix("HTTP/1.") else { return nil }
        var headers: [String: String] = [:]
        for line in lines where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
        return HTTPRequest(method: String(parts[0]), target: String(parts[1]), headers: headers, body: Data())
    }

    // host.js's rule: '/graph-apifoo' must never match '/graph-api'.
    static func boundaryMatch(_ target: String, _ prefix: String) -> Bool {
        target == prefix || target.hasPrefix(prefix + "/") || target.hasPrefix(prefix + "?")
    }

    private static func sidecarPort() -> UInt16? {
        #if os(macOS)
        let p = Sidecar.shared.boundPort
        return (Sidecar.shared.isRunning && p != 0) ? p : nil
        #else
        return nil
        #endif
    }

    // ---- routing -------------------------------------------------------------

    private func dispatch(_ req: HTTPRequest, _ ctx: Conn) {
        // The system browser lands here after Google auth. Intercept before any
        // proxy/static routing: ack the browser tab, and hand the code to the
        // app's webview. URLComponents percent-decodes the query values for us.
        if req.path.hasPrefix("/oauth/google/callback") {
            let items = URLComponents(string: req.target)?.queryItems ?? []
            let code = items.first { $0.name == "code" }?.value ?? ""
            let state = items.first { $0.name == "state" }?.value ?? ""
            DispatchQueue.main.async { self.onOAuthCallback?("google", code, state) }
            let html = "<!doctype html><html><head><meta charset=\"utf-8\">"
                + "<title>Atlas</title></head><body style=\"font-family:-apple-system,system-ui,sans-serif;padding:2rem\">"
                + "Signed in — you can close this tab and return to Atlas.</body></html>"
            respond(ctx, HTTPResponse(status: 200,
                headers: [("Content-Type", "text/html; charset=utf-8")],
                body: Data(html.utf8)))
            return
        }
        if req.path == "/local/session", req.method == "POST" || req.method == "DELETE" {
            if req.method == "DELETE" {
                TokenStore.shared.token = nil
            } else if req.body.count <= 4096,
                      let obj = try? JSONSerialization.jsonObject(with: req.body) as? [String: Any],
                      let token = obj["token"] as? String {
                TokenStore.shared.token = token
                // First moment the updater can authenticate against uiapi.
                Updater.shared.kick()
            }
            respond(ctx, HTTPResponse(status: 204))
            return
        }
        if req.path == "/local/icon", req.method == "POST" {
            Self.applyIcon(req.body)
            respond(ctx, HTTPResponse(status: 204))
            return
        }
        // Claude OAuth token broker — async URLSession round-trip to Anthropic.
        if req.path.hasPrefix("/ai-oauth/claude/") {
            claudeOAuth(req, ctx)
            return
        }
        // Native iCloud (or local-Documents fallback) notes storage.
        if req.path.hasPrefix("/icloud/notes/") {
            respond(ctx, Self.notesRoute(req))
            return
        }
        if Self.proxyPrefixes.contains(where: { Self.boundaryMatch(req.target, $0) }) {
            Task {
                let resp = await Uiapi.forward(req)
                self.queue.async { self.respond(ctx, resp) }
            }
            return
        }
        respond(ctx, Self.staticFile(req))
    }

    private func respond(_ ctx: Conn, _ resp: HTTPResponse) {
        guard ctx.mode != .done else { return }
        ctx.mode = .done
        ctx.conn.send(content: resp.serialize(), completion: .contentProcessed { _ in
            ctx.conn.cancel()
        })
    }

    // ---- Claude OAuth token broker ---------------------------------------------

    // POST /ai-oauth/claude/{exchange,refresh}: the web (ai.js) posts the PKCE
    // fields; we forward to Anthropic's token endpoint and hand back the three
    // fields the client stores. NEVER logs tokens or the raw provider payload.
    private func claudeOAuth(_ req: HTTPRequest, _ ctx: Conn) {
        guard req.method == "POST" else { respond(ctx, .json(405, ["error": "POST only"])); return }
        let sub = String(req.path.dropFirst("/ai-oauth/claude/".count))
        let obj = (try? JSONSerialization.jsonObject(with: req.body)) as? [String: Any] ?? [:]
        var payload: [String: Any]
        switch sub {
        case "exchange":
            guard let code = obj["code"] as? String, let verifier = obj["verifier"] as? String else {
                respond(ctx, .json(400, ["error": "missing code or verifier"])); return
            }
            payload = [
                "grant_type": "authorization_code",
                "code": code,
                "state": obj["state"] as? String ?? "",
                "client_id": Self.oauthClientID,
                "redirect_uri": "https://console.anthropic.com/oauth/code/callback",
                "code_verifier": verifier,
            ]
        case "refresh":
            guard let refresh = obj["refresh"] as? String else {
                respond(ctx, .json(400, ["error": "missing refresh token"])); return
            }
            payload = [
                "grant_type": "refresh_token",
                "refresh_token": refresh,
                "client_id": Self.oauthClientID,
            ]
        default:
            respond(ctx, .json(404, ["error": "unknown ai-oauth endpoint"])); return
        }
        guard let bodyData = try? JSONSerialization.data(withJSONObject: payload),
              let url = URL(string: "https://console.anthropic.com/v1/oauth/token") else {
            respond(ctx, .json(500, ["error": "bad request"])); return
        }
        var up = URLRequest(url: url)
        up.httpMethod = "POST"
        up.setValue("application/json", forHTTPHeaderField: "Content-Type")
        up.httpBody = bodyData
        URLSession.shared.dataTask(with: up) { [weak self] data, resp, err in
            guard let self else { return }
            let out = Self.claudeTokenResponse(data, resp, err)
            self.queue.async { self.respond(ctx, out) }
        }.resume()
    }

    static func claudeTokenResponse(_ data: Data?, _ resp: URLResponse?, _ err: Error?) -> HTTPResponse {
        if err != nil { return .json(502, ["error": "couldn't reach Anthropic"]) }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 502
        let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
        guard status == 200, let access = obj["access_token"] as? String else {
            let msg = (obj["error_description"] as? String) ?? (obj["error"] as? String) ?? "token request failed (\(status))"
            return .json(status == 400 || status == 401 ? 400 : 502, ["error": msg])
        }
        // refresh_token is optional on the refresh path (the client keeps its
        // existing one when the provider doesn't rotate it) — required only on
        // exchange, where the provider always returns one.
        let out: [String: Any] = ["access": access, "refresh": obj["refresh_token"] as? String ?? "", "expires": obj["expires_in"] ?? 0]
        let body = (try? JSONSerialization.data(withJSONObject: out)) ?? Data()
        return HTTPResponse(status: 200, headers: [("Content-Type", "application/json")], body: body)
    }

    // ---- iCloud notes storage --------------------------------------------------

    // The app's iCloud Documents ubiquity container (<container>/Documents/Notes),
    // or the local Documents dir when iCloud is unavailable so the routes still
    // work (un-synced) and nothing crashes.
    static func notesBase() -> URL {
        let fm = FileManager.default
        let cloud = fm.url(forUbiquityContainerIdentifier: nil)?
            .appendingPathComponent("Documents/Notes")
        let base = cloud ?? fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Notes")
        try? fm.createDirectory(at: base, withIntermediateDirectories: true)
        return base.standardizedFileURL
    }

    // Resolve a client-supplied relative path safely inside base; nil on traversal.
    static func notesResolve(_ rel: String, base: URL) -> URL? {
        guard !rel.contains("..") else { return nil }
        let trimmed = rel.hasPrefix("/") ? String(rel.dropFirst()) : rel
        guard !trimmed.isEmpty else { return nil }
        let file = base.appendingPathComponent(trimmed).standardizedFileURL
        guard file.path == base.path || file.path.hasPrefix(base.path + "/") else { return nil }
        return file
    }

    // Emit the SAME flat shape as the /notes-api sidecar tree so notesui.js
    // (which reads {dirs:[relPaths], notes:[{path}]}) stays unchanged — not a
    // nested children[] array.
    static func notesFlatten(_ dir: URL, base: URL, dirs: inout [String], notes: inout [[String: Any]]) {
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
        ) else { return }
        for item in items.sorted(by: {
            $0.lastPathComponent.localizedCaseInsensitiveCompare($1.lastPathComponent) == .orderedAscending
        }) {
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            let rel = String(item.standardizedFileURL.path.dropFirst(base.path.count + 1))
            if isDir {
                dirs.append(rel)
                notesFlatten(item, base: base, dirs: &dirs, notes: &notes)
            } else if item.pathExtension.lowercased() == "md" {
                notes.append(["path": rel])
            }
        }
    }

    static func notesRoute(_ req: HTTPRequest) -> HTTPResponse {
        let base = notesBase()
        let coordinator = NSFileCoordinator()
        switch req.path {
        case "/icloud/notes/tree":
            guard req.method == "GET" else { return HTTPResponse(status: 405) }
            var dirs: [String] = []
            var notes: [[String: Any]] = []
            var err: NSError?
            coordinator.coordinate(readingItemAt: base, options: [], error: &err) { url in
                notesFlatten(url, base: url, dirs: &dirs, notes: &notes)
            }
            let obj: [String: Any] = ["dirs": dirs, "notes": notes]
            let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"dirs\":[],\"notes\":[]}".utf8)
            return HTTPResponse(status: 200, headers: [("Content-Type", "application/json")], body: data)
        case "/icloud/notes/read":
            guard req.method == "GET" else { return HTTPResponse(status: 405) }
            let rel = URLComponents(string: req.target)?.queryItems?.first { $0.name == "path" }?.value ?? ""
            guard let file = notesResolve(rel, base: base) else { return .json(400, ["error": "bad path"]) }
            var out: Data?
            var err: NSError?
            coordinator.coordinate(readingItemAt: file, options: [], error: &err) { url in
                out = try? Data(contentsOf: url)
            }
            guard let data = out else {
                return HTTPResponse(status: 404, headers: [("Content-Type", "text/plain")], body: Data("not found".utf8))
            }
            return HTTPResponse(status: 200, headers: [("Content-Type", "text/markdown; charset=utf-8")], body: data)
        case "/icloud/notes/save":
            guard req.method == "POST",
                  let obj = try? JSONSerialization.jsonObject(with: req.body) as? [String: Any],
                  let rel = obj["path"] as? String, let content = obj["content"] as? String,
                  let file = notesResolve(rel, base: base) else { return .json(400, ["error": "bad request"]) }
            try? FileManager.default.createDirectory(
                at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            var ok = false
            var err: NSError?
            coordinator.coordinate(writingItemAt: file, options: .forReplacing, error: &err) { url in
                do { try Data(content.utf8).write(to: url); ok = true } catch { ok = false }
            }
            return ok ? HTTPResponse(status: 200) : .json(500, ["error": "write failed"])
        case "/icloud/notes/delete":
            guard req.method == "POST",
                  let obj = try? JSONSerialization.jsonObject(with: req.body) as? [String: Any],
                  let rel = obj["path"] as? String,
                  let file = notesResolve(rel, base: base) else { return .json(400, ["error": "bad request"]) }
            var err: NSError?
            coordinator.coordinate(writingItemAt: file, options: .forDeleting, error: &err) { url in
                try? FileManager.default.removeItem(at: url)
            }
            return HTTPResponse(status: 200)
        default:
            return HTTPResponse(status: 404, headers: [("Content-Type", "text/plain")], body: Data("not found".utf8))
        }
    }

    // ---- static files ---------------------------------------------------------

    static func staticFile(_ req: HTTPRequest) -> HTTPResponse {
        guard req.method == "GET" || req.method == "HEAD" else { return HTTPResponse(status: 405) }
        // URLComponents decodes the path; a decode failure is a bad request.
        guard let comps = URLComponents(string: req.target), !comps.path.isEmpty else {
            return HTTPResponse(status: 400)
        }
        var rel = comps.path
        if rel.hasSuffix("/") { rel += "index.html" }
        let root = WebRoots.active().standardizedFileURL
        // standardizedFileURL collapses any '..' before the containment check.
        let file = root.appendingPathComponent(rel).standardizedFileURL
        guard file.path == root.path || file.path.hasPrefix(root.path + "/") else {
            return HTTPResponse(status: 403, headers: [("Content-Type", "text/plain")], body: Data("forbidden".utf8))
        }
        guard let data = try? Data(contentsOf: file) else {
            // Atlas routes on the hash, so every real route is '/' — a miss is a
            // genuinely absent file, not a client route needing a rewrite.
            return HTTPResponse(status: 404, headers: [("Content-Type", "text/plain")], body: Data("not found".utf8))
        }
        return HTTPResponse(status: 200, headers: [
            ("Content-Type", mime(file.pathExtension.lowercased())),
            // The window is the only client; caching a stale bundle after a
            // self-update is worse than re-reading files (host.js's rule).
            ("Cache-Control", "no-store"),
        ], body: req.method == "HEAD" ? Data() : data)
    }

    static func mime(_ ext: String) -> String {
        switch ext {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "wasm": return "application/wasm"
        default: return "application/octet-stream"
        }
    }

    // ---- sidecar splice --------------------------------------------------------

    private func splice(_ ctx: Conn, to port: UInt16) {
        let up = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        up.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                guard ctx.mode == .spliceWait else { return }
                // Everything received so far, with the head rewritten to force
                // one-request-per-connection through the sidecar too.
                guard let headEnd = ctx.buffer.firstRange(of: Data("\r\n\r\n".utf8)) else { return }
                var lines = String(decoding: ctx.buffer.subdata(in: 0..<headEnd.lowerBound), as: UTF8.self)
                    .components(separatedBy: "\r\n")
                    .filter { !$0.lowercased().hasPrefix("connection:") }
                lines.append("Connection: close")
                var replay = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
                replay.append(ctx.buffer.subdata(in: headEnd.upperBound..<ctx.buffer.count))
                ctx.buffer.removeAll()
                ctx.upstream = up
                ctx.mode = .spliced
                up.send(content: replay, completion: .contentProcessed { _ in })
                self.pump(from: up, to: ctx.conn)
            case .failed:
                if ctx.mode == .spliceWait {
                    self.queue.async { self.respond(ctx, .json(503, ["error": "sidecar not running"])) }
                }
            default: break
            }
        }
        up.start(queue: queue)
    }

    private func pump(from: NWConnection, to: NWConnection) {
        from.receive(minimumIncompleteLength: 1, maximumLength: 128 * 1024) { [weak self] data, _, complete, error in
            if let data, !data.isEmpty {
                to.send(content: data, completion: .contentProcessed { _ in })
            }
            if complete || error != nil {
                to.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .idempotent)
                from.cancel()
                to.cancel()
                return
            }
            self?.pump(from: from, to: to)
        }
    }

    // ---- themed app icon --------------------------------------------------------

    // The page rasterises its themed logo and posts the PNG (electron/main.js
    // puts it on the dock). iOS has no runtime icon API worth the ceremony — no-op.
    static func applyIcon(_ body: Data) {
        #if os(macOS)
        guard body.count <= 4_000_000,
              let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let png = obj["png"] as? String,
              let b64 = png.components(separatedBy: "base64,").last,
              let data = Data(base64Encoded: b64),
              let img = NSImage(data: data) else { return }
        DispatchQueue.main.async { NSApp.applicationIconImage = img }
        #endif
    }
}
