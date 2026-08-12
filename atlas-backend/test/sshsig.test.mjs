// The gate's whole security rests on this: a signature verifies only when the
// right key signed the right nonce for the right purpose. Signatures are made
// here with the real ssh-keygen, then checked by our own verifier.
// Run: node test/sshsig.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifySignature, parseSignature, keyBlobOf, issueToken, tokenValid } from '../lib/sshsig.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshsig-'))
const keygen = (name, type = 'ed25519') => {
  const f = path.join(dir, name)
  execFileSync('ssh-keygen', ['-q', '-t', type, '-N', '', '-C', name, '-f', f])
  return { priv: f, pub: fs.readFileSync(f + '.pub', 'utf8').trim() }
}
const sign = (key, message, ns = 'atlas-gate') =>
  execFileSync('ssh-keygen', ['-Y', 'sign', '-f', key.priv, '-n', ns, '-'], { input: message, encoding: 'utf8' })

const mine = keygen('mine')
const theirs = keygen('theirs')
const NONCE = 'RG9udFJlcGxheU1lUGxlYXNl'

// --- the happy path ---------------------------------------------------------
const good = sign(mine, NONCE)
assert.ok(verifySignature(good, NONCE, 'atlas-gate', [mine.pub]), 'a real signature must verify')
// extra trusted keys alongside it are fine
assert.ok(verifySignature(good, NONCE, 'atlas-gate', [theirs.pub, mine.pub]))

// --- everything that must NOT get in ----------------------------------------
assert.equal(verifySignature(good, NONCE, 'atlas-gate', [theirs.pub]), false, 'an untrusted key must be refused')
assert.equal(verifySignature(good, NONCE, 'atlas-gate', []), false, 'no trusted keys means no entry')
assert.equal(verifySignature(good, NONCE + 'x', 'atlas-gate', [mine.pub]), false, 'a different message must fail')
assert.equal(verifySignature(good, NONCE, 'other-purpose', [mine.pub]), false, 'the namespace is part of the proof')
// a signature made for something else on this machine can't be reused here
assert.equal(verifySignature(sign(mine, NONCE, 'file'), NONCE, 'atlas-gate', [mine.pub]), false)

// a flipped bit in the signature body
const armor = good.match(/-----BEGIN SSH SIGNATURE-----\n([\s\S]*?)-----END/)[1].replace(/\s/g, '')
const raw = Buffer.from(armor, 'base64')
raw[raw.length - 5] ^= 0x40
const tampered = `-----BEGIN SSH SIGNATURE-----\n${raw.toString('base64')}\n-----END SSH SIGNATURE-----\n`
assert.equal(verifySignature(tampered, NONCE, 'atlas-gate', [mine.pub]), false, 'a tampered signature must fail')

// junk must be refused, not crash the gate
for (const junk of ['', 'hello', null, undefined, '-----BEGIN SSH SIGNATURE-----\nnope\n-----END SSH SIGNATURE-----']) {
  assert.equal(verifySignature(junk, NONCE, 'atlas-gate', [mine.pub]), false)
  assert.equal(parseSignature(junk), null)
}

// an RSA key is refused rather than half-checked
const rsa = keygen('rsa', 'rsa')
assert.equal(verifySignature(sign(rsa, NONCE), NONCE, 'atlas-gate', [rsa.pub]), false, 'only ed25519 is supported')

// --- reading authorized_keys lines ------------------------------------------
assert.ok(keyBlobOf(mine.pub))
assert.ok(keyBlobOf('restrict,pty ' + mine.pub), 'options before the key must still parse')
assert.equal(keyBlobOf('# a comment'), null)
assert.equal(keyBlobOf(''), null)
assert.deepEqual(keyBlobOf(mine.pub), keyBlobOf(mine.pub + ' trailing-comment'))

// --- the 24h browser token --------------------------------------------------
const secret = 'shh'
const tok = issueToken(secret)
assert.ok(tokenValid(tok, secret))
assert.equal(tokenValid(tok, 'other secret'), false, 'a token must not survive a different secret')
assert.equal(tokenValid(tok + 'x', secret), false)
assert.equal(tokenValid('', secret), false)
assert.equal(tokenValid('a.b', secret), false)
// exactly the 24h that was asked for
const t0 = 1_000_000
const day = issueToken(secret, 24 * 60 * 60 * 1000, t0)
assert.ok(tokenValid(day, secret, t0 + 23 * 60 * 60 * 1000), 'still good at 23h')
assert.equal(tokenValid(day, secret, t0 + 24 * 60 * 60 * 1000 + 1), false, 'expired just past 24h')
// the payload is signed, so a longer expiry can't be pasted in
const [body] = day.split('.')
const forged = Buffer.from(JSON.stringify({ exp: t0 + 1e12 })).toString('base64url')
assert.equal(tokenValid(`${forged}.${day.split('.')[1]}`, secret, t0), false, 'the HMAC covers the expiry')
assert.ok(body)

fs.rmSync(dir, { recursive: true, force: true })
console.log('sshsig.test: all assertions passed')
