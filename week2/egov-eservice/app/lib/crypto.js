'use strict';
// ข้อมูลส่วนบุคคล + ลายเซ็นจำลอง (DECISIONS 10, 11 · NFR-04 · A-22 · A-24 · A-54)
// - เลขบัตร/เบอร์โทร เก็บแบบ AES-256-GCM: encrypt() → "v1:<base64url(iv|tag|ciphertext)>"
//   ห้ามเก็บเลขบัตร 13 หลักหรือเบอร์ 10 หลักแบบ plaintext ในตารางใด ๆ (รวม otp/lock/session/audit/log)
// - ค้นหาด้วยเลขบัตร ใช้ blindIndex(idNo) (HMAC-SHA256 · base64url → ไม่มีตัวเลขยาว 13 หลักต่อกัน)
// - ลายเซ็นเอกสาร signDocument(): HMAC-SHA256 ของ docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer (CONTRACT 3)

const crypto = require('crypto');

const PII_KEY = crypto.createHash('sha256').update(process.env.PII_KEY || 'gotham-egov-test-pii-key-not-for-production').digest();
const INDEX_KEY = crypto.createHash('sha256').update('blind-index:' + (process.env.PII_KEY || 'gotham-egov-test-pii-key-not-for-production')).digest();
const DOC_SIGN_KEY = process.env.DOC_SIGN_KEY || 'gotham-egov-test-doc-sign-key';

// ---------- AES-256-GCM ----------
function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', PII_KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function decrypt(enc) {
  if (enc == null || enc === '') return null;
  const s = String(enc);
  if (!s.startsWith('v1:')) throw new Error('Unsupported ciphertext');
  const buf = Buffer.from(s.slice(3), 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', PII_KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
/** ดัชนีค้นหาเลขบัตร (deterministic · ย้อนกลับไม่ได้) */
function blindIndex(value) {
  return crypto.createHmac('sha256', INDEX_KEY).update(String(value)).digest('base64url');
}

// ---------- รหัสผ่านเจ้าหน้าที่ (scrypt) ----------
function hashPassword(pw, salt = crypto.randomBytes(16).toString('base64url')) {
  const h = crypto.scryptSync(String(pw), salt, 32).toString('base64url');
  return `scrypt:${salt}:${h}`;
}
function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [alg, salt, h] = stored.split(':');
  if (alg !== 'scrypt' || !salt || !h) return false;
  const a = Buffer.from(h, 'base64url');
  const b = crypto.scryptSync(String(pw == null ? '' : pw), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- เลขบัตร ----------
/** ตรวจเลขบัตร 13 หลัก + checksum (BR-01): หลักที่ 13 = (11 − (Σ dᵢ×(13−i)) mod 11) mod 10 */
function isValidThaiId(id) {
  const s = String(id == null ? '' : id);
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(s[12]);
}
/** "1101700123456" → "1-1017-00123-45-6" */
function formatId(id) {
  const s = String(id || '');
  if (s.length !== 13) return s;
  return `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}`;
}
/** "3100600987659" → "X-XXXX-XXXXX-65-9" (เห็น 3 หลักท้าย · A-24) */
function maskId(id) {
  const s = String(id || '');
  if (s.length !== 13) return 'X-XXXX-XXXXX-XX-X';
  return `X-XXXX-XXXXX-${s.slice(10, 12)}-${s[12]}`;
}
/** "สมชาย ใจดี" → "สมชาย ใ***" (A-54: ชื่อเต็ม + อักษรแรกของนามสกุล + ***) */
function maskName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(' ');
  return `${first} ${Array.from(last)[0]}***`;
}

// ---------- ลายเซ็นเอกสารจำลอง (A-22) ----------
const SIGN_FIELDS = ['docNo', 'caseNo', 'applicant', 'serviceId', 'issuedAt', 'validUntil', 'signer'];
/**
 * doc = { docNo, caseNo, applicant (ชื่อเต็ม), serviceId, issuedAt (ISO +07:00), validUntil ("YYYY-MM-DD"), signer (ชื่อแสดงผู้ลงนาม) }
 * คืน hex HMAC-SHA256 ของฟิลด์ตามลำดับ คั่นด้วย '|'
 */
function signDocument(doc) {
  const payload = SIGN_FIELDS.map((k) => (doc[k] == null ? '' : String(doc[k]))).join('|');
  return crypto.createHmac('sha256', DOC_SIGN_KEY).update(payload, 'utf8').digest('hex');
}
function verifyDocumentSignature(doc, signature) {
  const a = Buffer.from(signDocument(doc), 'hex');
  const b = Buffer.from(String(signature || ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- อื่น ๆ ----------
function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}
/** รหัสตรวจสอบเอกสาร 8 ตัว [A-Z0-9] */
function randomVerifyCode() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += A[crypto.randomInt(A.length)];
  return s;
}

module.exports = {
  encrypt, decrypt, blindIndex,
  hashPassword, verifyPassword,
  isValidThaiId, formatId, maskId, maskName,
  SIGN_FIELDS, signDocument, verifyDocumentSignature,
  randomToken, randomVerifyCode,
};
