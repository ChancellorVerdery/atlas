import SwiftUI
import WebKit

// The WKWebView that IS the app, pointed at the local server's origin.
// Reproduces the Electron window rules: same-origin navigation lock, external
// links to the system browser, and only Google's OAuth popup allowed to open
// in-app (it must post the auth code back to its opener).

struct AtlasWebView {
    let origin: URL

    // Google refuses OAuth in anything whose UA looks like an embedded webview;
    // this is our own OAuth client and our own account, so present as Safari —
    // the same fight the Electron shell wins by carrying a Chrome UA.
    static let safariUA: String = {
        #if os(macOS)
        return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
        #else
        return "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"
        #endif
    }()

    func makeWebView(_ coordinator: Coordinator) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Persistent on purpose: localStorage is Atlas's device cache of the
        // Postgres-backed sync DB, and the login token lives there too.
        config.websiteDataStore = .default()
        let web = WKWebView(frame: .zero, configuration: config)
        web.customUserAgent = Self.safariUA
        web.navigationDelegate = coordinator
        web.uiDelegate = coordinator
        #if os(macOS)
        web.underPageBackgroundColor = NSColor(srgbRed: 0x09 / 255, green: 0x0B / 255, blue: 0x11 / 255, alpha: 1)
        #else
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0x09 / 255, green: 0x0B / 255, blue: 0x11 / 255, alpha: 1)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        #endif
        coordinator.webView = web
        web.load(URLRequest(url: origin))
        return web
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let origin: URL
        weak var webView: WKWebView?
        private var observer: NSObjectProtocol?
        private var pendingReload = false
        #if os(macOS)
        private var popupWindows: [NSWindow] = []
        private var hasPopup: Bool { !popupWindows.isEmpty }
        #else
        private var popupHosts: [WKWebView: UIViewController] = [:]
        private var hasPopup: Bool { !popupHosts.isEmpty }
        #endif

        init(origin: URL) {
            self.origin = origin
            super.init()
            observer = NotificationCenter.default.addObserver(
                forName: .atlasWebRootChanged, object: nil, queue: .main
            ) { [weak self] _ in self?.reloadForNewAssets() }
        }

        // Assets were swapped on disk; the running page is stale. A main-frame
        // reload tears down the JS context the Google OAuth popup posts its code
        // back to — so defer it until any popup closes rather than stranding a
        // half-finished sign-in.
        private func reloadForNewAssets() {
            if hasPopup { pendingReload = true } else { webView?.reload() }
        }

        private func drainPendingReload() {
            guard pendingReload, !hasPopup else { return }
            pendingReload = false
            webView?.reload()
        }

        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

        static func openExternal(_ url: URL) {
            #if os(macOS)
            NSWorkspace.shared.open(url)
            #else
            UIApplication.shared.open(url)
            #endif
        }

        // electron/main.js will-navigate: the app itself never navigates away
        // from its own origin; external http(s) links go to the system browser.
        // Popups (Google OAuth) have no navigationDelegate and roam freely.
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard webView === self.webView,
                  navigationAction.targetFrame?.isMainFrame ?? true,
                  let url = navigationAction.request.url,
                  let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
                  !(url.host == origin.host && url.port == origin.port)
            else { decisionHandler(.allow); return }
            decisionHandler(.cancel)
            Self.openExternal(url)
        }

        // electron/main.js setWindowOpenHandler: only accounts.google.com may
        // open in-app (the OAuth code flow posts back to the opener window);
        // every other window.open goes to the system browser.
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let url = navigationAction.request.url else { return nil }
            guard url.host == "accounts.google.com" else {
                if url.scheme == "http" || url.scheme == "https" { Self.openExternal(url) }
                return nil
            }
            // Must use the configuration WebKit hands us — that is what ties the
            // popup to its opener so the auth code can flow back.
            let child = WKWebView(frame: CGRect(x: 0, y: 0, width: 480, height: 640), configuration: configuration)
            child.customUserAgent = AtlasWebView.safariUA
            child.uiDelegate = self
            present(child)
            return child
        }

        func webViewDidClose(_ webView: WKWebView) { dismiss(webView) }

        #if os(macOS)
        private func present(_ child: WKWebView) {
            let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 640),
                               styleMask: [.titled, .closable, .resizable],
                               backing: .buffered, defer: false)
            win.isReleasedWhenClosed = false
            win.title = "Sign in"
            win.contentView = child
            win.center()
            win.makeKeyAndOrderFront(nil)
            popupWindows.append(win)
        }

        private func dismiss(_ child: WKWebView) {
            if let i = popupWindows.firstIndex(where: { $0.contentView === child }) {
                popupWindows[i].close()
                popupWindows.remove(at: i)
            }
            drainPendingReload()
        }
        #else
        private func present(_ child: WKWebView) {
            let vc = UIViewController()
            vc.view = child
            popupHosts[child] = vc
            let root = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }
                .first { $0.isKeyWindow }?.rootViewController
            root?.present(vc, animated: true)
        }

        private func dismiss(_ child: WKWebView) {
            popupHosts.removeValue(forKey: child)?.dismiss(animated: true)
            drainPendingReload()
        }
        #endif
    }
}

#if os(macOS)
extension AtlasWebView: NSViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator(origin: origin) }
    func makeNSView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
#else
extension AtlasWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator(origin: origin) }
    func makeUIView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#endif
