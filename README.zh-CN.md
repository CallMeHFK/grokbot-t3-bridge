# grokbot-t3-bridge

[English](README.md) | 中文

**在 [T3](https://t3.codes) 里直接和你的 Grok Bot agent 对话——不用开桌面端。**

单文件、零依赖的 [ACP](https://agentclientprotocol.com) provider，把 T3 桥接到 Grok Bot 云端（`api2.cursor.sh` 上的 `aiserver.v1.GrokBotService`）。bot 的回复像其他模型一样流式进入 T3 线程，交互请求渲染为 T3 原生卡片，每轮对话只消耗 **Grok Bot 周额度——绝不动你的 Cursor 计划**。

> ⚠️ 基于逆向 Grok Bot 桌面端私有 Connect-JSON API 实现，仅供个人互操作；接口随时可能变化，无兼容承诺。不携带任何凭据——复用你本机已有的登录态。

## 特性

- **无桌面端聊天**——桌面端可以关着（已实弹验证：杀掉全部桌面进程后回复照常到达）。桌面端与桥是平级客户端，共享同一份云端 transcript。
- **Bot 选择器**——账号下全部 agent 出现在 T3 模型下拉框，按线程切换。
- **会话恢复**——进程重启后已有 T3 线程可续聊（`session/resume` + 会话→agent 绑定持久化）。
- **原生交互卡片**——bot 的权限询问、auto-review 审批、表单、widget 映射为 T3 的 `session/request_permission` / `elicitation/create`；客户端无相应能力时自动回落文字流。
- **计费隔离**——对话只消耗 Grok Bot 周额度（`sand_included`）；桥绝不开启按量付费，绝不触碰 Cursor 计费。
- **语音通话（实验特性，默认休眠）**——文字进、语音出的实时通话，支持任务转交（`send_task`）与结果语音回播。默认关闭（`GROKBOT_VOICE=1` 启用），等 T3 支持实时音频后启用。
- **安全边界**——桥只是消息通道，绝不在你本机替 bot 执行任何工具。

## 快速开始

环境要求：

| | |
| --- | --- |
| 系统 | Linux（GNOME keyring 凭据路径） |
| 运行时 | Node ≥ 22（全局 `fetch` / `WebSocket`） |
| 登录 | Grok Bot 桌面端**登录过一次**即可 |
| keyring 依赖 | `python3` + `secretstorage` + `cryptography` |

```sh
git clone https://github.com/CallMeHFK/grokbot-t3-bridge.git ~/.grokbot-bridge
cd ~/.grokbot-bridge
node test/smoke.mjs '只回复两个字符：OK'   # 预期输出：TEXT: OK
```

冒烟测试会从 keyring 解密凭据、刷新 OAuth token 并缓存到 `state.json`（0600，已 git-ignore）。然后在 `~/.t3/userdata/settings.json` 的 `providerInstances` 中注册：

```json
"acpRegistry_grokbot": {
  "driver": "acpRegistry",
  "config": {
    "source": "local",
    "agentId": "grokbot",
    "commandPath": "/home/<you>/.grokbot-bridge/grokbot-acp",
    "commandArgs": [],
    "customModels": []
  },
  "environment": ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "GROKBOT_AGENT=<你的bot名>"]
}
```

T3 `acpRegistry` driver 的 `source:"local"` 直接 spawn `commandPath`（`shell:false`，无需安装步骤；Windows 下 `.cmd`/`.bat` 会被拒绝，需真实可执行文件）。重启 T3，provider 选 **GrokBot**，模型下拉选你的 bot，即可对话。

不设置 `GROKBOT_AGENT` 时使用账号下第一个 agent。

## 工作原理

```
T3 线程 ── ACP（stdio JSON-RPC）── grokbot-acp ── Connect-JSON/HTTPS ── api2.cursor.sh
                                       │                                  │
                                 bridge.log                       云端 Temporal 工作流
                                                                          │
                                                             Grok Bot agent（云端模型）
```

每轮：`SendGrokBotUserMessage` → 轮询 `ListGrokBotTranscriptEntries` → 流式 `agent_message_chunk`。交互条目（询问/审批/表单/widget）在你答完 T3 卡片后，经 `ResolveGrokBotLocalToolPermission`、`ResolveGrokBotAutoReviewApproval`、`SubmitGrokBotUserForm`、`RespondGrokBotWidget` 回传云端。

### 需要执行的时候，谁来执行？

bot 跑在云端（`harness:"temporal"`）；桥永远不是执行体。取证：`ListGrokBotAgents` + `send_task` 官方工具描述（"需要你的电脑、文件、浏览器、邮箱的任务一律转交"）。

| 任务类型 | 执行体 | 桌面端需要在线？ |
| --- | --- | --- |
| 纯对话 / 推理 | 云端模型 | 否（已实弹验证） |
| 云端能力（天气、web 搜索、查对话记录） | 云端服务 | 否 |
| 本机工具（shell/文件/浏览器）、send_task 重活 | GrokBot 运行时；触碰本机的 local tool 以桌面端进程为执行体 | **是**——关着会挂起或失败 |

桌面端还用于**首次登录 / 重新登录**（日常 refresh token 自动续期；失效后开桌面端重登一次）。未验证：桌面端离线数天后 refresh token 是否仍有效；send_task 内纯 web 子任务在桌面端关闭时是否有云端兜底。

## 计费口径

只读探针实证——两个独立池：

- **Grok Bot 周额度池**（`sand_included`）：桥消耗的就是它。`DashboardService/GetSandUsageStatus` → `grokPlanLabel:"Grok Bot Plan"`、独立周周期；实测几天几十轮冒烟+语音+天气仅 ~3.7%。触顶报 `sand_included_limit` 并带周重置时间。
- **Cursor 计划池**：分毫不动。`on_demand`（Grok Bot 按量付费）需在 cursor.com/dashboard 显式开启——桥绝不替你开。
- 读 `GetCurrentPeriodUsage`（Cursor 池）两个坑：`bonusSpend` 是厂商赠送用量非真实花费（看 `autoPercentUsed`/`apiPercentUsed`）；`displayMessage:"You've hit your usage limit"` 是预置模板文案，不代表当前状态。

## 配置

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `GROKBOT_AGENT` | 第一个 agent | 新会话使用的 bot 名或 agentId |
| `GROKBOT_VOICE` | 关 | `1` 启用实验语音通话（`/voice`、`/hangup`） |
| `GROKBOT_WIDGET_CARD` | 关 | `1` 时 widget 问题走原生卡片（默认文字代答流） |
| `GROKBOT_DEBUG` | 关 | 轮询调试日志 |
| `GROKBOT_VOICE_IDLE_MS` | 15000 | 语音通话空闲超时（高级） |
| `GROKBOT_VOICE_FEED_WIRE` | `async-update` | 语音结果回播线协议（高级） |

## 测试

全部测试拉起真实桥、打真实 API，消耗周额度。默认 agent 名 `leo`，用 `GROKBOT_AGENT` 覆盖。

| 脚本 | 验证内容 |
| --- | --- |
| `test/smoke.mjs '<提示词>'` | 一轮对话端到端 |
| `test/answer-test.mjs` | bot 提问的文字代答流 |
| `test/native-ui-test.mjs <mode> <decision>` | 原生卡片闭环（`widget` 已实弹验证；`form`/`local-tool`/`auto-review` 已实现但未实弹触发——bot 拒绝凭空制造这些场景） |
| `test/render-test.mjs` | transcript 渲染 |
| `test/voice-smoke.mjs` | 语音通话各阶段（需 `GROKBOT_VOICE=1`） |

## 排障

- **日志**：`bridge.log`——T3 丢弃 provider stderr，此为唯一证据源。
- **改了脚本？** 杀桥进程让 T3 重新拉起：`pkill -f 'grokbot-acp[.]mjs'`；进程死后首次发送会失败，等 ~12s 重试。
- **`fetch failed` / `ECONNRESET`**：到 `api2.cursor.sh` 的连通性可能抖动，退避重试即可。Node 的 `fetch` 不认 `HTTPS_PROXY`——需要代理时须在系统层路由。
- **老线程报 "Failed to open provider session"**：0.2.1 已用 `session/resume` 修复；确认 T3 拉起的是新脚本。

## 协议要点（对齐 T3 0.1.10 实测）

- `initialize`：T3 发 `protocolVersion:2`；响应无 `info` 字段即回落 v1。桥返回 v1 + `agentInfo`。
- 会话恢复：T3 对已有线程必走 resume 路径；桥声明 `sessionCapabilities.resume:{}` 并实现 `session/resume`（`session/load` → -32601）。绑定持久化在 `acp-session-bindings.json`。
- 模型选择：configOption 须 `category:"model" && type:"select"` 才被识别。
- 取消：`session/cancel` 为通知；T3 等 ≤15s 后杀进程。SIGTERM/SIGINT 关闭语音 WS 后 exit 0。
- 卡片仅在客户端声明 elicitation/permission 能力时发送，否则文字回落。

## 版本

- **0.2.1**——`session/resume` + 会话绑定持久化 + `category:"model"`（修复老线程 "Failed to open session"）。
- **0.2.0**——按 T3 插件规范整改；语音改为 `GROKBOT_VOICE` 开关（默认关）；交互卡片能力门控。

## 许可

[MIT](LICENSE)
