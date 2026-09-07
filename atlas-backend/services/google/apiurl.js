// google.api forwards a CALLER-SUPPLIED url with the user's Google access
// token in an Authorization header, so the target is allowlisted rather than
// pattern-matched — the same posture, and for the same reason, as the Canvas
// proxy in uiapi/canvas.js: unrestricted this is an open forwarder carrying a
// bearer token, sitting on stack_default with reach to atlas-auth, postgres,
// adminer, portainer, the host metadata address and the home LAN. Any signed-in
// user could aim it anywhere and receive the body back through the outbox.
//
// Exactly two endpoints are used by the real client, checked rather than
// guessed (grep of atlas-ui/src): Gmail at gmail.googleapis.com/gmail/v1/ and
// Calendar at www.googleapis.com/calendar/v3/. Host equality plus a path-prefix
// test, both anchored, so 'gmail.googleapis.com.evil.test' and
// '/gmail/v1/../..' style targets cannot pass. Extra prefixes can be added via
// GOOGLE_API_PREFIXES (comma-separated) without a code change.
const API_PREFIXES = [
  'https://gmail.googleapis.com/gmail/v1/',
  'https://www.googleapis.com/calendar/v3/',
  ...String(process.env.GOOGLE_API_PREFIXES || '').split(',').map((x) => x.trim()).filter(Boolean),
]

export function allowedApiUrl(raw) {
  let u
  try {
    u = new URL(String(raw))
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  // Compare against the parsed href, not the raw string: URL() has already
  // resolved any '..' segments and normalized the host, so a prefix test on it
  // cannot be walked back out of.
  return API_PREFIXES.some((pre) => {
    let base
    try {
      base = new URL(pre)
    } catch {
      return false
    }
    return u.host === base.host && u.pathname.startsWith(base.pathname)
  })
}
