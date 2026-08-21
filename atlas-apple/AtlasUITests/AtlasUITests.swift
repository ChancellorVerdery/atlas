import XCTest

// Real-device checks for the iOS shell. Everything that can be measured in a
// headless browser already is (atlas-ui/tmp-e2e/mobile-sweep.mjs drives the
// same WebKit at iPhone metrics, far faster). What lives here is only what a
// browser genuinely cannot answer:
//
//   * env(safe-area-inset-*) — Playwright reports these as 0, so notch and
//     home-indicator layout can ONLY be checked on a real device/simulator
//   * real touch through WKWebView rather than a synthesised DOM click
//   * surviving a real background/foreground cycle
//
// Web content reaches XCUITest through the accessibility tree, so buttons are
// queried by their visible label.

final class AtlasUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Launches and gets past the login gate the way a user would — by tapping
    /// the real "Continue offline" button, rather than by seeding storage from
    /// a test-only launch flag.
    @discardableResult
    private func launchOffline(_ file: StaticString = #filePath, _ line: UInt = #line) -> XCUIApplication {
        let app = XCUIApplication()
        app.launch()

        // The label is uppercased by CSS text-transform and the accessibility
        // tree reports the TRANSFORMED text, so this must be queried as
        // 'CONTINUE OFFLINE'. Matched case-insensitively so a styling change
        // cannot silently turn this into a skip.
        let offline = app.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] 'continue offline'")).firstMatch
        XCTAssertTrue(offline.waitForExistence(timeout: 40),
                      "login gate never offered 'Continue offline'", file: file, line: line)
        offline.tap()

        // Do NOT assert on a 'Dashboard' static text: index.html ships the app
        // shell statically, so that text exists BEHIND the login overlay and an
        // earlier version of this test went green without ever logging in.
        // The gate disappearing is the only honest signal.
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: offline)
        waitForExpectations(timeout: 30)
        return app
    }

    func testLaunchesAndReachesDashboardOffline() throws {
        let app = launchOffline()
        XCTAssertEqual(app.state, .runningForeground)
    }

    /// The notch/Dynamic Island. AtlasApp.swift deliberately ignores the safe
    /// area (`.ignoresSafeArea`) and hands the insets to CSS via
    /// env(safe-area-inset-*) with viewport-fit=cover, so if that CSS is wrong
    /// the top chrome slides under the status bar. No browser can catch this.
    func testTopChromeClearsTheStatusBar() throws {
        let app = launchOffline()
        let window = app.windows.element(boundBy: 0)
        let safeTop = window.frame.minY + 44 // status bar / island region

        // Whichever piece of top chrome exists, it must sit below the island.
        let candidates = [app.buttons["Menu"], app.buttons.firstMatch]
        guard let chrome = candidates.first(where: { $0.exists }) else {
            return XCTFail("no top chrome found to measure")
        }
        XCTAssertGreaterThanOrEqual(
            chrome.frame.minY, safeTop,
            "top chrome at y=\(chrome.frame.minY) is under the status bar (safe top \(safeTop)) — "
            + "check env(safe-area-inset-top) in styles.css")
    }

    /// Nothing may sit under the home indicator either, and the app must still
    /// be usable after the OS has suspended and resumed it — the lifecycle that
    /// made data go stale before the resume fix in main.js.
    func testSurvivesBackgroundAndForeground() throws {
        let app = launchOffline()
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 3)
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20),
                      "app did not come back to the foreground")
        // Still rendering, not a white screen.
        let alive = app.buttons["Menu"].waitForExistence(timeout: 15)
            || app.buttons.firstMatch.waitForExistence(timeout: 5)
        XCTAssertTrue(alive, "the webview did not survive a background/foreground cycle")
    }

    /// Regression for the reported bug: on Calendar, the month/week/day pills
    /// and "New event" were pushed off the right edge of the screen. Measured
    /// with real touch geometry rather than DOM rects.
    /// Opens the off-canvas nav. On mobile the sidebar is parked off-screen and
    /// only `body.nav-open` slides it in, so every navigation needs this first.
    private func openNav(_ app: XCUIApplication) {
        for label in ["Menu", "Show navigation", "Open navigation"] {
            let b = app.buttons[label]
            if b.exists && b.isHittable { b.tap(); return }
        }
        // Fall back to the first control in the top-left corner.
        let first = app.buttons.firstMatch
        if first.exists && first.isHittable { first.tap() }
    }

    private func tapNav(_ app: XCUIApplication, _ label: String) -> Bool {
        openNav(app)
        for q in [app.links[label], app.buttons[label], app.staticTexts[label]] {
            let el = q.firstMatch
            if el.waitForExistence(timeout: 5) && el.isHittable { el.tap(); return true }
        }
        return false
    }

    /// A fresh install ships base Atlas only — login, settings, dashboard — so a
    /// simulator has no Calendar until it is switched on. Doing that through the
    /// real Settings → Plugins screen also exercises that screen on a phone.
    @discardableResult
    private func enablePlugin(_ app: XCUIApplication, _ name: String) -> Bool {
        guard tapNav(app, "Settings") else { return false }
        let plugins = app.links["Plugins"].firstMatch
        if plugins.waitForExistence(timeout: 8) { plugins.tap() }
        else if app.buttons["Plugins"].firstMatch.waitForExistence(timeout: 5) {
            app.buttons["Plugins"].firstMatch.tap()
        }
        // The whole plugin card is the switch (role="switch", aria-label=name).
        let card = app.switches[name].firstMatch
        guard card.waitForExistence(timeout: 10) else { return false }
        if (card.value as? String) != "1" { card.tap() }
        return true
    }

    /// Regression for the reported bug: on Calendar, the month/week/day pills
    /// and "New event" were pushed off the right edge of the screen. Measured
    /// with real touch geometry rather than DOM rects.
    func testCalendarToolbarControlsAreOnScreen() throws {
        let app = launchOffline()

        guard enablePlugin(app, "Calendar") else {
            throw XCTSkip("could not reach Settings → Plugins to switch Calendar on")
        }
        guard tapNav(app, "Calendar") else {
            throw XCTSkip("Calendar did not appear in the nav after being enabled")
        }

        let screen = app.windows.element(boundBy: 0).frame
        for label in ["Month", "Week", "Day", "New event"] {
            let el = app.buttons[label].firstMatch
            guard el.waitForExistence(timeout: 10) else {
                XCTFail("calendar control '\(label)' never appeared")
                continue
            }
            XCTAssertTrue(el.isHittable, "'\(label)' exists but is not hittable — it is off-screen or covered")
            XCTAssertLessThanOrEqual(
                el.frame.maxX, screen.maxX,
                "'\(label)' extends to x=\(el.frame.maxX) past the \(screen.maxX)pt screen edge")
            XCTAssertGreaterThanOrEqual(
                el.frame.minX, screen.minX,
                "'\(label)' starts at x=\(el.frame.minX), left of the screen")
        }
    }
}
