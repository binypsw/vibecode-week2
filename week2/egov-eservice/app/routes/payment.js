'use strict';
// B07 · ชำระเงิน PromptPay จำลอง + เลขคำขอ + ใบเสร็จ (DECISIONS §6–7 · BR-09 BR-10 BR-11 · CONTRACT 6.2 / 8)
//
//   POST /api/drafts/:id/payment        citizen เจ้าของร่าง → 201 {ref, amount, qrCreatedAt, qrExpiresAt}
//                                       ล็อกยอดตอนเข้า PENDING_PAYMENT (QR ใหม่ของร่างเดิมใช้ยอดที่ล็อก) · 409 MISSING_DOCS · 409 INVALID_STATE
//   GET  /api/payments/:ref             citizen เจ้าของ → {ref, amount, status PENDING|PAID|EXPIRED, qrCreatedAt, qrExpiresAt, paidAt, caseNo, receiptNo}
//   POST /api/test/payments/:ref/pay    ธนาคารจำลองยิง callback {amount} (server.js ตอบ 404 ให้เองเมื่อไม่ใช่ TEST_MODE)
//                                       200 {status:'PAID', caseNo, receiptNo, duplicate} · 410 QR_EXPIRED · 422 AMOUNT_MISMATCH · 404
//   GET  /citizen/receipts/:receiptNo   หน้าใบเสร็จ (พิมพ์ได้) ของคำขอตัวเอง
//
// กฎ:
//   - QR ใช้ได้ถ้า (เวลาชำระ − เวลาสร้าง) < 15:00 นาที · BUG B05: ใช้ ≤ (อายุ 15:00 พอดียังจ่ายได้)
//   - ยอดต้องเท่ายอดที่ล็อกใน payments.amount พอดี (จำนวนเต็ม)
//   - callback ซ้ำ ref เดิม → 200 duplicate:true เลขเดิม ไม่สร้างรายการใหม่
//   - ออกเลข EG-/RC- ตามปี พ.ศ. ของเวลาชำระ ภายใน tx เดียวกับการ insert (better-sqlite3 sync → ไม่ซ้ำเมื่อยิงพร้อมกัน)
//   - dueAt = sla.dueAt(paidAt, SLA ปัจจุบันของบริการ) คำนวณครั้งเดียวตอนชำระ

const sla = require('../lib/sla');

module.exports = function registerPayment(app, ctx) {
  const { db, dbm, tx, clock, isBug, audit, views, apiError, requireRole, requireLogin, wrap, C } = ctx;
  const TTL_MS = (C.RULES && C.RULES.QR_TTL_MINUTES ? C.RULES.QR_TTL_MINUTES : 15) * 60000;
  const citizenOnly = requireRole('citizen');

  const qDraft = db.prepare('SELECT * FROM drafts WHERE id = ?');
  const qPayment = db.prepare('SELECT * FROM payments WHERE ref = ?');
  const qPaidOfDraft = db.prepare(`SELECT * FROM payments WHERE draft_id = ? AND status = 'PAID' LIMIT 1`);
  const insPayment = db.prepare(`INSERT INTO payments (ref, draft_id, amount, status, qr_created_at, qr_expires_at)
    VALUES (?, ?, ?, 'PENDING', ?, ?)`);
  const lockDraft = db.prepare(`UPDATE drafts SET status = 'PENDING_PAYMENT', fee = ?, updated_at = ? WHERE id = ?`);
  const insCase = db.prepare(`INSERT INTO cases (case_no, year_be, seq, draft_id, user_id, service_id, qty, area_sqm, fee, status, step, dept,
      owner, issuer, return_count, paid_at, receipt_no, due_at, created_at, updated_at)
    VALUES (@case_no, @year_be, @seq, @draft_id, @user_id, @service_id, @qty, @area_sqm, @fee, 'SUBMITTED', @step, @dept,
      NULL, NULL, 0, @paid_at, @receipt_no, @due_at, @paid_at, @paid_at)`);
  const markPaid = db.prepare(`UPDATE payments SET status = 'PAID', paid_at = ?, case_no = ?, receipt_no = ? WHERE ref = ? AND status <> 'PAID'`);
  const submitDraft = db.prepare(`UPDATE drafts SET status = 'SUBMITTED', case_no = ?, updated_at = ? WHERE id = ?`);
  const moveFiles = db.prepare('UPDATE attachments SET case_no = ? WHERE draft_id = ?');
  const qCaseByReceipt = db.prepare('SELECT * FROM cases WHERE receipt_no = ?');

  // ---------------------------------------------------------------- ตัวช่วย
  const helpers = () => ctx.citizen || {};

  /** อายุ QR หมดหรือยัง ณ เวลา atMs (BR-10 · BUG B05 ใช้ > แทน ≥) */
  function isExpired(p, atMs) {
    const age = atMs - clock.toMs(p.qr_created_at);
    return isBug('B05') ? age > TTL_MS : age >= TTL_MS;
  }

  function view(p) {
    if (helpers().paymentView) return helpers().paymentView(p);
    const status = p.status === 'PAID' ? 'PAID' : isExpired(p, clock.nowMs()) ? 'EXPIRED' : 'PENDING';
    return {
      ref: p.ref, amount: p.amount, status, qrCreatedAt: p.qr_created_at, qrExpiresAt: p.qr_expires_at,
      paidAt: p.paid_at || null, caseNo: p.case_no || null, receiptNo: p.receipt_no || null,
    };
  }

  function missingDocs(d) {
    return helpers().missingDocs ? helpers().missingDocs(d) : [];
  }
  function missingResponse(res, miss) {
    const msg = C.missingDocsMessage ? C.missingDocsMessage(miss) : C.ERRORS.MISSING_DOCS[1] + miss.join(', ');
    return res.status(409).json({ code: 'MISSING_DOCS', message: msg, missing: miss });
  }

  /** ยอดที่ต้องล็อก: DRAFT = ค่าธรรมเนียมปัจจุบัน · PENDING_PAYMENT = ยอดที่ล็อกไว้แล้ว */
  function lockedFee(d) {
    if (d.status === 'PENDING_PAYMENT') return d.fee;
    return helpers().currentFee ? helpers().currentFee(d) : d.fee;
  }

  /** จำนวนเต็มจาก number หรือสตริงตัวเลข · อย่างอื่น NaN */
  function toInt(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
    if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v.trim());
    return NaN;
  }

  // ---------------------------------------------------------------- สร้าง QR
  app.post('/api/drafts/:id/payment', citizenOnly, (req, res) => {
    const result = tx(() => {
      const d = qDraft.get(String(req.params.id || ''));
      if (!d || d.user_id !== req.user.id) return { error: 'NOT_FOUND' };
      if (!['DRAFT', 'PENDING_PAYMENT'].includes(d.status) || d.case_no || qPaidOfDraft.get(d.id)) return { error: 'INVALID_STATE' };
      const miss = missingDocs(d);
      if (miss.length) return { missing: miss };
      const amount = lockedFee(d);
      if (!Number.isInteger(amount) || amount < 0) return { error: 'INVALID_STATE' };
      const now = clock.nowISO();
      const expires = clock.toISO(clock.toMs(now) + TTL_MS);
      const ref = dbm.next.paymentRef();
      insPayment.run(ref, d.id, amount, now, expires);
      lockDraft.run(amount, now, d.id);
      return { ref, amount, qrCreatedAt: now, qrExpiresAt: expires };
    });
    if (result.missing) return missingResponse(res, result.missing);
    if (result.error) return apiError(res, result.error);
    return res.status(201).json(result);
  });

  // ---------------------------------------------------------------- อ่านสถานะ QR
  app.get('/api/payments/:ref', requireLogin, (req, res) => {
    const p = qPayment.get(String(req.params.ref || ''));
    const d = p && qDraft.get(p.draft_id);
    if (!p || !d) return apiError(res, 'NOT_FOUND');
    // ref ของคนอื่น = ไม่มี (ไม่เปิดเผยว่ามีอยู่)
    if (req.user.role !== 'citizen' || d.user_id !== req.user.id) return apiError(res, 'NOT_FOUND');
    return res.json(view(p));
  });

  // ---------------------------------------------------------------- callback ธนาคารจำลอง (TEST_MODE)
  app.post('/api/test/payments/:ref/pay', (req, res) => {
    const body = req.body || {};
    const result = tx(() => {
      const p = qPayment.get(String(req.params.ref || ''));
      if (!p) return { error: 'NOT_FOUND' };
      // idempotent: ref นี้จ่ายแล้ว → ตอบเลขเดิม
      if (p.status === 'PAID') {
        return { ok: { status: 'PAID', caseNo: p.case_no, receiptNo: p.receipt_no, duplicate: true } };
      }
      const nowISO = clock.nowISO();
      if (isExpired(p, clock.toMs(nowISO))) return { error: 'QR_EXPIRED' };
      const amount = toInt(body.amount);
      if (amount !== p.amount) return { error: 'AMOUNT_MISMATCH' };

      const d = qDraft.get(p.draft_id);
      if (!d) return { error: 'NOT_FOUND' };
      // ร่างนี้ถูกจ่ายด้วย ref อื่นไปแล้ว / ไม่อยู่ในสถานะรอชำระ
      if (d.case_no || d.status !== 'PENDING_PAYMENT' || qPaidOfDraft.get(d.id)) return { error: 'INVALID_STATE' };
      const miss = missingDocs(d);
      if (miss.length) return { missing: miss };
      const svc = dbm.getService(d.service_id);
      if (!svc) return { error: 'INVALID_STATE' };

      const paidAt = nowISO;
      const cn = dbm.next.caseNo(paidAt);
      const rc = dbm.next.receiptNo(paidAt);
      const dueAt = sla.dueAt(paidAt, svc.sla);
      insCase.run({
        case_no: cn.caseNo, year_be: cn.yearBE, seq: cn.seq, draft_id: d.id, user_id: d.user_id, service_id: d.service_id,
        qty: d.qty == null ? null : d.qty, area_sqm: d.area_sqm == null ? null : d.area_sqm, fee: p.amount,
        step: d.service_id === 'SV-03' ? 1 : null, dept: 'registry',
        paid_at: paidAt, receipt_no: rc.receiptNo, due_at: dueAt,
      });
      const r = markPaid.run(paidAt, cn.caseNo, rc.receiptNo, p.ref);
      if (r.changes !== 1) throw new Error('payment state changed concurrently');
      submitDraft.run(cn.caseNo, paidAt, d.id);
      moveFiles.run(cn.caseNo, d.id);
      audit.timeline({ caseNo: cn.caseNo, at: paidAt, event: 'SUBMITTED', from: 'PENDING_PAYMENT', to: 'SUBMITTED', actor: null, role: 'citizen' });
      return { ok: { status: 'PAID', caseNo: cn.caseNo, receiptNo: rc.receiptNo, duplicate: false } };
    });
    if (result.missing) return missingResponse(res, result.missing);
    if (result.error) return apiError(res, result.error);
    return res.status(200).json(result.ok);
  });

  // ---------------------------------------------------------------- หน้าใบเสร็จ
  app.get('/citizen/receipts/:receiptNo', citizenOnly, wrap(async (req, res) => {
    const c = qCaseByReceipt.get(String(req.params.receiptNo || ''));
    if (!c || c.user_id !== req.user.id) return views.notFound(req, res);
    const svc = dbm.getService(c.service_id) || {};
    const esc = views.esc;
    const body = `
<section class="card" aria-labelledby="h-receipt">
  <h1 id="h-receipt">ใบเสร็จรับเงิน (จำลอง)</h1>
  <p class="muted">เทศบาลนครก็อตแทม · ชำระผ่าน PromptPay QR จำลอง</p>
  <dl class="kv">
    <dt>เลขใบเสร็จ</dt><dd data-testid="receipt-no">${esc(c.receipt_no)}</dd>
    <dt>เลขคำขอ</dt><dd data-testid="submitted-case-no">${esc(c.case_no)}</dd>
    <dt>บริการ</dt><dd>${esc(svc.name || c.service_id)}</dd>
    <dt>ยอดชำระ</dt><dd data-testid="receipt-amount">${esc(views.money(c.fee))}</dd>
    <dt>ชำระเมื่อ</dt><dd>${views.timeTag(c.paid_at, 'receipt-paid-at')}</dd>
  </dl>
  <div class="actions">
    <a class="btn" data-testid="go-case-btn" href="/citizen/cases/${encodeURIComponent(c.case_no)}">ดูคำขอ</a>
    <button type="button" class="btn btn-secondary" onclick="window.print()">พิมพ์ใบเสร็จ</button>
  </div>
</section>`;
    return views.render(req, res, { title: `ใบเสร็จ ${c.receipt_no}`, body });
  }));

  ctx.payment = { isExpired, view };
};
