import Foundation
import Network
import WebKit
import CryptoKit

// The runnable check behind the shell's non-trivial logic: static serving,
// the traversal guard, the proxy's auth gate, the sidecar splice, the
// updater's verify/swap path, and a real page boot in an offscreen webview.
//
// Run: atlas-apple/build.sh smoke   (launches the built .app with --smoke;
// no window is shown — activation policy is .prohibited)
@MainActor
enum Smoke {
    static func run(origin: URL) async -> Never {
        var failed = 0
        func check(_ name: String, _ pass: Bool, _ detail: String = "") {
            print("\(pass ? "PASS" : "FAIL") \(name)\(detail.isEmpty ? "" : " - \(detail)")")
            if !pass { failed += 1 }
        }
        func request(_ path: String, method: String = "GET") async -> (Int, Data) {
            guard let url = URL(string: path, relativeTo: origin) else { return (0, Data()) }
            var req = URLRequest(url: url)
            req.httpMethod = method
            do {
                let (data, resp) = try await URLSession.shared.data(for: req)
                return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
            } catch { return (0, Data()) }
        }

        // ---- static serving ------------------------------------------------
        let (code, html) = await request("/")
        check("serves the bundled app", code == 200
              && String(decoding: html, as: UTF8.self).contains("<title>Atlas</title>"),
              "status=\(code)")
        let (miss, _) = await request("/definitely-not-a-file")
        check("plain misses answer 404", miss == 404, "status=\(miss)")
        // %2F-spliced dots survive URL parsing and must hit the containment guard
        let (trav, travBody) = await request("/assets%2F..%2F..%2F..%2Fetc%2Fhosts")
        check("path traversal is refused", trav == 403 || trav == 404,
              "status=\(trav) body=\(String(decoding: travBody.prefix(40), as: UTF8.self))")

        // ---- malformed request must not crash the in-process server ----------
        // A negative Content-Length used to trap the process on a subdata range;
        // send it raw (URLSession won't) and assert 400 + the server survives.
        let raw = await rawRequest(port: LocalServer.shared.port,
                                   "GET / HTTP/1.1\r\nHost: x\r\nContent-Length: -1\r\n\r\n")
        check("negative Content-Length is rejected, not fatal", raw.contains("400"),
              "reply=\(raw.split(separator: "\r\n").first.map(String.init) ?? "<none>")")
        let (afterCode, _) = await request("/")
        check("server still serving after a malformed request", afterCode == 200, "status=\(afterCode)")

        // ---- uiapi proxy gate ------------------------------------------------
        _ = await request("/local/session", method: "DELETE")
        let (canvas, _) = await request("/canvas-proxy/uncc.instructure.com/api/v1/users/self")
        check("uiapi proxy refuses without a session token", canvas == 503, "status=\(canvas)")

        // ---- mac-only prefixes ------------------------------------------------
        #if os(macOS)
        // the sidecar's node process may still be booting — poll briefly
        var jobs = 0
        for _ in 0..<40 {
            jobs = (await request("/study-api/jobs")).0
            if jobs == 200 { break }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        check("sidecar serves /study-api/jobs through the splice", jobs == 200, "status=\(jobs)")
        // the handler's own error answer (400 here) proves a second prefix and
        // the error path both make it through the splice — 0/503 would mean not
        let (graphMiss, _) = await request("/graph-api/nope")
        check("second sidecar prefix answers through the splice",
              graphMiss == 400 || graphMiss == 404, "status=\(graphMiss)")
        #else
        let (jobs, _) = await request("/study-api/jobs")
        check("mac-only API answers 503 here", jobs == 503, "status=\(jobs)")
        #endif

        // ---- updater: verify, containment, swap -------------------------------
        let payload = Data("fixture".utf8)
        let sha = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
        let fixture = Manifest(version: "fixture", builtAt: 9e15, files: [
            .init(path: "index.html", size: payload.count, sha256: sha),
        ])
        do {
            let dir = try await Updater.shared.download(fixture) { _ in payload }
            WebRoots.adopt(dir, builtAt: fixture.builtAt)
            let (fcode, fbody) = await request("/")
            check("updater swap serves the downloaded root",
                  fcode == 200 && fbody == payload, "status=\(fcode)")
        } catch { check("updater downloads a valid build", false, "\(error)") }
        do {
            _ = try await Updater.shared.download(fixture) { _ in Data("tampered".utf8) }
            check("corrupt download is rejected", false)
        } catch { check("corrupt download is rejected", true) }
        do {
            let evil = Manifest(version: "evil", builtAt: 1, files: [
                .init(path: "../../escape", size: payload.count, sha256: sha),
            ])
            _ = try await Updater.shared.download(evil) { _ in payload }
            check("manifest path escape is rejected", false)
        } catch { check("manifest path escape is rejected", true) }
        WebRoots.reset() // back to the bundled root for the boot check
        try? FileManager.default.removeItem(at: WebRoots.downloads)

        // ---- page boot in an offscreen webview ---------------------------------
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 1280, height: 800))
        web.customUserAgent = AtlasWebView.safariUA
        web.load(URLRequest(url: origin))
        // Poll rather than sample once — a signed-in boot waits on the sync
        // connect before the shell renders (same rule as the Electron smoke).
        var booted = false
        for _ in 0..<100 where !booted {
            booted = ((try? await web.evaluateJavaScript(
                "!!(document.querySelector('.auth-card') || document.querySelector('#nav a'))"
            )) as? Bool) ?? false
            if !booted { try? await Task.sleep(nanoseconds: 150_000_000) }
        }
        check("page boots from the local origin (login gate or nav rendered)", booted)
        let secure = (try? await web.evaluateJavaScript(
            "typeof crypto.randomUUID === 'function'")) as? Bool ?? false
        check("origin is a secure context (crypto.randomUUID exists)", secure)

        print(failed == 0 ? "\nsmoke: all good" : "\nsmoke: \(failed) failed")
        exit(failed == 0 ? 0 : 1)
    }

    // A raw one-shot TCP request so the check can send bytes URLSession refuses
    // to (a negative Content-Length). Returns the reply text, or "" on failure.
    static func rawRequest(port: UInt16, _ text: String) async -> String {
        await withCheckedContinuation { cont in
            let conn = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
            var done = false
            let finish: (String) -> Void = { s in
                if !done { done = true; conn.cancel(); cont.resume(returning: s) }
            }
            conn.stateUpdateHandler = { state in
                if case .ready = state {
                    conn.send(content: Data(text.utf8), completion: .contentProcessed { _ in
                        conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, _, _ in
                            finish(data.map { String(decoding: $0, as: UTF8.self) } ?? "")
                        }
                    })
                } else if case .failed = state { finish("") }
            }
            conn.start(queue: .global())
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) { finish("") }
        }
    }
}
