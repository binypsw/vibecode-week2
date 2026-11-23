'use strict';
// B08 · คิวเจ้าหน้าที่ + รับเรื่อง + รายละเอียดคำขอ (มุมเจ้าหน้าที่/หัวหน้า) + แสดงเลขเต็ม + ไฟล์แนบ
// ที่มา: REQUIREMENTS FR-12 FR-13 FR-21 FR-29 · BR-16 BR-17 BR-18 BR-24 BR-29 · A-18 A-19 A-24 A-27 A-28 A-32 A-34 A-59 A-62
//        CONTRACT 1 · 2.6 · 2.7 · 5 · 6.2 (ไฟล์) · 6.3 · DECISIONS ข้อ 9 · 11 · 18
//
// API ที่ไฟล์นี้เป็นเจ้าของ
//   GET  /api/officer/queue?filter=all|unclaimed|mine     officer (แผนกตัวเอง) · head (ทุกแผนก อ่านอย่างเดียว)
//        → {items:[{caseNo,serviceId,applicantName,idMasked,status,step,owner,dueAt,slaLevel}], filter, workload}
//          เรียง BR-16: กำหนดเสร็จเร็วก่อน · เท่ากันเลขคำขอน้อยก่อน · ห้ามมี idNo/เลข 13 หลัก (BR-24)
//   POST /api/officer/cases/:caseNo/claim                 officer แผนกที่คำขออยู่ · ลำดับตรวจ: สิทธิ์ → ALREADY_CLAIMED → WORKLOAD_LIMIT
//        → 200 {owner, status:'IN_REVIEW', caseNo, workload} + Audit CLAIM (+ ไทม์ไลน์)
//   POST /api/officer/cases/:caseNo/unmask                officer · head · {reason} ไม่ว่างหลังตัดช่องว่าง (A-32)
//        → 200 {idNo, idFormatted} + Audit UNMASK (detail = เหตุผล)
//   GET  /api/cases/:caseNo/files · GET /api/files/:fileId   ส่วนของเจ้าหน้าที่ (BR-29 · A-59)
//        officer = แผนกตัวเอง ขั้นปัจจุบันหรือเคยผ่าน · head = ทุกแผนก · executive/auditor/admin = 403
//        (routes/citizen.js ตอบส่วนของประชาชนก่อนแล้ว next() มาที่นี่ · ไฟล์นี้มีส่วนประชาชนสำรองไว้ด้วยเผื่อไม่มี)
// หน้า
//   /officer/queue            queue-filter queue-table queue-row(+row-*) claim-btn workload-count queue-empty
//   /officer/cases/:caseNo    ข้อมูลคำขอ + ปุ่มดำเนินการตามสิทธิ์ (ปุ่มที่ทำไม่ได้ "ไม่ render" · CONTRACT 0.5)
//                             ปุ่มเรียก API: claim/unmask (ไฟล์นี้) · return/forward/approve/reject (routes/workflow.js)
//                             · issue (routes/documents.js)
//
// บั๊กที่ฝัง (BUGS.md · เปลี่ยนเฉพาะจุด):
//   B08 → claim ไม่ตรวจว่ามีผู้ถือแล้ว (คนที่ 2 ได้ 200 และกลายเป็นผู้ถือแทน · Audit CLAIM เพิ่มอีกแถว)
//   B09 → GET /api/officer/queue ใส่ idNo (เลขเต็ม) ในทุกแถว (หน้าจอยังปิดบัง)
//   B11 → unmask สำเร็จแต่ไม่บันทึก Audit UNMASK
//   (B12 ของ routes/workflow.js: หน้านี้ยัง render return-btn เมื่อตีกลับครบ 2 ครั้ง ตามอาการใน BUGS.md)
//
// ctx.officer (ให้บล็อกอื่นใช้ เช่น /head/approvals · Dashboard):
//   workloadOf(username)          จำนวน IN_REVIEW ที่ถือ (BR-18)
//   byQueueOrder(a, b)            ตัวเปรียบเทียบ BR-16 สำหรับแถว cases (due_at, case_no)
//   issuerOf(caseRow)             ผู้ออกเอกสาร (A-27) — SV-01 = ผู้อนุมัติ · SV-02/03 = ทะเบียนที่รับเรื่องขั้นแรก
//   canSeeFiles(user, caseRow)    สิทธิ์ไฟล์แนบของเจ้าหน้าที่/หัวหน้า (BR-29)
//   deptReached(caseRow, dept)    คำขออยู่ที่/เคยผ่านขั้นของแผนกนั้นแล้ว

const QRCode = require('qrcode');
const sla = require('../lib/sla');

const CLAIMABLE = ['SUBMITTED', 'IN_REVIEW'];
const QUEUE_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'APPROVED']; // A-34 (NEED_FIX / PENDING_APPROVAL ไม่อยู่ในคิว)
const FILTERS = ['all', 'unclaimed', 'mine'];
const FILTER_TH = { all: 'ทั้งหมด', unclaimed: 'ยังไม่มีผู้รับ', mine: 'ของฉัน' };
const EVENT_TH = {
  SUBMITTED: 'ชำระเงินและส่งคำขอ', CLAIM: 'รับเรื่อง', RETURN: 'ตีกลับให้แก้ไข', RESUBMIT: 'ประชาชนส่งแก้ไข',
  FORWARD: 'ผ่าน/ส่งต่อ', APPROVE: 'อนุมัติ', REJECT: 'ไม่อนุมัติ', ISSUE: 'ออกเอกสาร',
  CANCEL: 'ประชาชนยกเลิกคำขอ', AUTO_CANCEL: 'ยกเลิกอัตโนมัติ (เกินเวลาแก้ไข 168 ชม.)',
};

module.exports = function registerOfficer(app, ctx) {
  const { db, dbm, clock, isBug, crypto: pii, audit, views, render, apiError, requireRole, requireLogin, wrap, config, C } = ctx;
  const { esc, attr, money, timeTag, statusBadge, levelBadge, serviceLabel } = views;
  const { RULES, SV03_STEP_TH, DEPT_TH, ROLE_TH, DOC_TYPES } = C;
  const MAX_WORKLOAD = (RULES && RULES.MAX_WORKLOAD) || 10;
  const MAX_RETURNS = (RULES && RULES.MAX_RETURNS) || 2;

  const staffOnly = requireRole('officer', 'head');
  const officerOnly = requireRole('officer');

  // ------------------------------------------------------------------ คำสั่ง SQL
  const qWorkload = db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE owner = ? AND status = 'IN_REVIEW'`);
  const qQueueDept = db.prepare(`SELECT c.*, u.name AS applicant_name, u.id_no_enc AS applicant_id_enc
    FROM cases c JOIN users u ON u.id = c.user_id
    WHERE c.status IN ('SUBMITTED','IN_REVIEW','APPROVED') AND c.dept = ?`);
  const qQueueAll = db.prepare(`SELECT c.*, u.name AS applicant_name, u.id_no_enc AS applicant_id_enc
    FROM cases c JOIN users u ON u.id = c.user_id
    WHERE c.status IN ('SUBMITTED','IN_REVIEW','APPROVED') AND c.dept IS NOT NULL`);
  const qCaseFiles = db.prepare('SELECT id, name, doc_key, size, mime FROM attachments WHERE case_no = ? ORDER BY uploaded_at, id');
  const qFile = db.prepare('SELECT * FROM attachments WHERE id = ?');
  const qDocByCase = db.prepare('SELECT doc_no, verify_code, issued_at, signer FROM documents WHERE case_no = ?');

  // ------------------------------------------------------------------ กฎ
  function workloadOf(username) {
    return username ? qWorkload.get(username).n : 0;
  }

  /** BR-16 · A-18: กำหนดเสร็จเร็วก่อน · เท่ากันเลขคำขอน้อยก่อน (ปี พ.ศ. แล้วลำดับ) */
  function byQueueOrder(a, b) {
    const da = clock.toMs(a.due_at);
    const dbb = clock.toMs(b.due_at);
    if (da !== dbb) return da - dbb;
    if (a.year_be !== b.year_be) return (a.year_be || 0) - (b.year_be || 0);
    if (a.seq !== b.seq) return (a.seq || 0) - (b.seq || 0);
    return a.case_no < b.case_no ? -1 : a.case_no > b.case_no ? 1 : 0;
  }

  function routeOf(serviceId) {
    const svc = dbm.getService(serviceId);
    if (svc && Array.isArray(svc.route)) return svc.route;
    return (C.SERVICES[serviceId] && C.SERVICES[serviceId].route) || ['registry'];
  }

  /** คำขออยู่ที่ขั้นของแผนก dept หรือเคยผ่านแล้ว (A-59) · ทุกคำขอที่ชำระแล้วเข้าขั้นแรก (ทะเบียน) เสมอ */
  function deptReached(c, dept) {
    if (!c || !dept) return false;
    if (c.dept === dept) return true;
    const route = routeOf(c.service_id);
    const idx = route.indexOf(dept);
    if (idx < 0) return false;
    if (idx === 0) return true;
    return (Number(c.step) || 1) >= idx + 1; // SV-03: โยธา = ขั้น 2
  }

  /** BR-29: officer = แผนกตนเอง (ขั้นปัจจุบัน/เคยผ่าน) · head = ทุกแผนก · บทบาทอื่น = ไม่ได้ */
  function canSeeFiles(user, c) {
    if (!user || !c) return false;
    if (user.role === 'head') return true;
    if (user.role === 'officer') return deptReached(c, user.dept);
    return false;
  }

  /** A-27: ผู้ออกเอกสาร (ให้ตรงกับ routes/documents.js) */
  function issuerOf(c) {
    if (!c) return null;
    return c.service_id === 'SV-01' ? (c.approved_by || c.issuer) : c.issuer;
  }

  function stepOf(c) {
    return c.service_id === 'SV-03' && c.step ? Number(c.step) : null;
  }

  const idCache = () => {
    const m = new Map();
    return (enc) => {
      if (!enc) return null;
      if (!m.has(enc)) {
        let v = null;
        try { v = pii.decrypt(enc); } catch (_) { v = null; }
        m.set(enc, v);
      }
      return m.get(enc);
    };
  };

  /** แถวคิวของผู้ใช้ (เรียง BR-16 แล้วกรอง) */
  function queueFor(user, filter) {
    const f = FILTERS.includes(filter) ? filter : 'all';
    const rows = (user.role === 'head' ? qQueueAll.all() : qQueueDept.all(user.dept || '')).sort(byQueueOrder);
    if (f === 'unclaimed') return rows.filter((c) => CLAIMABLE.includes(c.status) && !c.owner);
    if (f === 'mine') return rows.filter((c) => c.status === 'IN_REVIEW' && c.owner && c.owner === user.username);
    return rows;
  }

  /** ปุ่ม "รับเรื่อง" แสดงเมื่อเจ้าหน้าที่คนนี้รับได้ (แผนกตรง · ยังไม่มีผู้ถือ · SUBMITTED/IN_REVIEW) · ไม่ดูงานในมือ (ตรวจตอนกด) */
  function canClaimView(user, c) {
    return !!user && user.role === 'officer' && !!c.dept && c.dept === user.dept && !c.owner && CLAIMABLE.includes(c.status);
  }

  // ------------------------------------------------------------------ API: คิว (BR-16 · A-34 · BR-24)
  app.get('/api/officer/queue', staffOnly, (req, res) => {
    const u = req.user;
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    const hs = sla.holidays();
    const now = clock.nowMs();
    const dec = idCache();
    const leakFullId = isBug('B09'); // BUG B09: ส่งเลขบัตรเต็มใน API คิว
    const items = queueFor(u, filter).map((c) => {
      const idNo = dec(c.applicant_id_enc);
      const item = {
        caseNo: c.case_no,
        serviceId: c.service_id,
        applicantName: c.applicant_name,
        idMasked: pii.maskId(idNo),
        status: c.status,
        step: stepOf(c),
        owner: c.owner || null,
        dueAt: c.due_at,
        slaLevel: sla.slaLevel(c, now, hs),
      };
      if (leakFullId) item.idNo = idNo;
      return item;
    });
    const out = { filter, items };
    if (u.role === 'officer') out.workload = workloadOf(u.username);
    res.json(out);
  });

  // ------------------------------------------------------------------ API: รับเรื่อง (BR-17 · BR-18 · A-28 · A-62)
  // better-sqlite3 เป็น synchronous: ตรวจ + UPDATE แบบมีเงื่อนไขใน transaction เดียว → ยิงพร้อมกันได้ผู้ชนะคนเดียว
  const claimTx = db.transaction((req, caseNo) => {
    const u = req.user;
    const c = dbm.getCase(caseNo);
    if (!c) return { error: 'NOT_FOUND' };
    // 1) สิทธิ์: เฉพาะเจ้าหน้าที่ของแผนกที่คำขออยู่ (ข้ามแผนก → 403)
    if (c.dept && c.dept !== u.dept) return { error: 'FORBIDDEN' };
    // 2) มีผู้ถือแล้ว (รวมตัวเอง) → 409 · BUG B08: ข้ามการตรวจนี้
    const skipOwnerCheck = isBug('B08');
    if (!skipOwnerCheck && c.owner) return { error: 'ALREADY_CLAIMED' };
    // สถานะที่รับไม่ได้ (ยกเลิก/ปิด/รออนุมัติ/อนุมัติแล้ว) → 409 INVALID_STATE (A-62: ยกเลิกชนรับเรื่อง)
    if (!CLAIMABLE.includes(c.status) || !c.dept) return { error: 'INVALID_STATE' };
    // 3) งานในมือ (ตรวจเฉพาะตอนรับเรื่อง · A-19)
    if (workloadOf(u.username) >= MAX_WORKLOAD) return { error: 'WORKLOAD_LIMIT' };

    const now = clock.nowISO();
    const r = db.prepare(`UPDATE cases
      SET status = 'IN_REVIEW', owner = @me,
          issuer = CASE WHEN issuer IS NULL AND dept = 'registry' THEN @me ELSE issuer END,
          updated_at = @now
      WHERE case_no = @caseNo AND status IN ('SUBMITTED','IN_REVIEW') AND dept = @dept
        ${skipOwnerCheck ? '' : 'AND owner IS NULL'}`).run({ me: u.username, now, caseNo: c.case_no, dept: c.dept });
    if (r.changes !== 1) return { error: 'ALREADY_CLAIMED' };
    audit.log(req, { event: 'CLAIM', caseNo: c.case_no, from: c.status, to: 'IN_REVIEW', detail: '', time: now });
    return { caseNo: c.case_no, owner: u.username, status: 'IN_REVIEW', workload: workloadOf(u.username) };
  });

  app.post('/api/officer/cases/:caseNo/claim', officerOnly, (req, res) => {
    const out = claimTx.immediate(req, req.params.caseNo);
    if (out.error) return apiError(res, out.error);
    return res.json(out);
  });

  // ------------------------------------------------------------------ API: แสดงเลขเต็ม (BR-24 · A-32)
  app.post('/api/officer/cases/:caseNo/unmask', staffOnly, (req, res) => {
    const c = dbm.getCase(req.params.caseNo);
    if (!c) return apiError(res, 'NOT_FOUND');
    const raw = req.body ? req.body.reason : undefined;
    const reason = raw == null ? '' : String(raw).trim();
    if (!reason) return apiError(res, 'REASON_REQUIRED'); // ความพยายามที่ผิดไม่บันทึก Audit
    const idNo = dbm.userIdNo(dbm.getUserById(c.user_id));
    if (!idNo) return apiError(res, 'NOT_FOUND');
    if (!isBug('B11')) audit.log(req, { event: 'UNMASK', caseNo: c.case_no, detail: reason }); // BUG B11: ไม่บันทึก
    return res.json({ caseNo: c.case_no, idNo, idFormatted: pii.formatId(idNo) });
  });

  // ------------------------------------------------------------------ API: ไฟล์แนบ (BR-29 · A-59)
  const mapFile = (f) => ({ fileId: f.id, name: f.name, docKey: f.doc_key, size: f.size });

  // attachment (ไม่ใช้แอตทริบิวต์ download ที่ลิงก์ เพราะ Chromium จะข้าม page.route() ของ Playwright)
  function sendFile(res, f) {
    res.set('Content-Type', f.mime || 'application/octet-stream');
    const ascii = String(f.name || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name || 'file')}`);
    return res.send(f.content);
  }

  app.get('/api/cases/:caseNo/files', requireLogin, (req, res) => {
    const u = req.user;
    const c = dbm.getCase(req.params.caseNo);
    if (u.role === 'citizen') { // สำรอง (ปกติ routes/citizen.js ตอบไปแล้ว)
      if (!c || c.user_id !== u.id) return apiError(res, 'NOT_FOUND');
      return res.json({ items: qCaseFiles.all(c.case_no).map(mapFile) });
    }
    if (u.role !== 'officer' && u.role !== 'head') return apiError(res, 'FORBIDDEN');
    if (!c) return apiError(res, 'NOT_FOUND');
    if (!canSeeFiles(u, c)) return apiError(res, 'FORBIDDEN');
    return res.json({ items: qCaseFiles.all(c.case_no).map(mapFile) });
  });

  app.get('/api/files/:fileId', requireLogin, (req, res) => {
    const u = req.user;
    const f = qFile.get(req.params.fileId);
    if (u.role === 'citizen') { // สำรอง (ปกติ routes/citizen.js ตอบไปแล้ว)
      const c = f && f.case_no ? dbm.getCase(f.case_no) : null;
      if (!f || !c || c.user_id !== u.id) return apiError(res, 'NOT_FOUND');
      return sendFile(res, f);
    }
    if (u.role !== 'officer' && u.role !== 'head') return apiError(res, 'FORBIDDEN');
    if (!f || !f.case_no) return apiError(res, 'NOT_FOUND'); // ไฟล์ของร่าง (ยังไม่ชำระ) ไม่ใช่ของเจ้าหน้าที่
    const c = dbm.getCase(f.case_no);
    if (!c) return apiError(res, 'NOT_FOUND');
    if (!canSeeFiles(u, c)) return apiError(res, 'FORBIDDEN');
    return sendFile(res, f);
  });

  // ------------------------------------------------------------------ หน้า: คิวงาน (CONTRACT 2.7)
  app.get('/officer/queue', staffOnly, (req, res) => {
    const u = req.user;
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    const hs = sla.holidays();
    const now = clock.nowMs();
    const dec = idCache();
    const rows = queueFor(u, filter);
    const isHead = u.role === 'head';
    const scope = isHead ? 'ทุกแผนก (อ่านอย่างเดียว)' : DEPT_TH[u.dept] || u.dept || '–';

    const trs = rows.map((c) => {
      const level = sla.slaLevel(c, now, hs);
      const claimable = canClaimView(u, c);
      const href = `/officer/cases/${encodeURIComponent(c.case_no)}`;
      return `<tr${attr({ 'data-testid': 'queue-row', 'data-case-no': c.case_no, 'data-owner': c.owner || '', 'data-status': c.status, 'data-sla-level': level })}>
  <td data-testid="row-case-no"><a href="${esc(href)}">${esc(c.case_no)}</a></td>
  <td data-testid="row-service">${esc(serviceLabel(c.service_id))}${stepOf(c) ? `<br><span class="muted">${esc(SV03_STEP_TH[stepOf(c)] || '')}</span>` : ''}</td>
  <td data-testid="row-applicant">${esc(c.applicant_name)}</td>
  <td data-testid="row-id-masked">${esc(pii.maskId(dec(c.applicant_id_enc)))}</td>
  <td>${statusBadge(c.status, 'row-status')}</td>
  <td>${timeTag(c.due_at, 'row-due')}</td>
  <td>${levelBadge(level, 'row-sla-level')}</td>
  <td data-testid="row-owner">${esc(c.owner || '')}</td>
  <td>${claimable ? `<button type="button" class="btn" data-testid="claim-btn" data-case-no="${esc(c.case_no)}" aria-label="รับเรื่อง ${esc(c.case_no)}">รับเรื่อง</button>` : ''}</td>
</tr>`;
    }).join('\n');

    const options = FILTERS.map((f) => `<option value="${f}"${f === filter ? ' selected' : ''}>${esc(FILTER_TH[f])}</option>`).join('');
    const body = `
<h1>คิวงาน · ${esc(scope)}</h1>
<div class="card">
  ${isHead ? '<p class="muted">หัวหน้าฝ่ายดูคิวของทุกแผนกได้แบบอ่านอย่างเดียว · อนุมัติที่เมนู “รออนุมัติ”</p>'
    : `<p>งานในมือของฉัน (กำลังตรวจสอบ): <strong data-testid="workload-count">${workloadOf(u.username)}</strong> / ${MAX_WORKLOAD} เรื่อง</p>`}
  <form method="get" action="/officer/queue" class="queue-filter-form" id="queue-filter-form">
    <label for="queue-filter">แสดงรายการ</label>
    <select id="queue-filter" name="filter" data-testid="queue-filter">${options}</select>
    <noscript><button type="submit" class="btn btn-secondary">กรอง</button></noscript>
  </form>
  <p class="muted">เรียงตามกำหนดเสร็จเร็วสุดก่อน · กำหนดเท่ากันเรียงเลขคำขอน้อยไปมาก</p>
</div>
${rows.length ? '' : '<p data-testid="queue-empty" class="card">ไม่มีงานในคิว</p>'}
<div class="table-wrap" role="region" aria-label="ตารางคิวงาน" tabindex="0">
<table data-testid="queue-table">
  <thead><tr>
    <th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">ผู้ยื่น</th><th scope="col">เลขบัตร</th>
    <th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th><th scope="col">ผู้ถือเรื่อง</th><th scope="col">ดำเนินการ</th>
  </tr></thead>
  <tbody>
${trs}
  </tbody>
</table>
</div>`;

    const scripts = `<script>
(function(){
  var sel=document.getElementById('queue-filter');
  if(sel){sel.addEventListener('change',function(){location.href='/officer/queue?filter='+encodeURIComponent(sel.value)})}
  var TH=${JSON.stringify({ IN_REVIEW: C.STATUS_TH.IN_REVIEW })};
  Array.prototype.forEach.call(document.querySelectorAll('[data-testid="claim-btn"]'),function(btn){
    btn.addEventListener('click',function(){
      var caseNo=btn.getAttribute('data-case-no');
      App.clearMessages();btn.disabled=true;
      App.api('POST','/api/officer/cases/'+encodeURIComponent(caseNo)+'/claim').then(function(r){
        if(!r.ok){btn.disabled=false;return}
        var row=btn.closest('[data-testid="queue-row"]');
        if(row){
          row.setAttribute('data-owner',r.data.owner||'');
          row.setAttribute('data-status','IN_REVIEW');
          var o=row.querySelector('[data-testid="row-owner"]');if(o)o.textContent=r.data.owner||'';
          var s=row.querySelector('[data-testid="row-status"]');
          if(s){s.setAttribute('data-status','IN_REVIEW');s.textContent=TH.IN_REVIEW;s.className='badge st-in_review'}
        }
        var w=App.el('workload-count');if(w&&typeof r.data.workload==='number')w.textContent=String(r.data.workload);
        var cell=btn.parentNode;btn.remove();
        if(cell){var a=document.createElement('a');a.href='/officer/cases/'+encodeURIComponent(caseNo);a.textContent='เปิดคำขอ';cell.appendChild(a)}
        App.showSuccess('รับเรื่อง '+caseNo+' แล้ว');
      });
    });
  });
})();
</script>`;
    render(req, res, { title: 'คิวงาน', body, scripts });
  });

  // ------------------------------------------------------------------ หน้า: รายละเอียดคำขอ (CONTRACT 2.6 ฝั่ง officer)
  function actionsFor(u, c) {
    const a = { claim: false, ret: false, forward: false, approve: false, reject: false, issue: false };
    if (!u) return a;
    const svc = dbm.getService(c.service_id) || C.SERVICES[c.service_id] || {};
    const approver = svc.approver || (c.service_id === 'SV-01' ? 'officer' : 'head');
    a.claim = canClaimView(u, c);
    const holder = u.role === 'officer' && c.status === 'IN_REVIEW' && !!c.owner && c.owner === u.username && c.dept === u.dept;
    if (holder) {
      // ตีกลับ: ไม่ render เมื่อครบ 2 ครั้ง (BR-19) · BUG B12 (routes/workflow.js) ปุ่มยังแสดง
      a.ret = (c.return_count || 0) < MAX_RETURNS || isBug('B12');
      if (approver === 'officer') {
        a.approve = true; // SV-01: ผู้ถือเรื่องตัดสินเอง
        a.reject = true;
      } else {
        a.forward = true; // SV-02/03: ส่งต่อตามเส้นทาง (ทะเบียน → (โยธา) → หัวหน้า) · ไม่มีช่องเลือกปลายทาง
      }
    }
    if (u.role === 'head' && c.status === 'PENDING_APPROVAL' && approver === 'head') {
      a.approve = true;
      a.reject = true;
    }
    if (u.role === 'officer' && c.status === 'APPROVED' && issuerOf(c) === u.username) a.issue = true;
    return a;
  }

  function reasonForm(kind, label, submitText, errTestid) {
    return `<form id="${kind}-form" class="reason-form card" hidden novalidate>
      <label for="${kind}-reason">${esc(label)}</label>
      <textarea id="${kind}-reason" name="reason" rows="3" data-testid="${kind}-reason" aria-describedby="${kind}-reason-hint"></textarea>
      <p id="${kind}-reason-hint" class="muted">อย่างน้อย 10 ตัวอักษร (ไม่นับช่องว่างหัวท้าย)</p>
      <p data-testid="${errTestid}" class="error" role="alert" hidden></p>
      <div class="actions"><button type="submit" class="btn${kind === 'reject' ? ' btn-danger' : ''}" data-testid="${kind}-submit">${esc(submitText)}</button></div>
    </form>`;
  }

  app.get('/officer/cases/:caseNo', staffOnly, wrap(async (req, res) => {
    const u = req.user;
    const c = dbm.getCase(req.params.caseNo);
    if (!c) return views.notFound(req, res);
    const applicant = dbm.getUserById(c.user_id);
    const idMasked = pii.maskId(dbm.userIdNo(applicant)); // ห้ามใส่เลขเต็มใน HTML (TC-PDPA-01)
    const level = sla.slaLevel(c);
    const step = stepOf(c);
    const act = actionsFor(u, c);
    const doc = qDocByCase.get(c.case_no);
    const docNo = c.doc_no || (doc && doc.doc_no) || null;
    const verifyCode = doc ? doc.verify_code : null;
    const verifyUrl = verifyCode ? `${config.BASE_URL}/verify/${verifyCode}` : null;
    let qrSrc = '';
    if (verifyUrl) {
      try { qrSrc = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 160 }); } catch (_) { qrSrc = ''; }
    }
    const files = canSeeFiles(u, c) ? qCaseFiles.all(c.case_no) : null;
    const events = audit.timelineOf(c.case_no);
    const enc = encodeURIComponent(c.case_no);

    const ownerText = c.owner ? c.owner : 'ยังไม่มีผู้รับ';
    const where = c.dept ? DEPT_TH[c.dept] || c.dept : c.status === 'PENDING_APPROVAL' ? 'หัวหน้าฝ่าย' : '–';

    const info = `
<dl class="kv">
  <dt>สถานะ</dt><dd>${statusBadge(c.status)}</dd>
  <dt>บริการ</dt><dd data-testid="case-service">${esc(serviceLabel(c.service_id))}</dd>
  ${step ? `<dt>ขั้นตอน</dt><dd data-testid="case-step">${esc(SV03_STEP_TH[step] || '')}</dd>` : ''}
  <dt>รายละเอียด</dt><dd>${c.service_id === 'SV-01' && c.qty ? `${esc(c.qty)} ฉบับ` : c.service_id === 'SV-03' && c.area_sqm ? `${esc(c.area_sqm)} ตร.ม.` : '–'}</dd>
  <dt>ค่าธรรมเนียม</dt><dd data-testid="case-fee">${esc(money(c.fee))}</dd>
  <dt>ชำระเมื่อ</dt><dd>${timeTag(c.paid_at, 'case-paid-at')} · ใบเสร็จ ${esc(c.receipt_no)}</dd>
  <dt>ผู้ยื่น</dt><dd data-testid="applicant-name">${esc(applicant ? applicant.name : '–')}</dd>
  <dt>เลขบัตรประชาชน</dt>
  <dd>
    <span data-testid="applicant-id">${esc(idMasked)}</span>
    <span id="full-id-slot"></span>
    <button type="button" class="btn btn-secondary" data-testid="show-full-id-btn" aria-controls="unmask-form" aria-expanded="false">แสดงเลขเต็ม</button>
    <form id="unmask-form" class="reason-form" hidden novalidate>
      <label for="unmask-reason">เหตุผลที่ขอดูเลขบัตรเต็ม (บันทึกใน Audit)</label>
      <input type="text" id="unmask-reason" name="reason" data-testid="unmask-reason" autocomplete="off">
      <p data-testid="unmask-error" class="error" role="alert" hidden></p>
      <div class="actions"><button type="submit" class="btn" data-testid="unmask-submit">ยืนยันแสดงเลขเต็ม</button></div>
    </form>
  </dd>
  <dt>กำหนดเสร็จ</dt><dd>${timeTag(c.due_at, 'sla-due')}</dd>
  <dt>ระดับเตือน</dt><dd>${levelBadge(level)}</dd>
  <dt>อยู่ที่</dt><dd>${esc(where)}</dd>
  <dt>ผู้ถือเรื่อง</dt><dd data-testid="case-owner">${esc(ownerText)}</dd>
  <dt>ตีกลับแล้ว</dt><dd><span data-testid="return-count">${esc(c.return_count || 0)}</span> / ${MAX_RETURNS} ครั้ง</dd>
  ${c.status === 'NEED_FIX' && c.fix_deadline ? `<dt>เส้นตายแก้ไขของประชาชน</dt><dd>${timeTag(c.fix_deadline, 'officer-fix-deadline')}</dd>` : ''}
  ${c.return_reason && (c.status === 'NEED_FIX' || c.return_count) ? `<dt>เหตุผลตีกลับล่าสุด</dt><dd>${esc(c.return_reason)}</dd>` : ''}
  ${['COMPLETED', 'REJECTED'].includes(c.status) && c.closed_at ? `<dt>ปิดงานเมื่อ</dt><dd>${timeTag(c.closed_at, 'closed-at')}</dd>` : ''}
  ${c.status === 'CANCELLED' && c.cancelled_at ? `<dt>ยกเลิกเมื่อ</dt><dd>${timeTag(c.cancelled_at, 'cancelled-at')}</dd>` : ''}
</dl>`;

    const docBlock = docNo ? `
<section class="card" aria-labelledby="doc-h">
  <h2 id="doc-h">เอกสารดิจิทัล</h2>
  <dl class="kv">
    <dt>เลขเอกสาร</dt><dd data-testid="doc-no">${esc(docNo)}</dd>
    ${verifyCode ? `<dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code">${esc(verifyCode)}</dd>` : ''}
    ${doc && doc.signer ? `<dt>ผู้ลงนาม</dt><dd>${esc(doc.signer)}</dd>` : ''}
  </dl>
  ${verifyUrl ? `<p><img data-testid="doc-qr"${attr({ 'data-url': verifyUrl, src: qrSrc || null, alt: `QR ตรวจสอบเอกสาร ${docNo}`, width: 160, height: 160 })}></p>
  <p><a href="${esc(verifyUrl)}">${esc(verifyUrl)}</a></p>` : ''}
</section>` : '';

    const filesBlock = files === null
      ? '<p class="muted">ไม่มีสิทธิ์เปิดไฟล์แนบของคำขอนี้ (เจ้าหน้าที่เห็นเฉพาะคำขอที่อยู่หรือเคยผ่านขั้นของแผนกตนเอง)</p>'
      : files.length
        ? `<ul class="doc-list">${files.map((f) => `<li data-testid="doc-item"${attr({ 'data-name': f.name, 'data-file-id': f.id, 'data-doc-key': f.doc_key })}>
      ${esc((DOC_TYPES && DOC_TYPES[f.doc_key]) || f.doc_key)} · ${esc(f.name)} <span class="muted">(${esc(Math.max(1, Math.round(f.size / 1024)))} KB)</span>
      <a data-testid="doc-download-link"${attr({ href: `/api/files/${encodeURIComponent(f.id)}` })}>ดาวน์โหลด ${esc(f.name)}</a>
    </li>`).join('')}</ul>`
        : '<p class="muted">ไม่มีไฟล์แนบ</p>';

    const timeline = `<ol data-testid="case-timeline" class="timeline">${events.map((e) => `<li data-testid="timeline-item"${attr({ 'data-iso': e.at, 'data-event': e.event })}>
      ${timeTag(e.at, null)} · <strong>${esc(EVENT_TH[e.event] || e.event)}</strong>${e.actor ? ` · ${esc(e.actor)}` : e.role === 'citizen' ? ' · ผู้ยื่น' : e.role === 'system' ? ' · ระบบ' : ''}${e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus ? ` <span class="muted">(${esc(C.STATUS_TH[e.fromStatus] || e.fromStatus)} → ${esc(C.STATUS_TH[e.toStatus] || e.toStatus)})</span>` : ''}${e.detail ? `<br><span class="muted">${esc(e.detail)}</span>` : ''}
    </li>`).join('')}</ol>`;

    const anyAction = act.claim || act.ret || act.forward || act.approve || act.reject || act.issue;
    const actions = `
<section class="card" aria-labelledby="act-h">
  <h2 id="act-h">ดำเนินการ</h2>
  ${anyAction ? '' : `<p class="muted">${u.role === 'head' ? 'หัวหน้าฝ่ายดำเนินการได้เฉพาะคำขอที่รออนุมัติ (SV-02/SV-03)' : 'ไม่มีรายการที่คุณดำเนินการได้ในสถานะนี้'}</p>`}
  <div class="actions">
    ${act.claim ? '<button type="button" class="btn" data-testid="claim-btn">รับเรื่อง</button>' : ''}
    ${act.approve ? '<button type="button" class="btn" data-testid="approve-btn">อนุมัติ</button>' : ''}
    ${act.issue ? '<button type="button" class="btn" data-testid="issue-btn">ออกเอกสาร</button>' : ''}
    ${act.ret ? '<button type="button" class="btn btn-secondary" data-testid="return-btn" aria-controls="return-form" aria-expanded="false">ตีกลับ</button>' : ''}
    ${act.reject ? '<button type="button" class="btn btn-danger" data-testid="reject-btn" aria-controls="reject-form" aria-expanded="false">ไม่อนุมัติ</button>' : ''}
  </div>
  ${act.forward ? `<div class="forward-box">
    <label for="forward-note">หมายเหตุส่งต่อ (ไม่บังคับ)</label>
    <textarea id="forward-note" name="note" rows="2" data-testid="forward-note"></textarea>
    <p class="muted">ระบบส่งต่อไปขั้นถัดไปตามเส้นทางของบริการอัตโนมัติ</p>
    <div class="actions"><button type="button" class="btn" data-testid="forward-btn">ผ่าน/ส่งต่อ</button></div>
  </div>` : ''}
  ${act.ret ? reasonForm('return', 'เหตุผลที่ตีกลับ (แจ้งประชาชน)', 'ยืนยันตีกลับ', 'return-reason-error') : ''}
  ${act.reject ? reasonForm('reject', 'เหตุผลที่ไม่อนุมัติ', 'ยืนยันไม่อนุมัติ', 'reject-reason-error') : ''}
</section>`;

    const body = `
<p><a href="/officer/queue">← กลับคิวงาน</a></p>
<h1>คำขอ <span data-testid="case-no">${esc(c.case_no)}</span></h1>
<div id="officer-case" data-case-no="${esc(c.case_no)}" hidden></div>
<section class="card" aria-label="ข้อมูลคำขอ">${info}</section>
${actions}
${docBlock}
<section class="card" aria-labelledby="files-h"><h2 id="files-h">เอกสารแนบ</h2>${filesBlock}</section>
<section class="card" aria-labelledby="tl-h"><h2 id="tl-h">ไทม์ไลน์</h2>${timeline}</section>`;

    const scripts = `<script>
(function(){
  var enc=${JSON.stringify(enc)};
  var FLASH='officerCaseFlash';
  try{var fl=sessionStorage.getItem(FLASH);if(fl){sessionStorage.removeItem(FLASH);App.showSuccess(fl)}}catch(e){}
  function done(msg){try{sessionStorage.setItem(FLASH,msg)}catch(e){}location.reload()}
  function fieldErr(id,msg){var e=App.el(id);if(e){e.textContent=msg||'';e.hidden=!msg}}
  function post(url,body,okMsg,btn){
    App.clearMessages();if(btn)btn.disabled=true;
    return App.api('POST',url,body).then(function(r){if(r.ok){done(okMsg)}else if(btn){btn.disabled=false}return r});
  }
  function on(id,fn){var el=App.el(id);if(el)el.addEventListener('click',function(ev){ev.preventDefault();fn(el)})}
  on('claim-btn',function(b){post('/api/officer/cases/'+enc+'/claim',null,'รับเรื่องแล้ว',b)});
  on('approve-btn',function(b){post('/api/cases/'+enc+'/approve',null,'อนุมัติแล้ว',b)});
  on('issue-btn',function(b){post('/api/officer/cases/'+enc+'/issue',null,'ออกเอกสารแล้ว',b)});
  on('forward-btn',function(b){var n=App.el('forward-note');post('/api/officer/cases/'+enc+'/forward',{note:n?n.value:''},'ส่งต่อแล้ว',b)});
  function reason(kind,url,errCode,errId,onOk){
    var open=App.el(kind==='unmask'?'show-full-id-btn':kind+'-btn');
    var form=document.getElementById(kind+'-form');var input=App.el(kind+'-reason');var submit=App.el(kind+'-submit');
    if(!form||!input||!submit)return;
    if(open)open.addEventListener('click',function(){form.hidden=false;open.setAttribute('aria-expanded','true');input.focus()});
    form.addEventListener('submit',function(ev){
      ev.preventDefault();App.clearMessages();fieldErr(errId,'');submit.disabled=true;
      App.api('POST',url,{reason:input.value},{silent:true}).then(function(r){
        submit.disabled=false;
        if(r.ok)return onOk(r.data||{});
        var d=r.data||{};
        if(d.code===errCode){fieldErr(errId,d.message);input.focus()}
        else{App.showError(d.message||('HTTP '+r.status));if(r.status===401)location.href='/login'}
      });
    });
  }
  reason('return','/api/officer/cases/'+enc+'/return','REASON_TOO_SHORT','return-reason-error',function(){done('ตีกลับแล้ว')});
  reason('reject','/api/cases/'+enc+'/reject','REASON_TOO_SHORT','reject-reason-error',function(){done('บันทึกไม่อนุมัติแล้ว')});
  reason('unmask','/api/officer/cases/'+enc+'/unmask','REASON_REQUIRED','unmask-error',function(d){
    var slot=document.getElementById('full-id-slot');
    if(slot){slot.textContent='';var s=document.createElement('strong');s.setAttribute('data-testid','full-id');s.textContent=d.idFormatted||d.idNo||'';slot.appendChild(document.createTextNode('เลขเต็ม: '));slot.appendChild(s)}
    var f=document.getElementById('unmask-form');if(f)f.hidden=true;
    var o=App.el('show-full-id-btn');if(o){o.setAttribute('aria-expanded','false');o.hidden=true}
    App.showSuccess('แสดงเลขเต็มแล้ว (บันทึกใน Audit)');
  });
})();
</script>`;
    return render(req, res, { title: `คำขอ ${c.case_no}`, body, scripts });
  }));

  ctx.officer = { workloadOf, byQueueOrder, issuerOf, canSeeFiles, deptReached, queueFor, MAX_WORKLOAD };
};
