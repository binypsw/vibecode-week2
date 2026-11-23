'use strict';
// seed ตาม TEST-DATA.md ทุกค่า (เรียกจาก dbm.wipeAndSeed() ภายใน transaction เดียว)
// กำหนดเสร็จ (due_at) ของ seed เป็นค่าตายตัวตามตาราง 4.1 ไม่คำนวณใหม่ (A-35) · audit/แจ้งเตือน/session ว่าง
// ผลต้องเหมือนเดิมทุกครั้ง (TC-NFR-03) → ไม่มีค่าสุ่มที่ test มองเห็น (ยกเว้น IV ของการเข้ารหัสซึ่งไม่ออกทาง API)

const pii = require('../lib/crypto');
const { SERVICES, SERVICE_DOCS } = require('./constants');

const T = (s) => (s.length === 10 ? s : s.replace(' ', 'T') + ':00+07:00'); // '2026-12-01 09:00' → ISO +07:00
const SEED_CREATED = '2026-10-01T09:00:00+07:00';
const STAFF_PASSWORD = 'Test@1234';
let cachedStaffHash = null; // scrypt ช้า → คำนวณครั้งเดียวต่อโปรเซส

// ---------- บัญชี (TEST-DATA 1) ----------
const CITIZENS = [
  { key: 'somchai', name: 'สมชาย ใจดี', idNo: '1101700123456', mobile: '0812345678', registered: 1 },
  { key: 'somying', name: 'สมหญิง รักไทย', idNo: '3100600987659', mobile: '0823456789', registered: 1 },
  { key: 'mana', name: 'มานะ ตั้งใจ', idNo: '5500400111221', mobile: null, registered: 0 },
  { key: 'piti', name: 'ปิติ มีสุข', idNo: '1909900555015', mobile: '0834567890', registered: 1 },
];
const STAFF = [
  { username: 'off.reg1', name: 'เจ้าหน้าที่ทะเบียน 1', role: 'officer', dept: 'registry' },
  { username: 'off.reg2', name: 'เจ้าหน้าที่ทะเบียน 2', role: 'officer', dept: 'registry' },
  { username: 'off.works1', name: 'เจ้าหน้าที่โยธา 1', role: 'officer', dept: 'works' },
  { username: 'head1', name: 'หัวหน้าฝ่าย', role: 'head', dept: null },
  { username: 'exec1', name: 'ผู้บริหาร', role: 'executive', dept: null },
  { username: 'audit1', name: 'ผู้ตรวจสอบภายใน', role: 'auditor', dept: null },
  { username: 'admin1', name: 'ผู้ดูแลระบบ', role: 'admin', dept: null },
];

// ---------- วันหยุด (TEST-DATA 3) ----------
const HOLIDAYS = [
  ['2026-12-07', 'ชดเชยวันหยุดทดสอบ (สมมติ)'],
  ['2026-12-10', 'วันรัฐธรรมนูญทดสอบ (สมมติ)'],
  ['2026-12-31', 'วันสิ้นปีทดสอบ (สมมติ)'],
  ['2027-01-01', 'วันขึ้นปีใหม่ทดสอบ (สมมติ)'],
];

// ---------- คำขอ 30 ใบ (TEST-DATA 4.1) ----------
// [seq, ป้าย, บริการ, ข้อมูลกรอก, ค่าธรรมเนียม, ผู้ยื่น, สถานะ, ชำระเมื่อ, กำหนดเสร็จ, ปิด/ยกเลิก, ผู้ถือ]
const CASES = [
  [1, 'H01', 'SV-01', { qty: 1 }, 20, 'somying', 'COMPLETED', '2026-10-14 10:00', '2026-10-19 16:30', '2026-10-16 14:00'],
  [2, 'H05', 'SV-03', { area: 120 }, 1200, 'piti', 'COMPLETED', '2026-11-02 09:00', '2026-11-23 16:30', '2026-11-20 11:00'],
  [3, 'H02', 'SV-01', { qty: 2 }, 40, 'piti', 'COMPLETED', '2026-11-02 09:30', '2026-11-05 16:30', '2026-11-04 15:00'],
  [4, 'H06', 'SV-02', {}, 500, 'somchai', 'COMPLETED', '2026-11-02 14:00', '2026-11-16 16:30', '2026-11-13 15:00'],
  [5, 'H03', 'SV-01', { qty: 1 }, 20, 'somchai', 'COMPLETED', '2026-11-03 11:00', '2026-11-06 16:30', '2026-11-05 10:00'],
  [6, 'H08', 'SV-02', {}, 500, 'piti', 'COMPLETED', '2026-11-03 15:00', '2026-11-17 16:30', '2026-11-19 10:00'],
  [7, 'H07', 'SV-02', {}, 500, 'somying', 'COMPLETED', '2026-11-04 10:00', '2026-11-18 16:30', '2026-11-18 16:00'],
  [8, 'H04', 'SV-01', { qty: 1 }, 20, 'somying', 'REJECTED', '2026-11-09 10:00', '2026-11-12 16:30', '2026-11-11 09:00'],
  [9, 'X01', 'SV-01', { qty: 1 }, 20, 'somchai', 'CANCELLED', '2026-11-09 14:30', '2026-11-12 16:30', '2026-11-09 15:00'],
  [10, 'W01', 'SV-03', { area: 80 }, 1000, 'somying', 'IN_REVIEW', '2026-11-12 10:00', '2026-12-03 16:30', null],
  [11, 'P02', 'SV-03', { area: 150 }, 1500, 'somchai', 'PENDING_APPROVAL', '2026-11-16 10:00', '2026-12-08 16:30', null],
  [12, 'R09', 'SV-03', { area: 101 }, 1010, 'piti', 'IN_REVIEW', '2026-11-18 10:00', '2026-12-11 16:30', null, 'off.reg2'],
  [13, 'R01', 'SV-02', {}, 500, 'somchai', 'IN_REVIEW', '2026-11-20 10:00', '2026-12-04 16:30', null, 'off.reg2'],
  [14, 'P01', 'SV-02', {}, 500, 'piti', 'PENDING_APPROVAL', '2026-11-20 11:00', '2026-12-04 16:30', null],
  [15, 'R02', 'SV-02', {}, 500, 'somying', 'IN_REVIEW', '2026-11-20 15:00', '2026-12-04 16:30', null, 'off.reg2'],
  [16, 'R03', 'SV-02', {}, 500, 'piti', 'IN_REVIEW', '2026-11-23 09:00', '2026-12-08 16:30', null, 'off.reg2'],
  [17, 'F01', 'SV-01', { qty: 1 }, 20, 'somchai', 'NEED_FIX', '2026-11-23 10:00', '2026-11-27 16:30', null, 'off.reg1'],
  [18, 'R04', 'SV-02', {}, 500, 'somchai', 'IN_REVIEW', '2026-11-24 10:00', '2026-12-09 16:30', null, 'off.reg2'],
  [19, 'A01', 'SV-02', {}, 500, 'somying', 'APPROVED', '2026-11-24 14:00', '2026-12-09 16:30', null],
  [20, 'O01', 'SV-01', { qty: 1 }, 20, 'somchai', 'IN_REVIEW', '2026-11-25 10:00', '2026-11-30 16:30', null, 'off.reg1'],
  [21, 'R08', 'SV-02', {}, 500, 'somying', 'IN_REVIEW', '2026-11-25 12:00', '2026-12-11 16:30', null, 'off.reg2'],
  [22, 'N02', 'SV-01', { qty: 2 }, 40, 'somying', 'IN_REVIEW', '2026-11-26 10:00', '2026-12-01 16:30', null, 'off.reg1'],
  [23, 'F02', 'SV-01', { qty: 1 }, 20, 'somying', 'IN_REVIEW', '2026-11-26 10:30', '2026-12-03 16:30', null, 'off.reg1'],
  [24, 'N01', 'SV-01', { qty: 1 }, 20, 'piti', 'SUBMITTED', '2026-11-27 11:00', '2026-12-02 16:30', null],
  [25, 'R05', 'SV-01', { qty: 3 }, 60, 'somying', 'IN_REVIEW', '2026-11-30 10:00', '2026-12-03 16:30', null, 'off.reg2'],
  [26, 'R07', 'SV-01', { qty: 5 }, 100, 'somchai', 'IN_REVIEW', '2026-11-30 16:29', '2026-12-03 16:30', null, 'off.reg2'],
  [27, 'R06', 'SV-01', { qty: 1 }, 20, 'piti', 'IN_REVIEW', '2026-11-30 16:30', '2026-12-04 16:30', null, 'off.reg2'],
  [28, 'S01', 'SV-01', { qty: 1 }, 20, 'somying', 'SUBMITTED', '2026-12-01 08:10', '2026-12-04 16:30', null],
  [29, 'S02', 'SV-01', { qty: 1 }, 20, 'piti', 'SUBMITTED', '2026-12-01 08:20', '2026-12-04 16:30', null],
  [30, 'S03', 'SV-01', { qty: 1 }, 20, 'somchai', 'SUBMITTED', '2026-12-01 08:30', '2026-12-04 16:30', null],
];

// ประวัติตีกลับ (TEST-DATA 4.4)
const RETURNS = {
  F01: [
    { at: '2026-11-24 11:00', resubmitted: '2026-11-25 10:00', reason: 'ภาพบัตรประชาชนไม่ชัด กรุณาถ่ายใหม่' },
    { at: '2026-11-27 14:00', resubmitted: null, reason: 'ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข' },
  ],
  F02: [
    { at: '2026-11-27 10:00', resubmitted: '2026-11-30 10:00', reason: 'ภาพเอกสารเบลอ อ่านเลขไม่ได้' },
    { at: '2026-11-30 14:00', resubmitted: '2026-12-01 08:30', reason: 'ข้อมูลในแบบฟอร์มไม่ครบถ้วน' },
  ],
};

// เอกสารที่ออกแล้ว (TEST-DATA 5)
const DOC1 = {
  docNo: 'DOC-2569-000001', caseNo: 'EG-2569-000005', applicant: 'สมชาย ใจดี', serviceId: 'SV-01',
  issuedAt: '2026-11-05T10:00:00+07:00', validUntil: '2027-02-02', signer: 'เจ้าหน้าที่ทะเบียน 1',
  verifyCode: 'K7M2Q9XA', issuedBy: 'off.reg1',
};

// ---------- PDF จริงขนาดเล็ก ----------
function makePdf(text) {
  const safe = String(text).replace(/[()\\]/g, '');
  const stream = `BT /F1 12 Tf 24 100 Td (${safe}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------- ตัวช่วยเวลา ----------
function spread(clock, startISO, endISO, n) {
  // n จุดเวลาเท่า ๆ กันจาก start ถึง end (รวมปลาย) ปัดเป็นนาที
  if (n <= 0) return [];
  if (n === 1) return [endISO];
  const a = clock.toMs(startISO);
  const b = clock.toMs(endISO);
  const pts = Array.from({ length: n }, (_, i) => Math.round((a + ((b - a) * i) / (n - 1)) / 60000) * 60000);
  // จุดกลางให้อยู่ในเวลาทำการ (ก่อน 09:00 → 10:00 วันเดียวกัน · หลัง 16:30 → 10:00 วันถัดไป) โดยไม่เลยปลายทาง
  for (let i = 1; i < n - 1; i++) {
    const p = clock.parts(pts[i]);
    const hm = p.hh * 60 + p.mm;
    let t = pts[i];
    if (hm < 9 * 60) t = clock.fromParts(p.y, p.m, p.d, 10, 0);
    else if (hm >= 16 * 60 + 30) t = clock.fromParts(p.y, p.m, p.d + 1, 10, 0);
    if (t > pts[i - 1] && t < b) pts[i] = t;
  }
  return pts.map((t) => clock.toISO(t));
}

/** สร้างลำดับเหตุการณ์ไทม์ไลน์ + ฟิลด์สถานะของคำขอแต่ละใบ */
function buildFlow(clock, row) {
  const [, label, svc, , , , status, paidS, , endS, holder] = row;
  const paid = T(paidS);
  const end = endS ? T(endS) : null;
  const ev = [];
  const add = (at, actor, role, event, from, to, detail = null) => ev.push({ at, actor, role, event, from, to, detail });
  const f = { owner: null, issuer: null, dept: null, step: svc === 'SV-03' ? 1 : null, approvedBy: null, approvedAt: null,
    returnCount: 0, returnedAt: null, returnReason: null, fixDeadline: null, closedAt: null, cancelledAt: null };
  const claim = clock.addMinutes(paid, 30);
  add(paid, null, 'citizen', 'SUBMITTED', 'PENDING_PAYMENT', 'SUBMITTED', null);

  if (status === 'SUBMITTED') {
    f.dept = 'registry';
  } else if (status === 'CANCELLED') {
    add(end, null, 'citizen', 'CANCEL', 'SUBMITTED', 'CANCELLED', 'ประชาชนยกเลิกคำขอ');
    f.cancelledAt = end;
  } else if (label === 'F01' || label === 'F02') {
    f.owner = holder; f.issuer = holder; f.dept = 'registry';
    add(claim, holder, 'officer', 'CLAIM', 'SUBMITTED', 'IN_REVIEW');
    for (const r of RETURNS[label]) {
      add(T(r.at), holder, 'officer', 'RETURN', 'IN_REVIEW', 'NEED_FIX', r.reason);
      f.returnCount += 1; f.returnedAt = T(r.at); f.returnReason = r.reason;
      if (r.resubmitted) add(T(r.resubmitted), null, 'citizen', 'RESUBMIT', 'NEED_FIX', 'IN_REVIEW', 'ประชาชนส่งแก้ไขเอกสาร');
    }
    if (status === 'NEED_FIX') f.fixDeadline = clock.addHours(f.returnedAt, 168);
  } else if (status === 'IN_REVIEW' && label !== 'W01') {
    f.owner = holder; f.issuer = holder; f.dept = 'registry';
    add(claim, holder, 'officer', 'CLAIM', 'SUBMITTED', 'IN_REVIEW');
  } else if (label === 'W01') {
    f.issuer = 'off.reg1'; f.dept = 'works'; f.step = 2;
    add(claim, 'off.reg1', 'officer', 'CLAIM', 'SUBMITTED', 'IN_REVIEW');
    add(T('2026-11-13 14:00'), 'off.reg1', 'officer', 'FORWARD', 'IN_REVIEW', 'IN_REVIEW', 'ส่งต่อฝ่ายโยธา');
  } else if (label === 'P01') {
    f.issuer = 'off.reg1';
    add(claim, 'off.reg1', 'officer', 'CLAIM', 'SUBMITTED', 'IN_REVIEW');
    add(T('2026-11-24 10:00'), 'off.reg1', 'officer', 'FORWARD', 'IN_REVIEW', 'PENDING_APPROVAL', null);
  } else if (label === 'P02') {
    f.issuer = 'off.reg1'; f.step = 3;
    add(claim, 'off.reg1', 'officer', 'CLAIM', 'SUBMITTED', 'IN_REVIEW');
    add(T('2026-11-18 10:00'), 'off.reg1', 'officer', 'FORWARD', 'IN_REVIEW', 'IN_REVIEW', 'ส่งต่อฝ่ายโยธา');
    add(T('2026-11-19 09:30'), 'off.works1', 'officer', 'CLAIM', 'IN_REVIEW', 'IN_REVIEW');
    add(T('2026-11-26 15:00'), 'off.works1', 'officer', 'FORWARD', 'IN_REVIEW', 'PENDING_APPROVAL', null);
  } else if (label === 'A01') {
    f.issuer = 'off.reg1'; f.dept = 'registry';
    add(claim, 'off.reg1', 'officer', 'CLAIM', 'SUBMITTED', 'IN_REVIEW');
    add(T('2026-11-27 10:00'), 'off.reg1', 'officer', 'FORWARD', 'IN_REVIEW', 'PENDING_APPROVAL', null);
    f.approvedBy = 'head1'; f.approvedAt = T('2026-11-30 15:00');
    add(f.approvedAt, 'head1', 'head', 'APPROVE', 'PENDING_APPROVAL', 'APPROVED');
  } else if (status === 'REJECTED') {
    f.issuer = 'off.reg1';
    add(claim, 'off.reg1', 'officer', 'CLAIM', 'SUBMITTED', 'IN_REVIEW');
    add(end, 'off.reg1', 'officer', 'REJECT', 'IN_REVIEW', 'REJECTED', 'เอกสารประกอบไม่ตรงตามระเบียบ');
    f.closedAt = end;
  } else if (status === 'COMPLETED') {
    f.issuer = 'off.reg1';
    if (svc === 'SV-01') {
      const [c, ap, is] = spread(clock, claim, end, 3);
      add(c, 'off.reg1', 'officer', 'CLAIM', 'SUBMITTED', 'IN_REVIEW');
      add(ap, 'off.reg1', 'officer', 'APPROVE', 'IN_REVIEW', 'APPROVED');
      f.approvedBy = 'off.reg1'; f.approvedAt = ap;
      add(is, 'off.reg1', 'officer', 'ISSUE', 'APPROVED', 'COMPLETED', null);
    } else if (svc === 'SV-02') {
      const [c, fw, ap, is] = spread(clock, claim, end, 4);
      add(c, 'off.reg1', 'officer', 'CLAIM', 'SUBMITTED', 'IN_REVIEW');
      add(fw, 'off.reg1', 'officer', 'FORWARD', 'IN_REVIEW', 'PENDING_APPROVAL', null);
      add(ap, 'head1', 'head', 'APPROVE', 'PENDING_APPROVAL', 'APPROVED');
      f.approvedBy = 'head1'; f.approvedAt = ap;
      add(is, 'off.reg1', 'officer', 'ISSUE', 'APPROVED', 'COMPLETED', null);
    } else {
      const [c, fw1, c2, fw2, ap, is] = spread(clock, claim, end, 6);
      add(c, 'off.reg1', 'officer', 'CLAIM', 'SUBMITTED', 'IN_REVIEW');
      add(fw1, 'off.reg1', 'officer', 'FORWARD', 'IN_REVIEW', 'IN_REVIEW', 'ส่งต่อฝ่ายโยธา');
      add(c2, 'off.works1', 'officer', 'CLAIM', 'IN_REVIEW', 'IN_REVIEW');
      add(fw2, 'off.works1', 'officer', 'FORWARD', 'IN_REVIEW', 'PENDING_APPROVAL', null);
      add(ap, 'head1', 'head', 'APPROVE', 'PENDING_APPROVAL', 'APPROVED');
      f.approvedBy = 'head1'; f.approvedAt = ap;
      add(is, 'off.reg1', 'officer', 'ISSUE', 'APPROVED', 'COMPLETED', null);
      f.step = 3;
    }
    f.closedAt = end;
  } else {
    throw new Error(`seed: unhandled case ${label}`);
  }
  return { f, ev };
}

function run(dbm) {
  const { db, fmtNo, setSeq } = dbm;
  const clock = require('../lib/clock');
  if (!cachedStaffHash) cachedStaffHash = pii.hashPassword(STAFF_PASSWORD);

  // ผู้ใช้
  const insUser = db.prepare(`INSERT INTO users (username, password_hash, name, role, dept, id_no_enc, id_no_hash, mobile_enc, email, registered, consent_at, created_at)
    VALUES (@username, @password_hash, @name, @role, @dept, @id_no_enc, @id_no_hash, @mobile_enc, @email, @registered, @consent_at, @created_at)`);
  const userId = {};
  for (const c of CITIZENS) {
    const r = insUser.run({
      username: null, password_hash: null, name: c.name, role: 'citizen', dept: null,
      id_no_enc: pii.encrypt(c.idNo), id_no_hash: pii.blindIndex(c.idNo), mobile_enc: pii.encrypt(c.mobile),
      email: c.registered ? '' : null, registered: c.registered, consent_at: c.registered ? SEED_CREATED : null, created_at: SEED_CREATED,
    });
    userId[c.key] = r.lastInsertRowid;
  }
  for (const s of STAFF) {
    insUser.run({
      username: s.username, password_hash: cachedStaffHash, name: s.name, role: s.role, dept: s.dept,
      id_no_enc: null, id_no_hash: null, mobile_enc: null, email: null, registered: 1, consent_at: null, created_at: SEED_CREATED,
    });
  }

  // บริการ
  const insSvc = db.prepare('INSERT INTO services (id, name, fee, fee_per_sqm, sla_days, route, approver, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  Object.values(SERVICES).forEach((s, i) => insSvc.run(s.id, s.name, s.fee, s.feePerSqm, s.sla, JSON.stringify(s.route), s.approver, i + 1));

  // วันหยุด
  const insHol = db.prepare('INSERT INTO holidays (date, name, created_at) VALUES (?, ?, ?)');
  for (const [d, n] of HOLIDAYS) insHol.run(d, n, SEED_CREATED);

  // คำขอ + ไทม์ไลน์ + ไฟล์แนบ
  const insCase = db.prepare(`INSERT INTO cases (case_no, year_be, seq, draft_id, user_id, service_id, qty, area_sqm, fee, status, step, dept, owner, issuer,
      approved_by, approved_at, return_count, returned_at, return_reason, fix_deadline, paid_at, receipt_no, due_at, closed_at, cancelled_at, doc_no, created_at, updated_at)
    VALUES (@case_no, @year_be, @seq, NULL, @user_id, @service_id, @qty, @area_sqm, @fee, @status, @step, @dept, @owner, @issuer,
      @approved_by, @approved_at, @return_count, @returned_at, @return_reason, @fix_deadline, @paid_at, @receipt_no, @due_at, @closed_at, @cancelled_at, @doc_no, @created_at, @updated_at)`);
  const insEv = db.prepare('INSERT INTO case_events (case_no, at, actor, actor_role, event, from_status, to_status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insFile = db.prepare(`INSERT INTO attachments (id, draft_id, case_no, doc_key, name, size, mime, content, uploaded_at, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?, ?)`);
  let fileSeq = 0;
  const addFile = (draftId, caseNo, docKey, at, uid) => {
    const name = `${docKey}.pdf`;
    const content = makePdf(`${name} - ${caseNo || draftId} (seed)`);
    fileSeq += 1;
    insFile.run(fmtNo.fileId(fileSeq), draftId, caseNo, docKey, name, content.length, content, at, uid);
  };

  for (const row of CASES) {
    const [seq, , svc, input, fee, who, status, paidS, dueS] = row;
    const caseNo = fmtNo.caseNo(2569, seq);
    const { f, ev } = buildFlow(clock, row);
    const paid = T(paidS);
    insCase.run({
      case_no: caseNo, year_be: 2569, seq, user_id: userId[who], service_id: svc,
      qty: input.qty == null ? null : input.qty, area_sqm: input.area == null ? null : input.area, fee, status,
      step: f.step, dept: f.dept, owner: f.owner, issuer: f.issuer, approved_by: f.approvedBy, approved_at: f.approvedAt,
      return_count: f.returnCount, returned_at: f.returnedAt, return_reason: f.returnReason, fix_deadline: f.fixDeadline,
      paid_at: paid, receipt_no: fmtNo.receiptNo(2569, seq), due_at: T(dueS), closed_at: f.closedAt, cancelled_at: f.cancelledAt,
      doc_no: caseNo === DOC1.caseNo ? DOC1.docNo : null, created_at: paid, updated_at: ev[ev.length - 1].at,
    });
    for (const e of ev) insEv.run(caseNo, e.at, e.actor, e.role, e.event, e.from, e.to, e.detail);
    for (const d of SERVICE_DOCS[svc].filter((x) => x.required)) addFile(null, caseNo, d.key, clock.addMinutes(paid, -10), userId[who]);
  }

  // ร่างของสมชาย (TEST-DATA 4.2) + QR ค้าง PP-0001
  const insDraft = db.prepare(`INSERT INTO drafts (id, user_id, service_id, qty, area_sqm, fee, status, case_no, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`);
  insDraft.run('DR-0001', userId.somchai, 'SV-01', 2, null, 40, 'DRAFT', T('2026-11-30 15:00'), T('2026-11-30 15:00'));
  insDraft.run('DR-0002', userId.somchai, 'SV-02', null, null, 500, 'PENDING_PAYMENT', T('2026-12-01 08:50'), T('2026-12-01 08:55'));
  addFile('DR-0002', null, 'id-card', T('2026-12-01 08:52'), userId.somchai);
  addFile('DR-0002', null, 'map', T('2026-12-01 08:53'), userId.somchai);
  db.prepare(`INSERT INTO payments (ref, draft_id, amount, status, qr_created_at, qr_expires_at, paid_at, case_no, receipt_no)
    VALUES ('PP-0001', 'DR-0002', 500, 'PENDING', ?, ?, NULL, NULL, NULL)`).run('2026-12-01T08:55:00+07:00', '2026-12-01T09:10:00+07:00');

  // เอกสาร DOC-2569-000001 (ลายเซ็นคำนวณจริงด้วยคีย์ทดสอบ)
  db.prepare(`INSERT INTO documents (doc_no, case_no, verify_code, applicant, service_id, issued_at, valid_until, signer, signature, issued_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(DOC1.docNo, DOC1.caseNo, DOC1.verifyCode, DOC1.applicant, DOC1.serviceId,
    DOC1.issuedAt, DOC1.validUntil, DOC1.signer, pii.signDocument(DOC1), DOC1.issuedBy);

  // ตัวนับ (TEST-DATA 12: ถัดไป EG-2569-000031 · RC-2569-000031 · DOC-2569-000002 · DR-0003 · PP-0002)
  setSeq('case:2569', 30);
  setSeq('receipt:2569', 30);
  setSeq('doc:2569', 1);
  setSeq('draft', 2);
  setSeq('payment', 1);
  setSeq('file', fileSeq);
}

module.exports = { run, makePdf, CITIZENS, STAFF, HOLIDAYS, CASES, DOC1, STAFF_PASSWORD };
