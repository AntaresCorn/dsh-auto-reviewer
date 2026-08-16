/**
 * @dsh-external/dsh-auto-reviewer — Codex-style "approve for me" permission mode.
 *
 * Adds an `auto-review` entry to the DSH permission preset list and mounts an
 * `approval/request` answerer that automatically decides sandbox escalations:
 *
 * - clearly safe operations are approved automatically;
 * - risky / ambiguous operations are forwarded to the human (or rejected when
 *   they are critical and the user has not confirmed them);
 * - optional LLM review is used for the ambiguous middle ground.
 *
 * The listener is prepended to the approval waterfall so it runs before the
 * interactive UI answerer. When it calls `next()`, the normal human approval
 * prompt appears.
 */
import type { Context } from 'cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import '@deepseek-ai/dsh-permission-presets'
import '@deepseek-ai/dsh-sandbox-policy'
import z from 'schemastery'

export const name = '@dsh-external/dsh-auto-reviewer'
export const inject = ['approval', 'permissionPresets', 'llm', 'sandboxPolicy']

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
  autoApproveDangerFullAccess: z.boolean().default(false),
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
  recentUserText: string
  hasExplicitUserConfirmation: boolean
}

const CONFIRM_PATTERNS = [
  /please (go ahead|run|do|execute|install|delete|remove|push|publish|apply|proceed)/i,
  /\b(i confirm|user (asked|requested|approved|wants|confirmed|said)|go ahead|approved|allow(ed)?|confirm|do it|please proceed|proceed)\b/i,
  /^\s*(yes|y|ok|okay|sure|fine)\b/i,
]

const HIGH_RISK_PATTERNS = [
  /\brm\s+-rf?\s+(\/|\/[*?]|~|\.\.[\\/])/i,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b.*\bof=\/dev\//i,
  /curl\b.*\|\s*(ba)?sh/i,
  /wget\b.*\|\s*(ba)?sh/i,
  /\bsudo\b/,
  /\bchmod\b.*(-R\s+)?777/i,
  /\bchown\b.*-R/i,
  />\s*\/dev\/(sd|nvme|disk)/i,
  /:\s*\(\)\s*\{\s*:\|\s*:&\s*\};/i,
  /Remove-Item.*-Recurse.*-Force/i,
  /del\s+\/f\s+\/s/i,
  /format\s+[a-z]:/i,
  /git\s+push.*--force/i,
  /npm\s+publish/i,
  /gh\s+release\s+create/i,
  /kubectl\s+delete/i,
  /systemctl\s+(stop|disable|mask)/i,
  /passwd\b/,
  /shutdown|reboot|halt/i,
]

const CRITICAL_RISK_PATTERNS = [
  /\brm\s+-rf?\s+(\/|\/[*?]|~|\.\.)/i,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b.*\bof=\/dev\//i,
  /curl\b.*\|\s*(ba)?sh/i,
  /wget\b.*\|\s*(ba)?sh/i,
  /:\s*\(\)\s*\{\s*:\|\s*:&\s*\};/i,
  />\s*\/dev\/(sd|nvme|disk)/i,
  /Remove-Item.*-Recurse.*-Force/i,
  /format\s+[a-z]:/i,
]

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
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
    recentUserText,
    hasExplicitUserConfirmation,
  }
}

function parseLlmDecision(text: string): 'allow' | 'ask' | 'reject' | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0])
    const action = String(parsed.action ?? '').toLowerCase()
    if (action === 'allow' || action === 'allowed-once') return 'allow'
    if (action === 'reject' || action === 'rejected') return 'reject'
    if (action === 'ask') return 'ask'
  } catch {
    return null
  }
  return null
}

async function runLlmReview(
  ctx: Context,
  req: ApprovalRequest,
  input: ReviewInput,
  config: Config,
): Promise<'allow' | 'ask' | 'reject' | null> {
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

export function apply(ctx: Context, config: Config): void {
  // Prepend so this reviewer runs before the interactive UI answerer.
  ctx.on('approval/request', async (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
    try {
      const permission = ctx.permissionPresets
      if (!permission || permission.current(req.agent.session.events) !== config.presetName) {
        return next()
      }

      const input = buildReviewInput(req, config)

      // Blocklist: user-configured hard rules.
      if (config.blocklist.length > 0 && matchesAny(input.commandText, config.blocklist.map((source) => new RegExp(source, 'i')))) {
        return config.blocklistMode === 'reject' ? 'rejected' : next()
      }

      const highRisk = matchesAny(input.commandText, HIGH_RISK_PATTERNS)
      const criticalRisk = matchesAny(input.commandText, CRITICAL_RISK_PATTERNS)

      // Critical destructive operations: reject unless the user explicitly confirmed.
      if (criticalRisk && !input.hasExplicitUserConfirmation && config.rejectCritical) {
        return 'rejected'
      }

      // Fast auto-approve paths.
      if (input.requestedMode === 'workspace-write' && config.autoApproveWorkspaceWrite && !highRisk) {
        return 'allowed-once'
      }
      if (input.requestedMode === 'danger-full-access' && config.autoApproveDangerFullAccess && !highRisk) {
        return 'allowed-once'
      }
      if (input.hasExplicitUserConfirmation && config.autoApproveUserConfirmed && !criticalRisk) {
        return 'allowed-once'
      }

      // Ambiguous middle ground: ask the reviewer LLM.
      const decision = await runLlmReview(ctx, req, input, config)
      if (decision === 'allow') return 'allowed-once'
      if (decision === 'reject') return 'rejected'
      if (decision === 'ask') return config.askOnAmbiguous ? next() : 'rejected'
      return config.askOnAmbiguous ? next() : 'rejected'
    } catch {
      // Any reviewer failure must fail safe: ask the user.
      return next()
    }
  }, true)
}
