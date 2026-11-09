// Tiny stand-in for an OpenAI-compatible model server (like Ollama), used only by tests. Port 4010.
import http from 'node:http';
http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
    const j = JSON.parse(b || '{}'), sys = j.messages?.[0]?.content || '', user = j.messages?.[1]?.content || '';
    let out = {};
    if (sys.includes('TASK:subjects')) out = { subjects: ['March offers are here', 'FREE MONEY!!! ACT NOW', 'Re: your order', 'Fresh arrivals this week', 'A small thank you'] };
    else if (sys.includes('TASK:draft')) out = { subject: 'Model draft subject', preheader: 'Written by the connected model', headline: 'Weekend picks', paragraphs: ['Hi {{first_name | there}},', 'Here are three things we think you will like.'], button_label: 'See picks' };
    else if (sys.includes('TASK:segment')) out = user.includes('BAD') ? { match: 'all', rules: [{ field: 'drop_table', value: 'x' }], explanation: 'x' } : { match: 'all', rules: [{ field: 'engaged_within', value: '30' }], explanation: 'Engaged in 30 days (from model)' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Sure:\n```json\n' + JSON.stringify(out) + '\n```' } }] }));
  });
}).listen(4010, () => console.log('mock model on 4010'));
