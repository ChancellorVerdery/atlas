// Canvas proxy redirect validation test
// Exercises the redirect bypass: verifies that redirect targets are re-validated
// Run: node --test canvas-redirect.test.mjs

import { canvasProxy, allowedHost } from '../services/uiapi/canvas.js'
import { strictEqual, ok } from 'node:assert'

// Mock fetch to simulate Canvas issuing redirects
const originalFetch = global.fetch
let mockResponses = []
let fetchCount = 0

global.fetch = async (url, opts) => {
  const response = mockResponses[fetchCount++]
  if (!response) throw new Error(`No mock response for fetch #${fetchCount}`)
  response.url = url
  response.options = opts
  return response
}

const mockResponse = (status, body, headers = {}) => ({
  status,
  headers: new Map(Object.entries(headers)),
  arrayBuffer: async () => Buffer.from(body),
})

const mockRedirect = (status, location, finalBody = 'final', finalHeaders = {}) => {
  mockResponses = [
    mockResponse(status, '', { location }),
    mockResponse(200, finalBody, finalHeaders),
  ]
  fetchCount = 0
}

const testCanvasProxy = async (name, setupFn, checkFn) => {
  console.log(`Testing: ${name}`)
  mockResponses = []
  fetchCount = 0
  const res = {
    statusCode: 0, body: '', headers: new Map(),
    writeHead(code) { this.statusCode = code; return this },
    setHeader(k, v) { this.headers.set(k, v); return this },
    end(b) { this.body = String(b ?? ''); },
  }
  const req = { method: 'GET', headers: {} }
  setupFn(req, mockResponses)
  try {
    await canvasProxy(req, res)
    checkFn(res)
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`)
    throw e
  }
}

// Test 1: Normal 200 response (no redirect)
await testCanvasProxy('normal 200 response', (req) => {
  req.url = '/uncc.instructure.com/api/v1/users/self'
  mockResponses = [mockResponse(200, '{"id":123}', { 'content-type': 'application/json' })]
}, (res) => {
  strictEqual(res.statusCode, 200)
  ok(res.body.includes('123'))
})

// Test 2: Redirect to the SAME allowed host (should follow)
await testCanvasProxy('redirect to same allowed host', (req) => {
  req.url = '/uncc.instructure.com/api/v1/users/self'
  mockRedirect(302, 'https://uncc.instructure.com/api/v1/users/123', '{"id":123}')
}, (res) => {
  strictEqual(res.statusCode, 200)
  ok(res.body.includes('123'))
})

// Test 3: Redirect to a DIFFERENT allowed host (should follow)
await testCanvasProxy('redirect to another allowed Canvas host', (req) => {
  req.url = '/uncc.instructure.com/api/v1/courses'
  mockRedirect(301, 'https://canvas.instructure.com/api/v1/courses', '{"courses":[]}')
}, (res) => {
  strictEqual(res.statusCode, 200)
})

// Test 4: Redirect to an DISALLOWED host (should reject with 403)
await testCanvasProxy('redirect to disallowed host is rejected', (req) => {
  req.url = '/uncc.instructure.com/api/v1/users/self'
  mockResponses = [
    mockResponse(302, '', { location: 'https://attacker.evil.com/steal' })
  ]
}, (res) => {
  strictEqual(res.statusCode, 403)
  ok(res.body.includes('redirect target not allowed'))
})

// Test 5: Redirect to localhost (should reject)
await testCanvasProxy('redirect to localhost is rejected', (req) => {
  req.url = '/uncc.instructure.com/admin'
  mockResponses = [
    mockResponse(302, '', { location: 'http://localhost:8000/admin/panel' })
  ]
}, (res) => {
  strictEqual(res.statusCode, 403)
})

// Test 6: Redirect with no Location header (error case)
await testCanvasProxy('redirect with missing Location header', (req) => {
  req.url = '/uncc.instructure.com/api'
  mockResponses = [
    mockResponse(302, '')
  ]
}, (res) => {
  strictEqual(res.statusCode, 502)
  ok(res.body.includes('no Location'))
})

// Test 7: Chain of redirects (should re-validate each step)
await testCanvasProxy('multiple redirects re-validate each step', (req) => {
  req.url = '/uncc.instructure.com/api'
  mockResponses = [
    mockResponse(301, '', { location: 'https://canvas.instructure.com/api' }),
    mockResponse(302, '', { location: 'https://attacker.net/final' })
  ]
}, (res) => {
  strictEqual(res.statusCode, 403, 'second redirect to attacker should be rejected')
})

// Test 8: Auth header is carried through redirect
await testCanvasProxy('Authorization header survives redirect', (req) => {
  req.url = '/uncc.instructure.com/api'
  req.headers.authorization = 'Bearer secret-canvas-token'
  mockRedirect(302, 'https://uncc.instructure.com/api/v2', '{"ok":true}')
}, (res) => {
  strictEqual(res.statusCode, 200)
  strictEqual(mockResponses[1].options?.headers?.Authorization, 'Bearer secret-canvas-token')
})

global.fetch = originalFetch
console.log('\nCanvas redirect validation: all tests passed')
