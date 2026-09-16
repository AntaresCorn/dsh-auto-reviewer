import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  approvalNoticeSummary,
  formatApprovalNotice,
  parseLlmDecision,
} from '../lib/index.js'

// Keep the on-load icon patch hermetic: point PATH at a fake `npm` whose
// `root -g` resolves to a throwaway directory, so the patch skips quietly
// instead of touching an installed DSH bundle.
const fakeBin = mkdtempSync(join(tmpdir(), 'dsh-ar-test-bin-'))
writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh\necho "${join(fakeBin, 'no-global-root')}"\n`)
chmodSync(join(fakeBin, 'npm'), 0o755)
const originalPath = process.env.PATH
process.env.PATH = `${fakeBin}:${originalPath ?? ''}`

after(() => {
  process.env.PATH = originalPath
  rmSync(fakeBin, { recursive: true, force: true })
})

const baseConfig = {
  presetName: 'auto-review',
  llmProvider: '',
  llmModel: '',
  maxContextMessages: 12,
  autoApproveWorkspaceWrite: true,
  autoApproveDangerFullAccess: true,
  autoApproveUserConfirmed: true,
  askOnAmbiguous: true,
  rejectCritical: true,
  useLlm: false,
  timeoutMs: 10000,
  blocklist: [],
  blocklistMode: 'reject',
  extraInstructions: '',
}

function harness(overrides = {}) {
  const config = { ...baseConfig, ...overrides }
  let handler
  const ctx = {
    logger: { warn() {} },
    on(event, fn) {
      if (event === 'approval/request') handler = fn
    },
    permissionPresets: { current: () => config.presetName },
    llm: { stream() { throw new Error('llm disabled in tests') } },
  }
  apply(ctx, config)
  assert.ok(handler, 'approval/request handler must be registered')
  return { config, handler }
}

function fakeRequest({ args = {}, toolName = 'bash', reason = '', callId = 'call-1', recentUserText = '' } = {}) {
  const messages = []
  if (recentUserText) {
    messages.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: recentUserText }] })
  }
  messages.push({
    role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: toolName, arguments: JSON.stringify(args) }],
  })
  const injected = []
  return {
    toolName,
    callId,
    reason,
    injected,
    agent: {
      session: {
        deriveMessages: () => messages,
        requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
      },
      inject: (message) => injected.push(message),
    },
  }
}

const askForUser = async () => 'ask'
const bodyOf = (message) => message.content.map((block) => block.text ?? '').join('\n')

test('formatApprovalNotice renders multi-line detail', () => {
  const text = formatApprovalNotice({
    outcome: 'denied',
    risk: 'critical',
    authorization: 'unknown',
    toolName: 'bash',
    mode: 'danger-full-access',
    basis: 'critical rule: recursive-delete-root; no explicit user confirmation',
    request: 'clean the tmp dir',
    command: 'rm -rf /tmp/x',
  })
  const lines = text.split('\n')
  assert.equal(lines[0], 'Automatic approval review denied (risk: critical, authorization: unknown)')
  assert.ok(lines.includes('tool: bash'))
  assert.ok(lines.includes('mode: danger-full-access'))
  assert.ok(lines.includes('basis: critical rule: recursive-delete-root; no explicit user confirmation'))
  assert.ok(lines.includes('request: clean the tmp dir'))
  assert.ok(lines.includes('command: rm -rf /tmp/x'))
})

test('approvalNoticeSummary stays on one line', () => {
  const summary = approvalNoticeSummary({
    outcome: 'approved',
    risk: 'low',
    authorization: 'user-confirmed',
    toolName: 'bash',
    mode: 'workspace-write',
    basis: 'auto-approve: workspace-write escalation without a high-risk rule',
    command: 'npm test',
  })
  assert.ok(!summary.includes('\n'))
  assert.match(summary, /approved\(low\)/)
  assert.match(summary, /bash/)
  assert.match(summary, /workspace-write/)
  assert.match(summary, /npm test/)
})

test('parseLlmDecision keeps a bounded single-line reason', () => {
  const decision = parseLlmDecision('```json\n{"action":"reject","reason":"writes outside workspace\\nrm data"}\n```')
  assert.deepEqual(decision, { action: 'reject', reason: 'writes outside workspace rm data' })
  assert.equal(parseLlmDecision('not json'), null)
})

test('workspace-write fast path injects a structured notice', async () => {
  const { handler } = harness()
  const req = fakeRequest({
    args: { command: 'npm test' },
    reason: 'escalate sandbox to workspace-write: run tests',
    recentUserText: 'please run the tests',
  })
  const outcome = await handler(req, askForUser)
  assert.equal(outcome, 'allowed-once')
  assert.equal(req.injected.length, 1)
  const message = req.injected[0]
  assert.equal(message.source.kind, 'plugin')
  assert.equal(message.source.form, 'notice')
  assert.equal(typeof message.source.summary, 'string')
  assert.ok(message.source.summary.length > 0 && message.source.summary.length <= 120)
  const body = bodyOf(message)
  assert.ok(body.includes('approved (risk: low, authorization: user-confirmed)'))
  assert.ok(body.includes('tool: bash'))
  assert.ok(body.includes('mode: workspace-write'))
  assert.ok(body.includes('basis: auto-approve: workspace-write escalation without a high-risk rule'))
  assert.ok(body.includes('command: npm test'))
})

test('critical rule denial names the matched rule', async () => {
  const { handler } = harness()
  const req = fakeRequest({
    args: { command: 'rm -rf /' },
    reason: 'escalate sandbox to danger-full-access: free disk space',
  })
  const outcome = await handler(req, askForUser)
  assert.equal(outcome, 'rejected')
  const body = bodyOf(req.injected[0])
  assert.ok(body.includes('denied (risk: critical, authorization: unknown)'))
  assert.ok(body.includes('basis: critical rule: recursive-delete-root; no explicit user confirmation'))
  assert.ok(body.includes('command: rm -rf /'))
})

test('blocklist rejection reports the configured rule', async () => {
  const { handler } = harness({ blocklist: ['secret-token'] })
  const req = fakeRequest({
    args: { command: 'cat secret-token' },
    reason: 'escalate sandbox to workspace-write: inspect file',
  })
  const outcome = await handler(req, askForUser)
  assert.equal(outcome, 'rejected')
  assert.ok(bodyOf(req.injected[0]).includes('basis: blocklist rule #1: secret-token'))
})

test('ambiguous fallback still asks the user without a notice', async () => {
  const { handler } = harness({ useLlm: false, askOnAmbiguous: true })
  const req = fakeRequest({
    args: { command: 'sudo ls' },
    reason: 'escalate sandbox to workspace-write: list files',
  })
  const outcome = await handler(req, askForUser)
  assert.equal(outcome, 'ask')
  assert.equal(req.injected.length, 0)
})
