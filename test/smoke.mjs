import { spawn } from 'node:child_process';
import readline from 'node:readline';

const PROMPT = process.argv[2] ?? '只回复两个字符：OK';
const child = spawn(process.env.HOME + '/.grokbot-bridge/grokbot-acp', [], {
  cwd: import.meta.dirname,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GROKBOT_AGENT: 'leo' },
});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const rl = readline.createInterface({ input: child.stdout });
let text = '';
const timer = setTimeout(() => { console.error('TIMEOUT'); child.kill('SIGKILL'); process.exit(2); }, 420000);

rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'session/update') {
    const u = msg.params?.update ?? {};
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text;
    return;
  }
  if (msg.id === 1) {
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: import.meta.dirname, mcpServers: [] } });
  } else if (msg.id === 2) {
    if (msg.error) { console.error('session/new failed', JSON.stringify(msg.error)); process.exit(1); }
    send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: msg.result.sessionId, prompt: [{ type: 'text', text: PROMPT }] } });
  } else if (msg.id === 3) {
    clearTimeout(timer);
    console.log('TEXT:\n' + text);
    console.log('RESULT:', JSON.stringify(msg.result ?? msg.error));
    child.kill('SIGKILL');
    process.exit(0);
  }
});
child.stderr.on('data', (d) => process.stderr.write(d));
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'gb-smoke', version: '0' } } });
