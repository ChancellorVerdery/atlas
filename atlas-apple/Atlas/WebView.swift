import SwiftUI
import WebKit

// The WKWebView that IS the app, pointed at the local server's origin.
// Same-origin navigation lock; every external link and every window.open
// (Google OAuth included) goes to the system browser. Google redirects back to
// the loopback /oauth/google/callback, which LocalServer bridges into the page.

// ponytail: one weak ref, not a whole state-management layer — the View menu
// commands (AtlasApp.swift) need *some* way to reach the on-screen WKWebView
// for zoom, and there's only ever one window's worth of it.
@MainActor
final class ActiveWebView {
    static let shared = ActiveWebView()
    private init() {}

    weak var webView: WKWebView?

    static let minZoom: CGFloat = 0.5
    static let maxZoom: CGFloat = 3.0
    private static let step: CGFloat = 0.1
    private static let zoomDefaultsKey = "atlas.webview.pageZoom"

    func zoomIn() { setZoom((webView?.pageZoom ?? 1) + Self.step) }
    func zoomOut() { setZoom((webView?.pageZoom ?? 1) - Self.step) }
    func resetZoom() { setZoom(1) }

    private func setZoom(_ zoom: CGFloat) {
        let clamped = min(Self.maxZoom, max(Self.minZoom, zoom))
        webView?.pageZoom = clamped
        UserDefaults.standard.set(Double(clamped), forKey: Self.zoomDefaultsKey)
    }

    // Called once, from makeWebView, when the page's own WKWebView exists.
    // Restores whatever zoom the last session left behind (session-only
    // persistence was the ask; UserDefaults gives us across-launch for free).
    fileprivate func attach(_ web: WKWebView) {
        webView = web
        let saved = UserDefaults.standard.double(forKey: Self.zoomDefaultsKey)
        web.pageZoom = saved > 0 ? min(Self.maxZoom, max(Self.minZoom, CGFloat(saved))) : 1
    }
}

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

    @MainActor
    func makeWebView(_ coordinator: Coordinator) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Persistent on purpose: localStorage is Atlas's device cache of the
        // Postgres-backed sync DB, and the login token lives there too.
        config.websiteDataStore = .default()
        // The only channel by which the web layer learns it's the native shell.
        // .atDocumentStart so it's set before any page script runs; main frame
        // only so cross-origin subframes never see it.
        #if os(iOS)
        let platform = "ios"
        #else
        let platform = "macos"
        #endif
        config.userContentController.addUserScript(WKUserScript(
            source: "window.__ATLAS_NATIVE__ = { platform: '\(platform)' };",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
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
        ActiveWebView.shared.attach(web)
        // Google OAuth now runs in the system browser and redirects to our
        // loopback /oauth/google/callback; LocalServer intercepts it and hands
        // the code back here to deliver into the page's registered bridge.
        LocalServer.shared.onOAuthCallback = { [weak web] provider, code, state in
            guard let web else { return }
            let js = "window.__atlasOAuthCallback && window.__atlasOAuthCallback("
                + "'\(Coordinator.jsEscape(provider))', "
                + "'\(Coordinator.jsEscape(code))', "
                + "'\(Coordinator.jsEscape(state))')"
            web.evaluateJavaScript(js)
        }
        web.load(URLRequest(url: origin))
        return web
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let origin: URL
        weak var webView: WKWebView?
        private var observer: NSObjectProtocol?

        init(origin: URL) {
            self.origin = origin
            super.init()
            observer = NotificationCenter.default.addObserver(
                forName: .atlasWebRootChanged, object: nil, queue: .main
            ) { [weak self] _ in self?.reloadForNewAssets() }
        }

        // Assets were swapped on disk; the running page is stale, so reload.
        // ponytail: OAuth now runs in the system browser and the code returns
        // via window.__atlasOAuthCallback, which the page re-registers on load —
        // so a reload mid-sign-in is the page's problem to re-arm, not ours to
        // defer. (The old in-app popup needed the JS context kept alive; gone.)
        private func reloadForNewAssets() { webView?.reload() }

        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

        // JS-string-escape for values interpolated into a single-quoted literal
        // in evaluateJavaScript (OAuth code/state from the loopback callback).
        static func jsEscape(_ s: String) -> String {
            var out = ""
            for u in s.unicodeScalars {
                switch u {
                case "\\": out += "\\\\"
                case "'": out += "\\'"
                case "\n": out += "\\n"
                case "\r": out += "\\r"
                case "\u{2028}": out += "\\u2028"
                case "\u{2029}": out += "\\u2029"
                default: out.unicodeScalars.append(u)
                }
            }
            return out
        }

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

        // No in-app popups: every window.open — Google OAuth included — goes to
        // the system browser. Google auth runs in the user's real default-browser
        // session and redirects to our loopback /oauth/google/callback, which
        // LocalServer intercepts and bridges back into this webview.
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url,
               url.scheme == "http" || url.scheme == "https" {
                Self.openExternal(url)
            }
            return nil
        }
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
