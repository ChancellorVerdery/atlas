import Foundation
import CryptoKit

// Which copy of the web app the local server serves, and how it gets newer.
//
// Two candidates: the dist/ baked into the app bundle at build time, and the
// newest complete download under Application Support — the higher builtAt wins.
// The updater fetches the server's manifest (token-gated uiapi /app route),
// downloads changed builds file-by-file with sha256 verification, swaps the
// directory in atomically, and asks the webview to reload. UI changes reach
// the phone without touching Xcode; if the server is unreachable the app just
// keeps running whatever it has.

struct Manifest: Codable {
    struct Entry: Codable {
        let path: String
        let size: Int
        let sha256: String
    }
    let version: String
    let builtAt: Double
    let files: [Entry]
}

enum WebRoots {
    // Smoke points this at a temp dir so fixtures never pollute real installs.
    static var baseOverride: URL?

    private static let lock = NSLock()
    private static var current: (root: URL, builtAt: Double)?

    static var bundled: URL { Bundle.main.resourceURL!.appendingPathComponent("dist") }
    static var downloads: URL {
        baseOverride ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AtlasWeb")
    }

    static func manifest(at root: URL) -> Manifest? {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("manifest.json")) else { return nil }
        return try? JSONDecoder().decode(Manifest.self, from: data)
    }

    static func active() -> URL {
        lock.lock(); defer { lock.unlock() }
        return current?.root ?? bundled
    }

    static func activeBuiltAt() -> Double {
        lock.lock(); defer { lock.unlock() }
        return current?.builtAt ?? 0
    }

    static func adopt(_ root: URL, builtAt: Double) {
        lock.lock(); current = (root, builtAt); lock.unlock()
    }

    static func reset() {
        lock.lock(); current = nil; lock.unlock()
    }

    // At launch: bundled dist vs. every complete download; higher builtAt wins.
    // An app update that out-ships the server (bundled newer than downloads)
    // takes over automatically for the same reason.
    static func rescan() {
        var best = (root: bundled, builtAt: manifest(at: bundled)?.builtAt ?? 0)
        let fm = FileManager.default
        for dir in (try? fm.contentsOfDirectory(at: downloads, includingPropertiesForKeys: nil)) ?? [] {
            guard fm.fileExists(atPath: dir.appendingPathComponent(".complete").path),
                  let m = manifest(at: dir), m.builtAt > best.builtAt else { continue }
            best = (dir, m.builtAt)
        }
        lock.lock(); current = best; lock.unlock()
    }
}

final class Updater {
    static let shared = Updater()

    private let lock = NSLock()
    private var running = false
    private var lastCheck: Date = .distantPast

    struct Err: Error, CustomStringConvertible {
        let description: String
        init(_ d: String) { description = d }
    }

    // Runs when the page shares its session token (every signed-in boot) and on
    // each return to foreground. Single-flight, at most every 5 minutes.
    func kick() {
        lock.lock()
        let go = !running && Date().timeIntervalSince(lastCheck) > 300
        if go { running = true; lastCheck = Date() }
        lock.unlock()
        guard go else { return }
        Task.detached(priority: .utility) {
            await self.check()
            self.finish()
        }
    }

    private func finish() {
        lock.lock(); running = false; lock.unlock()
    }

    private func check() async {
        guard let token = TokenStore.shared.token else { return }
        do {
            let remote = try await fetchManifest(token)
            guard remote.builtAt > WebRoots.activeBuiltAt() else { return }
            NSLog("atlas: newer web assets on the server (\(remote.version)) — downloading")
            let dir = try await download(remote) { rel in try await self.fetchFile(rel, token) }
            WebRoots.adopt(dir, builtAt: remote.builtAt)
            prune(keep: dir)
            NSLog("atlas: web assets updated to \(remote.version)")
            await MainActor.run {
                NotificationCenter.default.post(name: .atlasWebRootChanged, object: nil)
            }
        } catch {
            // Not fatal: the app keeps serving what it has.
            NSLog("atlas: asset update failed: \(error)")
        }
    }

    // Split from the network so the smoke check can drive the money path (hash
    // verification, manifest-path containment, atomic swap) with literal data.
    func download(_ m: Manifest, fetch: (String) async throws -> Data) async throws -> URL {
        let fm = FileManager.default
        let staging = WebRoots.downloads.appendingPathComponent(".staging")
        try? fm.removeItem(at: staging)
        try fm.createDirectory(at: staging, withIntermediateDirectories: true)
        let stagingPath = staging.standardizedFileURL.path
        for f in m.files {
            let dest = staging.appendingPathComponent(f.path).standardizedFileURL
            guard dest.path.hasPrefix(stagingPath + "/") else {
                throw Err("manifest path escapes staging: \(f.path)")
            }
            let data = try await fetch(f.path)
            guard data.count == f.size,
                  SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == f.sha256 else {
                throw Err("checksum mismatch: \(f.path)")
            }
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: dest)
        }
        // The manifest itself isn't in its own file list — write the copy we
        // verified everything against, then mark the download complete.
        try JSONEncoder().encode(m).write(to: staging.appendingPathComponent("manifest.json"))
        try Data().write(to: staging.appendingPathComponent(".complete"))
        // Name the dir by builtAt, not version: version can repeat across genuinely
        // different builds ('dev', or '<sha>-dirty' with uncommitted edits), and
        // reusing the name would removeItem the very root we're serving from during
        // the swap. builtAt is unique per build, so a new build lands in a new dir
        // and the active root is never touched. Guard anyway.
        let final = WebRoots.downloads.appendingPathComponent("build-\(Int(m.builtAt))")
        let active = WebRoots.active().standardizedFileURL.path
        if final.standardizedFileURL.path != active { try? fm.removeItem(at: final) }
        try fm.moveItem(at: staging, to: final)
        return final
    }

    private func prune(keep: URL) {
        let fm = FileManager.default
        for dir in (try? fm.contentsOfDirectory(at: WebRoots.downloads, includingPropertiesForKeys: nil)) ?? [] {
            if dir.standardizedFileURL.path != keep.standardizedFileURL.path {
                try? fm.removeItem(at: dir)
            }
        }
    }

    // ---- network ---------------------------------------------------------------

    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 60
        return URLSession(configuration: c)
    }()

    private func get(_ path: String, _ token: String) async throws -> Data {
        guard let url = URL(string: Uiapi.base + path) else { throw Err("bad url: \(path)") }
        var req = URLRequest(url: url)
        req.setValue(token, forHTTPHeaderField: "x-atlas-token")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw Err("\(path): status \((resp as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        return data
    }

    private func fetchManifest(_ token: String) async throws -> Manifest {
        try JSONDecoder().decode(Manifest.self, from: try await get("/app/manifest.json", token))
    }

    private func fetchFile(_ rel: String, _ token: String) async throws -> Data {
        let encoded = rel.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? rel
        return try await get("/app/" + encoded, token)
    }
}

extension Notification.Name {
    static let atlasWebRootChanged = Notification.Name("atlas.webroot.changed")
}
