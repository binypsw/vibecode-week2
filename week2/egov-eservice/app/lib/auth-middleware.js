'use strict';
// Session + RBAC กลาง (CONTRACT 0.6 · 1 · 5 · 6)
//
//   sessionMiddleware        — อ่าน cookie "sid" → req.user = { id, username, name, role, dept, registered, sid } หรือ null
//   createSession(res, user) — สร้าง session ใหม่ (role/dept ณ ตอนล็อกอิน) + ตั้ง cookie HttpOnly · คืน sid
//   destroySession(req, res) — ลบ session + ล้าง cookie
//   requireLogin             — ไม่ล็อกอิน: หน้า → redirect /login · API → 401 UNAUTHENTICATED
//   requireRole('officer','head')            — บทบาทไม่ตรง: หน้า → 403 forbidden-msg · API → 403 FORBIDDEN
//   requireRole(['citizen'], { allowUnregistered: true })  — ใช้กับ /register (ประชาชนที่ยังไม่ลงทะเบียน)
//     ประชาชนที่ยังไม่ลงทะเบียน (users.registered = 0) เข้าได้แค่ route ที่ allowUnregistered
//     (หน้า → redirect /register · API → 403 FORBIDDEN)
//   apiError(res, 'ALREADY_CLAIMED', { extra… }) — ตอบ {"code","message",…extra} ด้วย HTTP ตามตาราง ERRORS (CONTRACT 5)
//   landingFor(user)         — หน้าตั้งต้นตามบทบาท (ประชาชนที่ยังไม่ลงทะเบียน → /register)

const { db } = require('../db');
const clock = require('./clock');
const pii = require('./crypto');
const { ERRORS, LANDING } = require('../db/constants');

const COOKIE = 'sid';

function isApi(req) {
  return (req.originalUrl || req.url || '').startsWith('/api/');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

const qSession = db.prepare(`SELECT s.sid, s.role AS s_role, s.dept AS s_dept, u.id, u.username, u.name, u.registered
  FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid = ?`);

function sessionMiddleware(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.user = null;
  const sid = req.cookies[COOKIE];
  if (sid) {
    const r = qSession.get(sid);
    if (r) {
      req.user = { id: r.id, username: r.username, name: r.name, role: r.s_role, dept: r.s_dept, registered: !!r.registered, sid: r.sid };
    } else {
      res.clearCookie(COOKIE, { path: '/' }); // session ถูกล้าง (เช่น reset) → ทิ้ง cookie เก่า
    }
  }
  next();
}

/** user = แถว users (หรือ {id, role, dept}) · คืน sid */
function createSession(res, user) {
  const sid = pii.randomToken(32);
  db.prepare('INSERT INTO sessions (sid, user_id, role, dept, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sid, user.id, user.role, user.dept || null, clock.nowISO());
  res.cookie(COOKIE, sid, { httpOnly: true, sameSite: 'lax', path: '/' });
  return sid;
}

function destroySession(req, res) {
  const sid = (req.cookies && req.cookies[COOKIE]) || (req.user && req.user.sid);
  if (sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  res.clearCookie(COOKIE, { path: '/' });
  req.user = null;
}

function apiError(res, code, extra = {}, statusOverride) {
  const def = ERRORS[code] || [500, code];
  return res.status(statusOverride || def[0]).json({ code, message: def[1], ...extra });
}

function landingFor(user) {
  if (!user) return '/login';
  if (user.role === 'citizen' && !user.registered) return '/register';
  return LANDING[user.role] || '/login';
}

function denyUnauthenticated(req, res) {
  if (isApi(req)) return apiError(res, 'UNAUTHENTICATED');
  return res.redirect(302, '/login');
}
function denyForbidden(req, res) {
  if (isApi(req)) return apiError(res, 'FORBIDDEN');
  return require('../views/layout').forbidden(req, res);
}

function requireLogin(req, res, next) {
  if (!req.user) return denyUnauthenticated(req, res);
  if (req.user.role === 'citizen' && !req.user.registered) {
    if (isApi(req)) return apiError(res, 'FORBIDDEN');
    return res.redirect(302, '/register');
  }
  return next();
}

function requireRole(...args) {
  let roles;
  let opts = {};
  if (Array.isArray(args[0])) {
    roles = args[0];
    opts = args[1] || {};
  } else {
    roles = args;
  }
  const allowed = new Set(roles.flat());
  return function rbac(req, res, next) {
    const u = req.user;
    if (!u) return denyUnauthenticated(req, res);
    if (!allowed.has(u.role)) return denyForbidden(req, res);
    if (u.role === 'citizen' && !u.registered && !opts.allowUnregistered) {
      if (isApi(req)) return apiError(res, 'FORBIDDEN');
      return res.redirect(302, '/register');
    }
    return next();
  };
}

/** ตรวจในโค้ด (ไม่ใช่ middleware) */
function hasRole(req, ...roles) {
  return !!(req.user && roles.flat().includes(req.user.role));
}

module.exports = {
  COOKIE, isApi, parseCookies, sessionMiddleware, createSession, destroySession,
  apiError, landingFor, requireLogin, requireRole, hasRole, denyForbidden, denyUnauthenticated,
};
