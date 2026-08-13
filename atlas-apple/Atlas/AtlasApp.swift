import SwiftUI
#if os(macOS)
import AppKit
#endif

// Atlas as a native shell: one multiplatform SwiftUI target, a WKWebView over
// the app's own loopback origin. Everything the page needs beyond static files
// (session bridge, uiapi proxies, sidecar splice, self-updating assets) lives
// behind that origin in LocalServer — see that file for the contract.

@main
struct AtlasApp: App {
    @StateObject private var shell = Shell()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            Group {
                if let origin = shell.origin {
                    AtlasWebView(origin: origin)
                } else {
                    Text("Atlas could not start its local server — see the log.")
                        .padding()
                }
            }
            .background(Color(red: 0x09 / 255, green: 0x0B / 255, blue: 0x11 / 255))
            #if os(macOS)
            .frame(minWidth: 960, minHeight: 640)
            #else
            .ignoresSafeArea(.container, edges: .bottom)
            #endif
        }
        .onChange(of: phase) { _, now in
            if now == .active { Updater.shared.kick() }
        }
        #if os(macOS)
        .defaultSize(width: 1440, height: 900)
        #endif
    }
}

@MainActor
final class Shell: ObservableObject {
    @Published var origin: URL?

    init() {
        let smoke = CommandLine.arguments.contains("--smoke")
        if smoke {
            // Fixtures must never pollute the real Application Support installs.
            WebRoots.baseOverride = FileManager.default.temporaryDirectory
                .appendingPathComponent("atlas-smoke-web-\(ProcessInfo.processInfo.processIdentifier)")
            #if os(macOS)
            NSApplication.shared.setActivationPolicy(.prohibited)
            #endif
        }
        WebRoots.rescan()
        #if os(macOS)
        Sidecar.shared.start()
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { _ in Sidecar.shared.stop() }
        #endif
        do {
            _ = try LocalServer.shared.start()
            origin = LocalServer.shared.origin
        } catch {
            NSLog("atlas: local server failed to start: \(error)")
        }
        if smoke {
            guard let origin else { print("FAIL local server did not start"); exit(1) }
            Task { await Smoke.run(origin: origin) }
        }
    }
}
