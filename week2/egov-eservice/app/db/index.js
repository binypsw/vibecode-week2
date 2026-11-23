'use strict';
// การเชื่อมต่อ SQLite (better-sqlite3 แบบ synchronous) + ตัวช่วยที่ทุกบล็อกใช้
//   const { db, tx, nextSeq, getService, holidaySet, ... } = require('../db');
// better-sqlite3 เป็น synchronous: handler ที่ตรวจ+อัปเดตในฟังก์ชันเดียว (ไม่มี await คั่น) = atomic
// ภายในโปรเซสเดียว (ใช้กับ "รับเรื่องพร้อมกัน" และ "เลขคำขอไม่ซ้ำ") · ห่อหลายคำสั่งด้วย tx(() => …)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const clock = require('../lib/clock');
const pii = require('../lib/crypto');
const { DDL, DATA_TABLES } = require('./schema');

const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'egov.db'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
// DELETE = ไฟล์ DB ไฟล์เดียว อ่าน/inspect จาก host ผ่าน bind mount ได้ทุกระบบ (TC-NFR-04) · ตั้ง SQLITE_JOURNAL=WAL ได้
const JOURNAL = /^(DELETE|WAL|TRUNCATE|PERSIST|MEMORY)$/i.test(process.env.SQLITE_JOURNAL || '') ? process.env.SQLITE_JOURNAL.toUpperCase() : 'DELETE';
db.pragma(`journal_mode = ${JOURNAL}`);
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

const SCHEMA_VERSION = crypto.createHash('sha256').update(DDL).digest('hex').slice(0, 16);

function tx(fn) {
  return db.transaction(fn)();
}

// ---------- meta ----------
function getMeta(key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setMeta(key, value) {
  if (value == null) db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  else db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// ---------- schema ----------
function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
function dropAll() {
  const objs = db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','trigger','index','view')").all();
  db.exec('PRAGMA foreign_keys = OFF');
  tx(() => {
    for (const o of objs.filter((x) => x.type === 'trigger')) db.exec(`DROP TRIGGER IF EXISTS "${o.name}"`);
    for (const o of objs.filter((x) => x.type === 'view')) db.exec(`DROP VIEW IF EXISTS "${o.name}"`);
    for (const o of objs.filter((x) => x.type === 'table')) db.exec(`DROP TABLE IF EXISTS "${o.name}"`);
  });
}
/** สร้าง schema ถ้ายังไม่มี · ถ้า DDL เปลี่ยน → ลบแล้วสร้างใหม่ · คืน true ถ้าเป็นฐานข้อมูลใหม่ (ต้อง seed) */
function ensureSchema() {
  let fresh = !tableExists('meta') || !tableExists('users');
  if (!fresh && getMeta('schema_version') !== SCHEMA_VERSION) {
    console.log(`[db] schema changed → rebuild ${DB_PATH}`);
    dropAll();
    fresh = true;
  }
  db.exec(DDL);
  setMeta('schema_version', SCHEMA_VERSION);
  if (!fresh) fresh = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  return fresh;
}

/** ล้างข้อมูลทุกตาราง (รวม audit) แล้ว seed ใหม่ตาม TEST-DATA · ไม่แตะนาฬิกา (server.js เป็นผู้ reset นาฬิกา) */
function wipeAndSeed() {
  const seed = require('./seed');
  tx(() => {
    setMeta('allow_audit_wipe', '1');
    for (const t of DATA_TABLES) db.prepare(`DELETE FROM ${t}`).run();
    if (tableExists('sqlite_sequence')) db.prepare('DELETE FROM sqlite_sequence').run();
    setMeta('allow_audit_wipe', null);
    seed.run(module.exports);
  });
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* ignore */ }
}

// ---------- ตัวนับ ----------
/** เพิ่มตัวนับแล้วคืนค่าใหม่ (เรียกใน tx เดียวกับการ insert เพื่อไม่ให้เลขซ้ำ) เช่น nextSeq('case:2569') → 31 */
function nextSeq(name) {
  db.prepare('INSERT INTO counters(name, value) VALUES(?, 0) ON CONFLICT(name) DO NOTHING').run(name);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(name);
  return db.prepare('SELECT value FROM counters WHERE name = ?').get(name).value;
}
function peekSeq(name) {
  const r = db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
  return r ? r.value : 0;
}
function setSeq(name, value) {
  db.prepare('INSERT INTO counters(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value);
}
const pad = (n, w) => String(n).padStart(w, '0');
/** รูปแบบเลขเอกสารต่าง ๆ */
const fmtNo = {
  caseNo: (yearBE, seq) => `EG-${yearBE}-${pad(seq, 6)}`,
  receiptNo: (yearBE, seq) => `RC-${yearBE}-${pad(seq, 6)}`,
  docNo: (yearBE, seq) => `DOC-${yearBE}-${pad(seq, 6)}`,
  draftId: (seq) => `DR-${pad(seq, 4)}`,
  paymentRef: (seq) => `PP-${pad(seq, 4)}`,
  fileId: (seq) => `F-${pad(seq, 6)}`,
};
/** ออกเลขถัดไปแบบสำเร็จรูป: next.caseNo(clock.nowISO()) → {caseNo, yearBE, seq} */
const next = {
  caseNo(atISO) {
    const yearBE = clock.beYear(atISO || clock.nowISO());
    const seq = nextSeq(`case:${yearBE}`);
    return { caseNo: fmtNo.caseNo(yearBE, seq), yearBE, seq };
  },
  receiptNo(atISO) {
    const yearBE = clock.beYear(atISO || clock.nowISO());
    const seq = nextSeq(`receipt:${yearBE}`);
    return { receiptNo: fmtNo.receiptNo(yearBE, seq), yearBE, seq };
  },
  docNo(atISO) {
    const yearBE = clock.beYear(atISO || clock.nowISO());
    const seq = nextSeq(`doc:${yearBE}`);
    return { docNo: fmtNo.docNo(yearBE, seq), yearBE, seq };
  },
  draftId: () => fmtNo.draftId(nextSeq('draft')),
  paymentRef: () => fmtNo.paymentRef(nextSeq('payment')),
  fileId: () => fmtNo.fileId(nextSeq('file')),
};

// ---------- บริการ / วันหยุด ----------
function mapService(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, fee: r.fee, feePerSqm: r.fee_per_sqm, sla: r.sla_days,
    route: JSON.parse(r.route), approver: r.approver,
  };
}
/** บริการจากตาราง (ค่าปัจจุบันที่ admin แก้แล้ว) → {id,name,fee,feePerSqm,sla,route,approver} */
function getService(id) {
  return mapService(db.prepare('SELECT * FROM services WHERE id = ?').get(id));
}
function listServices() {
  return db.prepare('SELECT * FROM services ORDER BY sort, id').all().map(mapService);
}
/** Set ของวันหยุด "YYYY-MM-DD" (อ่านใหม่ทุกครั้ง เพราะ admin แก้ได้) */
function holidaySet() {
  return new Set(db.prepare('SELECT date FROM holidays').all().map((r) => r.date));
}
function listHolidays() {
  return db.prepare('SELECT date, name FROM holidays ORDER BY date').all();
}

// ---------- ผู้ใช้ ----------
function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}
function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}
function getUserByIdNo(idNo) {
  return db.prepare('SELECT * FROM users WHERE id_no_hash = ?').get(pii.blindIndex(idNo)) || null;
}
/** ถอดรหัสเลขบัตร/เบอร์ของแถว users (ใช้เฉพาะตอนต้องแสดงให้เจ้าของ/unmask) */
function userIdNo(user) {
  return user && user.id_no_enc ? pii.decrypt(user.id_no_enc) : null;
}
function userMobile(user) {
  return user && user.mobile_enc ? pii.decrypt(user.mobile_enc) : null;
}
/** ชื่อแสดงของเจ้าหน้าที่จาก username (เช่น off.reg1 → เจ้าหน้าที่ทะเบียน 1) */
function staffName(username) {
  if (!username) return null;
  const u = getUserByUsername(username);
  return u ? u.name : username;
}

// ---------- คำขอ ----------
function getCase(caseNo) {
  return db.prepare('SELECT * FROM cases WHERE case_no = ?').get(caseNo) || null;
}

module.exports = {
  db, DB_PATH, SCHEMA_VERSION, tx,
  getMeta, setMeta, ensureSchema, wipeAndSeed, dropAll,
  nextSeq, peekSeq, setSeq, fmtNo, next,
  getService, listServices, holidaySet, listHolidays,
  getUserById, getUserByUsername, getUserByIdNo, userIdNo, userMobile, staffName,
  getCase,
  FRESH: false,
};

// เตรียม schema ทันทีที่ require (โมดูลอื่น prepare statement ตอนโหลดได้เลย) · DB ใหม่ → seed
module.exports.FRESH = ensureSchema();
if (module.exports.FRESH) wipeAndSeed();
// นาฬิกาทดสอบ: เก็บค่าใน meta.clock (คงอยู่ข้ามการ restart) · reset จะตั้งกลับค่าเริ่มต้น
clock._restore(getMeta('clock'));
clock._setPersist((iso) => setMeta('clock', iso));
