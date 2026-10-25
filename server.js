// Servidor da Apuração Ao Vivo.
// Um único processo busca os arquivos do TSE sem parar e transmite cada mudança para todos os navegadores
// por Server-Sent Events. Assim o TSE recebe as buscas de um só servidor, não de cada pessoa, e quem está
// assistindo recebe a atualização no mesmo instante em que o servidor a vê.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3000;
const BASE = process.env.TSE_BASE || 'https://resultados.tse.jus.br/oficial';
const POLL_MS = Number(process.env.POLL_MS) || 700;          // pausa entre buscas do arquivo nacional
const STATES_MS = Number(process.env.STATES_MS) || 4000;     // pausa entre rodadas dos 28 arquivos estaduais
const TIMEOUT_MS = 6000;
const UFS = ['ac','al','ap','am','ba','ce','df','es','go','ma','mt','ms','mg','pa','pb','pr','pe','pi','rj','rn','rs','ro','rr','sc','sp','se','to','zz'];

let election = null;                  // { ciclo, cd }
const files = {};                     // uf -> versão enxuta do arquivo atual
const first = {};                     // uf -> versão enxuta do 1º turno
const meta = {};                      // uf -> { etag, lastModified, key }
const status = { ok: false, lastOk: 0, lastErr: '', checks: 0, startedAt: Date.now() };
const clients = new Set();
// audiência: cada navegador manda um código aleatório (sem nenhum dado pessoal); várias abas contam como uma pessoa
const watching = new Map();           // código -> conexões abertas
const seen = new Set();               // códigos que já passaram desde que o servidor ligou
let peak = 0, peakAt = 0;

// ---------- TSE ----------
function decode(text) {
  const t = text.trim();
  if (t[0] === '{' || t[0] === '[') return JSON.parse(t);
  const parts = t.replace(/^"|"$/g, '').split('.');
  if (parts.length === 3) return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  throw new Error('resposta inesperada');
}

async function get(url, m) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const headers = { 'user-agent': 'apuracao-ao-vivo/1.0', accept: 'application/json, */*' };
    if (m && m.etag) headers['if-none-match'] = m.etag;
    if (m && m.lastModified) headers['if-modified-since'] = m.lastModified;
    const r = await fetch(url, { headers, signal: ctl.signal });
    if (r.status === 304) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (m) { m.etag = r.headers.get('etag') || ''; m.lastModified = r.headers.get('last-modified') || ''; }
    return decode(await r.text());
  } finally {
    clearTimeout(timer);
  }
}

const fileUrl = (cd, uf) => `${BASE}/${election.ciclo}/${cd}/dados/${uf}/${uf}-c0001-e${String(cd).padStart(6, '0')}-u.json`;

// Mantém só o que a página usa, no mesmo formato do TSE (a página entende os dois).
function slim(j) {
  const raw = [];
  if (j.carg) {
    const car = j.carg.find(c => String(c.cd) === '1') || j.carg[0] || {};
    (car.agr || []).forEach(a => (a.par || []).forEach(p => (p.cand || []).forEach(c => raw.push(c))));
    (car.cand || []).forEach(c => raw.push(c));
  } else (j.cand || []).forEach(c => raw.push(c));
  const sec = j.s && typeof j.s === 'object' ? j.s : { pst: j.pst };
  const el = j.e && typeof j.e === 'object' ? j.e : { te: j.e, a: j.a, pa: j.pa, pc: j.pc };
  const vt = j.v && typeof j.v === 'object' ? j.v : { vb: j.vb, tvn: j.tvn != null ? j.tvn : j.vn };
  return {
    dg: j.dg, hg: j.hg,
    s: { pst: sec.pst },
    e: { te: el.te, a: el.a, pa: el.pa, pc: el.pc },
    v: { vb: vt.vb, tvn: vt.tvn != null ? vt.tvn : vt.vn },
    carg: [{ cd: '1', agr: [{ par: [{ cand: raw.map(c => ({ n: c.n, nm: c.nm, nmu: c.nmu, vap: c.vap, pvap: c.pvap, st: c.st, e: c.e })) }] }] }],
  };
}

async function discover() {
  if (process.env.CICLO && process.env.ELEICAO) return { ciclo: process.env.CICLO, cd: String(process.env.ELEICAO) };
  let conf;
  try { conf = await get(BASE + '/comum/config/ele-c.json'); } catch { conf = null; }
  const ciclo = process.env.CICLO || (conf && conf.c) || 'ele2026';
  if (process.env.ELEICAO) return { ciclo, cd: String(process.env.ELEICAO) };
  const found = [];
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (o.cdt2) found.push({ cd: o.cdt2, t: '2', nm: o.nm || '' });
      if (o.cd != null && o.t != null && (o.nm || o.dt)) found.push(o);
      Object.values(o).forEach(walk);
    }
  })(conf || {});
  const t2 = found.filter(e => String(e.t) === '2');
  const fed = t2.filter(e => /federal|geral/i.test(e.nm || ''));
  const pick = (fed.length ? fed : t2).sort((a, b) => Number(b.cd) - Number(a.cd))[0];
  return { ciclo, cd: pick ? String(pick.cd) : '6258' };
}

// Busca um arquivo e transmite se mudou. Devolve true se a busca funcionou.
async function refresh(uf) {
  const m = meta[uf] || (meta[uf] = {});
  const j = await get(fileUrl(election.cd, uf), m);
  if (!j) return true; // 304: nada mudou
  const s = slim(j);
  const key = JSON.stringify([s.dg, s.hg, s.s.pst, s.carg[0].agr[0].par[0].cand.map(c => c.vap)]);
  if (key === m.key) return true;
  // um nó de cache atrasado pode devolver um arquivo mais velho; nunca volta para trás
  const prev = files[uf];
  if (prev && olderThan(s, prev)) return true;
  m.key = key;
  files[uf] = s;
  broadcast('file', { uf, data: s });
  return true;
}

function tseMs(s) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s.dg || ''), h = /(\d{2}):(\d{2}):(\d{2})/.exec(s.hg || '');
  return m && h ? Date.UTC(+m[3], m[2] - 1, +m[1], +h[1] + 3, +h[2], +h[3]) : 0;
}
const pstNum = (v) => parseFloat(String(v == null ? 0 : v).replace(',', '.')) || 0;
function olderThan(a, b) {
  const ta = tseMs(a), tb = tseMs(b);
  return ta && tb && ta < tb && pstNum(a.s.pst) <= pstNum(b.s.pst);
}

function setStatus(ok, err) {
  status.checks++;
  if (ok) { status.lastOk = Date.now(); status.lastErr = ''; }
  else status.lastErr = String(err && err.message || err);
}
// "ok" = conseguiu falar com o TSE nos últimos 5s; se não, as páginas passam a buscar direto no TSE
const publicStatus = () => ({ ok: Date.now() - status.lastOk < 5000, lastOk: status.lastOk, now: Date.now(),
  viewers: watching.size, total: seen.size, peak, peakAt, since: status.startedAt, torcida: torcidaStatus() });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function nationalLoop() {
  let fails = 0;
  for (;;) {
    try {
      if (!election) election = await discover();
      await refresh('br');
      setStatus(true); fails = 0;
    } catch (e) {
      setStatus(false, e); fails++;
      if (fails % 20 === 1) console.error('[br]', e.message || e);
    }
    await sleep(fails ? Math.min(3000, 250 * 2 ** Math.min(fails, 4)) : POLL_MS);
  }
}

async function statesLoop() {
  for (;;) {
    if (election) await Promise.all(UFS.map(uf => refresh(uf).catch(() => false)));
    await sleep(STATES_MS);
  }
}

async function firstRoundLoop() {
  while (!election) await sleep(500);
  for (;;) {
    {
      const cd1 = String(Number(election.cd) - 1);
      await Promise.all(['br', ...UFS].map(async uf => {
        if (first[uf]) return;
        try { const j = await get(fileUrl(cd1, uf)); if (j) first[uf] = slim(j); } catch {}
      }));
      if (Object.keys(first).length >= 20) { broadcast('first', first); return; }
    }
    await sleep(60000);
  }
}

// ---------- transmissão ----------
function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => broadcast('status', publicStatus()), 1000);

// ---------- torcida ao vivo ----------
// Cada pessoa manda reações (só emojis, sem texto) para um dos lados. O servidor junta tudo a cada 250ms
// e transmite um pacote só, então funciona igual com 10 ou 10.000 pessoas.
const EMOJIS = 6;
const SIDES = ['a', 'b'];
const pending = { a: new Array(EMOJIS).fill(0), b: new Array(EMOJIS).fill(0) };
let pendingAny = false;
const torcida = { a: 0, b: 0 };                 // total desde que o servidor ligou
const perSecond = new Map();                    // segundo -> { a, b }, para a janela do último minuto
const limits = new Map();                       // limite de envio por pessoa e por IP

function allow(key, n, rate, burst) {
  const now = Date.now();
  let l = limits.get(key);
  if (!l) { l = { tokens: burst, at: now }; limits.set(key, l); }
  l.tokens = Math.min(burst, l.tokens + (now - l.at) / 1000 * rate);
  l.at = now;
  const ok = Math.max(0, Math.min(n, Math.floor(l.tokens)));
  l.tokens -= ok;
  return ok;
}
setInterval(() => { const now = Date.now(); for (const [k, l] of limits) if (now - l.at > 60000) limits.delete(k); }, 30000);

function lastMinute() {
  const sec = Math.floor(Date.now() / 1000), r = { a: 0, b: 0 };
  for (const [t, v] of perSecond) {
    if (t <= sec - 60) perSecond.delete(t);
    else { r.a += v.a; r.b += v.b; }
  }
  return r;
}
const torcidaStatus = () => { const m = lastMinute(); return { ta: torcida.a, tb: torcida.b, ma: m.a, mb: m.b }; };

function react(req, res, url) {
  const side = url.searchParams.get('s');
  const raw = url.searchParams.get('v') || '';
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!SIDES.includes(side)) { res.writeHead(400); return res.end(); }
  // c = "emoji:quantidade,emoji:quantidade" (o navegador junta os toques de ~300ms num envio só)
  let want = 0;
  const asks = String(url.searchParams.get('c') || '').split(',').slice(0, EMOJIS).map(x => {
    const [e, n] = x.split(':').map(Number);
    const ok = Number.isInteger(e) && e >= 0 && e < EMOJIS && Number.isInteger(n) && n > 0;
    if (ok) want += Math.min(n, 30);
    return ok ? [e, Math.min(n, 30)] : null;
  }).filter(Boolean);
  let budget = allow('v:' + (/^[a-z0-9]{8,40}$/i.test(raw) ? raw : ip), want, 8, 24);
  // limite por IP alto: no celular, muita gente diferente sai pelo mesmo IP da operadora
  budget = allow('i:' + ip, budget, 400, 1200);
  let used = 0;
  for (const [e, n] of asks) {
    const k = Math.min(n, budget - used);
    if (k <= 0) break;
    pending[side][e] += k; used += k;
  }
  if (used) {
    pendingAny = true;
    torcida[side] += used;
    const sec = Math.floor(Date.now() / 1000), b = perSecond.get(sec) || { a: 0, b: 0 };
    b[side] += used; perSecond.set(sec, b);
  }
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
}

setInterval(() => {
  if (!pendingAny) return;
  broadcast('react', { a: pending.a, b: pending.b, ...torcidaStatus() });
  pending.a.fill(0); pending.b.fill(0); pendingAny = false;
}, 250);

function stream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
  });
  res.write('retry: 2000\n\n');
  const raw = new URL(req.url, 'http://x').searchParams.get('v') || '';
  const vid = /^[a-z0-9]{8,40}$/i.test(raw) ? raw : 'anon-' + Math.random().toString(36).slice(2);
  watching.set(vid, (watching.get(vid) || 0) + 1);
  if (seen.size < 5e6) seen.add(vid);
  if (watching.size > peak) { peak = watching.size; peakAt = Date.now(); }
  send(res, 'hello', { election, status: publicStatus(), files, first: Object.keys(first).length >= 20 ? first : null });
  clients.add(res);
  req.on('close', () => {
    clients.delete(res);
    const n = (watching.get(vid) || 1) - 1;
    if (n > 0) watching.set(vid, n); else watching.delete(vid);
  });
}

// ---------- arquivos estáticos ----------
const ROOT = __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const cache = {};
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || /server\.js$|package\.json$|\/\./.test(file)) return notFound(res);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const c = cache[file];
    const body = c && c.mtime === st.mtimeMs ? c : (cache[file] = { mtime: st.mtimeMs, raw: fs.readFileSync(file), gz: null });
    if (!body.gz) body.gz = zlib.gzipSync(body.raw);
    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
    res.end(gzip ? body.gz : body.raw);
  });
}
function notFound(res) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('não encontrado'); }

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/api/stream') return stream(req, res);
  if (pathname === '/api/react' && req.method === 'POST') return react(req, res, new URL(req.url, 'http://x'));
  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ...publicStatus(), lastErr: status.lastErr, firstRound: Object.keys(first).length, election, clients: clients.size, checks: status.checks, files: Object.keys(files).length }));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, pathname);
}).listen(PORT, () => console.log(`Apuração ao vivo em http://localhost:${PORT}`));

nationalLoop();
statesLoop();
firstRoundLoop();
