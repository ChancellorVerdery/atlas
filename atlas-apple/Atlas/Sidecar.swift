#if os(macOS)
import Foundation

// The Mac-only plugin backends (/graph-api, /notes-api, /study-api) stay in
// Node — they shell out to osascript, sqlite3, sips, textutil, the claude CLI
// and Playwright's Chromium, none of which belongs in a Swift rewrite. The app
// spawns the repo's server as a sidecar and the local server splices those
// prefixes to it raw.
//
// ponytail: needs the Atlas repo on disk (ATLAS_REPO or ~/Desktop/Atlas V4)
// and a node install; without either, those three plugins answer 503 exactly
// like they do on iOS. Upgrade path: move study-api to the Atlas server once
// its claude CLI is logged in, then shrink this to notes/graph.
final class Sidecar {
    static let shared = Sidecar()

    private let lock = NSLock()
    private var process: Process?
    private var restarts = 0
    private var _port: UInt16 = 0

    // The port the sidecar actually bound (it listens on any free one and
    // reports it on stdout), 0 until the handshake line arrives.
    var boundPort: UInt16 { lock.lock(); defer { lock.unlock() }; return _port }
    var isRunning: Bool { (process?.isRunning ?? false) && boundPort != 0 }

    func start() {
        let env = ProcessInfo.processInfo.environment
        let repo = env["ATLAS_REPO"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Desktop/Atlas V4/atlas-ui")
        let script = repo.appendingPathComponent("server/standalone.mjs")
        let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
        guard let node, FileManager.default.fileExists(atPath: script.path) else {
            NSLog("atlas: sidecar disabled (node or \(script.path) missing) — graph/notes/study answer 503")
            return
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script.path]
        p.currentDirectoryURL = repo
        var e = env
        e.removeValue(forKey: "PORT") // let it bind any free port and report back
        // GUI apps get a bare PATH; the handlers spawn `claude`, `osascript`,
        // `sips`, ... from the usual CLI locations.
        e["PATH"] = (e["PATH"] ?? "/usr/bin:/bin") + ":/opt/homebrew/bin:/usr/local/bin"
        p.environment = e
        // The sidecar watches this pipe and exits when it closes, so it can
        // never outlive the app as an orphan holding the port.
        p.standardInput = Pipe()
        // Parse the SIDECAR_PORT= handshake off stdout.
        let out = Pipe()
        p.standardOutput = out
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let text = String(decoding: h.availableData, as: UTF8.self)
            for line in text.split(separator: "\n") where line.hasPrefix("SIDECAR_PORT=") {
                if let n = UInt16(line.dropFirst("SIDECAR_PORT=".count).trimmingCharacters(in: .whitespaces)) {
                    self?.lock.lock(); self?._port = n; self?.lock.unlock()
                    NSLog("atlas: sidecar bound 127.0.0.1:\(n)")
                }
            }
        }
        p.terminationHandler = { [weak self] proc in
            guard let self else { return }
            self.lock.lock(); self._port = 0; self.lock.unlock()
            guard self.restarts < 3 else { return }
            self.restarts += 1
            NSLog("atlas: sidecar exited (\(proc.terminationStatus)) — restart \(self.restarts)/3")
            DispatchQueue.global().asyncAfter(deadline: .now() + 1) { self.start() }
        }
        do {
            try p.run()
            process = p
        } catch {
            NSLog("atlas: sidecar failed to start: \(error)")
        }
    }

    func stop() {
        process?.terminationHandler = nil
        process?.terminate()
        process = nil
    }
}
#endif
