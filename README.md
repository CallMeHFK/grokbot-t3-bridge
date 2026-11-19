# grokbot-t3-bridge

English | [中文](README.zh-CN.md)

Use an agent from your Grok Bot desktop account as an ACP provider in T3.
This is a bridge to the private Cursor/GrokBot Connect-JSON API — no official compatibility promise; smoke tests consume the agent's weekly quota.

## Install (T3 local-source contract)

T3's `acpRegistry` driver with `source:"local"` spawns `commandPath` directly (`shell:false`, no install step; on Windows .cmd/.bat are rejected — a real executable is required).

Register under `providerInstances` in `~/.t3/userdata/settings.json` (adjust `commandPath` to your install path):

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
  "environment": ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "GROKBOT_AGENT=<your-bot-name>"]
}
```

Prerequisites:
- Linux + Node ≥ 22 (uses global WebSocket / fetch).
- Grok Bot desktop app **logged in once** (credentials are decrypted from the GNOME keyring + refreshed via OAuth, cached in `state.json`, mode 0600).
- Keyring decryption needs `python3` with the `secretstorage` and `cryptography` packages; without `GROKBOT_AGENT` the first agent of the account is used.

## Does the desktop app need to stay open? — No (live-verified)

The bot is a cloud agent: the bridge talks directly to `api2.cursor.sh` (SendGrokBotUserMessage → cloud orchestration → ListGrokBotTranscriptEntries polling); no hop goes through the desktop process. Verified live: with every desktop process killed, the smoke test still received a reply (`OK`, end_turn). The desktop app and the T3 bridge are peer clients and can be online simultaneously, sharing the same cloud transcript.

The desktop app is only needed for:
- **First login / re-login**: tokens are initially decrypted from the desktop keyring; day-to-day the refresh token auto-renews, but once it is invalidated you must open the desktop app and log in again.
- **Local tool execution**: local tools that touch files/commands on your machine run inside the desktop app; with it closed such operations hang or fail. Pure chat, weather, cloud search, send_task and other cloud capabilities are unaffected.

Not verified: whether the refresh token stays valid after the desktop app has been offline for days.

## Who executes the work? — executor layering

Read-only probe evidence: `ListGrokBotAgents` returns `harness:"temporal"` (cloud Temporal workflow orchestration); the agent's tool surface is only `send_task` / `search_conversations` / `end_the_call`, and `send_task`'s official description explicitly says jobs that need "their computer, files, web, browser, or mail" are handed off. Three layers follow:

| Task type | Executor | Desktop app must be online? |
| --- | --- | --- |
| Pure chat / reasoning | Cloud model | No (live-verified) |
| Cloud capabilities (weather, web search, conversation search) | Cloud services | No |
| Local/account resources (send_task jobs, local tools touching shell/files/browser) | GrokBot background agent runtime; local tools run inside the desktop process | **Yes** — with it closed they hang or fail |

- The T3 bridge is never an executor: it is only a message channel, runs no tools on your machine on the bot's behalf, and opens no local execution channel for the cloud (a security boundary).
- Not verified: whether pure web/search subtasks inside send_task have a cloud runner fallback while the desktop app is offline.
- Practical rule: as a "cloud Q&A + search assistant" the desktop app can stay closed; to touch local files/commands/browser, open it first (minimized is fine).

## Protocol notes (verified against T3 0.1.10)

- initialize: T3 sends `protocolVersion:2`; a response without an `info` field falls back to v1. The bridge answers v1 + `agentInfo` (a legal optional field in the v1 schema).
- Session restore: T3 **always takes the resume path** for existing threads. The bridge advertises `agentCapabilities.sessionCapabilities.resume:{}` and implements `session/resume`; `session/load` returns -32601. Without the resume capability T3 fails with "Failed to open provider session" before ever sending session/new.
- Session binding: `acp-session-bindings.json` persists sessionId→agentId across process restarts; legacy threads without a binding fall back to `GROKBOT_AGENT`.
- Model picker: a configOption is only recognized by T3's `findModelConfigOption` when `category:"model" && type:"select"` (the Bot dropdown lists your agents).
- Cancel: `session/cancel` is a notification; T3 waits ≤15s then kills the process. SIGTERM/SIGINT close the voice WS and exit 0.
- Interactive cards: `elicitation/create` / `session/request_permission` are only sent when the client advertises elicitation/permission capabilities; otherwise the bridge falls back to text prompts.

## Feature flags

- `GROKBOT_VOICE=1`: enable the experimental voice call (text in, voice out; T3 has no realtime audio input yet, off by default). Commands `/voice`, `/hangup`.
- `GROKBOT_WIDGET_CARD=1`: answer widget questions via a native approval card (default is the text answer flow).
- `GROKBOT_DEBUG=1`: polling debug logs.

## Operations

- Logs: `bridge.log` (T3 discards provider stderr, so this is the only evidence source).
- After editing the script, kill the bridge process so T3 respawns it: `pkill -f 'grokbot-acp[.]mjs'`; the first send after process death fails — wait ~12s and retry.
- Smoke: `node test/smoke.mjs 'Reply with exactly two characters: OK'`; native card: `node test/native-ui-test.mjs widget allow-once`.
- Test scripts default to agent name `leo`; override via env: `GROKBOT_AGENT=<your-bot-name> node test/smoke.mjs`.

## Disclaimer

This project reverse-engineers the private Connect-JSON API of the Grok Bot desktop app (`aiserver.v1.GrokBotService`) for personal interoperability only; the API may change at any time, with no compatibility promise. It contains no credentials; all runtime credentials come from the desktop app already logged in on your machine.

## Changelog

- 0.2.1: session/resume + persistent session bindings + category:model (fixes "Failed to open session" on existing T3 threads).
- 0.2.0: alignment with the T3 plugin contract; voice moved behind GROKBOT_VOICE (off by default); elicitation capability gating.

## License

[MIT](LICENSE)
