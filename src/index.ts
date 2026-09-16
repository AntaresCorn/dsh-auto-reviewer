import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import '@deepseek-ai/dsh-permission-presets'
import z from '@deepseek-ai/schemastery'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = '@dsh-external/dsh-auto-reviewer'
export const inject = ['approval', 'permissionPresets', 'llm']

export interface Config {
  /** The permission preset name this plugin implements. */
  presetName: string
  /** Provider used by the reviewer LLM; empty = use the session's current route. */
  llmProvider: string
  /** Model used by the reviewer LLM; empty = use the session's current route. */
  llmModel: string
  /** How many recent user messages are included in the review context. */
  maxContextMessages: number
  /** Automatically approve workspace-write escalations that are not risky. */
  autoApproveWorkspaceWrite: boolean
  /** Automatically approve danger-full-access escalations that are not risky. */
  autoApproveDangerFullAccess: boolean
  /** Allow an escalation when the user has explicitly asked for it (unless critical). */
  autoApproveUserConfirmed: boolean
  /** Ask the user when the LLM is unavailable or returns "ask". */
  askOnAmbiguous: boolean
  /** Reject critical destructive operations without a user confirmation. */
  rejectCritical: boolean
  /** Use the LLM reviewer for ambiguous requests. */
  useLlm: boolean
  /** Timeout for the reviewer LLM call in milliseconds. */
  timeoutMs: number
  /** Regex strings; matching requests are rejected or forwarded according to blocklistMode. */
  blocklist: string[]
  /** 'reject' or 'ask' when a blocklist pattern matches. */
  blocklistMode: 'reject' | 'ask'
  /** Extra reviewer instructions appended to the LLM system prompt. */
  extraInstructions: string
}

export const Config = z.object({
  presetName: z.string().default('auto-review'),
  llmProvider: z.string().default(''),
  llmModel: z.string().default(''),
  maxContextMessages: z.natural().max(50).default(12),
  autoApproveWorkspaceWrite: z.boolean().default(true),
  autoApproveDangerFullAccess: z.boolean().default(true),
  autoApproveUserConfirmed: z.boolean().default(true),
  askOnAmbiguous: z.boolean().default(true),
  rejectCritical: z.boolean().default(true),
  useLlm: z.boolean().default(true),
  timeoutMs: z.natural().min(100).default(10000),
  blocklist: z.array(z.string()).default([]),
  blocklistMode: z.union([z.const('reject'), z.const('ask')]).default('reject'),
  extraInstructions: z.string().default(''),
})

interface ReviewInput {
  toolName: string
  callId?: string
  reason?: string
  requestedMode?: string
  justification?: string
  commandText: string
  /** Single-line, truncated rendering of the tool arguments for notices. */
  commandSummary: string
  recentUserText: string
  hasExplicitUserConfirmation: boolean
}

const CONFIRM_PATTERNS = [
  /please (go ahead|run|do|execute|install|delete|remove|push|publish|apply|proceed)/i,
  /\b(i confirm|user (asked|requested|approved|wants|confirmed|said)|go ahead|approved|allow(ed)?|confirm|do it|please proceed|proceed)\b/i,
  /^\s*(yes|y|ok|okay|sure|fine)\b/i,
]

interface RiskRule {
  name: string
  pattern: RegExp
}

const HIGH_RISK_RULES: RiskRule[] = [
  { name: 'recursive-delete-root', pattern: /\brm\s+-rf?\s+(\/|\/[*?]|~|\.\.[\\/])/i },
  { name: 'mkfs', pattern: /\bmkfs(\.\w+)?\b/ },
  { name: 'raw-disk-write', pattern: /\bdd\b.*\bof=\/dev\//i },
  { name: 'curl-pipe-shell', pattern: /curl\b.*\|\s*(ba)?sh/i },
  { name: 'wget-pipe-shell', pattern: /wget\b.*\|\s*(ba)?sh/i },
  { name: 'sudo', pattern: /\bsudo\b/ },
  { name: 'chmod-777', pattern: /\bchmod\b.*(-R\s+)?777/i },
  { name: 'recursive-chown', pattern: /\bchown\b.*-R/i },
  { name: 'raw-device-redirect', pattern: />\s*\/dev\/(sd|nvme|disk)/i },
  { name: 'fork-bomb', pattern: /:\s*\(\)\s*\{\s*:\|\s*:&\s*\};/i },
  { name: 'powershell-recursive-delete', pattern: /Remove-Item.*-Recurse.*-Force/i },
  { name: 'windows-force-delete', pattern: /del\s+\/f\s+\/s/i },
  { name: 'format-drive', pattern: /format\s+[a-z]:/i },
  { name: 'git-force-push', pattern: /git\s+push.*--force/i },
  { name: 'npm-publish', pattern: /npm\s+publish/i },
  { name: 'gh-release-create', pattern: /gh\s+release\s+create/i },
  { name: 'kubectl-delete', pattern: /kubectl\s+delete/i },
  { name: 'systemctl-stop', pattern: /systemctl\s+(stop|disable|mask)/i },
  { name: 'passwd', pattern: /passwd\b/ },
  { name: 'power-control', pattern: /shutdown|reboot|halt/i },
]

const CRITICAL_RISK_RULES: RiskRule[] = [
  { name: 'recursive-delete-root', pattern: /\brm\s+-rf?\s+(\/|\/[*?]|~|\.\.)/i },
  { name: 'mkfs', pattern: /\bmkfs(\.\w+)?\b/ },
  { name: 'raw-disk-write', pattern: /\bdd\b.*\bof=\/dev\//i },
  { name: 'curl-pipe-shell', pattern: /curl\b.*\|\s*(ba)?sh/i },
  { name: 'wget-pipe-shell', pattern: /wget\b.*\|\s*(ba)?sh/i },
  { name: 'fork-bomb', pattern: /:\s*\(\)\s*\{\s*:\|\s*:&\s*\};/i },
  { name: 'raw-device-redirect', pattern: />\s*\/dev\/(sd|nvme|disk)/i },
  { name: 'powershell-recursive-delete', pattern: /Remove-Item.*-Recurse.*-Force/i },
  { name: 'format-drive', pattern: /format\s+[a-z]:/i },
]

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function firstRuleMatch(text: string, rules: RiskRule[]): RiskRule | null {
  for (const rule of rules) if (rule.pattern.test(text)) return rule
  return null
}

/** Bound for notice detail lines (rule names, LLM reasons, request text). */
const NOTICE_DETAIL_MAX_CHARS = 160
/** Bound for the single-line command rendering inside a notice. */
const NOTICE_COMMAND_MAX_CHARS = 160

/** Flatten untrusted text (tool args, LLM output) to one bounded line. */
function oneLine(text: string, maxChars: number): string {
  const flat = text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > maxChars ? `${flat.slice(0, Math.max(0, maxChars - 1))}…` : flat
}

function summarizeToolArguments(toolName: string, args: Record<string, unknown> | null): string {
  if (!args) return ''
  const bashLike = /bash|shell|pwsh|powershell|exec|run/i.test(toolName)
  const preferred = bashLike
    ? ['command', 'cmd', 'script', 'args']
    : ['path', 'file_path', 'filePath', 'file', 'target', 'command', 'cmd', 'pattern', 'url']
  for (const key of preferred) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value, NOTICE_COMMAND_MAX_CHARS)
  }
  try {
    return oneLine(JSON.stringify(args), NOTICE_COMMAND_MAX_CHARS)
  } catch {
    return ''
  }
}

function textOfMessage(message: { content?: { type: string; text?: string }[] }): string {
  return (message.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n')
}

function findToolCallArguments(session: any, callId?: string, toolName?: string): Record<string, unknown> | null {
  const messages = session.deriveMessages?.() ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    for (const block of message.content ?? []) {
      if (block.type !== 'tool-call') continue
      if (callId !== undefined && block.id !== callId) continue
      if (toolName !== undefined && block.name !== toolName) continue
      try {
        const parsed = JSON.parse(block.arguments)
        return typeof parsed === 'object' && parsed !== null ? parsed : null
      } catch {
        return null
      }
    }
  }
  return null
}

function collectRecentUserText(session: any, max: number): string {
  const messages = session.deriveMessages?.() ?? []
  const lines: string[] = []
  for (let index = messages.length - 1; index >= 0 && lines.length < max; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user' || message.source?.kind !== 'user') continue
    const text = textOfMessage(message).trim()
    if (text) lines.unshift(text)
  }
  return lines.join('\n---\n')
}

function buildReviewInput(req: ApprovalRequest, config: Config): ReviewInput {
  const session = req.agent.session
  const args = findToolCallArguments(session, req.callId, req.toolName)
  const commandText = [
    args ? JSON.stringify(args) : '',
    req.reason ?? '',
  ].filter(Boolean).join('\n')
  const commandSummary = summarizeToolArguments(req.toolName, args)

  const reason = req.reason ?? ''
  const requestedMode = /escalate sandbox to (workspace-write|danger-full-access)/.exec(reason)?.[1]
  const justification = reason.replace(/^escalate sandbox to (workspace-write|danger-full-access):\s*/i, '')

  const recentUserText = collectRecentUserText(session, config.maxContextMessages)
  const hasExplicitUserConfirmation = recentUserText.length > 0 && matchesAny(recentUserText, CONFIRM_PATTERNS)

  return {
    toolName: req.toolName,
    callId: req.callId,
    reason: req.reason,
    requestedMode,
    justification,
    commandText,
    commandSummary,
    recentUserText,
    hasExplicitUserConfirmation,
  }
}

export interface LlmDecision {
  action: 'allow' | 'ask' | 'reject'
  /** Reviewer's short rationale, flattened and bounded for notices. */
  reason?: string
}

export function parseLlmDecision(text: string): LlmDecision | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as { action?: unknown; reason?: unknown }
    const action = String(parsed.action ?? '').toLowerCase()
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim() !== ''
      ? oneLine(parsed.reason, NOTICE_DETAIL_MAX_CHARS)
      : undefined
    if (action === 'allow' || action === 'allowed-once') return { action: 'allow', ...(reason ? { reason } : {}) }
    if (action === 'reject' || action === 'rejected') return { action: 'reject', ...(reason ? { reason } : {}) }
    if (action === 'ask') return { action: 'ask', ...(reason ? { reason } : {}) }
  } catch {
    return null
  }
  return null
}

/** One automatic approval decision, rendered as a notice. */
export interface ApprovalNotice {
  outcome: 'approved' | 'denied'
  risk: 'low' | 'medium' | 'high' | 'critical'
  authorization: 'user-confirmed' | 'unknown'
  toolName: string
  mode?: string
  /** Why the reviewer decided this way (rule name, fast path, or LLM rationale). */
  basis: string
  /** The requester's own justification, when present. */
  request?: string
  /** Single-line rendering of the tool arguments; empty when unavailable. */
  command: string
}

/** Multi-line, human-readable account of one automatic approval decision. */
export function formatApprovalNotice(notice: ApprovalNotice): string {
  const lines = [
    `Automatic approval review ${notice.outcome} (risk: ${notice.risk}, authorization: ${notice.authorization})`,
    `tool: ${notice.toolName}`,
  ]
  if (notice.mode) lines.push(`mode: ${notice.mode}`)
  lines.push(`basis: ${notice.basis}`)
  if (notice.request) lines.push(`request: ${notice.request}`)
  lines.push(`command: ${notice.command || '(unavailable)'}`)
  return lines.join('\n')
}

/** One-line collapsed-row summary for the same decision. */
export function approvalNoticeSummary(notice: ApprovalNotice): string {
  const parts = [`${notice.outcome}(${notice.risk})`, notice.toolName]
  if (notice.mode) parts.push(notice.mode)
  parts.push(notice.command || notice.basis)
  return oneLine(parts.join(' · '), 200)
}

/**
* Best-effort UI notice: inject a plugin-sourced message into the agent's
* next-step inbox so the transcript shows the auto-approval decision. The
* `notice` context form carries a one-line summary for the collapsed row;
* the full body (tool, mode, basis, command) renders when expanded. The
* agent loop appends it at the next safe step boundary, after all tool
* results, so it never breaks the assistant tool-call -> tool-result
* pairing; failures are swallowed.
*/
function injectApprovalNotice(req: ApprovalRequest, notice: ApprovalNotice): void {
  try {
    req.agent.inject(createUserMessage({
      content: [{ type: 'text', text: formatApprovalNotice(notice) }],
      source: {
        kind: 'plugin',
        plugin: name,
        form: 'notice',
        summary: boundContextSummary(approvalNoticeSummary(notice)),
      },
    }))
  } catch {
    // Best-effort UI notice; never affect the approval outcome.
  }
}

async function runLlmReview(
  ctx: Context,
  req: ApprovalRequest,
  input: ReviewInput,
  config: Config,
): Promise<LlmDecision | null> {
  if (!config.useLlm) return null
  const header = req.agent.session.requestHeader?.()
  const provider = config.llmProvider || header?.config?.provider
  const model = config.llmModel || header?.config?.model
  if (!provider || !model) return null

  const system = [
    'You are an automated permission reviewer for a coding agent sandbox (Codex-style "approve for me").',
    'Decide whether to allow one sandbox escalation request.',
    'Answer with JSON only: {"action":"allow"|"ask"|"reject","reason":"short reason"}',
    'Rules:',
    '- allow only clearly safe, low-risk operations that match the user\'s intent; explicit user confirmation makes an operation more likely to be allowed.',
    '- ask when uncertain, potentially destructive, outside the workspace, or when the user should make the final call.',
    '- reject only clearly malicious, destructive, or unauthorized operations, or attempts to exfiltrate secrets.',
    '- Never allow operations that destroy data, modify system files, or exfiltrate secrets without explicit user confirmation.',
    config.extraInstructions ? `Extra instructions: ${config.extraInstructions}` : '',
  ].filter(Boolean).join('\n')

  const userText = [
    `Tool: ${input.toolName}`,
    input.callId ? `Call ID: ${input.callId}` : '',
    input.requestedMode ? `Requested sandbox mode: ${input.requestedMode}` : '',
    input.justification ? `Justification: ${input.justification}` : '',
    input.reason ? `Full reason: ${input.reason}` : '',
    `Command / arguments:\n${input.commandText || '(none)'}`,
    input.recentUserText ? `Recent user messages:\n${input.recentUserText}` : '(no direct user messages in context)',
    `Explicit user confirmation detected: ${input.hasExplicitUserConfirmation}`,
  ].join('\n')

  const userMessage = createUserMessage({
    content: [{ type: 'text', text: userText }],
    source: { kind: 'plugin', plugin: name },
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const assembler = new BlockAssembler()
    const stream = ctx.llm.stream({
      provider,
      model,
      system,
      messages: [userMessage],
      maxTokens: 120,
      signal: controller.signal,
    })
    for await (const chunk of stream) assembler.push(chunk)
    const blocks = assembler.blocks()
    const text = blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => (block as { text: string }).text)
      .join('\n')
    return parseLlmDecision(text)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── auto-review permission icon (applied on plugin load) ──────────────────
// The official DSH permission selector only ships icons for its built-in
// presets. This plugin keeps the glyph set symmetric by idempotently patching
// the installed conversation client bundle on load, so installing the plugin
// is the only step needed (a browser refresh re-fetches the client bundle).
const ICON_PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'
const ICON_ANCHOR = 'd: "M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z",'
// Legacy bundles (dsh < 0.1.2) store permission glyphs in an object literal:
//   { "read-only": ..., "workspace-write": ..., "danger-full-access": ... }
// dsh >= 0.1.2-rc.1 renders them from a `new Map([[...]])` instead. Keep both
// markers so an already patched bundle (either shape) is left untouched.
const ICON_MARK_OBJECT = '"auto-review": (0, react_jsx_runtime.jsxs)("svg", {'
const ICON_MARK_MAP = '["auto-review", (0, react_jsx_runtime.jsxs)("svg", {'

function permissionIconClientPath(): string {
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
  return join(root, '@deepseek-ai/dsh/node_modules', ICON_PACKAGE, 'lib/client.js')
}

/** One `auto-review` glyph entry snippet (no trailing comma). When
 * `mapFormat` is true the entry is emitted as `new Map([...])` element
 * (`["auto-review", (0, react_jsx_runtime.jsxs)(...)])`), otherwise as an
 * object property (`"auto-review": (0, react_jsx_runtime.jsxs)(...)`). */
function permissionIconEntry(mapFormat: boolean): string {
  const open = mapFormat
    ? '["auto-review", (0, react_jsx_runtime.jsxs)("svg", {'
    : '"auto-review": (0, react_jsx_runtime.jsxs)("svg", {'
  const close = mapFormat ? '\t\t\t})]' : '\t\t\t})'
  return [
    `\t\t\t${open}`,
    '\t\t\t\twidth: "16",',
    '\t\t\t\theight: "16",',
    '\t\t\t\tviewBox: "0 0 16 16",',
    '\t\t\t\tfill: "none",',
    '\t\t\t\t"aria-hidden": true,',
    '\t\t\t\tchildren: [',
    '\t\t\t\t\t(0, react_jsx_runtime.jsx)("path", {',
    '\t\t\t\t\t\td: shieldOutline,',
    '\t\t\t\t\t\tstroke: "currentColor",',
    '\t\t\t\t\t\tstrokeWidth: "1.31831",',
    '\t\t\t\t\t\tstrokeLinejoin: "round"',
    '\t\t\t\t\t}),',
    '\t\t\t\t\t(0, react_jsx_runtime.jsx)("path", {',
    '\t\t\t\t\t\td: "M8 4.4L9.3 6.7L11.6 8L9.3 9.3L8 11.6L6.7 9.3L4.4 8L6.7 6.7Z",',
    '\t\t\t\t\t\tfill: "currentColor"',
    '\t\t\t\t\t})',
    '\t\t\t\t]',
    close
  ].join('\n')
}

/** Pure text transform backing the on-load patch. Returns the input unchanged
 * when the `auto-review` glyph is already present; throws when the current DSH
 * bundle layout is unrecognized so callers can surface the skip reason. */
export function patchPermissionIconSource(source: string): string {
  if (source.includes(ICON_MARK_OBJECT) || source.includes(ICON_MARK_MAP)) return source

  const anchorAt = source.indexOf(ICON_ANCHOR)
  if (anchorAt < 0) throw new Error('icon anchor not found (DSH bundle layout changed?)')

  // Pick the container close token that comes first after the anchor: the
  // Map literal ends with `]);`, the legacy object literal with `};`.
  const mapCloseAt = source.indexOf(']);', anchorAt)
  const objectCloseAt = source.indexOf('};', anchorAt)
  const mapFormat = mapCloseAt >= 0 && (objectCloseAt < 0 || mapCloseAt < objectCloseAt)
  const closeAt = mapFormat ? mapCloseAt : objectCloseAt
  if (closeAt < 0) throw new Error('no glyph container close found after anchor')

  if (mapFormat) {
    // The last built-in Map entry has no trailing comma, so a bare newline
    // would parse the inserted entry as a subscript of it (silent runtime
    // breakage, invisible to `node --check`). Terminate that entry with a
    // comma first; `permissionIconEntry(true)` already carries its own
    // indentation, so do not indent it again.
    const prefix = source.slice(0, closeAt).replace(/\s+$/, '')
    return `${prefix},\n${permissionIconEntry(true)}\n\t\t${source.slice(closeAt)}`
  }
  const before = source.slice(0, closeAt)
  const jsxClose = before.lastIndexOf('})')
  if (jsxClose < 0) throw new Error('glyph value end not found')
  const head = before.slice(0, jsxClose + 2) + ',' + '\n\t\t\t' + permissionIconEntry(false) + '\n\t\t'
  return head + source.slice(closeAt)
}

function applyPermissionIconPatch(ctx: Context): void {
  let file = ''
  try {
    file = permissionIconClientPath()
    const source = readFileSync(file, 'utf8')
    const patched = patchPermissionIconSource(source)
    if (patched === source) return
    const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-reviewer-icon-'))
    const check = join(dir, 'client-check.mjs')
    copyFileSync(file, check)
    try {
      writeFileSync(check, patched)
      execFileSync(process.execPath, ['--check', check], { stdio: 'pipe' })
    } finally {
      unlinkSync(check)
    }
    writeFileSync(file, patched)
    ctx.logger?.warn?.('[dsh-auto-reviewer] permission icon patch applied: %s', file)
  } catch (error) {
    ctx.logger?.warn?.('[dsh-auto-reviewer] permission icon patch skipped (%s): %s', file, String(error))
  }
}

export function apply(ctx: Context, config: Config): void {
  applyPermissionIconPatch(ctx)

  // Prepend so this reviewer runs before the interactive UI answerer.
  ctx.on('approval/request', async (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
    try {
      const permission = ctx.permissionPresets
      if (!permission || permission.current(req.agent.session) !== config.presetName) {
        return next()
      }

      const input = buildReviewInput(req, config)
      const noticeBase = {
        authorization: (input.hasExplicitUserConfirmation ? 'user-confirmed' : 'unknown') as ApprovalNotice['authorization'],
        toolName: input.toolName,
        mode: input.requestedMode,
        request: input.justification ? oneLine(input.justification, NOTICE_DETAIL_MAX_CHARS) : undefined,
        command: input.commandSummary,
      }
      const approve = (risk: ApprovalNotice['risk'], basis: string): ApprovalOutcome => {
        injectApprovalNotice(req, { ...noticeBase, outcome: 'approved', risk, basis })
        return 'allowed-once'
      }
      const deny = (risk: ApprovalNotice['risk'], basis: string): ApprovalOutcome => {
        injectApprovalNotice(req, { ...noticeBase, outcome: 'denied', risk, basis })
        return 'rejected'
      }

      // Blocklist: user-configured hard rules.
      let blocklistIndex = -1
      for (let index = 0; index < config.blocklist.length; index += 1) {
        // Invalid patterns still fail safe through the outer catch.
        if (new RegExp(config.blocklist[index], 'i').test(input.commandText)) {
          blocklistIndex = index
          break
        }
      }
      if (blocklistIndex >= 0) {
        if (config.blocklistMode === 'reject') {
          return deny('high', `blocklist rule #${blocklistIndex + 1}: ${oneLine(config.blocklist[blocklistIndex], 80)}`)
        }
        return next()
      }

      const highRiskRule = firstRuleMatch(input.commandText, HIGH_RISK_RULES)
      const criticalRule = firstRuleMatch(input.commandText, CRITICAL_RISK_RULES)

      // Critical destructive operations: reject unless the user explicitly confirmed.
      if (criticalRule && !input.hasExplicitUserConfirmation && config.rejectCritical) {
        return deny('critical', `critical rule: ${criticalRule.name}; no explicit user confirmation`)
      }

      // Fast auto-approve paths.
      if (input.requestedMode === 'workspace-write' && config.autoApproveWorkspaceWrite && !highRiskRule) {
        return approve('low', 'auto-approve: workspace-write escalation without a high-risk rule')
      }
      if (input.requestedMode === 'danger-full-access' && config.autoApproveDangerFullAccess && !highRiskRule) {
        return approve('low', 'auto-approve: danger-full-access escalation without a high-risk rule')
      }
      if (input.hasExplicitUserConfirmation && config.autoApproveUserConfirmed && !criticalRule) {
        return approve(highRiskRule ? 'medium' : 'low', 'auto-approve: explicit user confirmation in recent messages')
      }

      // Ambiguous middle ground: ask the reviewer LLM.
      const decision = await runLlmReview(ctx, req, input, config)
      const llmReason = decision?.reason ? `: ${decision.reason}` : ''
      if (decision?.action === 'allow') {
        return approve(highRiskRule ? 'medium' : 'low', `llm review (allow)${llmReason}`)
      }
      if (decision?.action === 'reject') {
        return deny(criticalRule || highRiskRule ? 'high' : 'medium', `llm review (reject)${llmReason}`)
      }
      if (decision?.action === 'ask') {
        if (config.askOnAmbiguous) return next()
        return deny(highRiskRule ? 'high' : 'medium', `llm review (ask)${llmReason}; askOnAmbiguous=false`)
      }
      if (config.askOnAmbiguous) return next()
      return deny(highRiskRule ? 'high' : 'medium', 'llm reviewer unavailable or inconclusive; askOnAmbiguous=false')
    } catch {
      // Any reviewer failure must fail safe: ask the user.
      return next()
    }
  }, true)
}
