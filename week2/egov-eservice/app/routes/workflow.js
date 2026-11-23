'use strict';
// B09 · ขั้นตอนอนุมัติ: ตีกลับ · ส่งต่อ · อนุมัติ · ไม่อนุมัติ · ส่งแก้ไข · ยกเลิกอัตโนมัติ 168 ชม. + หน้า /head/approvals
// ที่มา: REQUIREMENTS FR-11 FR-14 FR-15 FR-16 · BR-13 BR-19 BR-20 BR-21 · DECISIONS ข้อ 5 9 10 18 · A-12 A-20 A-21 A-27 A-28 A-29 A-44 A-46
//        CONTRACT 2.6 (ปุ่ม) · 2.8 (/head/approvals) · 5 (ข้อความ error) · 6.2 (resubmit) · 6.3 (return/forward/approve/reject) · 6.8 (detail Audit)
//
// API ที่ไฟล์นี้เป็นเจ้าของ
//   POST /api/officer/cases/:caseNo/return    ผู้ถือเรื่อง (officer)  {reason}  → 200 {status:"NEED_FIX", returnCount, fixDeadline}
//   POST /api/officer/cases/:caseNo/forward   ผู้ถือเรื่อง (officer)  {note?}   → 200 {status:"IN_REVIEW", step:2} | {status:"PENDING_APPROVAL"}
//   POST /api/cases/:caseNo/approve           SV-01 ผู้ถือเรื่อง · SV-02/03 head ที่ PENDING_APPROVAL → 200 {status:"APPROVED"}
//   POST /api/cases/:caseNo/reject            เหมือน approve  {reason}  → 200 {status:"REJECTED", closedAt}
//   POST /api/cases/:caseNo/resubmit          ประชาชนเจ้าของ (JSON หรือ multipart: file[, docKey] ไม่บังคับ) → 200 {status:"IN_REVIEW", dueAt}
//   GET  /api/head/approvals                  head → {items:[{caseNo, serviceId, applicantName, step, dueAt, slaLevel}]}
// หน้า: GET /head/approvals (head เท่านั้น)
// hook: onRequest('workflow.auto-cancel', …, 10) ยกเลิก NEED_FIX ที่ถึง returned_at + 168 ชม. (เวลาไทม์ไลน์ = เส้นตาย · A-46)
//
// ลำดับตรวจ (ทุก action): ล็อกอิน/บทบาท (401/403) → มีคำขอ (404) → สิทธิ์ผู้ถือเรื่อง/อำนาจอนุมัติ (403) → สถานะ (409 INVALID_STATE)
//   → return: เพดาน 2 ครั้ง (409 RETURN_LIMIT) → เหตุผล ≥ 10 ตัวหลัง trim (400 REASON_TOO_SHORT)
//
// BUG_MODE (BUGS.md · เปลี่ยนเฉพาะจุดที่ระบุ):
//   B07 → approve ของบริการที่ผู้อนุมัติคือ head (SV-02/03) ไม่ตรวจบทบาท: officer อนุมัติได้เองที่ API (ปุ่มยังซ่อนตามปกติ)
//   B12 → ไม่ตรวจเพดานตีกลับ 2 ครั้ง (ทั้ง API และปุ่ม return-btn ยังแสดง)
//
// ctx.workflow (ให้บล็อกอื่นใช้ตอนมี request · routes/officer.js โหลดก่อนไฟล์นี้ จึงต้องอ่าน ctx.workflow ตอน runtime):
//   actionsFor(user, caseRow) → {return, forward, approve, reject, issue, returnCount, returnLimitReached, forwardTo}
//                               (ปุ่มที่ "ต้องไม่มี" = false → ห้าม render · CONTRACT 0.5)
//   issuerOf(caseRow) · isHolder(user, caseRow) · nextStep(caseRow) · fixDeadlineOf(caseRow) · autoCancelDue(nowISO?)

const path = require('path');
const sla = require('../lib/sla');

const AUTO_CANCEL_DETAIL = 'เลยเวลาแก้ไข 168 ชม. ระบบยกเลิกอัตโนมัติ';
const RESUBMIT_DETAIL = 'ประชาชนส่งแก้ไขเอกสาร';

module.exports = function registerWorkflow(app, ctx) {
  const { db, dbm, clock, isBug, hooks, audit, views, apiError, requireRole, upload, C } = ctx;
  const { RULES, SERVICE_DOCS, SERVICES } = C;
  const { esc, timeTag, levelBadge, serviceLabel } = views;

  const officerOnly = requireRole('officer');
  const deciders = requireRole('officer', 'head');
  const citizenOnly = requireRole('citizen');
  const headOnly = requireRole('head');

  // ------------------------------------------------------------------ statements
  const qNeedFix = db.prepare("SELECT case_no, returned_at, fix_deadline FROM cases WHERE status = 'NEED_FIX'");
  const updAutoCancel = db.prepare(`UPDATE cases SET status = 'CANCELLED', cancelled_at = @at, dept = NULL, owner = NULL, updated_at = @at
    WHERE case_no = @caseNo AND status = 'NEED_FIX'`);
  const updReturn = db.prepare(`UPDATE cases SET status = 'NEED_FIX', return_count = @returnCount, returned_at = @now,
      return_reason = @reason, fix_deadline = @fixDeadline, updated_at = @now
    WHERE case_no = @caseNo AND status = 'IN_REVIEW'`);
  const updForward = db.prepare(`UPDATE cases SET status = @status, dept = @dept, owner = NULL, step = @step,
      issuer = COALESCE(issuer, @issuer), updated_at = @now
    WHERE case_no = @caseNo AND status = 'IN_REVIEW'`);
  const updApprove = db.prepare(`UPDATE cases SET status = 'APPROVED', approved_by = @user, approved_at = @now,
      owner = NULL, dept = 'registry', issuer = CASE WHEN @selfIssue = 1 THEN @user ELSE issuer END, updated_at = @now
    WHERE case_no = @caseNo AND status = @from`);
  const updReject = db.prepare(`UPDATE cases SET status = 'REJECTED', closed_at = @now, owner = NULL, dept = NULL,
      fix_deadline = NULL, updated_at = @now
    WHERE case_no = @caseNo AND status = @from`);
  const updResubmit = db.prepare(`UPDATE cases SET status = 'IN_REVIEW', due_at = @dueAt, fix_deadline = NULL, updated_at = @now
    WHERE case_no = @caseNo AND status = 'NEED_FIX'`);
  const qCaseFiles = db.prepare('SELECT id, doc_key FROM attachments WHERE case_no = ?');
  const delCaseFileKey = db.prepare('DELETE FROM attachments WHERE case_no = ? AND doc_key = ?');
  const insCaseFile = db.prepare(`INSERT INTO attachments (id, draft_id, case_no, doc_key, name, size, mime, content, uploaded_at, uploaded_by)
    VALUES (@id, NULL, @caseNo, @docKey, @name, @size, @mime, @content, @at, @by)`);
  const qPending = db.prepare(`SELECT c.case_no, c.service_id, c.step, c.status, c.due_at, u.name AS applicant
    FROM cases c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.status = 'PENDING_APPROVAL' ORDER BY c.due_at ASC, c.case_no ASC`);

  // ------------------------------------------------------------------ กฎเส้นทาง/อำนาจ (BR-21 · A-27 · A-28)
  function serviceOf(c) {
    return dbm.getService(c.service_id) || SERVICES[c.service_id] || null;
  }
  function routeOf(c) {
    const s = serviceOf(c);
    return s && Array.isArray(s.route) ? s.route : [];
  }
  /** 'officer' (SV-01 ผู้ถือเรื่องอนุมัติ) | 'head' (SV-02/03 หัวหน้าอนุมัติที่ PENDING_APPROVAL) */
  function approverOf(c) {
    const s = serviceOf(c);
    return s ? s.approver : 'head';
  }
  /** ผู้ถือเรื่อง = officer ที่เป็น owner และอยู่แผนกเดียวกับคิวของคำขอ */
  function isHolder(user, c) {
    if (!user || !c || user.role !== 'officer' || !c.owner) return false;
    if (c.owner !== user.username) return false;
    return !c.dept || !user.dept || c.dept === user.dept;
  }
  /** ขั้นถัดไปตามเส้นทางของบริการ · null = ไม่มีขั้นให้ส่งต่อ (เช่น SV-01) */
  function nextStep(c) {
    const route = routeOf(c);
    const idx = route.indexOf(c.dept);
    if (idx < 0 || idx + 1 >= route.length) return null;
    const to = route[idx + 1];
    const stepped = route.length >= 3; // มีป้ายขั้นตอนเฉพาะบริการ 3 ขั้น (SV-03 · A-40)
    return { to, toHead: to === 'head', step: stepped ? idx + 2 : (c.step == null ? null : c.step) };
  }
  /** ผู้ออกเอกสาร (A-27): SV-01 = ผู้ถือเรื่องที่อนุมัติ · SV-02/03 = เจ้าหน้าที่ทะเบียนที่รับเรื่องขั้นแรก */
  function issuerOf(c) {
    if (!c) return null;
    if (approverOf(c) === 'officer') return c.approved_by || c.issuer || null;
    return c.issuer || null;
  }
  function fixDeadlineOf(c) {
    if (!c) return null;
    if (c.fix_deadline) return c.fix_deadline;
    return c.returned_at ? clock.addHours(c.returned_at, RULES.FIX_WINDOW_HOURS) : null;
  }
  /** เหตุผลหลังตัดช่องว่างหัวท้าย ≥ 10 ตัวอักษร (A-12 · A-44) → สตริง หรือ null */
  function cleanReason(v) {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const s = String(v).trim();
    return Array.from(s).length >= RULES.MIN_REASON_LEN ? s : null;
  }
  function cleanNote(v) {
    if (typeof v !== 'string' && typeof v !== 'number') return '';
    return String(v).trim().slice(0, 1000);
  }

  /** ปุ่มที่ผู้ใช้คนนี้ทำได้กับคำขอนี้ (ใช้ตัดสินการ render ปุ่ม · API ตรวจซ้ำเองเสมอ) */
  function actionsFor(user, c) {
    const returnCount = c ? Number(c.return_count) || 0 : 0;
    const out = {
      return: false, forward: false, approve: false, reject: false, issue: false,
      returnCount, returnLimitReached: returnCount >= RULES.MAX_RETURNS, forwardTo: null,
    };
    if (!user || !c) return out;
    const approver = approverOf(c);
    if (c.status === 'IN_REVIEW' && isHolder(user, c)) {
      out.return = !out.returnLimitReached || isBug('B12'); // [B12] ปุ่มตีกลับยังแสดงหลังครบ 2 ครั้ง
      const nx = nextStep(c);
      out.forward = !!nx;
      out.forwardTo = nx ? nx.to : null;
      if (approver === 'officer') {
        out.approve = true;
        out.reject = true;
      }
    } else if (c.status === 'PENDING_APPROVAL' && user.role === 'head' && approver === 'head') {
      out.approve = true;
      out.reject = true;
    } else if (c.status === 'APPROVED' && user.role === 'officer' && user.username === issuerOf(c)) {
      out.issue = true;
    }
    return out;
  }

  // ------------------------------------------------------------------ ยกเลิกอัตโนมัติ (BR-20 · A-21 · A-46)
  function cancelExpired(c, deadline) {
    const info = updAutoCancel.run({ caseNo: c.case_no, at: deadline });
    if (info.changes) {
      audit.timeline({
        caseNo: c.case_no, event: 'AUTO_CANCEL', from: 'NEED_FIX', to: 'CANCELLED',
        actor: null, role: 'system', at: deadline, detail: AUTO_CANCEL_DETAIL,
      });
    }
    return info.changes > 0;
  }
  /** ยกเลิกทุกคำขอ NEED_FIX ที่ตอนนี้ ≥ เส้นตาย (167:59 ยังส่งได้ · 168:00 ยกเลิก) · คืนจำนวนที่ยกเลิก */
  function autoCancelDue(nowISO) {
    const now = nowISO || clock.nowISO();
    let n = 0;
    for (const r of qNeedFix.all()) {
      const deadline = fixDeadlineOf(r);
      if (deadline && clock.cmp(now, deadline) >= 0 && cancelExpired(r, deadline)) n += 1;
    }
    return n;
  }
  hooks.onRequest('workflow.auto-cancel', () => { autoCancelDue(clock.nowISO()); }, 10);

  // ------------------------------------------------------------------ ตัวช่วยตอบ API
  function send(res, out) {
    if (out && out.error) return apiError(res, out.error);
    return res.status(200).json(out.body);
  }
  const caseNoOf = (req) => String(req.params.caseNo || '').trim();

  // ------------------------------------------------------------------ ตีกลับ (FR-14 · BR-19)
  const returnTx = db.transaction((req) => {
    const c = dbm.getCase(caseNoOf(req));
    if (!c) return { error: 'NOT_FOUND' };
    if (!isHolder(req.user, c)) return { error: 'FORBIDDEN' };
    if (c.status !== 'IN_REVIEW') return { error: 'INVALID_STATE' };
    const count = Number(c.return_count) || 0;
    if (count >= RULES.MAX_RETURNS && !isBug('B12')) return { error: 'RETURN_LIMIT' }; // [B12] ข้ามเพดาน
    const reason = cleanReason(req.body && req.body.reason);
    if (reason == null) return { error: 'REASON_TOO_SHORT' };
    const now = clock.nowISO();
    const fixDeadline = clock.addHours(now, RULES.FIX_WINDOW_HOURS);
    const returnCount = count + 1;
    const info = updReturn.run({ caseNo: c.case_no, returnCount, now, reason, fixDeadline });
    if (!info.changes) return { error: 'INVALID_STATE' };
    audit.log(req, { event: 'RETURN', caseNo: c.case_no, from: 'IN_REVIEW', to: 'NEED_FIX', detail: reason, time: now });
    return { body: { caseNo: c.case_no, status: 'NEED_FIX', returnCount, returnedAt: now, fixDeadline } };
  });
  app.post('/api/officer/cases/:caseNo/return', officerOnly, (req, res) => send(res, returnTx.immediate(req)));

  // ------------------------------------------------------------------ ส่งต่อ (FR-15 · ส่งตามเส้นทางของบริการ ผู้ใช้เลือกปลายทางไม่ได้)
  const forwardTx = db.transaction((req) => {
    const c = dbm.getCase(caseNoOf(req));
    if (!c) return { error: 'NOT_FOUND' };
    if (!isHolder(req.user, c)) return { error: 'FORBIDDEN' };
    if (c.status !== 'IN_REVIEW') return { error: 'INVALID_STATE' };
    const nx = nextStep(c);
    if (!nx) return { error: 'INVALID_STATE' };
    const note = cleanNote(req.body && req.body.note);
    const now = clock.nowISO();
    const to = nx.toHead ? 'PENDING_APPROVAL' : 'IN_REVIEW';
    const info = updForward.run({
      caseNo: c.case_no, status: to, dept: nx.toHead ? null : nx.to, step: nx.step, now,
      issuer: c.dept === 'registry' ? req.user.username : null, // ผู้ออกเอกสาร = ทะเบียนขั้นแรก (A-27) ถ้ายังไม่มี
    });
    if (!info.changes) return { error: 'INVALID_STATE' };
    audit.log(req, { event: 'FORWARD', caseNo: c.case_no, from: 'IN_REVIEW', to, detail: note, time: now });
    const body = { caseNo: c.case_no, status: to };
    if (nx.step != null) body.step = nx.step;
    if (!nx.toHead) body.dept = nx.to;
    return { body };
  });
  app.post('/api/officer/cases/:caseNo/forward', officerOnly, (req, res) => send(res, forwardTx.immediate(req)));

  // ------------------------------------------------------------------ อนุมัติ / ไม่อนุมัติ (FR-16 · BR-21 · A-20 · A-28)
  /** ตรวจอำนาจตัดสิน → {c, from} หรือ {error} */
  function decideGuard(req, kind) {
    const c = dbm.getCase(caseNoOf(req));
    if (!c) return { error: 'NOT_FOUND' };
    const u = req.user;
    if (approverOf(c) === 'officer') {
      // SV-01: ผู้ถือเรื่อง (officer แผนกที่ถือ) เท่านั้น · head/officer อื่น → 403
      if (!isHolder(u, c)) return { error: 'FORBIDDEN' };
      if (c.status !== 'IN_REVIEW') return { error: 'INVALID_STATE' };
      return { c, from: 'IN_REVIEW', selfIssue: true };
    }
    // SV-02/03: head ที่ PENDING_APPROVAL เท่านั้น · officer → 403 (รวมหลังตีกลับครบ 2 ครั้ง · A-20)
    const skipRole = kind === 'approve' && isBug('B07') && u.role === 'officer'; // [B07] API ไม่เช็กสิทธิ์อนุมัติ SV-02/03
    if (u.role !== 'head' && !skipRole) return { error: 'FORBIDDEN' };
    if (c.status !== 'PENDING_APPROVAL') return { error: 'INVALID_STATE' };
    return { c, from: 'PENDING_APPROVAL', selfIssue: false };
  }

  const approveTx = db.transaction((req) => {
    const g = decideGuard(req, 'approve');
    if (g.error) return g;
    const now = clock.nowISO();
    const info = updApprove.run({ caseNo: g.c.case_no, user: req.user.username, now, from: g.from, selfIssue: g.selfIssue ? 1 : 0 });
    if (!info.changes) return { error: 'INVALID_STATE' };
    audit.log(req, { event: 'APPROVE', caseNo: g.c.case_no, from: g.from, to: 'APPROVED', detail: '', time: now });
    return { body: { caseNo: g.c.case_no, status: 'APPROVED', approvedBy: req.user.username, approvedAt: now } };
  });
  app.post('/api/cases/:caseNo/approve', deciders, (req, res) => send(res, approveTx.immediate(req)));

  const rejectTx = db.transaction((req) => {
    const g = decideGuard(req, 'reject');
    if (g.error) return g;
    const reason = cleanReason(req.body && req.body.reason);
    if (reason == null) return { error: 'REASON_TOO_SHORT' };
    const now = clock.nowISO();
    const info = updReject.run({ caseNo: g.c.case_no, now, from: g.from });
    if (!info.changes) return { error: 'INVALID_STATE' };
    audit.log(req, { event: 'REJECT', caseNo: g.c.case_no, from: g.from, to: 'REJECTED', detail: reason, time: now });
    return { body: { caseNo: g.c.case_no, status: 'REJECTED', closedAt: now } };
  });
  app.post('/api/cases/:caseNo/reject', deciders, (req, res) => send(res, rejectTx.immediate(req)));

  // ------------------------------------------------------------------ ประชาชนส่งแก้ไข (FR-11 · BR-13 · BR-20 · A-29)
  function sniffMime(buf) {
    if (!buf || buf.length < 4) return null;
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf'; // %PDF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    return null;
  }
  /** ตรวจไฟล์แนบใหม่ตอนส่งแก้ (ไม่บังคับ) → {files:[…]} หรือ {error} · ยังไม่เขียน DB */
  function prepareFixFiles(req, c) {
    const raw = (Array.isArray(req.files) ? req.files : []).filter((f) => f && f.buffer && f.buffer.length > 0 && f.originalname);
    if (!raw.length) return { files: [] };
    const keysIn = req.body && req.body.docKey;
    const slots = SERVICE_DOCS[c.service_id] || [];
    const keyAt = (i) => {
      const k = Array.isArray(keysIn) ? (keysIn.length === raw.length ? keysIn[i] : keysIn[0]) : keysIn;
      const key = String(k || 'extra');
      return key === 'extra' || slots.some((s) => s.key === key) ? key : 'extra';
    };
    const files = [];
    for (let i = 0; i < raw.length; i += 1) {
      const f = raw[i];
      const docKey = keyAt(i);
      if (f.buffer.length > RULES.MAX_FILE_BYTES) return { error: 'FILE_TOO_LARGE' };
      const mime = sniffMime(f.buffer);
      if (!mime) return { error: 'FILE_TYPE' };
      const slot = slots.find((s) => s.key === docKey);
      if (slot && slot.pdfOnly && mime !== 'application/pdf') return { error: 'PLAN_NOT_PDF' };
      const name = path.basename(String(f.originalname)).slice(0, 200) || 'file';
      files.push({ docKey, name, size: f.buffer.length, mime, content: f.buffer });
    }
    // เอกสารชนิดเดียวกัน (ที่ไม่ใช่ "เพิ่มเติม") แทนที่ไฟล์เดิม · รวมแล้วไม่เกิน 5 ไฟล์ต่อคำขอ
    const replaced = new Set(files.filter((f) => f.docKey !== 'extra').map((f) => f.docKey));
    const keep = qCaseFiles.all(c.case_no).filter((r) => !replaced.has(r.doc_key)).length;
    const dupKeys = files.filter((f) => f.docKey !== 'extra').length !== replaced.size;
    if (dupKeys) return { error: 'BAD_REQUEST' };
    if (keep + files.length > RULES.MAX_FILES_PER_CASE) return { error: 'FILE_COUNT' };
    return { files, replaced: [...replaced] };
  }

  const resubmitTx = db.transaction((req) => {
    const c = dbm.getCase(caseNoOf(req));
    if (!c || c.user_id !== req.user.id) return { error: 'NOT_FOUND' }; // ของคนอื่น = ไม่มีจริง (BR-22)
    const now = clock.nowISO();
    if (c.status === 'CANCELLED' && c.returned_at) return { error: 'FIX_WINDOW_EXPIRED' }; // ถูกยกเลิกอัตโนมัติแล้ว
    if (c.status !== 'NEED_FIX') return { error: 'INVALID_STATE' };
    const deadline = fixDeadlineOf(c);
    if (deadline && clock.cmp(now, deadline) >= 0) {
      cancelExpired(c, deadline); // กันกรณี hook ยังไม่ได้ทำ (ผลยกเลิกต้อง commit แม้ตอบ 409)
      return { error: 'FIX_WINDOW_EXPIRED' };
    }
    const prep = prepareFixFiles(req, c);
    if (prep.error) return prep;
    // BR-13: กำหนดเสร็จใหม่ = เดิม + วันทำการใน (วันที่ตีกลับ, วันที่ส่งแก้] · ตารางวันหยุด ณ ตอนส่งแก้ (B04 อยู่ใน lib/sla)
    const dueAt = sla.extendDueAt(c.due_at, c.returned_at, now);
    const info = updResubmit.run({ caseNo: c.case_no, dueAt, now });
    if (!info.changes) return { error: 'INVALID_STATE' };
    for (const key of prep.replaced || []) delCaseFileKey.run(c.case_no, key);
    const added = [];
    for (const f of prep.files) {
      const id = dbm.next.fileId();
      insCaseFile.run({ id, caseNo: c.case_no, docKey: f.docKey, name: f.name, size: f.size, mime: f.mime, content: f.content, at: now, by: req.user.id });
      added.push({ fileId: id, name: f.name, docKey: f.docKey, size: f.size });
    }
    audit.timeline({
      caseNo: c.case_no, event: 'RESUBMIT', from: 'NEED_FIX', to: 'IN_REVIEW', actor: null, role: 'citizen', at: now,
      detail: added.length ? `${RESUBMIT_DETAIL} (แนบไฟล์ใหม่ ${added.length} ไฟล์)` : RESUBMIT_DETAIL,
    });
    return {
      body: {
        caseNo: c.case_no, status: 'IN_REVIEW', dueAt, slaLevel: sla.slaLevel({ status: 'IN_REVIEW', due_at: dueAt }),
        owner: c.owner || null, files: added,
      },
    };
  });
  app.post('/api/cases/:caseNo/resubmit', citizenOnly, upload.any(), (req, res) => send(res, resubmitTx.immediate(req)));

  // ------------------------------------------------------------------ หัวหน้า: รายการรออนุมัติ (CONTRACT 2.8 · BR-16)
  function pendingApprovals() {
    const hs = sla.holidays();
    return qPending.all().map((r) => ({
      caseNo: r.case_no, serviceId: r.service_id, applicantName: r.applicant || '',
      step: r.service_id === 'SV-03' && r.step ? r.step : null,
      status: r.status, dueAt: r.due_at, slaLevel: sla.slaLevel(r, undefined, hs),
    }));
  }

  app.get('/api/head/approvals', headOnly, (req, res) => res.json({ items: pendingApprovals() }));

  app.get('/head/approvals', headOnly, (req, res) => {
    const items = pendingApprovals();
    const rows = items.map((it) => `<tr data-testid="approval-row" data-case-no="${esc(it.caseNo)}" data-sla-level="${esc(it.slaLevel || '')}">
  <td data-testid="row-case-no">${esc(it.caseNo)}</td>
  <td data-testid="row-service">${esc(serviceLabel(it.serviceId))}</td>
  <td data-testid="row-applicant">${esc(it.applicantName)}</td>
  <td>${timeTag(it.dueAt, 'row-due')}</td>
  <td>${it.slaLevel ? levelBadge(it.slaLevel, 'row-sla-level') : '–'}</td>
  <td><a data-testid="approval-open" class="btn btn-secondary" href="/officer/cases/${encodeURIComponent(it.caseNo)}">เปิดคำขอ</a></td>
</tr>`).join('\n');
    const table = items.length
      ? `<div class="table-wrap"><table data-testid="approval-table" aria-labelledby="approvals-title">
<thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th><th scope="col">ดำเนินการ</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`
      : '<p data-testid="approvals-empty" class="card">ไม่มีคำขอรออนุมัติ</p>';
    const body = `<h1 id="approvals-title">รายการรออนุมัติ</h1>
<p class="muted">คำขอที่รอหัวหน้าฝ่ายพิจารณา <strong data-testid="approval-count">${items.length}</strong> รายการ · เรียงตามกำหนดเสร็จเร็วสุดก่อน (เท่ากันเรียงตามเลขคำขอ)</p>
${table}`;
    return views.render(req, res, { title: 'รายการรออนุมัติ', body });
  });

  ctx.workflow = { actionsFor, issuerOf, isHolder, nextStep, fixDeadlineOf, autoCancelDue, approverOf };
};
