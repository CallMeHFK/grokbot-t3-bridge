import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';

const child = spawn(process.env.HOME + '/.grokbot-bridge/grokbot-acp', [], {
  cwd: import.meta.dirname,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GROKBOT_AGENT: process.env.GROKBOT_AGENT ?? 'leo', GROKBOT_VOICE_IDLE_MS: '12000' },
});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const rl = readline.createInterface({ input: child.stdout });
let sessionId = null;
let phaseText = '';
const phases = [];
let step = 0;
const timer = setTimeout(() => { console.error('TIMEOUT'); dump(); child.kill('SIGKILL'); process.exit(2); }, 300000);

function dump() {
  for (const [i, p] of phases.entries()) console.log(`\n===== PHASE ${i + 1} =====\n` + p.text);
}
function prompt(text) {
  step += 1;
  phaseText = '';
  send({ jsonrpc: '2.0', id: 10 + step, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } });
}
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'session/update') {
    const u = msg.params?.update ?? {};
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') phaseText += u.content.text;
    return;
  }
  if (msg.id === 1) {
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: import.meta.dirname, mcpServers: [] } });
  } else if (msg.id === 2) {
    sessionId = msg.result.sessionId;
    prompt('语音');
  } else if (msg.id >= 11) {
    phases.push({ text: phaseText, result: msg.result ?? msg.error });
    console.log(`phase ${phases.length} stop:`, JSON.stringify(msg.result ?? msg.error));
    if (phases.length === 1) {
      prompt('请用一句话告诉我：语音链路正常，然后停下。');
    } else if (phases.length === 2) {
      prompt('挂断');
    } else {
      clearTimeout(timer);
      dump();
      const all = phases.map(p => p.text).join('\n');
      const wavMatches = [...all.matchAll(/!\[[^\]]*\]\(([^)]+\.wav)\)/g)].map(m => m[1]);
      let wavOk = 0;
      for (const w of wavMatches) {
        try {
          const b = fs.readFileSync(w);
          const riff = b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE';
          const rate = b.readUInt32LE(24);
          const dataLen = b.readUInt32LE(40);
          console.log(`WAV ${w}: bytes=${b.length} riff=${riff} rate=${rate} data=${dataLen} dur=${(dataLen / 48000).toFixed(1)}s`);
          if (riff && rate === 24000 && dataLen > 4800) wavOk += 1;
        } catch (e) { console.log(`WAV ${w}: READ FAIL ${e.message}`); }
      }
      const transcriptOk = /语音链路正常|链路正常/.test(all);
      console.log(`\nVERDICT: wavFiles=${wavMatches.length} validWav=${wavOk} transcriptOk=${transcriptOk}`);
      child.kill('SIGKILL');
      process.exit(wavOk >= 2 && transcriptOk ? 0 : 1);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(d));
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'gb-voice-smoke', version: '0' } } });
