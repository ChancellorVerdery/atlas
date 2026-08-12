// Verify an SSH signature (SSHSIG, the format `ssh-keygen -Y sign` produces).
//
// This is how the gate authenticates: prove you hold a private key that is
// already trusted to SSH into the box, and you get a browser token. No new
// credential to manage, and nothing secret ever leaves the user's machine —
// they sign a nonce, we check it against the same public keys sshd trusts.
//
// ed25519 only. That is what authorized_keys holds, and refusing anything else
// is better than half-verifying an algorithm we didn't test.
import crypto from 'node:crypto'

const MAGIC = Buffer.from('SSHSIG')
// SPKI wrapper for a raw ed25519 public key — the fixed prefix, then 32 bytes.
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

// SSH wire format: length-prefixed strings, one after another.
function reader(buf) {
  let at = 0
  return {
    str() {
      const n = buf.readUInt32BE(at)
      at += 4
      const out = buf.subarray(at, at + n)
      at += n
      return out
    },
    u32() { const v = buf.readUInt32BE(at); at += 4; return v },
    get rest() { return buf.subarray(at) },
  }
}
const sshString = (b) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(b.length)
  return Buffer.concat([len, Buffer.from(b)])
}

export function parseArmored(text) {
  const m = String(text).match(/-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/)
  if (!m) return null
  try { return Buffer.from(m[1].replace(/\s+/g, ''), 'base64') } catch { return null }
}

// -> { keyBlob, namespace, hash, signature } or null if it isn't a signature we
// know how to read. Never throws: this parses attacker-supplied bytes.
export function parseSignature(armored) {
  const buf = parseArmored(armored)
  if (!buf || buf.length < 10 || !buf.subarray(0, 6).equals(MAGIC)) return null
  try {
    const r = reader(buf.subarray(6))
    const version = r.u32()
    if (version !== 1) return null
    const keyBlob = r.str()
    const namespace = r.str().toString()
    const reserved = r.str()
    const hash = r.str().toString()
    const sigBlob = r.str()
    const sr = reader(sigBlob)
    const sigType = sr.str().toString()
    const signature = sr.str()
    if (sigType !== 'ssh-ed25519' || signature.length !== 64) return null
    return { keyBlob, namespace, reserved, hash, signature }
  } catch { return null }
}

// The public key half of an authorized_keys / allowed_signers line.
export function keyBlobOf(line) {
  const parts = String(line).trim().split(/\s+/)
  const i = parts.findIndex((p) => p === 'ssh-ed25519')
  if (i < 0 || !parts[i + 1]) return null
  try {
    const blob = Buffer.from(parts[i + 1], 'base64')
    const r = reader(blob)
    return r.str().toString() === 'ssh-ed25519' ? blob : null
  } catch { return null }
}

/**
 * True when `armored` is a signature over `message`, in `namespace`, by one of
 * `allowedKeys` (authorized_keys lines).
 */
export function verifySignature(armored, message, namespace, allowedKeys) {
  const sig = parseSignature(armored)
  if (!sig) return false
  // The namespace is what stops a signature made for one purpose being replayed
  // at another (ssh-keygen bakes it into the signed bytes).
  if (sig.namespace !== namespace) return false
  if (!['sha256', 'sha512'].includes(sig.hash)) return false

  const trusted = allowedKeys
    .map(keyBlobOf)
    .filter(Boolean)
    .some((k) => k.equals(sig.keyBlob))
  if (!trusted) return false

  const kr = reader(sig.keyBlob)
  if (kr.str().toString() !== 'ssh-ed25519') return false
  const raw = kr.str()
  if (raw.length !== 32) return false

  // What ssh-keygen actually signs: the magic, the context, and a HASH of the
  // message — not the message itself.
  const signed = Buffer.concat([
    MAGIC,
    sshString(sig.namespace),
    sshString(sig.reserved),
    sshString(sig.hash),
    sshString(crypto.createHash(sig.hash).update(message).digest()),
  ])
  const key = crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki',
  })
  try { return crypto.verify(null, signed, key, sig.signature) } catch { return false }
}

// ---- the browser token ------------------------------------------------------

const b64u = (b) => Buffer.from(b).toString('base64url')

// Signed, not encrypted: it says nothing but when it expires, and the HMAC is
// what stops it being edited. 24h, as asked.
export function issueToken(secret, ttlMs = 24 * 60 * 60 * 1000, now = Date.now()) {
  const body = b64u(JSON.stringify({ exp: now + ttlMs }))
  return `${body}.${b64u(crypto.createHmac('sha256', secret).update(body).digest())}`
}

export function tokenValid(token, secret, now = Date.now()) {
  const [body, mac] = String(token || '').split('.')
  if (!body || !mac) return false
  const want = b64u(crypto.createHmac('sha256', secret).update(body).digest())
  // timingSafeEqual throws on a length mismatch, which is itself a fail
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false
  try { return JSON.parse(Buffer.from(body, 'base64url')).exp > now } catch { return false }
}
