/*
 * dsh-auto-reviewer — client half (bundle).
 *
 * The host half injects one `user/message` per automatic approval decision with
 * source kind `dsh-auto-reviewer` and the `notice` context form. dsh 0.2 hides
 * plain injected-context rows from the Chat transcript: its visibility contract
 * keeps a `context` node only while that node carries a tool addition/removal, so
 * the notice stopped being visible. This bundle owns a Conversation node kind for
 * the same messages plus a Chat row for it — the contract keeps every kind other
 * than `context` and `system-prompt`, so the row shows where the injected context
 * row used to.
 *
 * dsh 0.1.x has no such visibility rule and already renders the injected context
 * row through its own definition, so `apply` returns early there (that generation
 * exposes no `uiConversation.groups`) instead of duplicating the row.
 *
 * Bundle contract: registered through `window.__ModuleLoader__.load` as a factory
 * over the synchronous `require` table. Only platform seed words are required —
 * `react`, `react/jsx-runtime`, and `@deepseek-ai/dsh-client-ui-primitives` — so
 * no `dsh.client.external` entry is needed; `dsh.client.inject` orders the rows
 * whose client plugins own the services used here.
 */
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-auto-reviewer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const { Fragment, jsx, jsxs } = jsxRuntime;
    const { memo, useCallback, useState } = react;

    /** Locale namespace owned by this bundle. */
    const NS = "dsh-auto-reviewer";
    /** Durable message source kind the host half writes. */
    const SOURCE_KIND = "dsh-auto-reviewer";
    /**
     * Conversation node kind owned by this bundle. It must never be `context`:
     * that is the kind the 0.2 Chat filters out of the visible transcript.
     */
    const NODE_KIND = "auto-review-notice";
    /** Event types that can carry a durable surface message. */
    const SURFACE_EVENT_TYPES = new Set([
      "system/message",
      "developer/message",
      "user/message",
      "assistant/message",
      "tool/result",
    ]);

    const zh = {
      "row.approved": "自动审批通过",
      "row.denied": "自动审批拒绝",
      "row.unknown": "自动审批",
    };
    const en = {
      "row.approved": "Auto-review approved",
      "row.denied": "Auto-review denied",
      "row.unknown": "Auto-review",
    };

    /** Whether one event is an appended surface message. */
    function isAppendSurfaceEvent(event) {
      return event !== null && typeof event === "object" && SURFACE_EVENT_TYPES.has(event.type) && event.surfaceOp === "append";
    }

    /** Model-facing text of one durable message, joined in block order. */
    function noticeText(content) {
      if (!Array.isArray(content)) return "";
      return content
        .filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
    }

    /**
     * Read the decision the host encoded in the notice. The summary is the
     * machine-readable line (`approved(low) · bash · …`); the body opens with
     * `Automatic approval review <outcome> (risk: <risk>, …)`.
     */
    function decisionOf(summary, text) {
      const fromSummary = /^(approved|denied)\(([^)]+)\)/.exec(summary);
      if (fromSummary !== null) return { outcome: fromSummary[1], risk: fromSummary[2] };
      const fromText = /Automatic approval review (approved|denied) \(risk: ([^,)]+)/.exec(text);
      if (fromText !== null) return { outcome: fromText[1], risk: fromText[2] };
      return { outcome: "unknown", risk: "unknown" };
    }

    /**
     * One node per injected notice, under this bundle's own kind and the `chat`
     * target. The location comes from the start match, so the row lands in the
     * same turn as the approval it reports.
     */
    const noticeDefinition = {
      kind: NODE_KIND,
      target: "chat",
      match: (event) => {
        if (!isAppendSurfaceEvent(event) || event.type !== "user/message") return null;
        const data = event.data;
        if (data === null || typeof data !== "object") return null;
        const source = data.source;
        if (source === null || typeof source !== "object" || source.kind !== SOURCE_KIND) return null;
        return typeof data.id === "string" ? { id: data.id, role: "start" } : null;
      },
      start: (_context, match) => {
        const event = match.event;
        const source = event.data.source;
        const text = noticeText(event.data.content);
        const summary = typeof source.summary === "string" ? source.summary : "";
        return {
          seq: event.seq,
          time: event.time,
          text,
          summary,
          ...decisionOf(summary, text),
        };
      },
      update: (context) => context.state,
      buildViewNode: (context) => {
        if (context.state === undefined) return null;
        const { seq, ...data } = context.state;
        return {
          key: context.key,
          kind: NODE_KIND,
          id: context.id,
          target: "chat",
          anchorSeq: seq,
          location: context.start === undefined ? { kind: "unresolved" } : context.start.location,
          visibility: "visible",
          data,
        };
      },
    };

    const separatorStyle = {
      width: 2,
      height: 2,
      borderRadius: 1,
      flex: "none",
      margin: "0 8px",
      background: "var(--dsw-alias-label-caption)",
    };
    const summaryStyle = {
      minWidth: 0,
      flex: "auto",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: "var(--dsw-alias-label-tertiary)",
      fontSize: "var(--dsh-content-font-size-secondary, 13px)",
      lineHeight: "calc(24px + var(--dsh-content-font-delta, 0px))",
    };
    const bodyStyle = {
      boxSizing: "border-box",
      width: "calc(100% - 22px - var(--dsh-content-font-delta, 0px))",
      maxHeight: 141,
      margin: "4px 0 0 calc(22px + var(--dsh-content-font-delta, 0px))",
      borderRadius: "var(--dsw-radius-md)",
      background: "var(--dsw-alias-markdown-code-block)",
      color: "var(--dsw-alias-label-tertiary)",
      font: "400 11px/16px var(--ds-font-family-code)",
      padding: "10px 16px 12px 12px",
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      overflow: "auto",
    };

    /** One collapsed transcript row: decision plus summary; full notice when open. */
    const NoticeRow = memo(function NoticeRow({ node, t }) {
      const data = node !== null && typeof node === "object" && node.data !== null && typeof node.data === "object" ? node.data : {};
      const [open, setOpen] = useState(false);
      const toggle = useCallback(() => {
        setOpen((value) => !value);
      }, []);
      const text = typeof data.text === "string" ? data.text : "";
      const summary = typeof data.summary === "string" && data.summary !== "" ? data.summary : text.split("\n")[0] ?? "";
      const denied = data.outcome === "denied";
      const icon = denied
        ? jsx(primitives.IconWarningOutlineRegular, { size: 14 })
        : data.outcome === "unknown"
          ? jsx(primitives.IconContextInjectionOutlineRegular, { size: 14 })
          : jsx(primitives.IconCheckCircleOutlineRegular, { size: 14 });
      return jsx(primitives.DisclosureRow, {
        icon,
        title: t(denied ? "row.denied" : data.outcome === "unknown" ? "row.unknown" : "row.approved"),
        open,
        expandable: text !== "",
        expandOnRowClick: true,
        keepContentWhenOpen: true,
        onToggle: toggle,
        collapsedContent: summary === "" ? undefined : jsxs(Fragment, {
          children: [
            jsx("span", { style: separatorStyle, "aria-hidden": true }),
            jsx("span", { style: summaryStyle, "data-auto-review-summary": true, children: summary }),
          ],
        }),
        children: jsx("div", { style: bodyStyle, "data-auto-review-body": true, children: text }),
      });
    });

    /**
     * Register the locale, the notice node kind, and its Chat row.
     *
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      /*
       * `uiConversation.groups` is the cheapest durable marker of the Chat
       * generation that filters injected-context rows. Earlier generations render
       * the notice through their own context row, so registering here would show
       * it twice.
       */
      if (ctx.uiConversation === undefined || ctx.uiConversation.groups === undefined) return;
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-auto-reviewer: notice locale");
      ctx.effect(() => ctx.uiConversation.events.register(noticeDefinition), "dsh-auto-reviewer: notice definition");
      ctx.effect(() => ctx.slots.register({
        name: "conversation.chat.node",
        key: NODE_KIND,
        locale: NS,
      }, NoticeRow), "dsh-auto-reviewer: notice row");
    }

    /** Services this bundle needs before it registers anything. */
    const inject = ["slots", "locale", "uiConversation"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
