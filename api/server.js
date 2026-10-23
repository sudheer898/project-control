'use strict';
/*
 * Project Control on Vercel: one serverless function handles login, the app page,
 * project data, saving and attachments. Data lives in Upstash Redis (Vercel Marketplace).
 *
 * Environment variables
 *   DASH_EDITOR_PASSWORD   required. Password for people who can edit and save.
 *   DASH_VIEWER_PASSWORD   optional. Password for read-only team members.
 *   DASH_SECRET            recommended. Long random string used to sign login sessions.
 *   KV_REST_API_URL / KV_REST_API_TOKEN            added automatically when you connect
 *   (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)   Upstash Redis to the project.
 *   DASH_SESSION_HOURS     optional, default 12.
 * No npm packages are needed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.cwd();
const EDITOR_PW = process.env.DASH_EDITOR_PASSWORD || '';
const VIEWER_PW = process.env.DASH_VIEWER_PASSWORD || '';
const SECRET = process.env.DASH_SECRET || crypto.createHash('sha256').update('pc-session|' + EDITOR_PW + '|' + VIEWER_PW).digest('hex');
const SESSION_HOURS = Number(process.env.DASH_SESSION_HOURS) || 12;
const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const HAS_KV = !!(KV_URL && KV_TOKEN);
const COOKIE = 'pc_session';
const DATA_PATH = /^data\/(index\.json|project\.json|projects\/p[a-z0-9]{3,24}\.json)$/;
const BLOB_ID = /^[a-f0-9]{32}$/;
const MAX_BLOB = 4 * 1024 * 1024; // Vercel request bodies are limited to 4.5 MB
const UPLOAD_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/csv', 'text/plain', 'text/markdown', 'application/json']);
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};

/* ---------------- storage (Upstash Redis REST API) ---------------- */
async function kv(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({ error: 'Bad response from storage' }));
  if (!r.ok || j.error) throw new Error('Storage: ' + (j.error || r.status));
  return j.result;
}
async function kvTx(cmds) {
  const r = await fetch(KV_URL + '/multi-exec', { method: 'POST', headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error('Storage transaction failed: ' + ((j && j.error) || r.status));
  const bad = j.find(x => x && x.error); if (bad) throw new Error('Storage: ' + bad.error);
  return j.map(x => x.result);
}
function seedFiles() {
  const base = path.join(ROOT, 'seed'), out = {};
  const walk = dir => { if (!fs.existsSync(dir)) return; for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) walk(p); else out[path.relative(base, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8'); } };
  walk(path.join(base, 'data'));
  return out;
}
let seeded = false;
async function ensureSeed() {
  if (seeded || !HAS_KV) return;
  if (!(await kv(['EXISTS', 'pc:seeded']))) {
    const cmds = Object.entries(seedFiles()).map(([p, c]) => ['SET', 'pc:file:' + p, c, 'NX']);
    cmds.push(['SET', 'pc:seeded', '1']);
    await kvTx(cmds);
  }
  seeded = true;
}
async function readData(rel) {
  if (HAS_KV) { await ensureSeed(); return kv(['GET', 'pc:file:' + rel]); }
  const p = path.join(ROOT, 'seed', ...rel.split('/'));
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
async function getRev() { return HAS_KV ? Number(await kv(['GET', 'pc:rev'])) || 0 : 0; }

/* ---------------- sessions ---------------- */
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
function makeSession(role) {
  const payload = Buffer.from(JSON.stringify({ r: role, e: Math.floor(Date.now() / 1000 + SESSION_HOURS * 3600) })).toString('base64url');
  return payload + '.' + sign(payload);
}
function readSession(req) {
  const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  if (!m) return null;
  const token = m.slice(COOKIE.length + 1), i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), sig = token.slice(i + 1), want = sign(payload);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const d = JSON.parse(Buffer.from(payload, 'base64url').toString()); return d.e > Date.now() / 1000 && (d.r === 'editor' || d.r === 'viewer') ? d.r : null; } catch { return null; }
}
const same = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

/* ---------------- request / response helpers ---------------- */
async function readBody(req, limit) {
  if (req.body !== undefined && req.body !== null) {            // Vercel's Node helpers already parsed it
    const b = req.body;
    if (Buffer.isBuffer(b)) return { buf: b };
    if (typeof b === 'string') return { buf: Buffer.from(b) };
    return { obj: b };
  }
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) return { tooLarge: true }; chunks.push(c); }
  return { buf: Buffer.concat(chunks) };
}
function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}, cache = 'no-store') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  res.statusCode = status;
  for (const [k, v] of Object.entries({ 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': cache, ...SEC_HEADERS, ...extra })) res.setHeader(k, v);
  res.end(buf);
}
const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
const redirect = (res, to, extra = {}) => send(res, 303, '', 'text/plain', { Location: to, ...extra });
const isHttps = req => (req.headers['x-forwarded-proto'] || '').includes('https');
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();

const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Project Control</title>
<style>
:root{--bg:#edf1f7;--card:#fff;--fg:#13203a;--muted:#5a6a84;--line:#dfe6f0;--accent:#1c5fd0;--nav:#0a2959;--bad:#d23a3a}
@media (prefers-color-scheme:dark){:root{--bg:#0b1322;--card:#121d32;--fg:#e6ecf6;--muted:#9aa8c0;--line:#25334e;--accent:#5a92ef;--bad:#ef6464;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 "Segoe UI",system-ui,sans-serif;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;width:min(380px,100%);box-shadow:0 8px 30px rgba(0,0,0,.08)}
.mono{width:48px;height:48px;border-radius:50%;background:var(--nav);color:#fff;display:grid;place-items:center;font-weight:700;margin-bottom:14px}
h1{font-size:21px;margin:0 0 4px}p{margin:0 0 18px;color:var(--muted);font-size:13.5px}
label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:6px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--fg);font:inherit}
input:focus{outline:2px solid var(--accent);border-color:transparent}
button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:9px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:var(--bad);font-size:13px;margin-top:12px;min-height:1em}
</style></head><body><form class="card" method="post" action="/login">
<div class="mono">PC</div><h1>Project Control</h1><p>Sign in · Connexion · साइन इन</p>
<label for="pw">Password / Mot de passe / पासवर्ड</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button><div class="err">__ERR__</div></form></body></html>`;
const loginPage = (res, status, err) => send(res, status, LOGIN_HTML.replace('__ERR__', err || ''), 'text/html; charset=utf-8');

let APP_HTML = null;
const appHtml = () => APP_HTML || (APP_HTML = fs.readFileSync(path.join(ROOT, 'app', 'index.html')));

/* ---------------- handler ---------------- */
module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const method = req.method || 'GET';
    if (p.includes('..') || p.includes('\0')) return send(res, 400, 'Bad path');
    if (p === '/healthz') return json(res, 200, { ok: true, storage: HAS_KV });

    if (p === '/login') {
      if (!EDITOR_PW) return send(res, 503, 'Set the DASH_EDITOR_PASSWORD environment variable in Vercel, then redeploy.');
      if (method === 'GET') return loginPage(res, 200);
      if (method !== 'POST') return send(res, 405, '');
      const ip = clientIp(req), failKey = 'pc:fail:' + ip;
      if (HAS_KV && Number(await kv(['GET', failKey])) >= 10) return loginPage(res, 429, 'Too many attempts. Wait 15 minutes.');
      const body = await readBody(req, 8192);
      const pw = body.obj ? String(body.obj.password || '') : (new URLSearchParams((body.buf || Buffer.alloc(0)).toString()).get('password') || '');
      const role = same(pw, EDITOR_PW) ? 'editor' : (VIEWER_PW && same(pw, VIEWER_PW) ? 'viewer' : null);
      if (!role) {
        if (HAS_KV) await kvTx([['INCR', failKey], ['EXPIRE', failKey, '900']]);
        await new Promise(r => setTimeout(r, 600));
        return loginPage(res, 401, 'Wrong password. Mot de passe incorrect. गलत पासवर्ड।');
      }
      const cookie = `${COOKIE}=${makeSession(role)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_HOURS * 3600)}${isHttps(req) ? '; Secure' : ''}`;
      return redirect(res, '/', { 'Set-Cookie': cookie });
    }
    if (p === '/logout') return redirect(res, '/login', { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });

    const role = readSession(req);
    if (!role) {
      if (p.startsWith('/api/') || p.startsWith('/data/') || p.startsWith('/_blob/')) return json(res, 401, { error: 'Sign in required' });
      return redirect(res, '/login');
    }

    if (p === '/api/me') return json(res, 200, { role, rev: await getRev(), storage: HAS_KV });

    if (p === '/api/save' || p === '/api/upload') {
      if (method !== 'POST') return json(res, 405, { error: 'POST only' });
      if (req.headers['x-requested-with'] !== 'ibpc') return json(res, 400, { error: 'Missing request header' });
      if (role !== 'editor') return json(res, 403, { error: 'Read-only account' });
      if (!HAS_KV) return json(res, 503, { error: 'Storage is not connected. Add Upstash Redis in the Vercel Storage tab and redeploy.' });
    }

    if (p === '/api/save') {
      const body = await readBody(req, 4.4 * 1024 * 1024);
      if (body.tooLarge) return json(res, 413, { error: 'Too large' });
      let reqObj;
      try { reqObj = body.obj || JSON.parse((body.buf || '').toString() || '{}'); } catch { return json(res, 400, { error: 'Invalid request' }); }
      const files = reqObj && reqObj.files;
      if (!files || typeof files !== 'object' || !Object.keys(files).length) return json(res, 400, { error: 'Invalid request' });
      await ensureSeed();
      const cur = await getRev();
      if (reqObj.baseRev != null && Number(reqObj.baseRev) !== cur) return json(res, 409, { error: 'Someone saved a newer version', rev: cur });
      const cmds = [];
      for (const [fp, content] of Object.entries(files)) {
        if (!DATA_PATH.test(fp)) return json(res, 400, { error: 'Path not allowed: ' + fp });
        if (content === null) { cmds.push(['DEL', 'pc:file:' + fp]); continue; }
        if (typeof content !== 'string') return json(res, 400, { error: fp + ' must be text' });
        try { JSON.parse(content); } catch { return json(res, 400, { error: fp + ' is not valid JSON' }); }
        cmds.push(['SET', 'pc:file:' + fp, content]);
      }
      cmds.push(['INCR', 'pc:rev']);
      const out = await kvTx(cmds);
      return json(res, 200, { ok: true, rev: Number(out[out.length - 1]) });
    }

    if (p === '/api/upload') {
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!UPLOAD_TYPES.has(ctype)) return json(res, 415, { error: 'File type not allowed', code: 'unsupported_type' });
      const body = await readBody(req, MAX_BLOB);
      if (body.tooLarge) return json(res, 413, { error: 'File larger than 4 MB', code: 'too_large' });
      const buf = body.buf || Buffer.from(JSON.stringify(body.obj));
      if (buf.length > MAX_BLOB) return json(res, 413, { error: 'File larger than 4 MB', code: 'too_large' });
      const id = crypto.randomBytes(16).toString('hex');
      await kvTx([['SET', 'pc:blob:' + id, buf.toString('base64')], ['SET', 'pc:blobtype:' + id, ctype]]);
      return json(res, 200, { id, url: '/_blob/' + id, sizeBytes: buf.length, contentType: ctype });
    }

    if (p.startsWith('/_blob/')) {
      const id = p.slice(7);
      if (!BLOB_ID.test(id) || !HAS_KV) return send(res, 404, 'Not found');
      const [data, type] = await Promise.all([kv(['GET', 'pc:blob:' + id]), kv(['GET', 'pc:blobtype:' + id])]);
      if (!data) return send(res, 404, 'Not found');
      return send(res, 200, Buffer.from(data, 'base64'), type || 'application/octet-stream', { 'Content-Disposition': 'attachment' }, 'private, max-age=3600');
    }

    if (p.startsWith('/data/')) {
      const rel = p.slice(1);
      if (!DATA_PATH.test(rel)) return send(res, 404, 'Not found');
      const content = await readData(rel);
      return content == null ? send(res, 404, 'Not found') : send(res, 200, content, 'application/json; charset=utf-8');
    }

    if (method !== 'GET' && method !== 'HEAD') return send(res, 405, '');
    if (p === '/' || p === '/index.html') return send(res, 200, appHtml(), 'text/html; charset=utf-8', {}, 'no-cache');
    return send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: 'Server error. Check the Vercel function logs.' });
  }
};
