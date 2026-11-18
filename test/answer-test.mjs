import { spawn } from 'node:child_process';
import readline from 'node:readline';

const child = spawn(process.env.HOME + '/.grokbot-bridge/grokbot-acp', [], {
  cwd: import.meta.dirname, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GROKBOT_AGENT: 'leo' },
});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const rl = readline.createInterface({ input: child.stdout });
let sessionId = '';
let text = '';
let phase = 0;
setTimeout(() => { console.log('TIMEOUT phase', phase, 'text:', text); child.kill('SIGKILL'); process.exit(2); }, 150000);

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
  if (m.id === 1) {
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: import.meta.dirname, mcpServers: [] } });
  } else if (m.id === 2) {
    sessionId = m.result.sessionId;
    phase = 1; text = '';
    send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '请用 send_message 发一张选项卡片：问题“代答链路测试”，选项“戊”“己”。发完卡片就停下等我回答。' }] } });
  } else if (m.id === 3) {
    console.log('TURN1 RESULT:', JSON.stringify(m.result ?? m.error));
    phase = 2; text = '';
    send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '戊' }] } });
  } else if (m.id === 4) {
    console.log('TURN2 RESULT:', JSON.stringify(m.result ?? m.error));
    console.log('TURN2 TEXT:\n' + text);
    child.kill('SIGKILL');
    process.exit(0);
  }
});
child.stderr.on('data', (d) => process.stderr.write(d));
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'gb-answer', version: '0' } } });
