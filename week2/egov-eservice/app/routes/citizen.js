'use strict';
// B06 · ประชาชน: แคตตาล็อก + ค่าธรรมเนียม + ร่าง + แนบไฟล์ + รายการ/หน้าคำขอ + ยกเลิกคำขอ
// (REQUIREMENTS FR-04..07 FR-09 FR-10 · BR-04..08 BR-22 · CONTRACT 2.4–2.6 · 6.2)
//
// API ที่ไฟล์นี้เป็นเจ้าของ
//   POST   /api/drafts                      สร้างร่าง (คำนวณค่าธรรมเนียม BR-04/05)
//   GET    /api/drafts                      ร่าง/รอชำระของฉัน
//   GET    /api/drafts/:id                  ร่าง + files + missing + payment ล่าสุด (สถานะ EXPIRED คิดจากนาฬิกา)
//   PATCH  /api/drafts/:id  (PUT ก็ได้)     แก้จำนวนฉบับ/พื้นที่ (เฉพาะ DRAFT)
//   DELETE /api/drafts/:id                  ลบร่าง DRAFT / PENDING_PAYMENT ที่ยังไม่ชำระ (ลบ QR ของร่างด้วย → ref เป็น 404)
//   POST   /api/drafts/:id/files            แนบไฟล์ (multipart: file, docKey) ตรวจ magic bytes ขนาด จำนวน แบบแปลน PDF
//   DELETE /api/drafts/:id/files/:fileId    ลบไฟล์แนบของร่าง
//   GET    /api/cases                       คำขอที่มีเลขแล้วของฉัน
//   GET    /api/cases/:caseNo               citizen เจ้าของ (idNo เต็ม) · officer/head (idMasked เท่านั้น) · อื่น 403
//   POST   /api/cases/:caseNo/cancel        ยกเลิก SUBMITTED ที่ยังไม่มีผู้รับ (atomic กับการรับเรื่อง)
//   GET    /api/cases/:caseNo/files · GET /api/files/:fileId  — เฉพาะส่วนของประชาชน (เจ้าของ 200 · คนอื่น 404)
//                                           บทบาทอื่นส่งต่อ next() ให้ routes/officer.js (BR-29)
// หน้า: /citizen · /citizen/new/:service(?draft=) · /citizen/cases/:caseNo · /citizen/qr/:ref (รูป QR ชำระเงินจำลอง)
//
// บั๊กที่ฝัง (BUGS.md): B01 พื้นที่ 101 คิดฐาน (ใช้ > 101) · B02 ไฟล์ 5,242,880 ไบต์ถูกปฏิเสธ · B06 IDOR หน้า/API คำขอ
//
// ctx.citizen (ให้บล็อกอื่นใช้ เช่น routes/payment.js):
//   calcFee(serviceId, {qty, areaSqm}) → {fee, qty, areaSqm} | {error:'INVALID_QTY'|…}
//   currentFee(draftRow)   ยอดปัจจุบันของร่าง (DRAFT คิดใหม่จากค่าบริการปัจจุบัน · PENDING_PAYMENT = ยอดที่ล็อก)
//   missingDocs(draftRow)  ชื่อเอกสารบังคับที่ยังขาด เรียงตาม CONTRACT 4.3 เช่น ['แบบแปลน','โฉนด']
//   draftFiles(draftId)    [{fileId,name,docKey,size,mime}]
//   paymentView(row)       แปลงแถว payments → {ref,amount,status(PENDING|PAID|EXPIRED),qrCreatedAt,qrExpiresAt,paidAt,caseNo,receiptNo}
//   slaLevel(caseRow, nowISO?) ระดับเตือนตาม BR-14

const path = require('path');
const QRCode = require('qrcode');
const pages = require('../views/citizen/pages');

module.exports = function registerCitizen(app, ctx) {
  const { db, dbm, tx, clock, isBug, crypto: pii, audit, views, apiError, requireRole, requireLogin, upload, wrap, config, C } = ctx;
  const { SERVICE_DOCS, RULES, STATUS_TH } = C;

  const citizenOnly = requireRole('citizen');

  // ---------------------------------------------------------------- ค่าธรรมเนียม (BR-04 BR-05)
  /** จำนวนเต็มจาก number หรือสตริงตัวเลข · อย่างอื่น NaN */
  function toInt(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
    if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v.trim());
    return NaN;
  }

  function calcFee(serviceId, input = {}) {
    const svc = dbm.getService(serviceId);
    if (!svc) return { error: 'BAD_REQUEST' };
    if (serviceId === 'SV-01') {
      const qty = toInt(input.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 5) return { error: 'INVALID_QTY' };
      return { fee: svc.fee * qty, qty, areaSqm: null };
    }
    if (serviceId === 'SV-03') {
      const raw = input.areaSqm !== undefined ? input.areaSqm : input.area;
      const area = toInt(raw);
      if (!Number.isInteger(area) || area < 1) return { error: 'INVALID_AREA' };
      if (area > 500) return { error: 'AREA_TOO_LARGE' };
      // ส่วนเกิน 100 ตร.ม. คิด ตร.ม. ละ feePerSqm · พื้นที่ ≥ 101 · BUG B01: ใช้ > 101 (101 ได้ราคาฐาน)
      const extraFrom = isBug('B01') ? 102 : 101;
      const fee = area >= extraFrom ? svc.fee + (svc.feePerSqm || 0) * (area - 100) : svc.fee;
      return { fee, qty: null, areaSqm: area };
    }
    return { fee: svc.fee, qty: null, areaSqm: null };
  }

  function currentFee(d) {
    if (d.status === 'DRAFT') {
      const r = calcFee(d.service_id, { qty: d.qty, areaSqm: d.area_sqm });
      if (!r.error) return r.fee;
    }
    return d.fee;
  }

  // ---------------------------------------------------------------- ร่าง / ไฟล์
  const qDraft = db.prepare('SELECT * FROM drafts WHERE id = ?');
  const qMyDrafts = db.prepare(`SELECT * FROM drafts WHERE user_id = ? AND status IN ('DRAFT','PENDING_PAYMENT') ORDER BY id DESC`);
  const qDraftFiles = db.prepare('SELECT id, name, doc_key, size, mime FROM attachments WHERE draft_id = ? ORDER BY uploaded_at, id');
  const qDraftFileCount = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE draft_id = ?');
  const qCaseFiles = db.prepare('SELECT id, name, doc_key, size, mime FROM attachments WHERE case_no = ? ORDER BY uploaded_at, id');
  const qFile = db.prepare('SELECT * FROM attachments WHERE id = ?');
  const qPayments = db.prepare(`SELECT * FROM payments WHERE draft_id = ? ORDER BY (status = 'PAID') DESC, qr_created_at DESC, ref DESC`);
  const qPayment = db.prepare('SELECT * FROM payments WHERE ref = ?');
  const qPaidCount = db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE draft_id = ? AND status = 'PAID'`);

  const mapFile = (f) => ({ fileId: f.id, name: f.name, docKey: f.doc_key, size: f.size, mime: f.mime });
  const draftFiles = (draftId) => qDraftFiles.all(draftId).map(mapFile);

  function missingDocs(d) {
    const keys = new Set(qDraftFiles.all(d.id).map((f) => f.doc_key));
    return (SERVICE_DOCS[d.service_id] || []).filter((x) => x.required && !keys.has(x.key)).map((x) => x.name);
  }

  /** สถานะ QR: PAID ตามที่เก็บ · EXPIRED เมื่ออายุ ≥ 15:00 (BR-10) · ไม่เช่นนั้น PENDING */
  function paymentView(p) {
    if (!p) return null;
    let status = p.status === 'PAID' ? 'PAID' : 'PENDING';
    if (status !== 'PAID') {
      const ageMs = clock.nowMs() - clock.toMs(p.qr_created_at);
      const ttl = RULES.QR_TTL_MINUTES * 60000;
      // ให้ตรงกับฝั่งชำระเงินเมื่อเปิด BUG B05 (อายุ 15:00 พอดียังจ่ายได้)
      if (isBug('B05') ? ageMs > ttl : ageMs >= ttl) status = 'EXPIRED';
    }
    return {
      ref: p.ref, amount: p.amount, status, qrCreatedAt: p.qr_created_at, qrExpiresAt: p.qr_expires_at,
      paidAt: p.paid_at || null, caseNo: p.case_no || null, receiptNo: p.receipt_no || null,
    };
  }

  function draftView(d, withDetail) {
    const out = {
      draftId: d.id, serviceId: d.service_id, status: d.status, fee: currentFee(d),
      qty: d.qty, areaSqm: d.area_sqm, caseNo: d.case_no || null, createdAt: d.created_at, updatedAt: d.updated_at,
    };
    if (withDetail) {
      out.files = draftFiles(d.id);
      out.missing = missingDocs(d);
      out.payment = paymentView(qPayments.get(d.id));
      // BR-08: เอกสารบังคับไม่ครบ (เช่นลบแผนที่ตั้งหลังสร้าง QR) → ระงับ QR ที่ยังไม่ชำระ ต้องแนบให้ครบก่อน
      out.paymentBlocked = out.missing.length > 0 && !(out.payment && out.payment.status === 'PAID');
    }
    return out;
  }

  /** ร่างของผู้ใช้นี้ · ของคนอื่น/ไม่มี → null (ตอบ 404 เหมือนกัน) */
  function ownDraft(req, id) {
    const d = qDraft.get(String(id || ''));
    if (!d || d.user_id !== req.user.id) return null;
    return d;
  }

  /** ตรวจชนิดจาก magic bytes เท่านั้น (BR-06) */
  function sniffMime(buf) {
    if (!buf || buf.length < 3) return null;
    if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf'; // %PDF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    return null;
  }

  // ---------------------------------------------------------------- คำขอ
  const qMyCases = db.prepare('SELECT * FROM cases WHERE user_id = ? ORDER BY case_no DESC');
  const qDoc = db.prepare('SELECT doc_no, verify_code FROM documents WHERE case_no = ?');

  /** ระดับเตือน (BR-14 · CONTRACT 4.2) · วันคงเหลือ = วันทำการใน (วันนี้, วันกำหนด] */
  function slaLevel(c, nowISO) {
    const now = nowISO || clock.nowISO();
    if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(c.status)) return 'closed';
    if (c.status === 'NEED_FIX') return 'paused';
    const due = c.due_at || c.dueAt;
    if (!due) return 'normal';
    if (clock.cmp(now, due) > 0) return 'overdue';
    const holidays = dbm.holidaySet();
    const end = clock.ymd(due);
    let d = clock.ymd(now);
    let left = 0;
    while (d < end && left < 2) {
      d = clock.addDays(d, 1);
      const w = clock.dow(`${d}T12:00:00+07:00`);
      if (w !== 0 && w !== 6 && !holidays.has(d)) left += 1;
    }
    return left >= 2 ? 'normal' : 'near';
  }

  /** citizen เห็นได้เฉพาะของตัวเอง (BR-22) · BUG B06: ไม่ตรวจเจ้าของ */
  function citizenCanSee(req, c) {
    if (!c) return false;
    if (isBug('B06')) return true;
    return c.user_id === req.user.id;
  }

  function caseJson(c, viewer) {
    const applicant = dbm.getUserById(c.user_id);
    const idNo = dbm.userIdNo(applicant);
    const doc = qDoc.get(c.case_no);
    const out = {
      caseNo: c.case_no, serviceId: c.service_id, status: c.status,
      step: c.service_id === 'SV-03' && c.step ? c.step : null,
      fee: c.fee, qty: c.qty, areaSqm: c.area_sqm, paidAt: c.paid_at, receiptNo: c.receipt_no,
      dueAt: c.due_at, slaLevel: slaLevel(c),
      owner: c.owner || null, returnCount: c.return_count || 0, closedAt: c.closed_at || null, cancelledAt: c.cancelled_at || null,
      applicantName: applicant ? applicant.name : null,
      fixDeadline: c.status === 'NEED_FIX' ? c.fix_deadline || null : null,
      returnReason: c.return_reason || null,
      docNo: c.doc_no || (doc && doc.doc_no) || null, verifyCode: doc ? doc.verify_code : null,
    };
    // PDPA (BR-24 · CONTRACT 6.7): ประชาชนเจ้าของได้เลขเต็ม · เจ้าหน้าที่/หัวหน้าได้เฉพาะเลขปิดบัง
    if (viewer === 'citizen') out.idNo = idNo;
    else out.idMasked = pii.maskId(idNo);
    return out;
  }

  // ---------------------------------------------------------------- API: ร่าง
  // FR-07 กันบันทึกซ้ำ: หน้า wizard ส่ง clientKey (สุ่มครั้งเดียวต่อการเปิดหน้า) มากับ POST
  // คำขอซ้ำที่ใช้ key เดิมของผู้ใช้เดิมได้ร่างเดิมกลับไป ไม่สร้างร่างใหม่ (การเรียก API ที่ไม่ส่ง key ทำงานตามปกติ)
  const draftKeys = new Map(); // `${userId}|${clientKey}` → draftId
  if (ctx.hooks && ctx.hooks.onReset) ctx.hooks.onReset('citizen-draft-keys', () => draftKeys.clear());

  app.post('/api/drafts', citizenOnly, (req, res) => {
    const b = req.body || {};
    const serviceId = String(b.serviceId || '');
    if (!dbm.getService(serviceId)) return apiError(res, 'BAD_REQUEST');
    const r = calcFee(serviceId, b);
    if (r.error) return apiError(res, r.error);
    const ck = typeof b.clientKey === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(b.clientKey) ? `${req.user.id}|${b.clientKey}` : null;
    let dup = null;
    const d = tx(() => {
      if (ck && draftKeys.has(ck)) {
        const prev = ownDraft(req, draftKeys.get(ck));
        if (prev && prev.status === 'DRAFT' && prev.service_id === serviceId) {
          db.prepare('UPDATE drafts SET qty = ?, area_sqm = ?, fee = ?, updated_at = ? WHERE id = ?')
            .run(r.qty, r.areaSqm, r.fee, clock.nowISO(), prev.id);
          dup = true;
          return qDraft.get(prev.id);
        }
      }
      const id = dbm.next.draftId();
      const now = clock.nowISO();
      db.prepare(`INSERT INTO drafts (id, user_id, service_id, qty, area_sqm, fee, status, case_no, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', NULL, ?, ?)`).run(id, req.user.id, serviceId, r.qty, r.areaSqm, r.fee, now, now);
      if (ck) draftKeys.set(ck, id);
      return qDraft.get(id);
    });
    return res.status(dup ? 200 : 201).json(draftView(d, false));
  });

  app.get('/api/drafts', citizenOnly, (req, res) => {
    res.json({ items: qMyDrafts.all(req.user.id).map((d) => draftView(d, false)) });
  });

  app.get('/api/drafts/:id', citizenOnly, (req, res) => {
    const d = ownDraft(req, req.params.id);
    if (!d) return apiError(res, 'NOT_FOUND');
    return res.json(draftView(d, true));
  });

  const updateDraft = (req, res) => {
    const b = req.body || {};
    const out = tx(() => {
      const d = ownDraft(req, req.params.id);
      if (!d) return { error: 'NOT_FOUND' };
      if (d.status !== 'DRAFT') return { error: 'INVALID_STATE' };
      const r = calcFee(d.service_id, b);
      if (r.error) return { error: r.error };
      db.prepare('UPDATE drafts SET qty = ?, area_sqm = ?, fee = ?, updated_at = ? WHERE id = ?')
        .run(r.qty, r.areaSqm, r.fee, clock.nowISO(), d.id);
      return { draft: qDraft.get(d.id) };
    });
    if (out.error) return apiError(res, out.error);
    return res.json(draftView(out.draft, false));
  };
  app.patch('/api/drafts/:id', citizenOnly, updateDraft);
  app.put('/api/drafts/:id', citizenOnly, updateDraft);

  app.delete('/api/drafts/:id', citizenOnly, (req, res) => {
    const out = tx(() => {
      const d = ownDraft(req, req.params.id);
      if (!d) return 'NOT_FOUND';
      if (!['DRAFT', 'PENDING_PAYMENT'].includes(d.status) || d.case_no || qPaidCount.get(d.id).n > 0) return 'INVALID_STATE';
      db.prepare('DELETE FROM attachments WHERE draft_id = ? AND case_no IS NULL').run(d.id);
      db.prepare('DELETE FROM payments WHERE draft_id = ?').run(d.id);
      db.prepare('DELETE FROM drafts WHERE id = ?').run(d.id);
      return null;
    });
    if (out) return apiError(res, out);
    return res.status(204).end();
  });

  // ---------------------------------------------------------------- API: ไฟล์แนบของร่าง (BR-06 BR-07 BR-08)
  app.post('/api/drafts/:id/files', citizenOnly, upload.single('file'), (req, res) => {
    const f = req.file;
    const docKey = String((req.body && req.body.docKey) || 'extra');
    const out = tx(() => {
      const d = ownDraft(req, req.params.id);
      if (!d) return { error: 'NOT_FOUND' };
      if (!['DRAFT', 'PENDING_PAYMENT'].includes(d.status) || d.case_no) return { error: 'INVALID_STATE' };
      const slot = docKey === 'extra' ? { key: 'extra' } : (SERVICE_DOCS[d.service_id] || []).find((x) => x.key === docKey);
      if (!slot || !f || !f.buffer) return { error: 'BAD_REQUEST' };
      const size = f.buffer.length;
      // ≤ 5,242,880 ไบต์ผ่าน · BUG B02: ใช้ < (5,242,880 พอดีถูกปฏิเสธ)
      const tooBig = isBug('B02') ? size >= RULES.MAX_FILE_BYTES : size > RULES.MAX_FILE_BYTES;
      if (tooBig) return { error: 'FILE_TOO_LARGE' };
      const mime = sniffMime(f.buffer);
      if (!mime) return { error: 'FILE_TYPE' };
      if (slot.pdfOnly && mime !== 'application/pdf') return { error: 'PLAN_NOT_PDF' };
      if (qDraftFileCount.get(d.id).n >= RULES.MAX_FILES_PER_CASE) return { error: 'FILE_COUNT' };
      const name = path.basename(String(f.originalname || 'file')).slice(0, 200) || 'file';
      const fileId = dbm.next.fileId();
      const now = clock.nowISO();
      db.prepare(`INSERT INTO attachments (id, draft_id, case_no, doc_key, name, size, mime, content, uploaded_at, uploaded_by)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`).run(fileId, d.id, docKey, name, size, mime, f.buffer, now, req.user.id);
      db.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(now, d.id);
      return { file: { fileId, name, docKey, size, mime } };
    });
    if (out.error) return apiError(res, out.error);
    return res.status(201).json(out.file);
  });

  app.delete('/api/drafts/:id/files/:fileId', citizenOnly, (req, res) => {
    const out = tx(() => {
      const d = ownDraft(req, req.params.id);
      if (!d) return 'NOT_FOUND';
      const f = qFile.get(req.params.fileId);
      if (!f || f.draft_id !== d.id) return 'NOT_FOUND';
      if (!['DRAFT', 'PENDING_PAYMENT'].includes(d.status) || d.case_no || f.case_no) return 'INVALID_STATE';
      db.prepare('DELETE FROM attachments WHERE id = ?').run(f.id);
      db.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(clock.nowISO(), d.id);
      return null;
    });
    if (out) return apiError(res, out);
    return res.status(204).end();
  });

  // ---------------------------------------------------------------- API: คำขอ
  app.get('/api/cases', citizenOnly, (req, res) => {
    const now = clock.nowISO();
    res.json({
      items: qMyCases.all(req.user.id).map((c) => ({
        caseNo: c.case_no, serviceId: c.service_id, status: c.status, dueAt: c.due_at, slaLevel: slaLevel(c, now),
        fee: c.fee, paidAt: c.paid_at, step: c.service_id === 'SV-03' && c.step ? c.step : null,
      })),
    });
  });

  app.get('/api/cases/:caseNo', requireRole('citizen', 'officer', 'head'), (req, res) => {
    const c = dbm.getCase(req.params.caseNo);
    if (req.user.role === 'citizen') {
      if (!citizenCanSee(req, c)) return apiError(res, 'NOT_FOUND');
      return res.json(caseJson(c, 'citizen'));
    }
    if (!c) return apiError(res, 'NOT_FOUND');
    return res.json(caseJson(c, 'staff'));
  });

  // ยกเลิก (FR-10 · BR-22 · A-62): ตรวจ+อัปเดตใน transaction เดียว (synchronous) → ชนกับรับเรื่องสำเร็จฝั่งเดียว
  const cancelTx = db.transaction((req) => {
    const c = dbm.getCase(req.params.caseNo);
    if (!c || c.user_id !== req.user.id) return { error: 'NOT_FOUND' };
    if (c.status === 'SUBMITTED' && !c.owner) {
      const now = clock.nowISO();
      const r = db.prepare(`UPDATE cases SET status = 'CANCELLED', cancelled_at = ?, dept = NULL, owner = NULL, updated_at = ?
        WHERE case_no = ? AND status = 'SUBMITTED' AND owner IS NULL`).run(now, now, c.case_no);
      if (r.changes !== 1) return { error: 'CANNOT_CANCEL' };
      audit.timeline({ caseNo: c.case_no, event: 'CANCEL', from: 'SUBMITTED', to: 'CANCELLED', actor: null, role: 'citizen', at: now });
      return { status: 'CANCELLED' };
    }
    if (['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED'].includes(c.status)) return { error: 'CANNOT_CANCEL' };
    return { error: 'INVALID_STATE' };
  });
  app.post('/api/cases/:caseNo/cancel', citizenOnly, (req, res) => {
    const out = cancelTx.immediate(req);
    if (out.error) return apiError(res, out.error);
    return res.json(out);
  });

  // ไฟล์แนบ: ส่วนของประชาชน (เจ้าของเท่านั้น · คนอื่น 404) · บทบาทอื่นให้ routes/officer.js ตัดสิน (BR-29)
  app.get('/api/cases/:caseNo/files', requireLogin, (req, res, next) => {
    if (req.user.role !== 'citizen') return next();
    const c = dbm.getCase(req.params.caseNo);
    if (!c || c.user_id !== req.user.id) return apiError(res, 'NOT_FOUND');
    return res.json({ items: qCaseFiles.all(c.case_no).map(mapFile) });
  });

  app.get('/api/files/:fileId', requireLogin, (req, res, next) => {
    if (req.user.role !== 'citizen') return next();
    const f = qFile.get(req.params.fileId);
    let ok = false;
    if (f && f.case_no) {
      const c = dbm.getCase(f.case_no);
      ok = !!c && c.user_id === req.user.id;
    } else if (f && f.draft_id) {
      ok = !!ownDraft(req, f.draft_id);
    }
    if (!ok) return apiError(res, 'NOT_FOUND');
    res.set('Content-Type', f.mime);
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return res.send(f.content);
  });

  // ---------------------------------------------------------------- หน้า
  const pageCtx = { views, clock, C, config, STATUS_TH };

  app.get('/citizen', citizenOnly, (req, res) => {
    const now = clock.nowISO();
    const cases = qMyCases.all(req.user.id).map((c) => ({ ...c, level: slaLevel(c, now) }));
    const drafts = qMyDrafts.all(req.user.id).map((d) => ({ ...d, fee: currentFee(d) }));
    views.render(req, res, {
      title: 'คำขอของฉัน',
      body: pages.home(pageCtx, { user: req.user, services: dbm.listServices(), cases, drafts }),
      scripts: pages.homeScript(),
    });
  });

  app.get('/citizen/new/:service', citizenOnly, (req, res) => {
    const svc = dbm.getService(req.params.service);
    if (!svc) return views.notFound(req, res, 'ไม่พบบริการ');
    let draft = null;
    if (req.query.draft) {
      const d = ownDraft(req, req.query.draft);
      if (!d) return views.notFound(req, res);
      if (d.service_id !== svc.id) return res.redirect(302, `/citizen/new/${d.service_id}?draft=${encodeURIComponent(d.id)}`);
      draft = draftView(d, true);
    }
    const errors = {};
    for (const k of ['INVALID_QTY', 'INVALID_AREA', 'AREA_TOO_LARGE', 'FILE_TOO_LARGE', 'FILE_TYPE', 'FILE_COUNT', 'PLAN_NOT_PDF']) {
      errors[k] = C.ERRORS[k][1];
    }
    const state = {
      serviceId: svc.id,
      fee: svc.fee,
      feePerSqm: svc.feePerSqm || 0,
      extraFrom: isBug('B01') ? 102 : 101,
      docs: SERVICE_DOCS[svc.id],
      errors,
      draft,
      statusTh: C.PAYMENT_STATUS_TH,
    };
    return views.render(req, res, {
      title: `ยื่นคำขอ ${svc.name}`,
      body: pages.wizard(pageCtx, { svc, draft }),
      scripts: pages.wizardScript(state),
    });
  });

  app.get('/citizen/cases/:caseNo', citizenOnly, wrap(async (req, res) => {
    const c = dbm.getCase(req.params.caseNo);
    if (!citizenCanSee(req, c)) return views.notFound(req, res);
    const applicant = dbm.getUserById(c.user_id);
    const doc = qDoc.get(c.case_no);
    const verifyUrl = doc ? `${config.BASE_URL}/verify/${doc.verify_code}` : null;
    const docQr = verifyUrl ? await QRCode.toDataURL(verifyUrl, { margin: 1, width: 160 }) : null;
    const now = clock.nowISO();
    const timeline = audit.timelineOf(c.case_no).map((e) => ({ ...e, actorName: e.actor ? dbm.staffName(e.actor) : null }));
    return views.render(req, res, {
      title: `คำขอ ${c.case_no}`,
      body: pages.caseDetail(pageCtx, {
        c,
        level: slaLevel(c, now),
        idFull: pii.formatId(dbm.userIdNo(applicant)),
        files: qCaseFiles.all(c.case_no).map(mapFile),
        doc: doc ? { docNo: doc.doc_no, verifyCode: doc.verify_code, verifyUrl, qr: docQr } : null,
        timeline,
        canCancel: c.status === 'SUBMITTED' && !c.owner,
        canFix: c.status === 'NEED_FIX' && !!c.fix_deadline && clock.cmp(now, c.fix_deadline) < 0,
      }),
      scripts: pages.caseScript(c.case_no),
    });
  }));

  /** รูป QR ชำระเงินจำลอง (SVG) ของร่างตัวเอง */
  app.get('/citizen/qr/:ref', citizenOnly, wrap(async (req, res) => {
    const p = qPayment.get(String(req.params.ref).replace(/\.svg$/, ''));
    const d = p && ownDraft(req, p.draft_id);
    if (!d) return views.notFound(req, res, 'ไม่พบ QR');
    if (p.status !== 'PAID') {
      const miss = missingDocs(d); // BR-08: เอกสารไม่ครบ → ไม่ออกรูป QR
      if (miss.length) return res.status(409).json({ code: 'MISSING_DOCS', message: C.ERRORS.MISSING_DOCS[1] + miss.join(', ') });
    }
    const svg = await QRCode.toString(`PROMPTPAY-SIMULATED|${p.ref}|${p.amount}|เทศบาลนครก็อตแทม`, { type: 'svg', margin: 1 });
    res.type('image/svg+xml').send(svg);
  }));

  ctx.citizen = { calcFee, currentFee, missingDocs, draftFiles, paymentView, slaLevel, sniffMime };
};
