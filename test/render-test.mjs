import fs from 'node:fs';
const src = fs.readFileSync(process.env.HOME + '/.grokbot-bridge/grokbot-acp.mjs', 'utf8');
const start = src.indexOf('function optionLabel');
const end = src.indexOf('const sessions = new Map();');
const mod = src.slice(start, end);
const renderMessage = new Function(mod + '\nreturn renderMessage;')();

const cases = [
  { type: 'text', content: 'hello **world**' },
  { type: 'text', content: '结果如下', cards: { items: [{ card: { kind: 'purchase', title: '订单卡片' } }] } },
  { type: 'attachment', url: 'https://example.com/a.pdf', file_name: 'a.pdf' },
  { type: 'widget', widget: { prompt: '选一个方向？', options: [{ label: '方案A', value: 'a' }, { label: '方案B', value: 'b' }] } },
  { type: 'widget', widget: { prompt: '确认继续吗？' } },
  { type: 'user-form', formRequest: { title: '部署信息', fields: [{ label: '环境' }, { name: 'region' }] } },
  { type: 'visualization', title: '销售趋势图', url: 'https://example.com/viz' },
  { type: 'email-draft', draft: { to: ['a@b.c'], subject: '测试', body: '正文' } },
  { type: 'auto-review-approval', approval: { status: 'pending', summary: '执行 rm' } },
  { type: 'something-new', title: '未来卡片' },
];
for (const c of cases) {
  console.log('---', c.type);
  console.log(renderMessage(c));
}
