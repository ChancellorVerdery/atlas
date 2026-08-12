// One retry for calls that leave the box.
//
// Transport blips happen (the google service logged bursts of bare "fetch
// failed"), and Google answers 5xx/429 of its own. Neither says anything about
// whether a grant is still valid, so they must reach the caller as plainly
// transient — a service that treats them as auth failures logs the user out of
// a perfectly good connection.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class TransientError extends Error {}

// ponytail: fixed 400ms step, 2 tries. Enough for a blip; a real outage should
// surface fast rather than stall the WS request behind long backoff.
export async function fetchRetry(url, init, { tries = 2, delay = 400 } = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(delay * i)
    try {
      const r = await fetch(url, init)
      if (r.status === 429 || r.status >= 500) {
        last = new TransientError(`${new URL(url).host} is unavailable (${r.status}).`)
        continue
      }
      return r
    } catch (e) {
      // undici hides the useful part in .cause (ENOTFOUND, ECONNRESET, …)
      last = new TransientError(`could not reach ${new URL(url).host}: ${e?.cause?.code || e?.message || e}`)
    }
  }
  throw last
}
