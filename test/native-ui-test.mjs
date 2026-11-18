import { spawn } from 'node:child_process';
import readline from 'node:readline';

const MODE = process.argv[2] ?? 'form';
const DECISION = process.argv[3] ?? (MODE === 'form' ? 'accept' : 'allow-once');
const PROMPTS = {
  form: '请给我发一张 user-form 表单卡片：标题“T3 表单链路测试”，只要一个必填文本字段 city（标签“城市”）。发完卡片就停下等我提交，不要做其他事。',
  'local-tool': '请尝试在本机执行 shell 命令 `echo gb-native-ui-test`，触发本机工具授权卡片后停下等我决定。',
  'auto-review': '请发起一个需要 auto-review 审批的操作（例如给 leo@example.com 发一封测试邮件的草稿并请求发送审批），触发审批卡片后停下等我决定。',
  widget: '请用 send_message 发一张选项卡片：问题“T3 原生卡片链路测试”，选项“庚”“辛”。发完卡片就停下等我回答。',
};

const child = spawn(process.env.HOME + '/.grokbot-bridge/grokbot-acp', [], {
  cwd: import.meta.dirname, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GROKBOT_AGENT: 'leo', ...(MODE === 'widget' ? { GROKBOT_WIDGET_CARD: '1' } : {}) },
});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const rl = readline.createInterface({ input: child.stdout });
let sessionId = '';
let text = '';
let sawCard = false;
setTimeout(() => { console.log('TIMEOUT sawCard=', sawCard, 'text:', text); child.kill('SIGKILL'); process.exit(2); }, 420000);

rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'session/update') {
    const u = m.params?.update ?? {};
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      text += u.content.text;
      console.log('CHUNK:', JSON.stringify(u.content.text.slice(0, 200)));
    }
    return;
  }
  if (m.method === 'session/request_permission') {
    sawCard = true;
    console.log('PERMISSION CARD:', JSON.stringify(m.params).slice(0, 500));
    const opt = (m.params.options ?? []).find(o => o.optionId === DECISION || o.name === DECISION) ?? m.params.options[0];
    send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } });
    return;
  }
  if (m.method === 'elicitation/create') {
    sawCard = true;
    console.log('FORM CARD:', JSON.stringify(m.params).slice(0, 500));
    if (DECISION === 'accept') {
      const content = {};
      for (const [k, v] of Object.entries(m.params.requestedSchema?.properties ?? {})) {
        content[k] = v.type === 'boolean' ? true : '苏州';
      }
      send({ jsonrpc: '2.0', id: m.id, result: { action: 'accept', content } });
    } else {
      send({ jsonrpc: '2.0', id: m.id, result: { action: 'decline' } });
    }
    return;
  }
  if (m.id === 1) {
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: import.meta.dirname, mcpServers: [] } });
  } else if (m.id === 2) {
    if (m.error) { console.error('session/new failed', JSON.stringify(m.error)); process.exit(1); }
    sessionId = m.result.sessionId;
    send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: PROMPTS[MODE] }] } });
  } else if (m.id === 3) {
    console.log('TURN RESULT:', JSON.stringify(m.result ?? m.error));
    console.log('SAW CARD:', sawCard);
    console.log('TEXT:\n' + text);
    child.kill('SIGKILL');
    process.exit(sawCard ? 0 : 3);
  }
});
child.stderr.on('data', (d) => process.stderr.write(d));
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } }, clientInfo: { name: 'gb-native-ui-test', version: '0' } } });
