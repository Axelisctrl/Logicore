'use strict';
// LOGICORE server: zero dependencies (Node 18+). API keys stay here, never in the browser.
const http = require('http'), fs = require('fs'), path = require('path');
const P = require('./prompts');

try { // minimal .env loader
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const E = process.env, PORT = +E.PORT || 3000, PROVIDER = (E.PROVIDER || 'anthropic').toLowerCase();
const MODEL = E.MODEL || (PROVIDER === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-4o');
const CODE = E.ACCESS_CODE || '', RATE = +E.RATE_LIMIT_PER_MIN || 30, TRUST_PROXY = E.TRUST_PROXY === '1';
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

class HttpError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code; } }

async function llm(system, messages, max) {
  let r;
  if (PROVIDER === 'anthropic') {
    if (!E.ANTHROPIC_API_KEY) throw new HttpError(500, 'Server is not configured: ANTHROPIC_API_KEY is missing.');
    r = await fetch((E.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: max, system, messages })
    });
  } else if (PROVIDER === 'openai') { // OpenAI and any OpenAI-compatible API (DeepSeek, etc.)
    if (!E.OPENAI_API_KEY) throw new HttpError(500, 'Server is not configured: OPENAI_API_KEY is missing.');
    r = await fetch((E.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + E.OPENAI_API_KEY },
      body: JSON.stringify({ model: MODEL, max_tokens: max, messages: [{ role: 'system', content: system }, ...messages] })
    });
  } else throw new HttpError(500, 'Server is not configured: PROVIDER must be "anthropic" or "openai".');
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Upstream error', r.status, JSON.stringify(j).slice(0, 300));
    const m = (j.error && j.error.message) || '';
    throw new HttpError(502, /credit|quota|billing/i.test(m) ? 'The AI provider account is out of credit.' : r.status === 401 ? 'The AI provider rejected the server API key.' : r.status === 429 ? 'The AI provider is rate limiting requests. Try again shortly.' : 'The AI provider returned an error (' + r.status + ').');
  }
  return PROVIDER === 'anthropic' ? j.content.filter(b => b.type === 'text').map(b => b.text).join('') : j.choices[0].message.content;
}

function cleanMessages(a) {
  if (!Array.isArray(a) || !a.length || a.length > 60) throw new HttpError(400, 'Invalid messages.');
  const out = [];
  for (const m of a) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 20000) throw new HttpError(400, 'Invalid message.');
    out.push({ role: m.role, content: m.content });
  }
  if (out[0].role !== 'user' || out[out.length - 1].role !== 'user') throw new HttpError(400, 'Conversation must start and end with a user message.');
  return out;
}
const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';

const routes = {
  // MODE 1: normal conversation
  '/api/chat': async b => ({ text: await llm(P.CHAT, cleanMessages(b.messages), 4096) }),
  // MODE 2: on-demand verification
  '/api/verify': async b => {
    const o = { question: str(b.question, 8000), answer: str(b.answer, 20000), source: str(b.source, 40), context: str(b.context, 6000) };
    if (!o.answer.trim()) throw new HttpError(400, 'Nothing to verify.');
    const raw = await llm(P.VERIFY, [{ role: 'user', content: P.buildVerify(o) }], 6000);
    try { return P.parseJSON(raw); } catch { throw new HttpError(502, 'The verification engine returned a malformed report. Try again.'); }
  }
};

const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
const limited = ip => { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > RATE; };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
  });
  res.end(body);
}
const fail = (res, e) => send(res, e.status || 500, JSON.stringify({ error: e.status ? e.message : 'Server error.', code: e.code }));

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, JSON.stringify({ ok: true, provider: PROVIDER, model: MODEL, accessCode: !!CODE }));
    if (req.method === 'POST' && routes[url.pathname]) {
      const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
      if (limited(ip)) throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
      if (CODE && req.headers['x-access-code'] !== CODE) throw new HttpError(401, 'Access code required.', 'access');
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 300000) throw new HttpError(413, 'Request too large.'); }
      let body; try { body = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
      return send(res, 200, JSON.stringify(await routes[url.pathname](body)));
    }
    if (req.method === 'GET') { // static files
      const file = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
      if (!file.startsWith(PUB + path.sep)) throw new HttpError(404, 'Not found.');
      const data = await fs.promises.readFile(file).catch(() => null);
      if (!data) throw new HttpError(404, 'Not found.');
      return send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
    }
    throw new HttpError(404, 'Not found.');
  } catch (e) { if (!e.status) console.error(e); fail(res, e); }
}).listen(PORT, () => console.log(`LOGICORE running on http://localhost:${PORT} (${PROVIDER}, ${MODEL})`));
