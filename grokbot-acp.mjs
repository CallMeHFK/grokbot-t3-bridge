#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execFile } from 'node:child_process';

const STATE_DIR = path.join(os.homedir(), '.grokbot-bridge');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const BASE = 'https://api2.cursor.sh';
const CLIENT_ID = 'OzaBXLClY5CAGxNzUhQ2vlknpi07tGuE';
const SECRETS_FILE = path.join(os.homedir(), '.config/Grok Bot/sand-secrets.json');
const POLL_MS = 3000;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const GRACE_MS = 15000;
const GROKBOT_VERSION = '0.2.1';
const VOICE_FEATURE_ENABLED = process.env.GROKBOT_VOICE === '1';

const log = (...args) => {
  const line = `[grokbot-acp ${new Date().toISOString()}] ` + args.join(' ') + '\n';
  process.stderr.write(line);
  try { fs.appendFileSync(path.join(os.homedir(), '.grokbot-bridge', 'bridge.log'), line); } catch {}
};
const WS = globalThis.WebSocket ?? (await import('ws')).default;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), { mode: 0o600 });
}

function decryptViaKeyring() {
  const script = `
import secretstorage, json, os, base64, hashlib, sys
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
conn = secretstorage.dbus_init()
col = secretstorage.get_default_collection(conn)
if col.is_locked():
    sys.exit('keyring locked')
master = None
for it in col.search_items({'application': 'Grok Bot'}):
    try:
        if 'safe storage' in it.get_label().lower():
            master = it.get_secret().decode(); break
    except Exception:
        continue
if master is None:
    sys.exit('no Safe Storage key')
d = json.load(open(os.path.expanduser(${JSON.stringify(SECRETS_FILE)})))
acc = json.loads(d['cursor-accounts'])
key = hashlib.pbkdf2_hmac('sha1', master.encode(), b'saltysalt', 1, 16)
def dec(v):
    raw = base64.b64decode(v + '==')
    assert raw[:3] == b'v11'
    c = Cipher(algorithms.AES(key), modes.CBC(b' ' * 16)).decryptor()
    pt = c.update(raw[3:]) + c.finalize()
    return pt[:-pt[-1]].decode()
fields = acc['accounts'][acc['active']]
print(json.dumps({'account': acc['active'], 'access': dec(fields['cursor-access-token']), 'refresh': dec(fields['cursor-refresh-token']), 'machineId': d['cursor-machine-id']}))
`;
  return new Promise((resolve, reject) => {
    execFile('python3', ['-c', script], {
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? 'unix:path=/run/user/1000/bus' },
      timeout: 30000,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error('keyring decrypt failed: ' + (stderr || err.message)));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

function jwtExp(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp ?? 0;
  } catch { return 0; }
}

class Backend {
  constructor(state) {
    this.state = state;
    this.refreshing = null;
  }
  async ensureCreds() {
    const creds = this.state.creds;
    if (creds?.access && jwtExp(creds.access) * 1000 > Date.now() + 120000) return creds;
    if (creds?.refresh) {
      try {
        const refreshed = await this.refresh(creds.refresh);
        this.state.creds = { ...creds, ...refreshed };
        saveState(this.state);
        return this.state.creds;
      } catch (e) { log('refresh failed:', e.message); }
    }
    const fresh = await decryptViaKeyring();
    this.state.creds = fresh;
    saveState(this.state);
    return fresh;
  }
  async refresh(refreshToken) {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const res = await fetch(`${BASE}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`oauth/token HTTP ${res.status}: ${text.slice(0, 200)}`);
        const data = JSON.parse(text);
        const access = data.access_token ?? data.accessToken;
        if (!access) throw new Error('oauth/token: no access token in response');
        return { access, refresh: data.refresh_token ?? data.refreshToken ?? refreshToken };
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  checksum(machineId) {
    const t = Math.floor(Date.now() / 1e6);
    const bytes = Buffer.alloc(6);
    bytes.writeUIntBE(t, 0, 6);
    let key = 165;
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = ((bytes[i] ^ key) + i) % 256;
      key = bytes[i];
    }
    return bytes.toString('base64url') + machineId;
  }
  async rpc(method, body, { retried = false } = {}) {
    const creds = await this.ensureCreds();
    const res = await fetch(`${BASE}/aiserver.v1.GrokBotService/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        authorization: `Bearer ${creds.access}`,
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Sand/1.1.0 Safari/537.36',
        'x-cursor-client-type': 'sand',
        'x-cursor-client-version': '1.1.0',
        'x-cursor-client-os': 'linux',
        'x-sand-box-namespace': 'prod',
        'x-cursor-checksum': this.checksum(creds.machineId),
        'x-ghost-mode': 'false',
        'x-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 401 && !retried) {
      this.state.creds = { ...this.state.creds, access: '' };
      return this.rpc(method, body, { retried: true });
    }
    if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
}

const state = loadState();
const backend = new Backend(state);
let agentsCache = null;

async function listAgents() {
  if (!agentsCache) {
    const r = await backend.rpc('ListGrokBotAgents', { includeTeamAgents: true });
    agentsCache = (r.agents ?? []).filter(a => a.agentId);
  }
  return agentsCache;
}

function entryBody(entry) {
  if (!entry?.body) return null;
  try { return JSON.parse(Buffer.from(entry.body, 'base64').toString('utf8')); } catch { return null; }
}

function optionLabel(opt) {
  if (typeof opt === 'string') return opt;
  return String(opt?.label ?? opt?.title ?? opt?.value ?? JSON.stringify(opt));
}

const CONDITION_ZH = {
  Clear: '晴', MostlyClear: '基本晴', PartlyCloudy: '多云', MostlyCloudy: '大部多云', Cloudy: '阴',
  Foggy: '雾', Haze: '霾', Smoky: '烟霾', Breezy: '微风', Windy: '大风',
  Drizzle: '毛毛雨', Rain: '雨', HeavyRain: '大雨', SunShowers: '太阳雨',
  IsolatedThunderstorms: '局部雷雨', ScatteredThunderstorms: '分散雷雨', Thunderstorms: '雷雨', StrongStorms: '强风暴',
  Snow: '雪', HeavySnow: '大雪', Flurries: '阵雪', Sleet: '雨夹雪', WintryMix: '雨雪混合',
  FreezingRain: '冻雨', FreezingDrizzle: '冻毛毛雨', Hail: '冰雹', Blizzard: '暴风雪', BlowingSnow: '吹雪',
  Hurricane: '飓风', TropicalStorm: '热带风暴', Tornado: '龙卷风', Dust: '浮尘', Hot: '炎热', Frigid: '严寒',
};
const conditionZh = (code) => CONDITION_ZH[code] ?? code ?? '?';
const fmtC = (v) => (typeof v === 'number' ? `${Math.round(v)}°` : '?');

function renderWeatherCard(card) {
  const w = card.weather;
  if (!w) return null;
  const lines = [`### 🌤 ${w.locationLabel ?? w.locationQuery ?? '天气'}`];
  const cur = w.current;
  if (cur) {
    const bits = [`${conditionZh(cur.conditionCode)} ${fmtC(cur.temperatureC)}C`, `体感 ${fmtC(cur.apparentC)}C`];
    if (typeof cur.humidity === 'number') bits.push(`湿度 ${Math.round(cur.humidity * 100)}%`);
    if (typeof cur.windKph === 'number') bits.push(`风速 ${Math.round(cur.windKph)} km/h`);
    if (typeof cur.uvIndex === 'number') bits.push(`UV ${cur.uvIndex}`);
    lines.push(`**当前**：${bits.join(' · ')}`);
  }
  const hours = (w.hours ?? []).slice(0, 8);
  if (hours.length > 0) {
    const fmtHour = (ms) => {
      try {
        return new Intl.DateTimeFormat('zh-CN', { hour: 'numeric', hour12: false, timeZone: w.timeZone ?? 'Asia/Shanghai' }).format(new Date(ms));
      } catch { return '?'; }
    };
    lines.push('', '| 时段 | ' + hours.map(h => fmtHour(h.startMs)).join(' | ') + ' |');
    lines.push('|---|' + hours.map(() => '---').join('|') + '|');
    lines.push('| 天气 | ' + hours.map(h => conditionZh(h.conditionCode)).join(' | ') + ' |');
    lines.push('| 气温 | ' + hours.map(h => fmtC(h.temperatureC)).join(' | ') + ' |');
  }
  const days = (w.days ?? []).slice(0, 7);
  if (days.length > 0) {
    lines.push('', '| 日期 | 天气 | 最低 | 最高 | 降水 |');
    lines.push('|---|---|---|---|---|');
    for (const d of days) {
      let day = '?';
      try {
        day = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short', timeZone: w.timeZone ?? 'Asia/Shanghai' }).format(new Date(d.startMs));
      } catch {}
      const precip = typeof d.precipChance === 'number' && d.precipChance > 0 ? `${Math.round(d.precipChance * 100)}%` : '—';
      lines.push(`| ${day} | ${conditionZh(d.conditionCode)} | ${fmtC(d.minC)} | ${fmtC(d.maxC)} | ${precip} |`);
    }
  }
  if (w.attributionUrl) lines.push('', `数据来源：${w.attributionUrl}`);
  return lines.join('\n');
}

function renderCard(card) {
  if (!card || typeof card !== 'object') return '';
  if (card.kind === 'weather') {
    const rendered = renderWeatherCard(card);
    if (rendered) return rendered;
  }
  const payload = card[card.kind];
  const summary = card.title ?? card.text ?? card.summary ?? card.prompt
    ?? (payload && typeof payload === 'object' ? (payload.title ?? payload.name ?? payload.subject ?? payload.label) : null);
  let out = `> 📇 [${card.kind ?? 'card'}]${summary ? ' ' + summary : ''}`;
  if (payload && typeof payload === 'object') {
    const brief = JSON.stringify(payload);
    if (!summary && brief.length <= 400) out += `\n> ${brief}`;
  }
  return out;
}

function renderMessage(m) {
  if (!m || typeof m !== 'object') return '';
  switch (m.type) {
    case 'text': {
      let out = String(m.content ?? '');
      const cards = m.cards?.items ?? [];
      for (const { card } of cards) {
        const rendered = renderCard(card);
        if (rendered) out += '\n\n' + rendered;
      }
      return out;
    }
    case 'attachment': {
      const name = m.file_name ?? m.url ?? 'attachment';
      return `📎 [${name}](${m.url ?? ''})`;
    }
    case 'widget': {
      const w = m.widget ?? {};
      const lines = [];
      if (typeof w.prompt === 'string' && w.prompt) lines.push(`❓ ${w.prompt}`);
      if (Array.isArray(w.options) && w.options.length > 0) {
        lines.push(...w.options.map((o, i) => `${i + 1}. ${optionLabel(o)}`));
        lines.push('', process.env.GROKBOT_WIDGET_CARD === '1' ? '（T3 卡片处理中…）' : '（在 T3 里直接回复选项文字即可，桥接会代答此卡片）');
      }
      return lines.join('\n') || '📇 [widget]';
    }
    case 'user-form': {
      const f = m.formRequest ?? {};
      const lines = [`📝 表单：${f.title ?? ''}`];
      for (const field of f.fields ?? []) lines.push(`- ${field.label ?? field.name ?? field.id ?? '?'}`);
      return lines.join('\n');
    }
    case 'visualization':
    case 'factory':
      return `📊 ${m.title ?? m.type}${m.url ? ` — ${m.url}` : ''}`;
    case 'email-draft': {
      const d = m.draft ?? {};
      return `✉️ 邮件草稿\n- To: ${(d.to ?? []).join(', ')}\n- Subject: ${d.subject ?? ''}\n\n${d.body ?? ''}`;
    }
    case 'slack-draft':
    case 'meeting-chat-draft':
    case 'imessage-draft':
      return `💬 消息草稿（${m.type}）\n\n${m.draft?.body ?? ''}`;
    case 'calendar-event':
      return `📅 ${m.event?.subject ?? 'calendar event'}`;
    case 'permission-request':
      return `🔐 权限请求：${m.permission?.title ?? ''}（请在 Grok Bot 桌面端处理）`;
    case 'auto-review-approval':
      return `🛡️ 审批（${m.approval?.status ?? '?'}）：${m.approval?.summary ?? ''}${m.approval?.status === 'pending' ? '（T3 审批卡片处理中…）' : ''}`;
    case 'local-tool-permission':
      return `🔧 本机工具授权：${m.ask?.tool ?? m.ask?.title ?? ''}（状态 ${m.ask?.status ?? 'pending'}）${m.ask?.status === 'pending' ? '（T3 审批卡片处理中…）' : ''}`;
    case 'secret-request':
      return `🔑 凭据请求：${m.secretRequest?.label ?? ''}（请在 Grok Bot 桌面端处理）`;
    case 'cursor-agent':
      return `🤖 Cursor Agent 任务：${m.title ?? ''}（云端任务，请在桌面端查看）`;
    case 'phone-call':
      return `📞 电话任务卡片（请在 Grok Bot 桌面端查看）`;
    default:
      return `📇 [${m.type ?? 'card'}]${m.title ? ' ' + m.title : ''}（暂不支持在 T3 内交互，请在 Grok Bot 桌面端查看）`;
  }
}

const sessions = new Map();
const SESSION_BINDINGS_FILE = path.join(path.dirname(STATE_FILE), 'acp-session-bindings.json');

function loadSessionBindings() {
  try { return JSON.parse(fs.readFileSync(SESSION_BINDINGS_FILE, 'utf8')); } catch { return {}; }
}

function bindSession(sessionId, agentId) {
  const bindings = loadSessionBindings();
  bindings[sessionId] = agentId;
  try { fs.writeFileSync(SESSION_BINDINGS_FILE, JSON.stringify(bindings), { mode: 0o600 }); } catch (e) { log('bind persist failed:', e.message); }
}

function sessionConfigOptions(agents, currentValue) {
  return [{
    id: 'model', name: 'Bot', category: 'model', type: 'select', currentValue,
    options: agents.map(a => ({ value: a.agentId, name: a.name })),
  }];
}

function sessionCommands() {
  return [
    { name: 'voice', description: VOICE_FEATURE_ENABLED ? '接通 GrokBot 实时语音通话（实验特性）' : '语音通话（未启用：设置 GROKBOT_VOICE=1 后可用）' },
    { name: 'hangup', description: '挂断当前语音通话' },
  ];
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

const pendingRpc = new Map();
let nextRpcId = 900000;
function agentRpc(method, params, timeoutMs = 10 * 60 * 1000) {
  const id = nextRpcId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingRpc.delete(id)) reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pendingRpc.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else resolve(msg.result);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

async function requestApprovalCard(sessionId, { title, detail, allowAlways = false, allowLabel = '允许一次', denyLabel = '拒绝' }) {
  const options = [
    { optionId: 'allow-once', name: allowLabel, kind: 'allow_once' },
    ...(allowAlways ? [{ optionId: 'always', name: '始终允许', kind: 'allow_always' }] : []),
    { optionId: 'deny', name: denyLabel, kind: 'reject_once' },
  ];
  const res = await agentRpc('session/request_permission', {
    sessionId,
    toolCall: {
      toolCallId: 'gb-' + crypto.randomUUID(),
      title,
      kind: 'execute',
      status: 'pending',
      rawInput: { command: detail },
    },
    options,
  });
  if (res?.outcome?.outcome !== 'selected') return 'cancel';
  return res.outcome.optionId;
}

function formSchema(formRequest) {
  const properties = {};
  const required = [];
  for (const field of formRequest.fields ?? []) {
    const key = field.id ?? field.name;
    if (!key) continue;
    const label = field.label ?? key;
    if (Array.isArray(field.options) && field.options.length > 0) {
      properties[key] = { type: 'string', title: label, enum: field.options.map(o => String(o.value ?? o.label ?? o)) };
    } else if (field.type === 'boolean' || field.type === 'checkbox') {
      properties[key] = { type: 'boolean', title: label };
    } else {
      properties[key] = { type: 'string', title: label, ...(field.placeholder ? { description: field.placeholder } : {}) };
    }
    if (field.required) required.push(key);
  }
  if (Object.keys(properties).length === 0) properties.answer = { type: 'string', title: '回答' };
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function interactiveFallbackText(body) {
  const m = body.message ?? {};
  if (m.type === 'local-tool-permission') {
    const ask = m.ask ?? {};
    return `\n🔐 **本机工具授权待处理**：${[ask.title, ask.description, ask.target].filter(Boolean).join(' / ')}\n（当前客户端不支持审批卡片，请在 Grok Bot 桌面端处理）`;
  }
  if (m.type === 'auto-review-approval') {
    const a = m.approval ?? {};
    return `\n🔐 **审批待处理**：${(a.summary ?? a.title ?? a.command ?? '').slice(0, 300)}\n（当前客户端不支持审批卡片，请在 Grok Bot 桌面端处理）`;
  }
  if (m.type === 'user-form') {
    const f = m.formRequest ?? {};
    const fields = (f.fields ?? []).map(x => x.label ?? x.id).join('、');
    return `\n📋 **表单待填写**：${f.title ?? f.instruction ?? ''}${fields ? '（字段：' + fields + '）' : ''}\n（当前客户端不支持表单，请在 Grok Bot 桌面端填写）`;
  }
  return null;
}

async function resolveInteractive(session, sessionId, body, entryId) {
  const m = body.message ?? {};
  const agentId = session.agentId;
  if (!session.clientCaps?.elicitation && ['local-tool-permission', 'auto-review-approval', 'user-form'].includes(m.type)) {
    const text = interactiveFallbackText(body);
    if (text) chunk(sessionId, text);
    return null;
  }
  if (m.type === 'local-tool-permission') {
    const ask = m.ask ?? {};
    const detail = [ask.title, ask.description, ask.target].filter(Boolean).join('\n');
    const choice = await requestApprovalCard(sessionId, {
      title: `GrokBot 本机工具授权：${ask.title ?? ask.action ?? ''}`,
      detail: detail || ask.action || 'local tool',
      allowAlways: ask.standingGrant?.kind === 'offered',
    });
    if (choice === 'cancel') return { outcome: 'cancelled' };
    const resolution = { 'allow-once': 'ALLOW_ONCE', always: 'ALWAYS', deny: 'DENY' }[choice] ?? 'DENY';
    const r = await backend.rpc('ResolveGrokBotLocalToolPermission', { agentId, entryId, requestId: ask.requestId, resolution });
    return { outcome: 'resolved', accepted: r?.dispatched !== false, note: `本机工具授权 → ${choice}`, refusal: r?.refusal };
  }
  if (m.type === 'auto-review-approval') {
    const approval = m.approval ?? {};
    const choice = await requestApprovalCard(sessionId, {
      title: `GrokBot 审批：${(approval.summary ?? approval.title ?? '').slice(0, 120)}`,
      detail: approval.command ?? approval.summary ?? JSON.stringify(approval).slice(0, 400),
      allowAlways: true,
    });
    if (choice === 'cancel') return { outcome: 'cancelled' };
    const resolution = { 'allow-once': 'APPROVED', always: 'ALWAYS', deny: 'DENIED' }[choice] ?? 'DENIED';
    const r = await backend.rpc('ResolveGrokBotAutoReviewApproval', {
      agentId, requestId: approval.requestId, resolution, approvalPlatform: 'desktop',
      ...(choice !== 'deny' && approval.command ? { approvedCommand: approval.command } : {}),
    });
    return { outcome: 'resolved', accepted: r?.dispatched !== false, note: `审批 → ${choice}`, refusal: r?.refusal };
  }
  if (m.type === 'user-form') {
    const f = m.formRequest ?? {};
    const res = await agentRpc('elicitation/create', {
      sessionId,
      mode: 'form',
      message: `GrokBot 表单：${f.title ?? f.instruction ?? ''}`,
      requestedSchema: formSchema(f),
    });
    if (res?.action !== 'accept') {
      const r = await backend.rpc('DismissGrokBotUserForm', { agentId, entryId, mode: 'DISMISSED', platform: 'DESKTOP' });
      return { outcome: 'resolved', accepted: r?.accepted !== false, note: '表单已取消', refusal: r?.refusal };
    }
    const values = {};
    for (const [k, v] of Object.entries(res.content ?? {})) values[k] = String(v);
    const r = await backend.rpc('SubmitGrokBotUserForm', { agentId, entryId, values, platform: 'DESKTOP' });
    return { outcome: 'resolved', accepted: r?.accepted !== false, note: `表单已提交：${JSON.stringify(values)}`, refusal: r?.refusal };
  }
  if (m.type === 'widget' && process.env.GROKBOT_WIDGET_CARD === '1' && session.clientCaps?.permission !== false) {
    const w = m.widget ?? {};
    const opts = (w.options ?? []).map((o, i) => ({
      optionId: 'opt-' + i,
      name: String(o.label ?? o.value ?? o).slice(0, 60),
      kind: 'allow_once',
      value: String(o.value ?? o.label ?? o),
    }));
    if (opts.length === 0) return null;
    const res = await agentRpc('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'gb-' + crypto.randomUUID(), title: `GrokBot 提问：${w.prompt ?? ''}`, kind: 'execute', status: 'pending', rawInput: { command: w.prompt ?? 'widget' } },
      options: opts,
    });
    if (res?.outcome?.outcome !== 'selected') return { outcome: 'cancelled' };
    const chosen = opts.find(o => o.optionId === res.outcome.optionId) ?? opts[0];
    const r = await backend.rpc('RespondGrokBotWidget', { agentId, entryId, value: chosen.value });
    return { outcome: 'resolved', accepted: r?.accepted !== false, note: `已代答：${chosen.value}`, refusal: r?.refusal };
  }
  return null;
}

function chunk(sessionId, text) {
  notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
}

function extractUserText(raw) {
  const tagged = [...raw.matchAll(/<user_request>\s*\n?([\s\S]*?)<\/user_request>/g)];
  if (tagged.length) {
    let body = tagged.at(-1)[1].trim();
    const um = body.lastIndexOf('User message:');
    if (um >= 0) body = body.slice(um + 'User message:'.length).trim();
    return body;
  }
  if (raw.includes('[Historical user')) {
    const matches = [...raw.matchAll(/\[Historical user;[^\]]*\]\s*\n([\s\S]*?)(?=\n\s*\[(?:Historical|Attached|Assistant)|$)/g)];
    const last = matches.at(-1)?.[1]?.trim();
    if (last) return last;
  }
  return raw.trim();
}

const VOICE_DIR = path.join(os.homedir(), '.grokbot-bridge', 'voice');
const VOICE_SAMPLE_RATE = 24000;
const VOICE_IDLE_MS = Number(process.env.GROKBOT_VOICE_IDLE_MS ?? 15000);

function wavFile(pcm, filePath) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(VOICE_SAMPLE_RATE, 24);
  header.writeUInt32LE(VOICE_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

class VoiceCall {
  constructor(session, sessionId, harness, agents) {
    this.session = sessionId;
    this.cwd = session.cwd ?? null;
    this.audioDir = this.cwd ? path.join(this.cwd, '.grokbot-voice') : VOICE_DIR;
    this.agentId = session.agentId;
    this.agentName = agents.find(a => a.agentId === session.agentId)?.name ?? 'leo';
    this.voiceId = agents.find(a => a.agentId === session.agentId)?.voiceId || null;
    this.harness = harness;
    this.ws = null;
    this.callId = crypto.randomUUID();
    this.startedAtMs = Date.now();
    this.conversationId = null;
    this.turns = [];
    this.toolCalls = [];
    this.audioChunks = [];
    this.transcriptParts = [];
    this.responseActive = false;
    this.spokeThisResponse = false;
    this.lastActivityAt = Date.now();
    this.closed = false;
    this.closeReason = null;
    this.ready = null;
    this.turnCounter = 0;
    this.feedBaseSeq = null;
    this.forwardedEntryIds = new Set();
    this.awaitingFeed = false;
    this.feedSince = 0;
    this.feedWire = process.env.GROKBOT_VOICE_FEED_WIRE === 'pair' ? 'pair' : 'async-update';
    this.lastFeedPollAt = 0;
    this.feedBusy = false;
    this.nudges = [];
  }

  async open() {
    fs.mkdirSync(this.audioDir, { recursive: true });
    const mint = await backend.rpc('MintSandVoiceCallSecret', {
      agentId: this.agentId, callId: this.callId, startSurface: 'DESKTOP_BUTTON',
    });
    if (!mint.clientSecret || !mint.websocketUrl) throw new Error('mint returned no credential: ' + JSON.stringify(mint).slice(0, 200));
    const url = new URL(mint.websocketUrl);
    url.searchParams.set('model', mint.model);
    this.ready = new Promise((resolve, reject) => { this._resolveReady = resolve; this._rejectReady = reject; });
    this.ws = new WebSocket(url.toString(), [`xai-client-secret.${mint.clientSecret}`]);
    this.ws.onmessage = (ev) => { try { this.onFrame(JSON.parse(ev.data)); } catch (e) { log('voice frame error:', e.message); } };
    this.ws.onerror = () => { this._rejectReady?.(new Error('voice websocket error')); };
    this.ws.onclose = (ev) => {
      this.closed = true;
      this.closeReason = `ws closed ${ev.code} ${String(ev.reason ?? '').slice(0, 120)}`;
      this._rejectReady?.(new Error(this.closeReason));
    };
    const readyTimeout = setTimeout(() => this._rejectReady?.(new Error('voice session setup timeout')), 20000);
    await this.ready;
    clearTimeout(readyTimeout);
  }

  sendFrame(frame) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  createResponse(instructions) {
    this.sendFrame(instructions == null ? { type: 'response.create' } : { type: 'response.create', response: { instructions } });
  }

  onFrame(f) {
    if (f.type !== 'ping') this.lastActivityAt = Date.now();
    switch (f.type) {
      case 'session.created': {
        this.sendFrame({
          type: 'session.update',
          session: {
            ...(this.voiceId ? { voice: this.voiceId } : {}),
            resumption: { enabled: true },
            instructions: this.harness.instructions ?? '',
            turn_detection: { type: 'server_vad' },
            audio: {
              input: { format: { type: 'audio/pcm', rate: VOICE_SAMPLE_RATE }, transcription: { model: 'grok-transcribe', language_hint: 'zh' } },
              output: { format: { type: 'audio/pcm', rate: VOICE_SAMPLE_RATE }, speed: 1 },
            },
            tools: this.harness.tools ?? [],
          },
        });
        break;
      }
      case 'session.updated':
        this._resolveReady?.();
        this._resolveReady = null;
        break;
      case 'conversation.created':
        this.conversationId = f.conversation?.id ?? this.conversationId;
        break;
      case 'input_audio_buffer.speech_started':
        chunk(this.session, '\n🎙️ （听到你说话…）');
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const text = f.transcript ?? '';
        if (text) {
          this.turns.push({ id: `user-${this.turns.length}`, speaker: 'user', text, atMs: Date.now() });
          chunk(this.session, `\n**你：** ${text}\n`);
        }
        break;
      }
      case 'response.created':
        if (f.response?.trigger === 'async_update') this.asyncTriggerSeen = true;
        this.responseActive = true;
        this.spokeThisResponse = false;
        this.audioChunks = [];
        this.transcriptParts = [];
        break;
      case 'response.audio.delta':
      case 'response.output_audio.delta':
        if (f.delta) this.audioChunks.push(Buffer.from(f.delta, 'base64'));
        break;
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
        if (f.delta) this.transcriptParts.push(f.delta);
        break;
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        if (f.transcript) this.transcriptParts = [f.transcript];
        break;
      case 'response.function_call_arguments.done':
        this.onToolCall({ callId: f.call_id, name: f.name, argumentsJson: f.arguments ?? '{}' }).catch(e => log('voice tool error:', e.message));
        break;
      case 'response.done':
        this.finishResponse();
        break;
      case 'error':
        chunk(this.session, `\n[voice] 协议错误：${JSON.stringify(f).slice(0, 300)}`);
        break;
      default:
        break;
    }
  }

  finishResponse() {
    this.responseActive = false;
    if (this.feedPending && !this.closed && (!this.feedQuietUntil || Date.now() >= this.feedQuietUntil)) {
        this.flushFeedPending();
      } else if (this.feedPending && !this.closed && !this.feedFlushTimer) {
        this.feedFlushTimer = setTimeout(() => {
          this.feedFlushTimer = null;
          if (!this.closed && !this.responseActive && this.feedPending) this.flushFeedPending();
        }, Math.max(0, (this.feedQuietUntil ?? 0) - Date.now()) + 100);
      }
      const text = this.transcriptParts.join('').trim();
      if (text) {
        this.spokeThisResponse = true;
        this.turns.push({ id: `assistant-${this.turns.length}`, speaker: 'assistant', text, atMs: Date.now() });
        let line = `\n**${this.agentName}：** ${text}\n`;
        if (this.audioChunks.length) {
          this.turnCounter += 1;
          const file = path.join(this.audioDir, `${this.callId}-${this.turnCounter}.wav`);
          try {
            wavFile(Buffer.concat(this.audioChunks), file);
            line += `\n![${this.agentName} 语音 ${this.turnCounter}](${file})\n`;
          } catch (e) { log('wav write failed:', e.message); }
        }
        chunk(this.session, line);
      }
      this.audioChunks = [];
      this.transcriptParts = [];
    }

  flushFeedPending() {
      const { texts } = this.feedPending;
      this.feedPending = null;
      const atMs = Date.now();
      const seedCallId = 'seeded-nudge-' + crypto.randomUUID();
      this.nudges.push({ id: seedCallId, request: this.lastSendTaskRequest ?? texts.join('\n').slice(0, 500), atMs, answer: texts.join('\n').slice(0, 8000), answeredAtMs: atMs });
      chunk(this.session, `\n📬 主聊天结果已回灌语音（${texts.length} 条，合并补播）\n`);
      this.asyncTriggerSeen = false;
      this.feedQuietUntil = Date.now() + 8000;
      if (this.feedWire === 'async-update') {
        this.sendFrame({
          type: 'async_update.add',
          event_id: seedCallId,
          async_update: { topic: 'work_landed', payload: texts.map(text => ({ message: { type: 'text', content: text.slice(0, 2000) }, timestampMs: atMs })) },
        });
        setTimeout(() => {
          if (this.closed || this.asyncTriggerSeen || this.responseActive) return;
          this.sendSeedPair(seedCallId + '-fb', texts, atMs);
        }, 4000);
      } else {
        this.sendSeedPair(seedCallId, texts, atMs);
      }
      this.lastActivityAt = Date.now();
  }

  async onToolCall(call) {
    log('voice tool call:', call.name, call.argumentsJson.slice(0, 200));
    this.toolCalls.push({ id: call.callId, name: call.name, argumentsJson: call.argumentsJson, atMs: Date.now() });
    if (call.name === 'send_task' && this.feedBaseSeq === null) {
      try {
        const t = await backend.rpc('ListGrokBotTranscriptEntries', { agentId: this.agentId, limit: 1 });
        this.feedBaseSeq = BigInt(t.entries?.[0]?.seq ?? '0');
        this.awaitingFeed = true;
        this.feedSince = Date.now();
        log('voice feed armed at seq', String(this.feedBaseSeq));
      } catch (e) { log('voice feed baseline failed:', e.message); }
    }
    let output;
    let spoken = false;
    if (call.name === 'end_the_call') {
      chunk(this.session, `\n📞 ${this.agentName} 挂断了语音通话。`);
      this.closed = true;
      this.closeReason = 'end_the_call';
      try {
        await backend.rpc('VoiceCallHarnessTool', {
          agentId: this.agentId, callId: this.callId, name: call.name, input: {},
          line: { theyJustTalked: true, newsOwed: false, receiptOwed: false, alreadySpokeThisTurn: this.spokeThisResponse },
        });
      } catch (e) { log('end_the_call harness error:', e.message); }
      try { this.ws?.close(1000, 'hung-up'); } catch {}
      return;
    }
    if (call.name === 'send_task') {
      let args = {};
      try { args = JSON.parse(call.argumentsJson); } catch {}
      const request = String(args.request ?? '').slice(0, 2000);
      this.lastSendTaskRequest = request;
      const receipt = this.harness.receipt ?? { output: { receipt: 'under way' }, instructions: '' };
      output = receipt.output ?? { receipt: 'under way' };
      spoken = !this.spokeThisResponse;
      chunk(this.session, `\n📨 **转交任务给 ${this.agentName} 主聊天：** ${request}\n`);
      try {
        const r = await backend.rpc('VoiceCallHarnessTool', {
          agentId: this.agentId, callId: this.callId, name: call.name, input: { request },
          line: { theyJustTalked: true, newsOwed: false, receiptOwed: !this.spokeThisResponse, alreadySpokeThisTurn: this.spokeThisResponse },
        });
        log('send_task harness result:', JSON.stringify(r).slice(0, 300));
      } catch (e) {
        chunk(this.session, `\n[voice] 任务转交失败：${e.message}`);
        output = { error: 'relay unreachable' };
      }
    } else {
      let input = {};
      try { input = JSON.parse(call.argumentsJson); } catch {}
      try {
        const r = await backend.rpc('VoiceCallHarnessTool', {
          agentId: this.agentId, callId: this.callId, name: call.name, input,
          line: { theyJustTalked: true, newsOwed: false, receiptOwed: false, alreadySpokeThisTurn: this.spokeThisResponse },
        });
        output = r?.output ?? {};
        if (r?.kind && r.kind !== 'SERVED' && r.kind !== 1) output = { error: String(r.kind) };
      } catch (e) {
        output = { error: e.message.slice(0, 200) };
      }
    }
    this.sendFrame({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.callId, output: JSON.stringify(output) } });
    if (spoken) this.createResponse(this.harness.receipt?.instructions ?? null);
  }

  async pollFeed() {
    if (this.feedBaseSeq === null || this.feedBusy || this.closed) return;
    if (Date.now() - this.lastFeedPollAt < 2500) return;
    this.lastFeedPollAt = Date.now();
    this.feedBusy = true;
    try {
      const t = await backend.rpc('ListGrokBotTranscriptEntries', { agentId: this.agentId, limit: 20 });
      const chan = 'voice:' + this.callId;
      const fresh = (t.entries ?? [])
        .filter(e => BigInt(e.seq) > this.feedBaseSeq)
        .map(e => ({ seq: BigInt(e.seq), body: entryBody(e) }))
        .filter(e => e.body?.kind === 'send-message' || e.body?.message?.type === 'text')
        .filter(e => (e.body.message?.channel ?? e.body.channel) === chan)
        .filter(e => !this.forwardedEntryIds.has(e.body.id ?? String(e.seq)))
        .sort((a, b) => (a.seq < b.seq ? -1 : 1));
      if (!fresh.length) return;
      const texts = fresh.map(e => String(e.body.message?.content ?? e.body.content ?? '').trim()).filter(Boolean).slice(0, 5);
      for (const e of fresh) this.forwardedEntryIds.add(e.body.id ?? String(e.seq));
      if (!texts.length) return;
      const joined = texts.join('\n').slice(0, 2000);
      if (this.responseActive || (this.feedQuietUntil && Date.now() < this.feedQuietUntil)) {
        this.feedPending = { texts: [...(this.feedPending?.texts ?? []), ...texts].slice(-5) };
        return;
      }
      chunk(this.session, `\n📬 主聊天结果已回灌语音（${texts.length} 条）\n`);
      const atMs = Date.now();
      const seedCallId = 'seeded-nudge-' + crypto.randomUUID();
      this.nudges.push({ id: seedCallId, request: this.lastSendTaskRequest ?? texts.join('\n').slice(0, 500), atMs, answer: texts.join('\n').slice(0, 8000), answeredAtMs: atMs });
      this.asyncTriggerSeen = false;
      this.feedQuietUntil = Date.now() + 8000;
      if (this.feedWire === 'async-update') {
        this.sendFrame({
          type: 'async_update.add',
          event_id: seedCallId,
          async_update: {
            topic: 'work_landed',
            payload: texts.map(text => ({ message: { type: 'text', content: text.slice(0, 2000) }, timestampMs: atMs })),
          },
        });
        setTimeout(() => {
          if (this.closed || this.asyncTriggerSeen || this.responseActive) return;
          log('voice feed: no orchestrated response, falling back to seed pair');
          this.sendSeedPair(seedCallId + '-fb', texts, atMs);
        }, 4000);
      } else {
        this.sendSeedPair(seedCallId, texts, atMs);
      }
      this.lastActivityAt = Date.now();
      log('voice feed forwarded', texts.length, 'texts via', this.feedWire, ':', joined.slice(0, 120));
    } catch (e) {
      log('voice feed poll error:', e.message);
    } finally {
      this.feedBusy = false;
    }
  }

  sendSeedPair(seedCallId, texts, atMs) {
    const at = new Date(atMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    this.sendFrame({ type: 'conversation.item.create', item: { type: 'function_call', name: 'work_landed', call_id: seedCallId, arguments: '{}' } });
    this.sendFrame({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: seedCallId, output: JSON.stringify({ status: 'landed', updates: texts.map(t => t.slice(0, 2000)), at }) } });
    this.createResponse(null);
  }

  async record() {
    try {
      const endedAtMs = Date.now();
      await backend.rpc('RecordGrokBotVoiceCall', {
        agentId: this.agentId,
        record: {
          callId: this.callId,
          agentId: this.agentId,
          realtimeConversationId: this.conversationId,
          startedAtMs: this.startedAtMs,
          endedAtMs,
          durationMs: endedAtMs - this.startedAtMs,
          ending: this.closeReason === 'end_the_call' || this.closeReason === 'user hung up' ? 'hung-up' : 'disconnected',
          model: '',
          turns: this.turns,
          nudges: this.nudges,
          events: [],
          toolCalls: this.toolCalls.map(t => ({ ...t, result: null })),
          overheard: [],
        },
      });
    } catch (e) { log('voice record failed (non-fatal):', e.message); }
  }
}

async function startVoice(id, params, session) {
  const agents = await listAgents();
  const agent = agents.find(a => a.agentId === session.agentId);
  chunk(params.sessionId, `📞 正在接通 ${agent?.name ?? 'leo'} 的语音通话…（输入文字即语音对话；发送「挂断」结束）`);
  const harness = await backend.rpc('VoiceCallHarnessSession', {
    agentId: session.agentId, agentName: agent?.name ?? 'leo', spokenLanguage: 'zh',
  });
  const call = new VoiceCall(session, params.sessionId, harness, agents);
  await call.open();
  session.voiceCall = call;
  chunk(params.sessionId, `\n✅ 语音已接通（${agent?.voiceId ?? '默认音色'}）。请开始说话或输入文字。`);
  call.createResponse(harness.greeting?.direction ?? null);
  return voiceWait(id, params, session, call);
}

async function voiceWait(id, params, session, call) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    if (session.cancelled || call.closed) break;
    await call.pollFeed();
    if (call.awaitingFeed) {
      if (call.forwardedEntryIds.size > 0 && !call.responseActive && Date.now() - call.lastActivityAt > VOICE_IDLE_MS) {
        call.awaitingFeed = false;
      } else if (Date.now() - call.feedSince > 120000) {
        call.awaitingFeed = false;
        chunk(params.sessionId, '\n[voice] 等待主聊天结果超时（120s），通话保持中。');
      }
    }
    if (!call.responseActive && !call.awaitingFeed && Date.now() - call.lastActivityAt > VOICE_IDLE_MS) break;
  }
  if (call.closed) {
    session.voiceCall = null;
    await call.record();
    chunk(params.sessionId, `\n📞 通话已结束（${call.closeReason ?? 'cancelled'}）。`);
    return reply(id, { stopReason: 'end_turn' });
  }
  chunk(params.sessionId, '\n⏸️ 语音通话保持中：继续说话/输入即可接着聊；发送「挂断」结束通话。');
  return reply(id, { stopReason: 'end_turn' });
}

async function voiceTextTurn(id, params, session, call, text) {
  if (/^(挂断|hang ?up|结束通话|退出语音)$/i.test(text.trim())) {
    call.closed = true;
    call.closeReason = 'user hung up';
    try { call.ws?.close(1000, 'hung-up'); } catch {}
    session.voiceCall = null;
    await call.record();
    chunk(params.sessionId, '\n📞 已挂断语音通话。');
    return reply(id, { stopReason: 'end_turn' });
  }
  call.turns.push({ id: `user-${call.turns.length}`, speaker: 'user', text, atMs: Date.now() });
  call.sendFrame({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  call.createResponse(null);
  call.lastActivityAt = Date.now();
  return voiceWait(id, params, session, call);
}

async function handlePrompt(id, params, { continueTurn = false } = {}) {
  const session = sessions.get(params.sessionId);
  if (!session) return replyError(id, -32602, 'unknown session');
  const text = (params.prompt ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
  const agentId = session.agentId;
  try {
    const baseline = await backend.rpc('ListGrokBotTranscriptEntries', { agentId, limit: 1 });
    const baseSeq = BigInt(baseline.entries?.[0]?.seq ?? '0');
    const nonce = crypto.randomUUID();
    const sentAtMs = Date.now();
    let sawAccepted = continueTurn;
    if (!continueTurn) {
      const sendRes = await backend.rpc('SendGrokBotUserMessage', {
        agentId, messageId: nonce, text, sentAtMs: String(sentAtMs), source: 'DESKTOP', initiator: 'USER',
      });
      if (sendRes?.dispatched === false) {
        chunk(params.sessionId, `[bridge] send refused: ${JSON.stringify(sendRes.refusal ?? sendRes)}`);
        return reply(id, { stopReason: 'refusal' });
      }
    }
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    let delivered = '';
    const emitted = new Set();
    let pendingWidget = null;
    let pendingInteraction = null;
    let quietPolls = 0;
    let lastFreshAt = Date.now();
    let pollCount = 0;
    let sawComplete = false;
    let widgetSince = 0;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_MS));
      if (session.cancelled) return reply(id, { stopReason: 'cancelled' });
      pollCount += 1;
      const pollStart = Date.now();
      if (!continueTurn) {
        const status = await backend.rpc('GetGrokBotSendStatus', { agentId, messageId: nonce });
        if (status?.status === 'GROK_BOT_SEND_STATUS_ACCEPTED') sawAccepted = true;
        if (status?.status && String(status.status).includes('REJECT')) {
          chunk(params.sessionId, `[bridge] send rejected: ${status.rejectionCode ?? status.status}`);
          return reply(id, { stopReason: 'refusal' });
        }
      }
      const t = await backend.rpc('ListGrokBotTranscriptEntries', { agentId, limit: 20 });
      if (process.env.GROKBOT_DEBUG && (pollCount <= 3 || pollCount % 10 === 0)) {
        log(`poll#${pollCount} rpc=${Date.now() - pollStart}ms entries=${t.entries?.length ?? 0} accepted=${sawAccepted} emitted=${emitted.size}`);
      }
      const fresh = (t.entries ?? [])
        .filter(e => BigInt(e.seq) > baseSeq)
        .map(e => ({ seq: BigInt(e.seq), entryId: e.entryId ?? e.body?.id, body: entryBody(e) }))
        .filter(e => e.body)
        .sort((a, b) => (a.seq < b.seq ? -1 : 1));
      let complete = false;
      for (const e of fresh) {
        const b = e.body;
        const key = b.id ?? String(e.seq);
        if (emitted.has(key)) {
          if (pendingWidget && pendingWidget.key === key && (b.respondedValue != null || b.widgetDismissed === true)) {
            pendingWidget = null;
            complete = true;
          }
          if (pendingInteraction && pendingInteraction.key === key) {
            const t = pendingInteraction.type;
            const settled = t === 'widget'
              ? (b.respondedValue != null || b.widgetDismissed === true)
              : t === 'user-form'
                ? b.formResolution != null
                : (b.ask?.status ?? b.approval?.status) && (b.ask?.status ?? b.approval?.status) !== 'pending';
            if (settled) {
              pendingInteraction = null;
              complete = true;
            }
          }
          continue;
        }
        if (b.kind === 'send-message') {
          const content = renderMessage(b.message);
          if (content && (b.timestampMs ?? 0) >= sentAtMs - 5000) {
            emitted.add(key);
            lastFreshAt = Date.now();
            chunk(params.sessionId, (delivered ? '\n\n' : '') + content);
            delivered += content;
            const isQuestion = b.message?.type === 'widget'
              && typeof b.message.widget?.prompt === 'string'
              && b.respondedValue == null && b.widgetDismissed !== true;
            const mtype = b.message?.type;
            const interactivePending =
              (mtype === 'local-tool-permission' && b.message.ask?.status === 'pending' && b.message.ask?.requestId)
              || (mtype === 'auto-review-approval' && b.message.approval?.status === 'pending' && b.message.approval?.requestId)
              || (mtype === 'user-form' && b.formResolution == null)
              || (mtype === 'widget' && process.env.GROKBOT_WIDGET_CARD === '1'
                && typeof b.message.widget?.prompt === 'string'
                && (b.message.widget?.options ?? []).length > 0
                && b.respondedValue == null && b.widgetDismissed !== true);
            if (interactivePending) {
              pendingInteraction = { key, entryId: b.id ?? e.entryId, type: mtype };
              complete = true;
              lastFreshAt = Date.now();
              resolveInteractive(session, params.sessionId, b, pendingInteraction.entryId)
                .then((r) => {
                  if (!r) return;
                  if (r.outcome === 'cancelled') {
                    chunk(params.sessionId, '\n[bridge] 已取消，卡片保留在 Grok Bot 桌面端待处理。');
                  } else if (r.accepted === false) {
                    chunk(params.sessionId, `\n[bridge] 回传被拒：${JSON.stringify(r.refusal ?? {})}，请在桌面端处理`);
                  } else {
                    chunk(params.sessionId, `\n（${r.note}）`);
                  }
                  lastFreshAt = Date.now();
                })
                .catch((err) => {
                  chunk(params.sessionId, `\n[bridge] 卡片回传失败：${err.message}，请在桌面端处理`);
                  pendingInteraction = null;
                  lastFreshAt = Date.now();
                });
            } else if (isQuestion) {
              if (process.env.GROKBOT_WIDGET_CARD !== '1') pendingWidget = { key, entryId: b.id ?? e.entryId };
              else complete = true;
            } else {
              complete = true;
            }
          }
        } else if (b.kind === 'message' && b.role !== 'user' && b.isStreaming === false) {
          const content = String(b.content ?? '');
          if (content && (b.timestampMs ?? 0) >= sentAtMs - 5000) {
            emitted.add(key);
            lastFreshAt = Date.now();
            chunk(params.sessionId, (delivered ? '\n\n' : '') + content);
            delivered += content;
            complete = true;
          }
        }
      }
      if (pendingWidget && session.widgetAnswer != null) {
        widgetSince = 0;
        const answer = String(session.widgetAnswer);
        session.widgetAnswer = null;
        try {
          const r = await backend.rpc('RespondGrokBotWidget', { agentId, entryId: pendingWidget.entryId, value: answer });
          if (r?.accepted === false) {
            chunk(params.sessionId, `[bridge] 卡片代答被拒：${JSON.stringify(r.refusal ?? r)}，请在桌面端处理`);
            pendingWidget = null;
            complete = true;
          } else {
            chunk(params.sessionId, `（已代答：${answer}）`);
          }
        } catch (err) {
          chunk(params.sessionId, `[bridge] 卡片代答失败：${err.message}，请在桌面端处理`);
          pendingWidget = null;
          complete = true;
        }
      }
      if (continueTurn && !complete && !pendingWidget && !pendingInteraction) {
        quietPolls += 1;
        if (quietPolls >= 3) return reply(id, { stopReason: 'end_turn' });
      } else {
        quietPolls = 0;
      }
      if (complete) sawComplete = true;
      if (pendingWidget) {
        if (!widgetSince) widgetSince = Date.now();
        if (Date.now() - widgetSince >= GRACE_MS) {
          chunk(params.sessionId, '\n[bridge] Bot 在等待卡片回答；直接发消息即可代答，或在 Grok Bot 桌面端点选。');
          session.awaitingWidget = true;
          session.pendingWidgetEntryId = pendingWidget.entryId;
          return reply(id, { stopReason: 'end_turn' });
        }
      } else {
        widgetSince = 0;
      }
      if (sawComplete && sawAccepted && !pendingWidget && !pendingInteraction && Date.now() - lastFreshAt >= GRACE_MS) {
        return reply(id, { stopReason: 'end_turn' });
      }
    }
    if (pendingInteraction) {
      chunk(params.sessionId, '\n[bridge] 卡片仍在等待处理（T3 卡片或 Grok Bot 桌面端）。');
      return reply(id, { stopReason: 'end_turn' });
    }
    if (pendingWidget) {
      chunk(params.sessionId, '\n[bridge] Bot 在等待卡片回答；直接发消息即可代答，或在 Grok Bot 桌面端点选。');
      session.awaitingWidget = true;
      session.pendingWidgetEntryId = pendingWidget.entryId;
      return reply(id, { stopReason: 'end_turn' });
    }
    if (sawComplete && sawAccepted) {
      chunk(params.sessionId, '\n[bridge] Bot 已回复但仍在运行，先结束本轮；后续消息会在下一轮带出。');
      return reply(id, { stopReason: 'end_turn' });
    }
    chunk(params.sessionId, '\n[bridge] turn timed out waiting for bot reply');
    return reply(id, { stopReason: 'max_turn_requests' });
  } catch (e) {
    log('prompt error:', e.message);
    chunk(params.sessionId, `[bridge] error: ${e.message}`);
    return reply(id, { stopReason: 'refusal' });
  }
}

let negotiatedClientCaps = { elicitation: false, permission: true, fs: {}, terminal: false };

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === undefined && id !== undefined && pendingRpc.has(id)) {
      const resolve = pendingRpc.get(id);
      pendingRpc.delete(id);
      resolve(msg);
      return;
    }
    if (method === undefined && id !== undefined) {
      log('ignoring late/unknown response id', id);
      return;
    }
    if (method === 'initialize') {
      const requested = Number(params?.protocolVersion ?? 1);
      const clientCaps = params?.clientCapabilities ?? {};
      negotiatedClientCaps = {
        elicitation: clientCaps.elicitation != null,
        permission: true,
        fs: clientCaps.fs ?? {},
        terminal: clientCaps.terminal === true,
      };
      return reply(id, {
        protocolVersion: 1,
        agentInfo: { name: 'grokbot-t3-bridge', title: 'GrokBot', version: GROKBOT_VERSION },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          sessionCapabilities: { resume: {} },
        },
        authMethods: [],
      });
    }
    if (method === 'authenticate') return reply(id, {});
    if (method === 'session/new') {
      const agents = await listAgents();
      const wanted = process.env.GROKBOT_AGENT;
      const agent = (wanted && agents.find(a => a.name === wanted || a.agentId === wanted)) || agents[0];
      if (!agent) return replyError(id, -32603, 'no Grok Bot agents visible to this account');
      const sessionId = 'gb-' + crypto.randomUUID();
      sessions.set(sessionId, { agentId: agent.agentId, cancelled: false, cwd: typeof params.cwd === 'string' ? params.cwd : null, clientCaps: negotiatedClientCaps });
      bindSession(sessionId, agent.agentId);
      reply(id, { sessionId, configOptions: sessionConfigOptions(agents, agent.agentId) });
      notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: sessionCommands() } });
      return;
    }
    if (method === 'session/set_config_option') {
      const session = sessions.get(params.sessionId);
      if (session && params.configId === 'model') {
        session.agentId = params.value;
        bindSession(params.sessionId, params.value);
        const agents = await listAgents();
        return reply(id, { configOptions: sessionConfigOptions(agents, params.value) });
      }
      return reply(id, { configOptions: [] });
    }
    if (method === 'session/prompt') {
      const session = sessions.get(params.sessionId);
      if (session) session.cancelled = false;
      const promptText = (params.prompt ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
      const voiceCommand = /^(语音|语音通话|voice|打电话|call)$/i;
      const userText = extractUserText(promptText);
      const wantsVoice = voiceCommand.test(userText) || /^\/voice$/im.test(userText);
      const wantsHangUp = /^(挂断|hang ?up|结束通话|退出语音)$/i.test(userText);
      if (wantsVoice && !VOICE_FEATURE_ENABLED) {
        chunk(params.sessionId, '🔇 语音通话是预留特性，当前未启用（T3 尚不支持实时音频输入）。如需试用，在 provider 环境变量中设置 GROKBOT_VOICE=1；启用后为文字进、语音出的实验模式。');
        return reply(id, { stopReason: 'end_turn' });
      }
      if (session?.voiceCall && !session.voiceCall.closed) {
        return voiceTextTurn(id, params, session, session.voiceCall, wantsHangUp ? '挂断' : userText);
      }
      if (session && wantsVoice) {
        try {
          return await startVoice(id, params, session);
        } catch (e) {
          log('voice start error:', e.message);
          chunk(params.sessionId, `[voice] 接通失败：${e.message}`);
          return reply(id, { stopReason: 'refusal' });
        }
      }
      if (session?.awaitingWidget) {
        session.awaitingWidget = false;
        const answer = (params.prompt ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
        try {
          const r = await backend.rpc('RespondGrokBotWidget', { agentId: session.agentId, entryId: session.pendingWidgetEntryId, value: answer });
          if (r?.accepted === false) {
            chunk(params.sessionId, `[bridge] 卡片代答被拒：${JSON.stringify(r.refusal ?? r)}，请在桌面端处理`);
            return reply(id, { stopReason: 'refusal' });
          }
          chunk(params.sessionId, `（已代答：${answer}，等待 Bot 继续…）`);
        } catch (err) {
          chunk(params.sessionId, `[bridge] 卡片代答失败：${err.message}`);
          return reply(id, { stopReason: 'refusal' });
        }
        return handlePrompt(id, { ...params, prompt: [] }, { continueTurn: true });
      }
      return handlePrompt(id, params);
    }
    if (method === 'session/cancel') {
      const session = sessions.get(params.sessionId);
      if (session) session.cancelled = true;
      return;
    }
    if (method === 'session/resume') {
      const agents = await listAgents();
      const bindings = loadSessionBindings();
      const wanted = process.env.GROKBOT_AGENT;
      const fallback = (wanted && agents.find(a => a.name === wanted || a.agentId === wanted)) || agents[0];
      const bound = bindings[params.sessionId];
      const agentId = (bound && agents.some(a => a.agentId === bound)) ? bound : fallback?.agentId;
      if (!agentId) return replyError(id, -32603, 'no Grok Bot agents visible to this account');
      sessions.set(params.sessionId, { agentId, cancelled: false, cwd: typeof params.cwd === 'string' ? params.cwd : null, clientCaps: negotiatedClientCaps });
      bindSession(params.sessionId, agentId);
      log('session/resume', params.sessionId, '→ agent', agentId, bound ? '(bound)' : '(fallback)');
      reply(id, { configOptions: sessionConfigOptions(agents, agentId) });
      notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: sessionCommands() } });
      return;
    }
    if (method === 'session/load') {
      return replyError(id, -32601, 'session/load not supported; agent advertises session/resume only');
    }
    if (method === 'session/set_model') {
      const session = sessions.get(params.sessionId);
      if (session && typeof params.modelId === 'string') {
        session.agentId = params.modelId;
        bindSession(params.sessionId, params.modelId);
      }
      return reply(id, {});
    }
    if (method === 'session/set_mode') return replyError(id, -32601, 'modes not supported');
    if (id !== undefined) return replyError(id, -32601, 'unsupported: ' + method);
  } catch (e) {
    log('handler error:', method, e.message);
    if (id !== undefined) replyError(id, -32603, e.message);
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const session of sessions.values()) {
      try { session.voiceCall?.ws?.close(1000, 'bridge shutting down'); } catch {}
    }
    process.exit(0);
  });
}

log('ready');
