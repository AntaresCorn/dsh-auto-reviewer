import type { Context } from '@deepseek-ai/cordis';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import '@deepseek-ai/dsh-permission-presets';
import z from '@deepseek-ai/schemastery';
export declare const name = "@dsh-external/dsh-auto-reviewer";
export declare const inject: string[];
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** Auto-review decision notices injected into the transcript. */
        'dsh-auto-reviewer': {
            kind: 'dsh-auto-reviewer';
        } & ContextFormed;
    }
}
export interface Config {
    /** The permission preset name this plugin implements. */
    presetName: string;
    /** Provider used by the reviewer LLM; empty = use the session's current route. */
    llmProvider: string;
    /** Model used by the reviewer LLM; empty = use the session's current route. */
    llmModel: string;
    /** How many recent user messages are included in the review context. */
    maxContextMessages: number;
    /** Automatically approve workspace-write escalations that are not risky. */
    autoApproveWorkspaceWrite: boolean;
    /** Automatically approve danger-full-access escalations that are not risky. */
    autoApproveDangerFullAccess: boolean;
    /** Allow an escalation when the user has explicitly asked for it (unless critical). */
    autoApproveUserConfirmed: boolean;
    /** Ask the user when the LLM is unavailable or returns "ask". */
    askOnAmbiguous: boolean;
    /** Reject critical destructive operations without a user confirmation. */
    rejectCritical: boolean;
    /** Use the LLM reviewer for ambiguous requests. */
    useLlm: boolean;
    /** Timeout for the reviewer LLM call in milliseconds. */
    timeoutMs: number;
    /** Regex strings; matching requests are rejected or forwarded according to blocklistMode. */
    blocklist: string[];
    /** 'reject' or 'ask' when a blocklist pattern matches. */
    blocklistMode: 'reject' | 'ask';
    /** Extra reviewer instructions appended to the LLM system prompt. */
    extraInstructions: string;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    presetName: z<string, string, "defined">;
    llmProvider: z<string, string, "defined">;
    llmModel: z<string, string, "defined">;
    maxContextMessages: z<number, number, "defined">;
    autoApproveWorkspaceWrite: z<boolean, boolean, "defined">;
    autoApproveDangerFullAccess: z<boolean, boolean, "defined">;
    autoApproveUserConfirmed: z<boolean, boolean, "defined">;
    askOnAmbiguous: z<boolean, boolean, "defined">;
    rejectCritical: z<boolean, boolean, "defined">;
    useLlm: z<boolean, boolean, "defined">;
    timeoutMs: z<number, number, "defined">;
    blocklist: z<string[], string[], "defined">;
    blocklistMode: z<"reject" | "ask", "reject" | "ask", "defined">;
    extraInstructions: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    presetName: z<string, string, "defined">;
    llmProvider: z<string, string, "defined">;
    llmModel: z<string, string, "defined">;
    maxContextMessages: z<number, number, "defined">;
    autoApproveWorkspaceWrite: z<boolean, boolean, "defined">;
    autoApproveDangerFullAccess: z<boolean, boolean, "defined">;
    autoApproveUserConfirmed: z<boolean, boolean, "defined">;
    askOnAmbiguous: z<boolean, boolean, "defined">;
    rejectCritical: z<boolean, boolean, "defined">;
    useLlm: z<boolean, boolean, "defined">;
    timeoutMs: z<number, number, "defined">;
    blocklist: z<string[], string[], "defined">;
    blocklistMode: z<"reject" | "ask", "reject" | "ask", "defined">;
    extraInstructions: z<string, string, "defined">;
}>>, "plain">;
export interface LlmDecision {
    action: 'allow' | 'ask' | 'reject';
    /** Reviewer's short rationale, flattened and bounded for notices. */
    reason?: string;
}
export declare function parseLlmDecision(text: string): LlmDecision | null;
/** One automatic approval decision, rendered as a notice. */
export interface ApprovalNotice {
    outcome: 'approved' | 'denied';
    risk: 'low' | 'medium' | 'high' | 'critical';
    authorization: 'user-confirmed' | 'unknown';
    toolName: string;
    mode?: string;
    /** Why the reviewer decided this way (rule name, fast path, or LLM rationale). */
    basis: string;
    /** The requester's own justification, when present. */
    request?: string;
    /** Single-line rendering of the tool arguments; empty when unavailable. */
    command: string;
}
/** Multi-line, human-readable account of one automatic approval decision. */
export declare function formatApprovalNotice(notice: ApprovalNotice): string;
/** One-line collapsed-row summary for the same decision. */
export declare function approvalNoticeSummary(notice: ApprovalNotice): string;
/** Pure text transform backing the on-load patch. Returns the input unchanged
 * when the `auto-review` glyph is already present; throws when the current DSH
 * bundle layout is unrecognized so callers can surface the skip reason. */
export declare function patchPermissionIconSource(source: string): string;
export declare function apply(ctx: Context, config: Config): void;
