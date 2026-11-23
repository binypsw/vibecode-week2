'use strict';
// นาฬิกากลางของระบบ (README กติกา 5 · CONTRACT 8 · A-37)
// - กฎธุรกิจทุกข้อต้องอ่านเวลาจากที่นี่เท่านั้น (ห้าม new Date()/Date.now() ตรง ๆ ในกฎธุรกิจ)
// - TEST_MODE=1 → นาฬิกา "แช่แข็ง" (เริ่มที่ 2026-12-01T09:00:00+07:00 · ตั้งด้วย PUT /api/test/clock)
// - ไม่ตั้ง TEST_MODE → เวลาจริงของเครื่อง
// - เขตเวลา Asia/Bangkok = UTC+07:00 คงที่ (ไม่มี DST) · ทุก timestamp ใน DB/API เป็นสตริง ISO "YYYY-MM-DDTHH:mm:ss+07:00"
//   (เรียงตามตัวอักษร = เรียงตามเวลา จึงเทียบใน SQL ได้ตรง ๆ)

const OFFSET_MS = 7 * 3600 * 1000;
const DEFAULT_NOW = '2026-12-01T09:00:00+07:00';
const TEST_MODE = process.env.TEST_MODE === '1';

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_DAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

// ISO ที่ยอมรับ: ต้องมีวันที่ + 'T' + เวลา + offset (Z หรือ ±HH:MM) · ไม่มี offset → ไม่ถูกต้อง (INVALID_TIME)
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|[+-]\d{2}:\d{2})$/;

let frozenMs = TEST_MODE ? Date.parse(DEFAULT_NOW) : null;
let persist = null; // ฟังก์ชันบันทึกค่านาฬิกาลง DB (db/index.js ตั้งให้)

const pad = (n, w = 2) => String(n).padStart(w, '0');

function toMs(x) {
  if (x == null) return nowMs();
  if (typeof x === 'number') return x;
  if (x instanceof Date) return x.getTime();
  if (typeof x === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(x)) return Date.parse(x + 'T00:00:00+07:00');
    const ms = Date.parse(x);
    if (Number.isNaN(ms)) throw new Error('Invalid time: ' + x);
    return ms;
  }
  throw new Error('Invalid time value');
}

/** ตรวจสตริง ISO ตามที่ test hook ต้องการ (มี offset) → ms หรือ null */
function parseStrictISO(s) {
  if (typeof s !== 'string') return null;
  const m = ISO_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || (se !== undefined && +se > 59)) return null;
  const ms = Date.parse(s.trim());
  if (Number.isNaN(ms)) return null;
  // กันวันที่ล้น เช่น 2026-02-31
  const p = partsUTC(ms + offsetOf(m[8]));
  if (p.y !== +y || p.m !== +mo || p.d !== +d) return null;
  return ms;
}

function offsetOf(tz) {
  if (tz === 'Z') return 0;
  const sign = tz[0] === '-' ? -1 : 1;
  return sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6))) * 60000;
}

function partsUTC(ms) {
  const d = new Date(ms);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(), ms: d.getUTCMilliseconds(),
    dow: d.getUTCDay(),
  };
}

// ---------- นาฬิกา ----------
function nowMs() {
  return frozenMs != null ? frozenMs : Date.now();
}
function now() {
  return new Date(nowMs());
}
function nowISO() {
  return toISO(nowMs());
}
/** ตั้งนาฬิกา (แช่แข็ง) · รับ ISO ที่มี offset หรือ ms · คืน ISO +07:00 */
function set(x) {
  const ms = typeof x === 'string' ? parseStrictISO(x) : toMs(x);
  if (ms == null) throw Object.assign(new Error('INVALID_TIME'), { code: 'INVALID_TIME' });
  frozenMs = Math.floor(ms / 1000) * 1000;
  if (persist) persist(toISO(frozenMs));
  return toISO(frozenMs);
}
/** กลับค่าเริ่มต้น (TEST_MODE: 2026-12-01T09:00:00+07:00) */
function reset() {
  if (TEST_MODE) return set(DEFAULT_NOW);
  frozenMs = null;
  return nowISO();
}
function _setPersist(fn) { persist = fn; }
function _restore(iso) {
  if (!TEST_MODE || !iso) return;
  const ms = parseStrictISO(iso);
  if (ms != null) frozenMs = ms;
}

// ---------- แปลงเวลา (Asia/Bangkok) ----------
/** ส่วนประกอบเวลาไทย: {y,m,d,hh,mm,ss,dow} (dow 0=อาทิตย์) */
function parts(x) {
  return partsUTC(toMs(x) + OFFSET_MS);
}
/** ms จากส่วนประกอบเวลาไทย (เดือน 1–12 · ล้นได้ เช่น d=32) */
function fromParts(y, m, d, hh = 0, mm = 0, ss = 0) {
  return Date.UTC(y, m - 1, d, hh, mm, ss) - OFFSET_MS;
}
/** "2026-12-04T16:30:00+07:00" */
function toISO(x) {
  const p = parts(x);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}+07:00`;
}
/** วันที่ไทย "YYYY-MM-DD" (ค.ศ.) */
function ymd(x) {
  const p = parts(x);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
/** "YYYY-MM" (ค.ศ.) ตามเวลาไทย */
function ym(x) {
  const p = parts(x);
  return `${p.y}-${pad(p.m)}`;
}
/** ปี พ.ศ. ตามเวลาไทย */
function beYear(x) {
  return parts(x).y + 543;
}
function addMinutes(x, n) { return toISO(toMs(x) + n * 60000); }
function addHours(x, n) { return toISO(toMs(x) + n * 3600000); }
function addSeconds(x, n) { return toISO(toMs(x) + n * 1000); }
/** บวกวันปฏิทิน (คงเวลา) · รับ/คืน "YYYY-MM-DD" ถ้าอินพุตเป็นวันที่ล้วน */
function addDays(x, n) {
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) {
    const [y, m, d] = x.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }
  return toISO(toMs(x) + n * 86400000);
}
/** วันในสัปดาห์ของวันที่ "YYYY-MM-DD" หรือเวลาใด ๆ (0=อาทิตย์ … 6=เสาร์) */
function dow(x) {
  return parts(x).dow;
}
/** เทียบเวลา: <0 · 0 · >0 */
function cmp(a, b) {
  return toMs(a) - toMs(b);
}

// ---------- รูปแบบบนจอ (A-04 · A-51) ----------
/** "4 ธ.ค. 2569 16:30" */
function fmtThai(x) {
  if (x == null || x === '') return '';
  const p = parts(x);
  return `${p.d} ${TH_MONTHS[p.m - 1]} ${p.y + 543} ${pad(p.hh)}:${pad(p.mm)}`;
}
/** "2 ก.พ. 2570" (รับ "YYYY-MM-DD" หรือเวลา) */
function fmtThaiDate(x) {
  if (x == null || x === '') return '';
  const p = parts(x);
  return `${p.d} ${TH_MONTHS[p.m - 1]} ${p.y + 543}`;
}

module.exports = {
  TEST_MODE, DEFAULT_NOW, OFFSET_MS, TH_MONTHS, TH_DAYS,
  now, nowMs, nowISO, set, reset,
  toMs, toISO, parseStrictISO, parts, fromParts, ymd, ym, beYear,
  addMinutes, addHours, addSeconds, addDays, dow, cmp,
  fmtThai, fmtThaiDate,
  _setPersist, _restore,
};
