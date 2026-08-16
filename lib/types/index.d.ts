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
import type { Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-permission-presets';
import z from '@deepseek-ai/schemastery';
export declare const name = "@dsh-external/dsh-auto-reviewer";
export declare const inject: string[];
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
export declare const Config: z<Schemastery.ObjectS<{
    presetName: z<string, string>;
    llmProvider: z<string, string>;
    llmModel: z<string, string>;
    maxContextMessages: z<number, number>;
    autoApproveWorkspaceWrite: z<boolean, boolean>;
    autoApproveDangerFullAccess: z<boolean, boolean>;
    autoApproveUserConfirmed: z<boolean, boolean>;
    askOnAmbiguous: z<boolean, boolean>;
    rejectCritical: z<boolean, boolean>;
    useLlm: z<boolean, boolean>;
    timeoutMs: z<number, number>;
    blocklist: z<string[], string[]>;
    blocklistMode: z<"reject" | "ask", "reject" | "ask">;
    extraInstructions: z<string, string>;
}>, Schemastery.ObjectT<{
    presetName: z<string, string>;
    llmProvider: z<string, string>;
    llmModel: z<string, string>;
    maxContextMessages: z<number, number>;
    autoApproveWorkspaceWrite: z<boolean, boolean>;
    autoApproveDangerFullAccess: z<boolean, boolean>;
    autoApproveUserConfirmed: z<boolean, boolean>;
    askOnAmbiguous: z<boolean, boolean>;
    rejectCritical: z<boolean, boolean>;
    useLlm: z<boolean, boolean>;
    timeoutMs: z<number, number>;
    blocklist: z<string[], string[]>;
    blocklistMode: z<"reject" | "ask", "reject" | "ask">;
    extraInstructions: z<string, string>;
}>>;
export declare function apply(ctx: Context, config: Config): void;
