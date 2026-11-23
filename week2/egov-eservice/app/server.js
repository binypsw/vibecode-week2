'use strict';
// e-Service กลาง เทศบาลนครก็อตแทม (สมมติ) · Node 20 + Express 4 + SQLite (better-sqlite3)
//
// ลำดับ middleware:
//   1. body parser (JSON/urlencoded ≤ 10 MB · multipart ใช้ ctx.upload ซึ่งรับไฟล์ ≤ 8 MB → ไฟล์ 5,242,881 ไบต์ได้ 400 FILE_TOO_LARGE ไม่ใช่ 413)
//   2. session (req.user)
//   3. /api/test/* → 404 ถ้าไม่ได้ตั้ง TEST_MODE=1 (ครอบ hook ของทุกบล็อก)
//   4. hook ทุก request (ยกเว้น /api/test/* และ static): ยกเลิกอัตโนมัติ (order 10) → แจ้งเตือน SLA (order 20) · lib/hooks.js
//   5. route แกนกลาง: GET /api/health · POST /api/test/reset · GET/PUT /api/test/clock · GET / · /logout
//   6. โหลด routes/*.js อัตโนมัติ (เรียงตามชื่อไฟล์) · แต่ละไฟล์ export function (app, ctx)
//   7. 404 + error handler
//
// ctx ที่ส่งให้ routes: { app, db, dbm, tx, clock, bug, isBug, crypto, hooks, audit, auth, requireRole, requireLogin,
//   apiError, views, render, C (ค่าคงที่), upload (multer), wrap (async handler), config }

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const dbm = require('./db');
const C = require('./db/constants');
const clock = require('./lib/clock');
const bug = require('./lib/bug');
const pii = require('./lib/crypto');
const hooks = require('./lib/hooks');
const audit = require('./lib/audit');
const auth = require('./lib/auth-middleware');
const views = require('./views/layout');

const TEST_MODE = clock.TEST_MODE;
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const BODY_LIMIT = '10mb'; // ≥ 6 MB (CONTRACT 0.10)

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

/** multer แบบเก็บในหน่วยความจำ · ขนาดเพดาน 8 MB (สูงกว่า 5 MB เพื่อให้ route ตรวจเองแล้วตอบ FILE_TOO_LARGE) */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 10, fields: 50, fieldSize: 1024 * 1024 },
});
// multer อ่านชื่อไฟล์เป็น latin1 → แปลงเป็น UTF-8 ให้ชื่อไฟล์ภาษาไทยถูกต้อง
function fixName(f) {
  if (f && f.originalname && !f._nameFixed) {
    const decoded = Buffer.from(f.originalname, 'latin1').toString('utf8');
    if (!decoded.includes('�')) f.originalname = decoded;
    f._nameFixed = true;
  }
  return f;
}
for (const m of ['single', 'array', 'fields', 'any']) {
  const orig = upload[m].bind(upload);
  upload[m] = (...args) => {
    const mw = orig(...args);
    return (req, res, next) => mw(req, res, (err) => {
      if (req.file) fixName(req.file);
      if (Array.isArray(req.files)) req.files.forEach(fixName);
      else if (req.files) Object.values(req.files).flat().forEach(fixName);
      next(err);
    });
  };
}

/** ห่อ async handler ให้ Express 4 ส่ง error เข้า error handler */
const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

const ctx = {
  app,
  db: dbm.db,
  dbm,
  tx: dbm.tx,
  clock,
  bug,
  isBug: bug.isBug,
  crypto: pii,
  hooks,
  audit,
  auth,
  requireRole: auth.requireRole,
  requireLogin: auth.requireLogin,
  apiError: auth.apiError,
  views,
  render: views.render,
  C,
  upload,
  wrap,
  config: { TEST_MODE, PORT, BASE_URL, DB_PATH: dbm.DB_PATH, BUGS: bug.list() },
};

// ---------- 1–2. parser + session ----------
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use(auth.sessionMiddleware);

if (process.env.LOG_REQUESTS === '1') {
  // log แค่ method + path + status (ห้าม log body/ข้อมูลส่วนบุคคล · TC-NFR-04)
  app.use((req, res, next) => {
    const t = Date.now();
    res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`));
    next();
  });
}

// ---------- 3. ปิด test hook เมื่อไม่ได้ตั้ง TEST_MODE=1 ----------
app.use('/api/test', (req, res, next) => {
  if (!TEST_MODE) return res.status(404).json({ code: 'NOT_FOUND', message: 'Not Found' });
  return next();
});

// ---------- 4. hook ทุก request (CONTRACT 0.7 · A-30 · A-46) ----------
const SKIP_HOOKS = /^\/(api\/test(\/|$)|static\/|favicon\.ico$)/;
app.use((req, res, next) => {
  if (!SKIP_HOOKS.test(req.path)) {
    try {
      dbm.tx(() => hooks.runRequestHooks(ctx, req));
    } catch (err) {
      console.error('[hooks] transaction failed:', err);
    }
  }
  next();
});

// ---------- 5. route แกนกลาง ----------
app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));

/** ล้างทุกอย่าง + seed ใหม่ + นาฬิกาค่าเริ่มต้น + ล้าง session ทุกคน (CONTRACT 0.9 · 8) */
function resetAll() {
  dbm.wipeAndSeed(); // ล้าง sessions otp_state notifications audit ไฟล์อัปโหลด ฯลฯ แล้ว seed ตาม TEST-DATA
  const now = clock.reset();
  hooks.runResetHooks(ctx);
  return now;
}
app.post('/api/test/reset', (req, res) => {
  const now = resetAll();
  res.clearCookie(auth.COOKIE, { path: '/' });
  res.json({ ok: true, now });
});
app.get('/api/test/clock', (req, res) => res.json({ now: clock.nowISO() }));
app.put('/api/test/clock', (req, res) => {
  const raw = req.body && req.body.now;
  if (clock.parseStrictISO(raw) == null) return auth.apiError(res, 'INVALID_TIME');
  return res.json({ now: clock.set(raw) });
});

app.get('/', (req, res) => res.redirect(302, auth.landingFor(req.user)));
const logout = (req, res) => {
  auth.destroySession(req, res);
  res.redirect(303, '/login');
};
app.post('/logout', logout);
app.get('/logout', logout);

const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) app.use('/static', express.static(PUBLIC_DIR, { maxAge: 0 }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ---------- 6. โหลด routes/*.js อัตโนมัติ ----------
const ROUTES_DIR = process.env.ROUTES_DIR ? path.resolve(process.env.ROUTES_DIR) : path.join(__dirname, 'routes');
const loaded = [];
const failed = [];
if (fs.existsSync(ROUTES_DIR)) {
  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js')).sort()) {
    try {
      const mod = require(path.join(ROUTES_DIR, file));
      const fn = typeof mod === 'function' ? mod : mod && (mod.register || mod.default);
      if (typeof fn !== 'function') throw new Error('ต้อง export function (app, ctx)');
      fn(app, ctx);
      loaded.push(file);
    } catch (err) {
      failed.push(file);
      console.error(`[routes] โหลด ${file} ไม่สำเร็จ:`, err && err.stack ? err.stack : err);
      if (process.env.STRICT_ROUTES === '1') throw err;
    }
  }
}
ctx.config.routes = { loaded, failed };

// ---------- 7. 404 + error ----------
app.use((req, res) => {
  if (auth.isApi(req)) return auth.apiError(res, 'NOT_FOUND');
  return views.notFound(req, res);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return undefined;
  const api = auth.isApi(req);
  let code = null;
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.type === 'entity.too.large')) code = 'FILE_TOO_LARGE';
  else if (err && err.code === 'LIMIT_FILE_COUNT') code = 'FILE_COUNT';
  else if (err && (err.type === 'entity.parse.failed' || (typeof err.code === 'string' && err.code.startsWith('LIMIT_')))) code = 'BAD_REQUEST';
  if (code) {
    if (api || req.is('multipart/form-data') || req.is('json')) return auth.apiError(res, code);
    return views.render(req, res, { status: C.ERRORS[code][0], error: C.ERRORS[code][1], title: 'ผิดพลาด', body: '' });
  }
  console.error('[error]', req.method, req.path, err && err.stack ? err.stack : err);
  if (api) return res.status(500).json({ code: 'INTERNAL', message: 'เกิดข้อผิดพลาดภายในระบบ' });
  return views.render(req, res, { status: 500, title: 'ผิดพลาด', error: 'เกิดข้อผิดพลาดภายในระบบ', body: '' });
});

// ---------- start ----------
if (TEST_MODE && dbm.FRESH) clock.reset();

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`[egov] listening on :${PORT} · TEST_MODE=${TEST_MODE ? 1 : 0} · BUG_MODE=${bug.list().join(',') || '-'} · DB_PATH=${dbm.DB_PATH}`);
    console.log(`[egov] clock=${clock.nowISO()} · routes loaded=[${loaded.join(', ')}]${failed.length ? ' FAILED=[' + failed.join(', ') + ']' : ''} · hooks=${JSON.stringify(hooks.list())}`);
  });
  const stop = () => server.close(() => { try { dbm.db.close(); } catch (_) { /* ignore */ } process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { app, ctx, resetAll };
