// Runs the exact github-script of .github/workflows/notify-user.yml against a fake
// GitHub client and a fake Resend, and evaluates the real `if:` of both notify
// workflows. The contact-ref fixture is byte-identical to waverider-app's
// src/lib/feedback/__fixtures__/wr-contact-v1.json (produced by its TS encoder).
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { evaluate, workflowValue } from './lib/workflow.mjs'

const { Response } = globalThis
const require = createRequire(import.meta.url)
const fixture = JSON.parse(readFileSync(new URL('./fixtures/wr-contact-v1.json', import.meta.url), 'utf8'))
const SCRIPT = workflowValue('notify-user.yml', 'script')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const ROUTE_USER = { login: 'waveriderai', type: 'User' }
const ADDRESS = fixture.contact.email

/** A ref sealed exactly like contactRef.ts, for a given key/repo/number/plaintext. */
function seal(keyB64, repo, number, plaintext) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv)
  c.setAAD(Buffer.from(`wr-contact v1\n${repo}\n${number}`))
  const ct = Buffer.concat([c.update(plaintext), c.final()])
  return `<!-- wr-contact v1 ${Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url')} -->`
}

async function notify({ body, number = fixture.number, author = ROUTE_USER, env = {}, resend = 200, issueRead = 'ok', eventBody = 'stale event copy', commentUrl } = {}) {
  const logs = []
  const failures = []
  const sends = []
  const [owner, repo] = fixture.repo.split('/')
  const github = {
    rest: {
      issues: {
        get: async (args) => {
          assert.deepEqual(args, { owner, repo, issue_number: number })
          if (issueRead !== 'ok') throw new Error('HttpError: Not Found leak')
          return { data: { number, title: 'Chart <b>blank</b>', body, user: author } }
        },
      },
    },
  }
  const context = {
    repo: { owner, repo },
    payload: {
      issue: { number, body: eventBody },
      comment: { id: 555, body: 'Fixed <script>x</script>', user: { login: 'kai' }, html_url: commentUrl ?? `https://github.com/${fixture.repo}/issues/${number}#issuecomment-555` },
    },
  }
  const core = { info: (m) => logs.push(m), setFailed: (m) => failures.push(m) }
  const fetch = async (url, init) => {
    sends.push({ url, init, payload: JSON.parse(init.body) })
    if (resend === 'network') throw new TypeError(`fetch failed for ${ADDRESS}`)
    return new Response(JSON.stringify({ message: `provider says ${ADDRESS}` }), { status: resend })
  }
  const proc = { env: { RESEND_API_KEY: 'fake-resend', FEEDBACK_CONTACT_KEY: fixture.fixture_key_base64, ...env } }
  await new AsyncFunction('github', 'context', 'core', 'require', 'process', 'fetch', SCRIPT)(github, context, core, require, proc, fetch)
  const all = [...logs, ...failures].join('\n')
  assert.ok(!all.includes('@'), `logs must not carry an address: ${all}`)
  assert.ok(!all.includes('wr-contact v1 '), 'logs must not carry a ref')
  return { logs, failures, sends }
}

// ------------------------------------------------------------- contact lookup

test('interop: the fixture ref (encrypted by waverider-app contactRef.ts) is decrypted and mailed, idempotently and escaped', async () => {
  const r = await notify({ body: `It broke\n\n${fixture.ref_line}` })
  assert.deepEqual(r.logs, ['sent'])
  assert.deepEqual(r.failures, [])
  assert.equal(r.sends.length, 1)
  const [{ url, init, payload }] = r.sends
  assert.equal(url, 'https://api.resend.com/emails')
  assert.equal(payload.to, ADDRESS)
  assert.equal(init.headers['Idempotency-Key'], 'feedback-comment-555')
  assert.equal(init.redirect, 'manual')
  assert.ok(init.signal instanceof AbortSignal)
  assert.ok(payload.html.includes('Fixed &lt;script&gt;x&lt;/script&gt;'))
  assert.ok(payload.html.includes('Chart &lt;b&gt;blank&lt;/b&gt;'))
  assert.ok(payload.html.includes(`href="https://github.com/${fixture.repo}/issues/${fixture.number}#issuecomment-555"`))
})

test('the ref is bound to repo and issue: the same ciphertext on another issue is skipped, never a fallback', async () => {
  const body = `| **User** | other@example.com |\n${fixture.ref_line}`
  const r = await notify({ body, number: fixture.number + 1 })
  assert.deepEqual(r.logs, ['skipped: decrypt-failed'])
  assert.equal(r.sends.length, 0)
})

test('any bad ref is skipped and never falls back to a legacy row', async (t) => {
  const legacyRow = '| **User** | legacy@example.com |'
  const env = fixture.ref_line.split(' ')[3]
  const raw = Buffer.from(env, 'base64url')
  const flipped = Buffer.from(raw)
  flipped[20] ^= 1
  const k = fixture.fixture_key_base64
  for (const [name, body, code, over = {}] of [
    ['tampered', `<!-- wr-contact v1 ${flipped.toString('base64url')} -->`, 'decrypt-failed'],
    ['unknown version', `<!-- wr-contact v2 ${env} -->`, 'malformed-ref'],
    ['non-canonical encoding', `<!-- wr-contact v1 ${env}= -->`, 'malformed-ref'],
    ['too short', `<!-- wr-contact v1 ${Buffer.alloc(28).toString('base64url')} -->`, 'malformed-ref'],
    ['oversized', `<!-- wr-contact v1 ${'A'.repeat(1100)} -->`, 'malformed-ref'],
    ['duplicated', `${fixture.ref_line}\n${fixture.ref_line}`, 'ambiguous-ref'],
    ['stray mention', `${fixture.ref_line}\nabout wr-contact`, 'ambiguous-ref'],
    ['no key', fixture.ref_line, 'no-key', { FEEDBACK_CONTACT_KEY: '' }],
    ['invalid key', fixture.ref_line, 'no-key', { FEEDBACK_CONTACT_KEY: 'short' }],
    ['wrong key', fixture.ref_line, 'decrypt-failed', { FEEDBACK_CONTACT_KEY: randomBytes(32).toString('base64') }],
    ['extra field', seal(k, fixture.repo, fixture.number, JSON.stringify({ ...fixture.contact, x: 1 })), 'bad-payload'],
    ['not an address', seal(k, fixture.repo, fixture.number, JSON.stringify({ email: 'nope', tier: 'pro' })), 'bad-payload'],
    ['not json', seal(k, fixture.repo, fixture.number, 'nope'), 'bad-payload'],
  ]) {
    await t.test(name, async () => {
      const r = await notify({ body: `${legacyRow}\n${body}`, env: over })
      assert.deepEqual(r.logs, [`skipped: ${code}`])
      assert.equal(r.sends.length, 0)
    })
  }
  // Control: a well-formed ref sealed by this test's helper is accepted, so the cases above fail for their stated reason.
  const ok = await notify({ body: seal(k, fixture.repo, fixture.number, JSON.stringify({ email: 'x@example.com', tier: 'free' })) })
  assert.deepEqual(ok.logs, ['sent'])
})

test('legacy fallback: only with no wr-contact text, one exact User row, and the route account as author', async (t) => {
  const row = '| **User** | legacy@example.com |'
  const sent = await notify({ body: `text\n| Field | Value |\n${row}\n| **Tier** | pro |` })
  assert.deepEqual(sent.logs, ['sent'])
  assert.equal(sent.sends[0].payload.to, 'legacy@example.com')
  for (const [name, body, author] of [
    ['other author', row, { login: 'mallory', type: 'User' }],
    ['route login but Bot type', row, { login: 'waveriderai', type: 'Bot' }],
    ['two User rows', `${row}\n| **User** | b@example.com |`, ROUTE_USER],
    ['User mentioned twice', `${row}\nsee **User** above`, ROUTE_USER],
    ['Anonymous', '| **User** | Anonymous |', ROUTE_USER],
    ['not exact row', `x ${row}`, ROUTE_USER],
    ['no row', 'nothing here', ROUTE_USER],
    ['empty body', null, ROUTE_USER],
  ]) {
    await t.test(name, async () => {
      const r = await notify({ body, author })
      assert.deepEqual(r.logs, ['skipped: no-contact'])
      assert.equal(r.sends.length, 0)
    })
  }
})

test('reads the latest issue body, not the event snapshot from before the ref PATCH', async () => {
  const r = await notify({ body: fixture.ref_line, eventBody: '| **User** | stale@example.com |' })
  assert.equal(r.sends[0].payload.to, ADDRESS)
})

test('failures report a fixed code only', async (t) => {
  for (const [name, opts, failure] of [
    ['issue read fails', { issueRead: 'fail' }, 'notify failed: issue-read'],
    ['resend 422', { resend: 422 }, 'notify failed: resend-status-422'],
    ['resend network', { resend: 'network' }, 'notify failed: resend-request'],
  ]) {
    await t.test(name, async () => {
      const r = await notify({ body: fixture.ref_line, ...opts })
      assert.deepEqual(r.failures, [failure])
    })
  }
  const r = await notify({ body: fixture.ref_line, env: { RESEND_API_KEY: '' } })
  assert.deepEqual(r.logs, ['skipped: no-resend-key'])
  assert.equal(r.sends.length, 0)
})

test('a non-GitHub-HTTPS comment URL is replaced by the issue URL', async () => {
  for (const commentUrl of ['javascript:alert(1)', 'http://github.com/x', 'https://evil.test/', 'https://github.com/x" onclick="y']) {
    const r = await notify({ body: fixture.ref_line, commentUrl })
    assert.ok(r.sends[0].payload.html.includes(`href="https://github.com/${fixture.repo}/issues/${fixture.number}"`), commentUrl)
  }
})

// ------------------------------------------------------------------ if: gates

const commentEvent = ({ association = 'OWNER', body = 'Thanks!', pr = false, name = 'issue_comment' } = {}) => ({
  github: {
    event_name: name,
    event: { issue: { number: 1, ...(pr ? { pull_request: { url: 'x' } } : {}) }, comment: name === 'issue_comment' ? { author_association: association, body } : undefined },
  },
})

test('notify-user if: (OWNER || MEMBER || COLLABORATOR) && not a PR && not an agent-88 comment', () => {
  const cond = workflowValue('notify-user.yml', 'if')
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(evaluate(cond, commentEvent({ association: a })), true, a)
  for (const a of ['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR']) assert.equal(evaluate(cond, commentEvent({ association: a })), false, a)
  // The marker exclusion must apply to every association, not only the last OR branch.
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(evaluate(cond, commentEvent({ association: a, body: '<!-- agent-88:gh-issue-triage v1 key=waveriderai/feedback#1 state=final -->\nThanks' })), false, a)
  }
  assert.equal(evaluate(cond, commentEvent({ body: 'quoting <!-- agent-88: is fine' })), true)
  assert.equal(evaluate(cond, commentEvent({ pr: true })), false)
  const yml = readFileSync(new URL('../.github/workflows/notify-user.yml', import.meta.url), 'utf8')
  assert.match(yml, /^on:\n {2}issue_comment:\n {4}types: \[created\]$/m)
  assert.match(yml, /^permissions:\n {2}issues: read\n\n/m)
})

test('notify.yml if: skips agent-88 comments on created AND edited, keeps everything else', () => {
  const cond = workflowValue('notify.yml', 'if')
  const marker = '<!-- agent-88:gh-issue-triage v1 key=waveriderai/feedback#1 state=pending -->\nThanks'
  // created and edited carry the same event_name; the comment body decides.
  assert.equal(evaluate(cond, commentEvent({ body: marker })), false)
  assert.equal(evaluate(cond, commentEvent({ body: marker.replace('pending', 'final') })), false)
  assert.equal(evaluate(cond, commentEvent({ body: 'human reply' })), true)
  assert.equal(evaluate(cond, commentEvent({ name: 'issues' })), true)
  const yml = readFileSync(new URL('../.github/workflows/notify.yml', import.meta.url), 'utf8')
  assert.match(yml, /issue_comment:\n {4}types: \[created, edited\]/)
})
