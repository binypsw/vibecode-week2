'use strict';
// ไลบรารีวันทำการ + กำหนดเสร็จ (SLA) + ระดับเตือน (B05)
// ที่มา: REQUIREMENTS BR-12 BR-13 BR-14 · DECISIONS ข้อ 0 และ 8 · A-02 A-03 A-17 A-33 A-42 · CONTRACT 4.2
//
// - วันทำการ = จันทร์–ศุกร์ ที่ไม่อยู่ในตารางวันหยุด (A-02)
// - เวลาตัดรอบ 16:30:00 · ชำระตั้งแต่ 16:30:00 นับ D0 เป็นวันทำการถัดไป (A-03)
// - ทุกการคำนวณใช้เวลาไทย (Asia/Bangkok = UTC+07:00 คงที่) ผ่าน lib/clock.js เท่านั้น ไม่เรียก Date.now()/new Date() เอง
// - วันหยุด: ส่ง Set/Array ของ "YYYY-MM-DD" มาเองได้ (แนะนำเมื่อคำนวณหลายแถว) · ไม่ส่ง = อ่าน dbm.holidaySet() ใหม่ทุกครั้ง
//   (เพิ่ม/ลบวันหยุดมีผลทันทีกับการคำนวณครั้งถัดไป แต่ due_at ที่เก็บแล้วไม่ถูกคำนวณใหม่ · A-42)
//
// BUG_MODE (BUGS.md · ผ่าน lib/bug.js · เปลี่ยนเฉพาะจุดที่ระบุ):
//   B03 → isBusinessDay() ไม่สนตารางวันหยุด (ข้ามแค่เสาร์-อาทิตย์) — ฟังก์ชันเดียวนี้ใช้ทั้ง D0 กำหนดเสร็จ หยุดนับ และวันคงเหลือ
//   B04 → pauseDays() คืน 0 เสมอ (ไม่หยุดนับระหว่าง NEED_FIX) → extendDueAt() คืนกำหนดเดิม
//
// การใช้งาน (ฝั่ง route):
//   const sla = require('../lib/sla');
//   ตอนชำระ:   due_at = sla.dueAt(paidAtISO, ctx.dbm.getService(serviceId).sla)
//   ตอนส่งแก้: due_at = sla.extendDueAt(c.due_at, c.returned_at, ctx.clock.nowISO())
//   แสดงผล:    const level = sla.slaLevel(caseRow)   // 'normal' | 'near' | 'overdue' | 'paused' | 'closed'
//              หลายแถว: const hs = sla.holidays(); rows.map(r => sla.slaLevel(r, undefined, hs))

const clock = require('./clock');
const bug = require('./bug');
const { LEVEL_TH } = require('../db/constants');

/** เวลาตัดรอบ/เวลากำหนดเสร็จ */
const CUTOFF = { hh: 16, mm: 30, ss: 0 };
const CUTOFF_SEC = CUTOFF.hh * 3600 + CUTOFF.mm * 60 + CUTOFF.ss; // 59400
const CUTOFF_TIME = '16:30:00';

const CLOSED = new Set(['COMPLETED', 'REJECTED', 'CANCELLED']);
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SCAN = 3700; // กันวนไม่รู้จบ (ตารางวันหยุดผิดปกติ) ≈ 10 ปี

// ---------- วันหยุด ----------
let dbm = null;
/** Set ของวันหยุด "YYYY-MM-DD" จากตาราง holidays (อ่านใหม่ทุกครั้ง) */
function holidays() {
  if (!dbm) dbm = require('../db'); // lazy: ให้ unit test ส่งวันหยุดเองได้โดยไม่ต้องเปิด DB
  return dbm.holidaySet();
}
function toHolidaySet(h) {
  if (h == null) return holidays();
  if (h instanceof Set) return h;
  if (Array.isArray(h)) return new Set(h.map((x) => (typeof x === 'string' ? x : x && x.date)).filter(Boolean));
  throw new TypeError('holidays ต้องเป็น Set หรือ Array ของ "YYYY-MM-DD"');
}

// ---------- วันที่ ----------
/** วันที่ไทย "YYYY-MM-DD" จาก "YYYY-MM-DD" / ISO / ms */
function toYmd(x) {
  if (typeof x === 'string' && YMD_RE.test(x)) return x;
  return clock.ymd(x);
}
/** วินาทีของวัน (เวลาไทย) ไม่สนมิลลิวินาที */
function secOfDay(x) {
  const p = clock.parts(x);
  return p.hh * 3600 + p.mm * 60 + p.ss;
}
/** เวลา (ms) ปัดลงเป็นวินาที — เทียบแบบ ISO ที่เก็บถึงวินาที (16:30:00.xxx ยังนับเป็นวินาที 16:30:00) */
function secMs(x) {
  return Math.floor(clock.toMs(x) / 1000) * 1000;
}

/** วันทำการ = จ.–ศ. และไม่อยู่ในตารางวันหยุด (A-02) */
function isBusinessDay(date, hs) {
  const d = toYmd(date);
  const dow = clock.dow(d);
  if (dow === 0 || dow === 6) return false;
  if (bug.isBug('B03')) return true; // [B03] ไม่ข้ามวันหยุดในตาราง (ข้ามแค่เสาร์-อาทิตย์)
  return !toHolidaySet(hs).has(d);
}

/** วันทำการถัดไป (หลังวันที่ให้มา ไม่รวมวันนั้น) → "YYYY-MM-DD" */
function nextBusinessDay(date, hs) {
  const set = toHolidaySet(hs);
  let d = toYmd(date);
  for (let i = 0; i < MAX_SCAN; i += 1) {
    d = clock.addDays(d, 1);
    if (isBusinessDay(d, set)) return d;
  }
  throw new Error('ไม่พบวันทำการถัดไป (ตรวจตารางวันหยุด)');
}

/** วันทำการที่ n หลังวันที่ให้มา (n = 0 → วันเดิม) → "YYYY-MM-DD" */
function addBusinessDays(date, n, hs) {
  const set = toHolidaySet(hs);
  let d = toYmd(date);
  const k = Math.max(0, Math.trunc(Number(n) || 0));
  for (let i = 0; i < k; i += 1) d = nextBusinessDay(d, set);
  return d;
}

/** จำนวนวันทำการในช่วง (from, to] ตามวันที่ (ไม่สนเวลา) · to ≤ from → 0 */
function countBusinessDays(from, to, hs) {
  const set = toHolidaySet(hs);
  const a = toYmd(from);
  const b = toYmd(to);
  if (b <= a) return 0;
  let n = 0;
  let d = a;
  for (let i = 0; i < MAX_SCAN * 10; i += 1) {
    d = clock.addDays(d, 1);
    if (d > b) return n;
    if (isBusinessDay(d, set)) n += 1;
  }
  throw new Error('ช่วงวันที่ยาวเกินไป');
}

// ---------- BR-12 กำหนดเสร็จ ----------
/** ก่อนเวลาตัดรอบ 16:30:00 หรือไม่ (16:29:59 ✓ · 16:30:00 ✗) */
function isBeforeCutoff(at) {
  return secOfDay(at) < CUTOFF_SEC;
}

/** D0 = วันที่ชำระ ถ้าเป็นวันทำการและก่อน 16:30:00 ไม่เช่นนั้นวันทำการถัดไป → "YYYY-MM-DD" */
function d0(paidAt, hs) {
  const set = toHolidaySet(hs);
  const day = clock.ymd(paidAt);
  if (isBusinessDay(day, set) && isBeforeCutoff(paidAt)) return day;
  return nextBusinessDay(day, set);
}

/** ISO ของวันที่ "YYYY-MM-DD" เวลา 16:30:00 (+07:00) */
function atCutoff(date) {
  return `${toYmd(date)}T${CUTOFF_TIME}+07:00`;
}

/**
 * กำหนดเสร็จ = วันทำการที่ N หลัง D0 เวลา 16:30 (BR-12) → ISO "YYYY-MM-DDT16:30:00+07:00"
 * คำนวณครั้งเดียวตอนชำระแล้วเก็บใน cases.due_at (ไม่คำนวณใหม่เมื่อแก้วันหยุด · A-42)
 */
function dueAt(paidAt, slaDays, hs) {
  const n = Number(slaDays);
  if (!Number.isInteger(n) || n < 0) throw new TypeError('slaDays ต้องเป็นจำนวนเต็ม ≥ 0');
  const set = toHolidaySet(hs);
  return atCutoff(addBusinessDays(d0(paidAt, set), n, set));
}

// ---------- BR-13 หยุดนับระหว่าง NEED_FIX ----------
/**
 * จำนวนวันทำการใน (วันที่ตีกลับ, วันที่ส่งแก้ไข] — นับตามวันที่ ไม่ขึ้นกับเวลา
 * (ไม่นับวันตีกลับ นับวันส่งแก้ · ใช้ตารางวันหยุด ณ เวลาที่ส่งแก้)
 */
function pauseDays(returnedAt, resubmittedAt, hs) {
  if (bug.isBug('B04')) return 0; // [B04] ไม่หยุดนับ SLA ระหว่างรอแก้ไขเอกสาร
  if (!returnedAt || !resubmittedAt) return 0;
  return countBusinessDays(clock.ymd(returnedAt), clock.ymd(resubmittedAt), hs);
}

/**
 * กำหนดเสร็จใหม่หลังส่งแก้ = กำหนดเดิม + pauseDays วันทำการ (คงเวลาเดิม ปกติ 16:30:00) → ISO +07:00
 * หยุด 0 วัน → คืนค่าเดิม
 */
function extendDueAt(currentDueAt, returnedAt, resubmittedAt, hs) {
  const set = toHolidaySet(hs);
  const k = pauseDays(returnedAt, resubmittedAt, set);
  if (k <= 0) return clock.toISO(currentDueAt);
  const p = clock.parts(currentDueAt);
  const [y, m, d] = addBusinessDays(clock.ymd(currentDueAt), k, set).split('-').map(Number);
  return clock.toISO(clock.fromParts(y, m, d, p.hh, p.mm, p.ss));
}

// ---------- BR-14 ระดับเตือน ----------
/** วันคงเหลือ = จำนวนวันทำการหลังวันนี้ถึงวันกำหนดเสร็จ (รวมวันกำหนด) · กำหนดผ่านไปแล้ว → 0 */
function daysLeft(due, now, hs) {
  const at = now == null ? clock.nowMs() : now;
  return countBusinessDays(clock.ymd(at), clock.ymd(due), hs);
}

/** ตอนนี้ > กำหนดเสร็จ (เทียบระดับวินาที: 16:30:00 ยังไม่เกิน · 16:30:01 เกิน) */
function isOverdue(due, now) {
  const at = now == null ? clock.nowMs() : now;
  return secMs(at) > secMs(due);
}

/**
 * ระดับเตือนของคำขอ (CONTRACT 4.2)
 * @param {object|string} c  แถว cases ({status, due_at}) หรืออ็อบเจกต์ API ({status, dueAt}) หรือสถานะ (string) แล้วส่ง due ใน opts
 * @param {string|number} [now]  เวลาที่ประเมิน (ไม่ส่ง = clock.nowMs())
 * @param {Set|Array} [hs]  ตารางวันหยุด (ไม่ส่ง = อ่านจาก DB)
 * @returns {'normal'|'near'|'overdue'|'paused'|'closed'|null}
 */
function slaLevel(c, now, hs) {
  if (c == null) return null;
  const status = typeof c === 'string' ? c : c.status;
  const due = typeof c === 'string' ? null : (c.due_at !== undefined ? c.due_at : c.dueAt);
  if (CLOSED.has(status)) return 'closed';
  if (status === 'NEED_FIX') return 'paused';
  if (!due) return null; // DRAFT / PENDING_PAYMENT ยังไม่มีกำหนดเสร็จ
  const at = now == null ? clock.nowMs() : now;
  if (isOverdue(due, at)) return 'overdue';
  return daysLeft(due, at, hs) >= 2 ? 'normal' : 'near';
}

/** ข้อความไทยของระดับ: ปกติ ใกล้ครบกำหนด เกินกำหนด หยุดนับ ปิดแล้ว */
function levelText(level) {
  return LEVEL_TH[level] || '';
}

/** สรุปสำหรับแสดงผล: {dueAt, slaLevel, slaText, daysLeft} */
function describe(c, now, hs) {
  const set = hs == null ? undefined : toHolidaySet(hs);
  const due = c && (c.due_at !== undefined ? c.due_at : c.dueAt);
  const level = slaLevel(c, now, set);
  return {
    dueAt: due || null,
    slaLevel: level,
    slaText: levelText(level),
    daysLeft: due && (level === 'normal' || level === 'near') ? daysLeft(due, now, set) : null,
  };
}

module.exports = {
  CUTOFF, CUTOFF_TIME,
  holidays,
  isBusinessDay, nextBusinessDay, addBusinessDays, countBusinessDays,
  isBeforeCutoff, d0, atCutoff, dueAt,
  pauseDays, extendDueAt,
  daysLeft, isOverdue, slaLevel, levelText, describe,
};
