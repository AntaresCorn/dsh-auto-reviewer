import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const bundleSource = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

const SOURCE_KIND = 'dsh-auto-reviewer'
const NODE_KIND = 'auto-review-notice'

/** Load the shipped client bundle with stubbed platform seed modules. */
function loadBundle() {
  const registrations = []
  const seed = {
    react: {
      memo: (component) => component,
      useCallback: (callback) => callback,
      useState: (value) => [value, () => {}],
    },
    'react/jsx-runtime': {
      Fragment: Symbol('Fragment'),
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    '@deepseek-ai/dsh-client-ui-primitives': {
      DisclosureRow: 'DisclosureRow',
      IconCheckCircleOutlineRegular: 'IconCheckCircleOutlineRegular',
      IconContextInjectionOutlineRegular: 'IconContextInjectionOutlineRegular',
      IconWarningOutlineRegular: 'IconWarningOutlineRegular',
    },
  }
  const windowStub = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      },
    },
  }
  // eslint-disable-next-line no-new-func -- the bundle is a browser script, not a module
  new Function('window', bundleSource)(windowStub)
  assert.equal(registrations.length, 1, 'the bundle registers exactly one module')
  const registration = registrations[0]
  const exportsField = registration.factory((specifier) => {
    if (!(specifier in seed)) throw new Error(`unexpected require(${specifier})`)
    return seed[specifier]
  })
  return { registration, exportsField }
}

/** Client plugin context stub recording every registration. */
function recordingContext(options = {}) {
  const recorded = { locale: [], definitions: [], slots: [] }
  const ctx = {
    locale: {
      register(namespace, dictionaries) {
        recorded.locale.push({ namespace, dictionaries })
        return () => {}
      },
    },
    slots: {
      register(spec, view) {
        recorded.slots.push({ spec, view })
        return () => {}
      },
    },
    uiConversation: {
      events: {
        register(definition) {
          recorded.definitions.push(definition)
          return () => {}
        },
      },
    },
    effect(callback) {
      callback()
    },
  }
  if (options.groups !== false) ctx.uiConversation.groups = {}
  if (options.groups === false) delete ctx.uiConversation.groups
  return { ctx, recorded }
}

/** One host-written notice message event, as the assembler receives it. */
function noticeEvent(overrides = {}) {
  const notice = {
    outcome: 'approved',
    risk: 'low',
    toolName: 'bash',
    summary: 'approved(low) · bash · workspace-write · npm test',
    text: 'Automatic approval review approved (risk: low, authorization: unknown)\ntool: bash\nmode: workspace-write\nbasis: auto-approve: workspace-write escalation without a high-risk rule\ncommand: npm test',
  }
  return {
    type: 'user/message',
    seq: 42,
    time: 1700000000000,
    surfaceOp: 'append',
    data: {
      id: 'notice-message-1',
      role: 'user',
      content: [{ type: 'text', text: notice.text }],
      source: { kind: SOURCE_KIND, form: 'notice', summary: notice.summary },
    },
    ...overrides,
  }
}

/** Mirror of the dsh 0.2 Chat visibility contract, for the mechanism assertion. */
function visibleInModernChat(node) {
  const data = node.data ?? {}
  const content = Array.isArray(data.content) ? data.content : []
  const toolChange = content.some((block) => block.type === 'tool-addition' || block.type === 'tool-removal')
  if (node.visibility !== 'visible') return false
  if (node.kind === 'system-prompt') return false
  if (node.kind === 'context' && !toolChange) return false
  if (node.kind === 'command' && data.name === 'permission') return false
  return true
}

test('client bundle exposes a cordis plugin face', () => {
  const { registration, exportsField } = loadBundle()
  assert.equal(registration.id, '@dsh-external/dsh-auto-reviewer')
  assert.equal(typeof exportsField.apply, 'function')
  assert.deepEqual(exportsField.inject, ['slots', 'locale', 'uiConversation'])
})

test('apply registers locale, notice definition, and one chat row', () => {
  const { exportsField } = loadBundle()
  const { ctx, recorded } = recordingContext()
  exportsField.apply(ctx)
  assert.equal(recorded.definitions.length, 1)
  assert.equal(recorded.definitions[0].kind, NODE_KIND)
  assert.equal(recorded.definitions[0].target, 'chat')
  assert.equal(recorded.slots.length, 1)
  assert.equal(recorded.slots[0].spec.name, 'conversation.chat.node')
  assert.equal(recorded.slots[0].spec.key, NODE_KIND)
  assert.equal(recorded.slots[0].spec.locale, 'dsh-auto-reviewer')
  assert.equal(recorded.locale.length, 1)
  assert.equal(recorded.locale[0].namespace, 'dsh-auto-reviewer')
  assert.equal(recorded.locale[0].dictionaries.zh['row.approved'], '自动审批通过')
  assert.equal(recorded.locale[0].dictionaries.en['row.denied'], 'Auto-review denied')
})

test('apply stays inert on a Chat generation that renders injected context itself', () => {
  const { exportsField } = loadBundle()
  const { ctx, recorded } = recordingContext({ groups: false })
  exportsField.apply(ctx)
  assert.deepEqual(recorded, { locale: [], definitions: [], slots: [] })
})

test('the notice definition claims only the plugin source kind', () => {
  const { exportsField } = loadBundle()
  const { ctx, recorded } = recordingContext()
  exportsField.apply(ctx)
  const definition = recorded.definitions[0]

  assert.deepEqual(definition.match(noticeEvent()), { id: 'notice-message-1', role: 'start' })

  const userMessage = noticeEvent()
  userMessage.data.source = { kind: 'user', rpcId: 'req-1' }
  assert.equal(definition.match(userMessage), null)

  const replaced = noticeEvent({ surfaceOp: 'replace' })
  assert.equal(definition.match(replaced), null)

  assert.equal(definition.match({ type: 'assistant/message', seq: 1, surfaceOp: 'append', data: {} }), null)
  assert.equal(definition.match({ type: 'tool/result', seq: 2, surfaceOp: 'append', data: {} }), null)
})

test('the view node carries the decision under a kind the modern Chat keeps', () => {
  const { exportsField } = loadBundle()
  const { ctx, recorded } = recordingContext()
  exportsField.apply(ctx)
  const definition = recorded.definitions[0]

  const event = noticeEvent()
  const startMatch = { event, role: 'start', location: { kind: 'turn', turn: 3 } }
  const state = definition.start({ key: 'auto-review-notice:notice-message-1' }, startMatch, { previous: () => undefined })
  assert.equal(state.seq, 42)
  assert.equal(state.outcome, 'approved')
  assert.equal(state.risk, 'low')
  assert.equal(state.summary, 'approved(low) · bash · workspace-write · npm test')

  const node = definition.buildViewNode({
    key: 'auto-review-notice:notice-message-1',
    kind: NODE_KIND,
    id: 'notice-message-1',
    matches: [startMatch],
    start: startMatch,
    state,
    current: new Map(),
  })
  assert.equal(node.kind, NODE_KIND)
  assert.notEqual(node.kind, 'context')
  assert.equal(node.target, 'chat')
  assert.equal(node.visibility, 'visible')
  assert.equal(node.anchorSeq, 42)
  assert.deepEqual(node.location, { kind: 'turn', turn: 3 })
  assert.equal(node.data.seq, undefined)
  assert.equal(node.data.outcome, 'approved')
  assert.match(node.data.text, /Automatic approval review approved/)
  assert.equal(visibleInModernChat(node), true, 'the modern Chat visibility contract keeps this node')

  assert.equal(definition.buildViewNode({ state: undefined, start: undefined }), null)
})

test('a denied notice renders the denied row with an expandable body', () => {
  const { exportsField } = loadBundle()
  const { ctx, recorded } = recordingContext()
  exportsField.apply(ctx)
  const definition = recorded.definitions[0]
  const view = recorded.slots[0].view

  const deniedText = 'Automatic approval review denied (risk: critical, authorization: unknown)\ntool: bash\nmode: danger-full-access\nbasis: critical rule: raw-disk-write; no explicit user confirmation\ncommand: dd if=/dev/zero of=/dev/null bs=1 count=1'
  const node = {
    kind: NODE_KIND,
    data: {
      text: deniedText,
      summary: 'denied(critical) · bash · danger-full-access · dd if=/dev/zero of=/dev/null bs=1 count=1',
      outcome: 'denied',
      risk: 'critical',
    },
  }
  const rendered = view({ node, t: (key) => key })
  assert.equal(rendered.type, 'DisclosureRow')
  assert.equal(rendered.props.title, 'row.denied')
  assert.equal(rendered.props.icon.type, 'IconWarningOutlineRegular')
  assert.equal(rendered.props.expandable, true)
  assert.equal(rendered.props.expandOnRowClick, true)
  assert.equal(rendered.props.children.props.children, deniedText)
  const summaryChildren = rendered.props.collapsedContent.props.children
  assert.equal(summaryChildren[1].props.children, node.data.summary)
  assert.deepEqual(definition.match(noticeEvent()), { id: 'notice-message-1', role: 'start' })
})

test('an unparsable notice still renders under the neutral title', () => {
  const { exportsField } = loadBundle()
  const { ctx, recorded } = recordingContext()
  exportsField.apply(ctx)
  const definition = recorded.definitions[0]
  const unreadable = noticeEvent()
  unreadable.data.source = { kind: SOURCE_KIND }
  unreadable.data.content = [{ type: 'text', text: 'notice without the expected header' }]
  const startMatch = { event: unreadable, role: 'start', location: { kind: 'unresolved' } }
  const state = definition.start({}, startMatch, { previous: () => undefined })
  assert.equal(state.outcome, 'unknown')
  const node = definition.buildViewNode({ key: 'k', kind: NODE_KIND, id: 'x', matches: [startMatch], start: startMatch, state, current: new Map() })
  assert.deepEqual(node.location, { kind: 'unresolved' })
  const rendered = recorded.slots[0].view({ node, t: (key) => key })
  assert.equal(rendered.props.title, 'row.unknown')
  assert.equal(rendered.props.icon.type, 'IconContextInjectionOutlineRegular')
})
