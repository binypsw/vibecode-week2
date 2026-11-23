'use strict';
// ค่าคงที่ที่ทุกบล็อกใช้ร่วมกัน (CONTRACT 2.1 · 4 · 5 · DECISIONS 1, 3, 13)

const ROLES = ['citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];
const ROLE_TH = {
  citizen: 'ประชาชน', officer: 'เจ้าหน้าที่', head: 'หัวหน้าฝ่าย',
  executive: 'ผู้บริหาร', auditor: 'ผู้ตรวจสอบภายใน', admin: 'ผู้ดูแลระบบ',
};
const DEPTS = ['registry', 'works'];
const DEPT_TH = { registry: 'ฝ่ายทะเบียน', works: 'ฝ่ายโยธา' };

/** หน้าตั้งต้นหลังล็อกอิน (CONTRACT 1) */
const LANDING = {
  citizen: '/citizen', officer: '/officer/queue', head: '/head/approvals',
  executive: '/dashboard', auditor: '/audit', admin: '/admin/services',
};

/** สถานะคำขอ (CONTRACT 4.1) */
const STATUS_TH = {
  DRAFT: 'ร่าง', PENDING_PAYMENT: 'รอชำระเงิน', SUBMITTED: 'ส่งคำขอแล้ว', IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร', PENDING_APPROVAL: 'รออนุมัติ', APPROVED: 'อนุมัติ', COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ', CANCELLED: 'ยกเลิก',
};
const OPEN_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED']; // งานคงค้าง
const CLOSED_STATUSES = ['COMPLETED', 'REJECTED']; // ปิดงาน (Dashboard) · CANCELLED ไม่นับเป็นปิดงาน

/** ระดับเตือน SLA (CONTRACT 4.2) */
const LEVEL_TH = { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว' };

/** สถานะการชำระ (CONTRACT 2.5) */
const PAYMENT_STATUS_TH = { PENDING: 'รอชำระ', PAID: 'ชำระแล้ว', EXPIRED: 'QR หมดอายุ' };

/**
 * เอกสารแนบตามบริการ (CONTRACT 4.3) · ลำดับในอาร์เรย์ = ลำดับใน missing-docs
 * docKey `extra` = เอกสารเพิ่มเติม (ทุกบริการ ไม่บังคับ รับหลายไฟล์)
 */
const DOC_TYPES = {
  'id-card': 'บัตรประชาชน', map: 'แผนที่ตั้ง', 'site-photo': 'ภาพสถานที่',
  plan: 'แบบแปลน', deed: 'โฉนด', extra: 'เอกสารเพิ่มเติม',
};
const SERVICE_DOCS = {
  'SV-01': [{ key: 'id-card', name: 'บัตรประชาชน', required: true }],
  'SV-02': [
    { key: 'id-card', name: 'บัตรประชาชน', required: true },
    { key: 'map', name: 'แผนที่ตั้ง', required: true },
    { key: 'site-photo', name: 'ภาพสถานที่', required: false },
  ],
  'SV-03': [
    { key: 'id-card', name: 'บัตรประชาชน', required: true },
    { key: 'plan', name: 'แบบแปลน', required: true, pdfOnly: true },
    { key: 'deed', name: 'โฉนด', required: true },
  ],
};

/**
 * แคตตาล็อกบริการ (ค่าเริ่มต้นของ seed · ค่าที่ใช้จริงอ่านจากตาราง services ซึ่ง admin แก้ได้)
 * route = ลำดับขั้นของบริการ (DECISIONS 3 · A2): แผนก → (แผนก) → head
 * approver = ใครอนุมัติ ('officer' = ผู้ถือเรื่องฝ่ายทะเบียน SV-01 · 'head' = หัวหน้าฝ่ายที่ PENDING_APPROVAL)
 * validity = อายุเอกสาร (A-23): SV-01 90 วัน · SV-02/03 1 ปี
 */
const SERVICES = {
  'SV-01': { id: 'SV-01', name: 'ขอหนังสือรับรอง', fee: 20, feePerSqm: null, sla: 3, route: ['registry'], approver: 'officer', validity: { days: 90 } },
  'SV-02': { id: 'SV-02', name: 'ขออนุญาตประกอบกิจการ', fee: 500, feePerSqm: null, sla: 10, route: ['registry', 'head'], approver: 'head', validity: { years: 1 } },
  'SV-03': { id: 'SV-03', name: 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร', fee: 1000, feePerSqm: 10, sla: 15, route: ['registry', 'works', 'head'], approver: 'head', validity: { years: 1 } },
};
const SERVICE_IDS = Object.keys(SERVICES);

/** ป้ายขั้นตอน SV-03 (CONTRACT 2.6 case-step) */
const SV03_STEP_TH = { 1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน', 2: 'ขั้นตอน 2/3 · ฝ่ายโยธา', 3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย' };

/** เหตุการณ์ Audit 10 แบบ (DECISIONS 13) */
const AUDIT_EVENTS = ['STAFF_LOGIN', 'CLAIM', 'RETURN', 'FORWARD', 'APPROVE', 'REJECT', 'ISSUE', 'UNMASK', 'EXPORT', 'ADMIN_CHANGE'];

/** ข้อความ error ตรงตัวอักษร (CONTRACT 5) · code → [HTTP, message] */
const ERRORS = {
  INVALID_ID: [400, 'เลขบัตรประชาชนไม่ถูกต้อง'],
  OTP_INVALID: [401, 'รหัส OTP ไม่ถูกต้อง'],
  LOCKED: [423, 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที'],
  INVALID_CREDENTIALS: [401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'],
  INVALID_MOBILE: [400, 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0'],
  CONSENT_REQUIRED: [400, 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)'],
  INVALID_QTY: [400, 'จำนวนฉบับต้อง 1–5 ฉบับ'],
  INVALID_AREA: [400, 'กรุณาระบุพื้นที่ 1–500 ตร.ม.'],
  AREA_TOO_LARGE: [400, 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน'],
  FILE_TOO_LARGE: [400, 'ไฟล์ใหญ่เกิน 5 MB'],
  FILE_TYPE: [400, 'รองรับเฉพาะไฟล์ PDF, JPG, PNG'],
  FILE_COUNT: [400, 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ'],
  PLAN_NOT_PDF: [400, 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น'],
  MISSING_DOCS: [409, 'ยังขาดเอกสาร: '], // ต่อท้ายด้วยชื่อเอกสารคั่น ", " (ดู missingDocsMessage)
  QR_EXPIRED: [410, 'QR หมดอายุ กรุณาสร้าง QR ใหม่'],
  AMOUNT_MISMATCH: [422, 'ยอดเงินไม่ตรงกับค่าธรรมเนียม'],
  NOT_FOUND: [404, 'ไม่พบคำขอ'],
  CANNOT_CANCEL: [409, 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว'],
  FIX_WINDOW_EXPIRED: [409, 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก'],
  ALREADY_CLAIMED: [409, 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว'],
  WORKLOAD_LIMIT: [409, 'รับงานได้สูงสุด 10 เรื่อง'],
  RETURN_LIMIT: [409, 'ตีกลับได้สูงสุด 2 ครั้ง'],
  REASON_TOO_SHORT: [400, 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร'],
  REASON_REQUIRED: [400, 'กรุณากรอกเหตุผล'],
  INVALID_STATE: [409, 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้'],
  FORBIDDEN: [403, 'ไม่มีสิทธิ์ทำรายการนี้'],
  UNAUTHENTICATED: [401, 'กรุณาเข้าสู่ระบบ'],
  INVALID_FEE: [400, 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท'],
  INVALID_SLA: [400, 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ'],
  DUPLICATE_HOLIDAY: [409, 'มีวันหยุดนี้อยู่แล้ว'],
  SELF_ROLE_CHANGE: [409, 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้'],
  METHOD_NOT_ALLOWED: [405, 'Method Not Allowed'],
  INVALID_TIME: [400, 'รูปแบบเวลาไม่ถูกต้อง ต้องเป็น ISO 8601 พร้อม offset เช่น 2026-12-01T09:00:00+07:00'],
  BAD_REQUEST: [400, 'ข้อมูลไม่ถูกต้อง'],
};
/** ข้อความหน้า (ไม่ใช่ API) */
const PAGE_MSG = {
  FORBIDDEN_PAGE: 'ไม่มีสิทธิ์เข้าถึงหน้านี้',
  NOT_FOUND_CASE: 'ไม่พบคำขอ',
  NOT_FOUND_DOC: 'ไม่พบเอกสาร',
};

function missingDocsMessage(names) {
  return 'ยังขาดเอกสาร: ' + names.join(', ');
}

// กฎตัวเลขที่ใช้ร่วม (DECISIONS)
const RULES = {
  MAX_FILE_BYTES: 5 * 1024 * 1024, // 5,242,880 (≤ ผ่าน)
  MAX_FILES_PER_CASE: 5,
  QR_TTL_MINUTES: 15, // ใช้ได้ถ้า อายุ < 15:00
  OTP_CODE: '123456',
  OTP_MAX_FAILS: 3,
  OTP_LOCK_MINUTES: 15,
  MAX_WORKLOAD: 10,
  MAX_RETURNS: 2,
  FIX_WINDOW_HOURS: 168,
  MIN_REASON_LEN: 10,
  CUTOFF_HHMM: '16:30',
};

module.exports = {
  ROLES, ROLE_TH, DEPTS, DEPT_TH, LANDING,
  STATUS_TH, OPEN_STATUSES, CLOSED_STATUSES, LEVEL_TH, PAYMENT_STATUS_TH,
  DOC_TYPES, SERVICE_DOCS, SERVICES, SERVICE_IDS, SV03_STEP_TH,
  AUDIT_EVENTS, ERRORS, PAGE_MSG, missingDocsMessage, RULES,
};
