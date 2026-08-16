# dsh-auto-reviewer — Codex-style "approve for me" permission mode

[English](README.en.md) | [中文](README.md)

A permission mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) similar to Codex Auto Reviewer / "approve for me":

- Adds an **auto-review** option to the existing **Permissions** list.
- When the model requests a sandbox escalation, the plugin automatically judges whether the operation is dangerous or explicitly confirmed by the user.
- Safe operations are auto-approved (`allowed-once`); risky/ambiguous operations are forwarded to the user for confirmation; clearly malicious or destructive operations are rejected.
- For ambiguous cases, an optional LLM review decides; if the LLM is unavailable or unsure, it safely falls back to asking the user.

> This is a community project and is not affiliated with or endorsed by DeepSeek.

## Features

- **New permission preset**: extends the official `permission-presets` table through `cordis.patch.yml`. The UI permission dropdown gains an `auto-review` option, which writes `workspace-write + ask` and records the `auto-review` preset.
- **Auto-decision notices**: whenever the plugin auto-approves or auto-rejects, it injects a Codex-style notice into the conversation flow (approve: `Automatic approval review approved (risk: low, authorization: unknown): Auto-review returned a low-risk allow decision.`; deny: `Automatic approval review denied (risk: high, authorization: unknown): Auto-review returned a high-risk deny decision.`), so you can see which escalations were decided automatically.
- **Approval waterfall prepend**: uses `ctx.on('approval/request', handler, true)` to place the reviewer before the interactive UI answerer; returning `allowed-once`/`rejected` decides immediately, while calling `next()` falls through to the normal human confirmation prompt.
- **Multi-level safety policy**:
  - Fast approve: `workspace-write` escalation that is not high risk;
  - User-confirmed approve: recent user messages contain explicit signals such as "please run / I confirm / allow", and the operation is not a critical destructive one;
  - Ambiguous → human: the LLM returns `ask`, the LLM is unavailable, or it times out;
  - Direct reject: matches the `blocklist`, or is a critical destructive operation without user confirmation (`rm -rf /`, `mkfs`, `curl | sh`, etc.).
- **Optional LLM review**: by default, uses the current session's provider/model for a short JSON review of ambiguous requests; you can configure a dedicated `llmProvider`/`llmModel`.

## Installation

### Install from GitHub (recommended)

```bash
dsh plugin --profile web add github:AntaresCorn/dsh-auto-reviewer
```

Or clone and install manually (the repo ships a compiled `lib/`; for local-directory installs, install dev dependencies and link the host packages first):

```bash
git clone https://github.com/AntaresCorn/dsh-auto-reviewer.git
cd dsh-auto-reviewer
npm install
npm run link-host
cd ..
dsh plugin --profile web add /path/to/dsh-auto-reviewer
```

Note: `dsh plugin add /path/to/dir` installs through a `link:` to that directory, so you must run `npm install` and `npm run link-host` in the repo before installing.

### Local build

```bash
npm install          # install dev deps such as typescript / @types/node
npm run link-host    # symlink node_modules/@deepseek-ai to the installed dsh host packages (avoids duplicate copies)
npm run build        # src/ → lib/ (the repo already ships the compiled output; regular users don't need to build)
```

After install/injection, **fully restart DeepSeek Harness**, open a new session, and select **auto-review** in the permission picker.

> ⚠️ Lesson learned (tested 2026-08-16): do not hot-load the plugin with `dev_install_package` / `dev_inject_plugin` during a running conversation and continue using it. The hot-load path is inconsistent with the official bundle assembly and can corrupt loader/agent context (`Cannot read properties of undefined (reading 'enabled')`). Install through the official `dsh plugin --profile web add <dir>` and then `systemctl --user restart dsh-web` (or your equivalent restart method). The dev directory's `node_modules` is for local build/typecheck only; don't let it become the runtime dependency source for a profile link.

## Usage

1. Open a new (or existing) session.
2. Select **auto-review** in the permission dialog/settings.
3. Let the model work normally. When it requests `sandbox_permissions` escalation after a sandbox denial, the plugin decides automatically:
   - Safe → auto-approved;
   - Risky → manual confirmation prompt;
   - Clearly malicious / unconfirmed destructive → rejected.

## Configuration

The plugin's default configuration is provided in `cordis.patch.yml`. You can override it through the profile's `cordis.patch.yml`:

| Option | Default | Description |
| --- | --- | --- |
| `presetName` | `auto-review` | The permission preset this plugin responds to |
| `llmProvider` | `''` | Reviewer LLM provider; empty = use the current session |
| `llmModel` | `''` | Reviewer LLM model; empty = use the current session |
| `maxContextMessages` | `12` | Number of recent user messages considered |
| `autoApproveWorkspaceWrite` | `true` | Auto-approve non-high-risk workspace-write escalations |
| `autoApproveDangerFullAccess` | `true` | Auto-approve non-high-risk danger-full-access escalations |
| `autoApproveUserConfirmed` | `true` | Approve when the user explicitly confirmed and it is not critical |
| `askOnAmbiguous` | `true` | Ask the user when ambiguous; `false` rejects instead |
| `rejectCritical` | `true` | Reject critical destructive operations without user confirmation |
| `useLlm` | `true` | Use LLM review for ambiguous requests |
| `timeoutMs` | `10000` | LLM review timeout |
| `blocklist` | `[]` | Custom regex blocklist |
| `blocklistMode` | `reject` | `reject` or `ask` when a blocklist pattern matches |
| `extraInstructions` | `''` | Extra instructions appended to the reviewer LLM |

## Security notes

- Any internal exception **fails closed**: it calls `next()` to ask the user and never auto-approves.
- Auto-approval is one-shot (`allowed-once`); it does not remember "always allow".
- This plugin does not bypass the `never` policy: if the session is switched to `danger-full-access` (`approval: never`), the approval service rejects before reaching this plugin.
- Read the source before installing; the plugin only makes permission decisions and only makes LLM review calls (no other network requests).

## Repository structure

```
dsh-auto-reviewer/
├── cordis.patch.yml          # extends permission presets + mounts the plugin
├── package.json              # plugin package metadata (dsh.bundle.patch)
├── scripts/build.sh          # tsc build script (no DSH checkout required)
├── scripts/link-host-deps.sh # symlinks host @deepseek-ai deps (avoids duplicates)
├── src/index.ts              # auto-review implementation
├── README.md                 # Chinese README
└── README.en.md              # English README
```

## License

BSD-3-Clause
