# dsh-auto-reviewer — Codex-style "approve for me" permission mode

为 DeepSeek Harness 提供类似 Codex Auto Reviewer / "approve for me" 的权限模式：

- 在现有 **Permissions** 列表中新增 **auto-review** 选项；
- 模型在沙箱中请求提权时，插件自动判断这次操作是否危险、是否已被用户明确确认；
- 安全操作自动同意（`allowed-once`），危险/模糊操作转交用户确认，明显恶意/破坏性操作直接拒绝；
- 模糊场景可选调用 LLM 进行自动审查，LLM 不可用或拿不准时安全地退回人工确认。

> 这是一个社区项目，与 DeepSeek 官方无关。

## 特性

- **新增权限预设**：通过 `cordis.patch.yml` 扩展官方 `permission-presets` 表，UI 的权限下拉框会多出 `auto-review` 选项，选择后写入 `workspace-write + ask`，并记录为 `auto-review` 预设。
- **审批瀑布前置**：使用 `ctx.on('approval/request', handler, true)` 把自动审查器放在交互式 UI 应答者之前；返回 `allowed-once`/`rejected` 即直接裁决，调用 `next()` 则正常弹出人工确认。
- **多级安全策略**：
  - 快速放行：`workspace-write` 且非高风险；
  - 用户确认放行：最近用户消息中有明确“请执行/我确认/允许”等信号，且非致命破坏操作；
  - 模糊转人工：LLM 返回 `ask`、LLM 不可用或超时；
  - 直接拒绝：命中 `blocklist`，或未获用户确认的致命破坏操作（`rm -rf /`、`mkfs`、`curl | sh` 等）。
- **可选 LLM 审查**：默认使用当前会话的 provider/model 对模糊请求做一次短输出 JSON 审查；可配置独立 `llmProvider`/`llmModel`。

## 安装

### 作为 GitHub 仓库装配（推荐）

```bash
dsh plugin --profile web add github:<你的用户名>/dsh-auto-reviewer
```

或手动 clone 后装配：

```bash
git clone https://github.com/<你的用户名>/dsh-auto-reviewer.git
dsh plugin --profile web add /path/to/dsh-auto-reviewer
```

### 开发 / 热注入

```bash
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh
# 在已运行 dsh-super-injector 的环境中：
# dev_inject_plugin /path/to/dsh-auto-reviewer
```

安装/注入后**完全重启 DeepSeek Harness**，新建会话，在权限选择器中选择 **auto-review**。

## 使用方法

1. 打开一个新会话（或已有会话）。
2. 在权限弹窗/设置中选择 **auto-review**。
3. 正常让模型工作。当模型因为沙箱拒绝而请求 `sandbox_permissions` 提权时，本插件自动裁决：
   - 安全 → 自动放行；
   - 有风险 → 弹出人工确认；
   - 明确恶意/未确认的破坏性操作 → 拒绝。

## 配置

插件默认配置已在 `cordis.patch.yml` 中给出。你可以通过 profile 的 `cordis.patch.yml` 覆盖：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `presetName` | `auto-review` | 本插件响应的权限预设名 |
| `llmProvider` | `''` | 审查 LLM provider，留空使用当前会话 |
| `llmModel` | `''` | 审查 LLM model，留空使用当前会话 |
| `maxContextMessages` | `12` | 参与判断的最近用户消息数 |
| `autoApproveWorkspaceWrite` | `true` | 自动放行非高风险 workspace-write 提权 |
| `autoApproveDangerFullAccess` | `false` | 自动放行非高风险 danger-full-access 提权 |
| `autoApproveUserConfirmed` | `true` | 用户明确确认且非致命破坏时放行 |
| `askOnAmbiguous` | `true` | 模糊时转人工；`false` 则拒绝 |
| `rejectCritical` | `true` | 未确认的致命破坏操作直接拒绝 |
| `useLlm` | `true` | 对模糊请求使用 LLM 审查 |
| `timeoutMs` | `10000` | LLM 审查超时 |
| `blocklist` | `[]` | 自定义正则黑名单 |
| `blocklistMode` | `reject` | 命中黑名单时 `reject` 或 `ask` |
| `extraInstructions` | `''` | 追加给审查 LLM 的指令 |

## 安全说明

- 任何内部异常都会**失败关闭**：调用 `next()` 转人工确认，不会自动放行。
- 自动放行只针对单次操作（`allowed-once`），不会记住“永远允许”。
- 本插件不会绕过 `never` 策略：如果会话被切到 `danger-full-access`（`approval: never`），审批服务会在到达本插件前直接拒绝。
- 请先阅读源码再安装；本插件只做权限决策，不执行任何网络请求以外的 LLM 审查调用。

## 仓库结构

```
dsh-auto-reviewer/
├── cordis.patch.yml      # 扩展权限表 + 装配插件
├── package.json          # 插件包元数据（dsh.bundle.patch）
├── scripts/build.sh      # DSH checkout 构建脚本
├── src/index.ts          # 自动审查实现
└── README.md
```

## License

BSD-3-Clause
