// Runs the exact `run:` block of .github/workflows/agent-88-forward.yml with a
// fake fetch and a fake process. No network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { evaluate, workflowValue } from './lib/workflow.mjs'

const { Response } = globalThis
const SCRIPT = workflowValue('agent-88-forward.yml', 'run')
const DISPATCHES = 'https://api.github.com/repos/waveriderai/wavefinder-app/dispatches'

async function forward(env, respond = () => new Response(null, { status: 204 })) {
  const calls = []
  const logs = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return respond(url, init)
  }
  let resolve
  const done = new Promise((r) => (resolve = r))
  const proc = {
    env,
    set exitCode(c) {
      resolve(c)
    },
  }
  const fakeConsole = { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) }
  new Function('process', 'fetch', 'console', SCRIPT)(proc, fetch, fakeConsole)
  return { code: await done, calls, logs }
}

test('workflow shape: issues:opened only, no permissions, hosted runner, no checkout, ≤2 min, PRs skipped', () => {
  const yml = readFileSync(new URL('../.github/workflows/agent-88-forward.yml', import.meta.url), 'utf8')
  assert.match(yml, /^on:\n {2}issues:\n {4}types: \[opened\]$/m)
  assert.match(yml, /^permissions: \{\}$/m)
  assert.equal(workflowValue('agent-88-forward.yml', 'runs-on'), 'ubuntu-latest')
  assert.ok(Number(workflowValue('agent-88-forward.yml', 'timeout-minutes')) <= 2)
  assert.ok(!/actions\/checkout|self-hosted|pull_request_target/.test(yml))
  assert.ok(!SCRIPT.includes('${{'), 'no expression interpolation inside run:')
  const cond = workflowValue('agent-88-forward.yml', 'if')
  assert.equal(evaluate(cond, { github: { event: { issue: { number: 3 } } } }), true)
  assert.equal(evaluate(cond, { github: { event: { issue: { number: 3, pull_request: { url: 'x' } } } } }), false)
})

test('dispatches only {number} as JSON to the fixed endpoint and accepts only 204', async () => {
  const r = await forward({ ISSUE_NUMBER: '68', DISPATCH_TOKEN: 'fake-dispatch-token' })
  assert.equal(r.code, 0)
  assert.equal(r.calls.length, 1)
  const [{ url, init }] = r.calls
  assert.equal(url, DISPATCHES)
  assert.equal(init.method, 'POST')
  assert.equal(init.redirect, 'manual')
  assert.ok(init.signal instanceof AbortSignal)
  assert.equal(init.headers.Authorization, 'Bearer fake-dispatch-token')
  assert.deepEqual(JSON.parse(init.body), { event_type: 'agent-88-feedback-issue', client_payload: { number: 68 } })
  assert.deepEqual(r.logs, ['dispatched'])
})

test('invalid numbers fail before any request', async (t) => {
  for (const raw of [undefined, '', '0', '-1', '1.5', '1e3', ' 7', '07', '7"}, "x": "y', '9007199254740993']) {
    await t.test(JSON.stringify(raw), async () => {
      const r = await forward({ ISSUE_NUMBER: raw, DISPATCH_TOKEN: 'fake-dispatch-token' })
      assert.equal(r.code, 1)
      assert.equal(r.calls.length, 0)
      assert.deepEqual(r.logs, ['::error::issue number is not a positive integer'])
    })
  }
})

test('missing secret: warning and success, no request', async () => {
  for (const token of [undefined, '']) {
    const r = await forward({ ISSUE_NUMBER: '5', DISPATCH_TOKEN: token })
    assert.equal(r.code, 0)
    assert.equal(r.calls.length, 0)
    assert.deepEqual(r.logs, ['::warning::AGENT88_DISPATCH_TOKEN is not set; AGENT-88 forward skipped'])
  }
})

test('any non-204, a redirect or a network error fails with a fixed message: no body, no retry', async (t) => {
  for (const [name, respond, msg] of [
    ['200', () => new Response('{"secret":"leak"}', { status: 200 }), '::error::dispatch failed (status 200); not retried'],
    ['302', () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }), '::error::dispatch failed (status 302); not retried'],
    ['404', () => new Response('{"message":"Not Found leak"}', { status: 404 }), '::error::dispatch failed (status 404); not retried'],
    ['500', () => new Response('boom leak', { status: 500 }), '::error::dispatch failed (status 500); not retried'],
    ['network', () => Promise.reject(new TypeError('fetch failed leak')), '::error::dispatch request failed (network or timeout); not retried'],
  ]) {
    await t.test(name, async () => {
      const r = await forward({ ISSUE_NUMBER: '5', DISPATCH_TOKEN: 'fake-dispatch-token' }, respond)
      assert.equal(r.code, 1)
      assert.equal(r.calls.length, 1)
      assert.deepEqual(r.logs, [msg])
      assert.ok(!r.logs.join('\n').includes('leak'))
      assert.ok(!r.logs.join('\n').includes('fake-dispatch-token'))
    })
  }
})
