# grokbot-t3-bridge

把 Grok Bot 桌面端账号里的 agent 作为 ACP provider 接入 T3。
私有 Cursor/GrokBot Connect-JSON API 桥，无官方兼容承诺；冒烟消耗该 agent 的每周配额。

## 安装（T3 local-source 规范）

T3 `acpRegistry` driver 的 `source:"local"` 直接 spawn `commandPath`（`shell:false`，无需安装步骤；Windows 下 .cmd/.bat 会被拒绝，需真实可执行文件）。

在 `~/.t3/userdata/settings.json` 的 `providerInstances` 中注册（`commandPath` 改成你的安装路径）：

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

前提：
- Linux + Node ≥ 22（用到全局 WebSocket / fetch）。
- Grok Bot 桌面端**登录过一次**即可（凭据经 GNOME keyring 解密 + OAuth 刷新，缓存在 `state.json`，0600）。
- keyring 解密依赖 `python3` 及 `secretstorage`、`cryptography` 包；`GROKBOT_AGENT` 不设置则用账号下第一个 agent。

## 需要开着桌面端吗？——不需要（已实弹验证）

bot 是云端 agent：桥直连 `api2.cursor.sh`（SendGrokBotUserMessage → 云端编排 → ListGrokBotTranscriptEntries 轮询），整条链路不经过桌面端进程。实测把桌面端全部进程退出后，冒烟仍正常收到回复（`OK`，end_turn）。桌面端与 T3 桥是平级客户端，可同时在线共享同一份云端 transcript。

桌面端仅在以下场景需要打开：
- **首次登录 / 重新登录**：token 首次从桌面端 keyring 解密；日常靠 refresh token 自动续期，但 refresh token 失效后需开桌面端重新登录一次。
- **本地工具执行**：bot 操作你本机文件/命令的 local tool 以桌面端为执行体；桌面端关闭时这类操作会挂起或失败。纯问答、天气、云端搜索、send_task 等云端能力不受影响。

未验证：桌面端长期离线（数天）后 refresh token 是否持续有效。

## 协议要点（对齐 T3 0.1.10 实测）

- initialize：T3 发 `protocolVersion:2`；响应无 `info` 字段即回落 v1。桥返回 v1 + `agentInfo`（v1 schema 合法可选字段）。
- 会话恢复：T3 对已有线程**必走 resume 路径**。桥声明 `agentCapabilities.sessionCapabilities.resume:{}` 并实现 `session/resume`；`session/load` 返回 -32601。缺 resume 能力时 T3 在发 session/new 之前就报 "Failed to open provider session"。
- 会话绑定：`acp-session-bindings.json` 持久化 sessionId→agentId，跨进程重启恢复；旧线程无绑定则回落 `GROKBOT_AGENT`。
- 模型选择：configOption 必须 `category:"model" && type:"select"` 才被 T3 的 `findModelConfigOption` 识别（Bot 下拉即 agent 列表）。
- 取消：`session/cancel` 为通知；T3 等 ≤15s 后杀进程。SIGTERM/SIGINT 关闭语音 WS 后 exit 0。
- 交互卡片：仅当客户端声明 elicitation/permission 能力时发 `elicitation/create` / `session/request_permission`；否则回落文字提示。

## 特性开关

- `GROKBOT_VOICE=1`：启用实验语音通话（文字进、语音出；T3 尚不支持实时音频输入，默认关闭）。命令 `/voice`、`/hangup`。
- `GROKBOT_WIDGET_CARD=1`：widget 问题走原生审批卡片（默认文字代答流）。
- `GROKBOT_DEBUG=1`：轮询调试日志。

## 运维

- 日志：`bridge.log`（T3 丢弃 provider stderr，此为唯一证据源）。
- 改脚本后需杀桥进程让 T3 重新拉起：`pkill -f 'grokbot-acp[.]mjs'`；进程死后首次发送会失败，等 ~12s 重试。
- 冒烟：`node test/smoke.mjs '只回复两个字符：OK'`；原生卡片：`node test/native-ui-test.mjs widget allow-once`。
- 测试脚本默认 agent 名为 `leo`，可用环境变量覆盖：`GROKBOT_AGENT=<你的bot名> node test/smoke.mjs`。

## 免责

本项目逆向自 Grok Bot 桌面端的私有 Connect-JSON API（`aiserver.v1.GrokBotService`），仅供个人互操作用途；接口随时可能变化，无兼容性承诺。不包含任何凭据；运行时凭据全部来自你本机已登录的桌面端。

## 版本

- 0.2.1：session/resume + 会话绑定持久化 + category:model（修复 T3 老线程 "Failed to open session"）。
- 0.2.0：按 T3 插件规范 review 整改；语音改为 GROKBOT_VOICE 开关（默认关）；elicitation 能力门控。
