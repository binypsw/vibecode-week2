'use strict';
// B12 · Dashboard ผู้บริหาร + ส่งออก Excel/PDF
// ที่มา: REQUIREMENTS FR-22 FR-23 BR-24 BR-25 BR-26 · A-39 A-41 A-50 · CONTRACT 2.9 · 6.4 · 6.8 · 7 · TEST-DATA ตาราง 7 · BUGS B10
//
//   GET /dashboard                                       หน้า (executive เท่านั้น · อื่น 403 · ไม่ล็อกอิน → /login)
//   GET /api/dashboard?period=2026-11&service=ALL        {received, closed, onTime, ontimePct, backlog, overdue, workload:[{username,count}]}
//   GET /api/dashboard/export?format=xlsx|pdf&period=…&service=…   ไฟล์ตาม CONTRACT 7 + Audit EXPORT ("xlsx 2026-11 ALL")
//
// นิยาม (BR-25 · A-41):
//   รับเรื่อง        = คำขอที่ชำระสำเร็จ (paid_at) ในช่วง · รวม CANCELLED ที่เคยชำระ
//   ปิดงาน          = COMPLETED + REJECTED ที่ closed_at ในช่วง (CANCELLED ไม่ใช่ปิดงาน)
//   ทัน             = closed_at ≤ due_at ระดับวินาที (16:30:00 ทัน · 16:30:01 ไม่ทัน) ผ่าน sla.isOverdue ของ B05
//   ทันกำหนด %      = ทัน ÷ ปิดงาน × 100 ทศนิยม 1 ตำแหน่ง ปัดครึ่งขึ้น (เลขจำนวนเต็มล้วน ไม่มีปัญหาทศนิยมลอย) · ปิดงาน 0 → "–" / null
//   งานคงค้าง        = SUBMITTED+IN_REVIEW+NEED_FIX+PENDING_APPROVAL+APPROVED ณ ตอนนี้ (ไม่ขึ้นกับช่วง · ขึ้นกับบริการ)
//   เกินกำหนดคงค้าง   = คงค้างที่ไม่ใช่ NEED_FIX และตอนนี้ > due_at
//   งานในมือ         = IN_REVIEW ที่ owner = เจ้าหน้าที่คนนั้น · แสดงทุกคนที่ role = officer แม้ 0 · ไม่ขึ้นกับตัวกรอง
//   รายปี (period=YYYY) = นับจากทั้งปีในครั้งเดียว = รวมตัวเลขทุกเดือนแล้วจึงคิด % (BR-26 · ไม่เฉลี่ย % รายเดือน)
//
// หน้า / API / ไฟล์ส่งออก ใช้ฟังก์ชัน report() ตัวเดียวกัน จึงเท่ากันทุกช่อง (BR-26)
// หน้าเว็บฝังตัวเลขของทุกช่วง×บริการไว้ตอนโหลด → เปลี่ยน select แล้วตัวเลขและลิงก์ส่งออกเปลี่ยนทันที (ไม่มีจังหวะค่าค้าง)
// "ส่งออกเท่าจอ" แม้ข้อมูลเปลี่ยนระหว่างเปิดหน้า: ตอนโหลดหน้าเก็บ "ผลตัวชี้วัดทุกช่วง×บริการที่ฝังในหน้า" ไว้ในหน่วยความจำพร้อม token
//   ลิงก์ส่งออกแนบ &snap=<token> → ไฟล์ใช้ผลชุดเดียวกับที่แสดงบนจอ (ออบเจ็กต์เดียวกัน ไม่คำนวณใหม่)
//   ไม่มี snap (เรียก API ตรง) → คำนวณจากข้อมูลปัจจุบัน
//   มี snap แต่หาไม่เจอ (ถูกตัดออกเพราะเกินจำนวน / RESET / เริ่มเซิร์ฟเวอร์ใหม่ / ไม่ใช่ของผู้ใช้คนนี้ / ช่วงไม่อยู่บนจอนั้น)
//     → 409 DASHBOARD_STALE "กรุณาโหลดหน้าใหม่ก่อนส่งออก" · ไม่ส่งไฟล์ ไม่บันทึก EXPORT · ห้ามถอยไปใช้ข้อมูลปัจจุบัน (ไฟล์จะไม่เท่าจอ)
//     เบราว์เซอร์ที่กดลิงก์ได้หน้า HTML พร้อมข้อความใน action-error และปุ่มโหลด Dashboard ใหม่ · fetch/API ได้ JSON
// HEAD ของลิงก์ส่งออกตอบเฉพาะ header (ไม่บันทึก Audit เพราะไม่ได้ส่งไฟล์)
//
// ข้อมูลส่วนบุคคล (BR-24): โมดูลนี้ไม่ SELECT ชื่อผู้ยื่น/เลขบัตร/เบอร์เลย · แสดงเฉพาะตัวเลขรวม + username/ชื่อแสดงของเจ้าหน้าที่
//
// BUG_MODE B10: ทันกำหนด % หารด้วย "รับเรื่อง" แทน "ปิดงาน" (พ.ย. 23.1% · ปี 23.3% · ธ.ค. 0.0%) — เปลี่ยนเฉพาะตัวหาร

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const nodeCrypto = require('crypto');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const sla = require('../lib/sla');

/** 5 ตัวชี้วัด ตามลำดับบนจอ / แถว 2–6 ของ xlsx (CONTRACT 7) */
const KPIS = [
  { key: 'received', label: 'รับเรื่อง', en: 'Received', testid: 'kpi-received', ascii: 'received' },
  { key: 'closed', label: 'ปิดงาน', en: 'Closed', testid: 'kpi-closed', ascii: 'closed' },
  { key: 'ontimePct', label: 'ทันกำหนด %', en: 'On-time %', testid: 'kpi-ontime-pct', ascii: 'ontime' },
  { key: 'backlog', label: 'งานคงค้าง', en: 'Backlog', testid: 'kpi-backlog', ascii: 'backlog' },
  { key: 'overdue', label: 'เกินกำหนดคงค้าง', en: 'Overdue backlog', testid: 'kpi-overdue', ascii: 'overdue' },
];
const DASH = '–'; // ปิดงาน 0 (CONTRACT 2.9) · ใน PDF บรรทัด ASCII ใช้ "-"

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------- ฟอนต์ไทยสำหรับ PDF (ป้ายไทยเป็นของเสริม · test ตรวจเฉพาะบรรทัด ASCII) ----------
// ใช้ฟอนต์ Sarabun (OFL) ที่ B11 ฝังไว้ใน routes/documents.js แบบอ่านอย่างเดียว · หาไม่เจอ → ป้ายอังกฤษ Helvetica
let thaiFontCache; // undefined = ยังไม่ลอง · null = ไม่มี
function thaiFont() {
  if (thaiFontCache !== undefined) return thaiFontCache;
  thaiFontCache = null;
  try {
    const src = fs.readFileSync(path.join(__dirname, 'documents.js'), 'utf8');
    const m = /SARABUN_FONT\s*=\s*brotliDecompressSync\(\s*Buffer\.from\(\s*`([A-Za-z0-9+/=\s]+)`/.exec(src);
    if (m) {
      const buf = zlib.brotliDecompressSync(Buffer.from(m[1].replace(/\s+/g, ''), 'base64'));
      if (buf.length > 1024) thaiFontCache = buf;
    }
  } catch (_) {
    thaiFontCache = null;
  }
  return thaiFontCache;
}

module.exports = function registerReports(app, ctx) {
  const { db, clock, C, audit, views, render, apiError, requireRole, wrap, isBug } = ctx;
  const { esc, attr } = views;

  const OPEN = new Set(C.OPEN_STATUSES); // งานคงค้าง 5 สถานะ
  const CLOSED = new Set(C.CLOSED_STATUSES); // ปิดงาน = COMPLETED + REJECTED
  const SERVICE_KEYS = ['ALL', ...C.SERVICE_IDS];

  // ไม่มีคอลัมน์ชื่อ/เลขบัตร/เบอร์ใน query ใด ๆ ของโมดูลนี้ (BR-24)
  const qCases = db.prepare('SELECT service_id, status, paid_at, closed_at, due_at FROM cases');
  const qOfficers = db.prepare(`SELECT username, name, dept FROM users
    WHERE role = 'officer' AND username IS NOT NULL ORDER BY username`);
  const qInReview = db.prepare(`SELECT owner, COUNT(*) AS n FROM cases
    WHERE status = 'IN_REVIEW' AND owner IS NOT NULL GROUP BY owner`);

  // ---------- ช่วงเวลา (A-41: "YYYY-MM" ค.ศ. หรือ "YYYY" = ทั้งปี) ----------
  function parsePeriod(raw) {
    const s = String(raw == null ? '' : raw).trim();
    let m = /^(\d{4})-(\d{2})$/.exec(s);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      if (y < 1900 || mo < 1 || mo > 12) return null;
      return {
        key: s, kind: 'month', y, m: mo,
        startMs: clock.fromParts(y, mo, 1), endMs: clock.fromParts(y, mo + 1, 1),
        label: `${clock.TH_MONTHS[mo - 1]} ${y + 543}`,
      };
    }
    m = /^(\d{4})$/.exec(s);
    if (m) {
      const y = Number(m[1]);
      if (y < 1900) return null;
      return {
        key: s, kind: 'year', y, m: null,
        startMs: clock.fromParts(y, 1, 1), endMs: clock.fromParts(y + 1, 1, 1),
        label: `ทั้งปี ${y + 543}`,
      };
    }
    return null;
  }
  function parseService(raw) {
    const s = String(raw == null || raw === '' ? 'ALL' : raw).trim().toUpperCase();
    return SERVICE_KEYS.includes(s) ? s : null;
  }
  function serviceText(svc) {
    return svc === 'ALL' ? 'ทุกบริการ' : views.serviceLabel(svc);
  }
  /** query → {period, service} · ค่าว่าง = เดือนของนาฬิกา / ALL · ค่าผิดรูปแบบ → null */
  function parseQuery(q) {
    const rawP = q && q.period != null && String(q.period).trim() !== '' ? q.period : clock.ym(clock.nowMs());
    const period = parsePeriod(rawP);
    const service = parseService(q && q.service);
    if (!period || !service) return null;
    return { period, service };
  }

  // ---------- คำนวณ ----------
  /** โหลดคำขอทั้งหมดครั้งเดียวแล้วคิดค่าที่ไม่ขึ้นกับช่วงไว้ก่อน (ทัน / คงค้าง / เกินกำหนด ณ ตอนนี้) */
  function snapshot() {
    const nowMs = clock.nowMs();
    const rows = qCases.all().map((r) => {
      const isClosed = CLOSED.has(r.status) && !!r.closed_at;
      const isOpen = OPEN.has(r.status);
      return {
        svc: r.service_id,
        paidMs: r.paid_at ? clock.toMs(r.paid_at) : null,
        closedMs: isClosed ? clock.toMs(r.closed_at) : null,
        onTime: isClosed && !!r.due_at && !sla.isOverdue(r.due_at, r.closed_at), // closed ≤ due ระดับวินาที
        open: isOpen,
        overdueNow: isOpen && r.status !== 'NEED_FIX' && !!r.due_at && sla.isOverdue(r.due_at, nowMs),
      };
    });
    const counts = new Map(qInReview.all().map((r) => [r.owner, r.n]));
    const workload = qOfficers.all().map((u) => ({ username: u.username, name: u.name, dept: u.dept, count: counts.get(u.username) || 0 }));
    return { nowMs, rows, workload };
  }

  // ---------- ผลของหน้าที่เปิดอยู่ (BR-26 ส่งออกเท่าจอ) ----------
  // เก็บเฉพาะตัวเลขรวมที่หน้าแสดง (≈10 KB ต่อหน้า ไม่ขึ้นกับจำนวนคำขอ · ไม่มีข้อมูลส่วนบุคคล)
  // ตัดแบบ LRU: ผู้ใช้หนึ่งคนเก็บล่าสุด SNAP_PER_USER หน้า · ทั้งระบบ SNAP_MAX หน้า · ใช้ token แล้วนับเป็นล่าสุด
  const SNAP_PER_USER = 100;
  const SNAP_MAX = 1000;
  const snaps = new Map(); // token → { uid, nowMs, workload, results: Map('period|service' → kpi) } · ลำดับใน Map = เก่า → ใหม่
  const perUser = new Map(); // uid → จำนวน token ที่เก็บอยู่
  function dropSnap(token) {
    const e = snaps.get(token);
    if (!e) return;
    snaps.delete(token);
    const n = (perUser.get(e.uid) || 1) - 1;
    if (n > 0) perUser.set(e.uid, n);
    else perUser.delete(e.uid);
  }
  function keepSnapshot(req, entry) {
    const token = nodeCrypto.randomBytes(16).toString('hex');
    const uid = req.user.id;
    snaps.set(token, { ...entry, uid });
    perUser.set(uid, (perUser.get(uid) || 0) + 1);
    if (perUser.get(uid) > SNAP_PER_USER) {
      for (const [t, e] of snaps) {
        if (e.uid === uid) { dropSnap(t); break; } // หน้าที่เก่าที่สุดของผู้ใช้คนนี้
      }
    }
    while (snaps.size > SNAP_MAX) dropSnap(snaps.keys().next().value);
    return token;
  }
  function clearSnaps() {
    snaps.clear();
    perUser.clear();
  }
  ctx.hooks.onReset('reports.snapshots', clearSnaps);

  /**
   * รายงานตามคำขอ:
   *   ไม่มี ?snap= → คำนวณจากข้อมูลปัจจุบัน
   *   มี ?snap= ของผู้ใช้คนนี้และช่วง/บริการอยู่บนจอนั้น → ผลชุดเดียวกับจอ
   *   มี ?snap= แต่หาไม่เจอ → null (ผู้เรียกตอบ 409 ให้โหลดหน้าใหม่ · ห้ามใช้ข้อมูลปัจจุบันแทน)
   */
  function reportFor(req, q) {
    const raw = req.query ? req.query.snap : undefined;
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return report(q.period, q.service);
    const t = typeof raw === 'string' ? raw.trim() : '';
    const e = /^[0-9a-f]{32}$/.test(t) ? snaps.get(t) : null;
    if (!e || !req.user || e.uid !== req.user.id) return null;
    const k = e.results.get(`${q.period.key}|${q.service}`);
    if (!k) return null;
    snaps.delete(t); // LRU: ใช้แล้วย้ายไปท้าย
    snaps.set(t, e);
    return makeReport(q.period, q.service, e.nowMs, e.workload, k);
  }

  const STALE_CODE = 'DASHBOARD_STALE';
  const STALE_MSG = 'ตัวเลขบนหน้า Dashboard ที่เปิดค้างไว้หมดอายุแล้ว กรุณาโหลดหน้าใหม่ก่อนส่งออก';
  /** 409 เมื่อ snap หาไม่เจอ · กดลิงก์จากเบราว์เซอร์ → หน้า HTML · fetch/API → JSON · ไม่ส่งไฟล์ ไม่บันทึก EXPORT */
  function staleResponse(req, res, q) {
    const reload = `/dashboard?period=${encodeURIComponent(q.period.key)}&service=${encodeURIComponent(q.service)}`;
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'HEAD' && req.accepts(['json', 'html']) === 'html') {
      return render(req, res, {
        status: 409,
        title: 'ส่งออกรายงานไม่ได้',
        error: STALE_MSG,
        body: `<h1>ส่งออกรายงานไม่ได้</h1>
<p>ไฟล์ส่งออกต้องมีตัวเลขเท่ากับหน้า Dashboard ที่เปิดไว้ แต่ระบบไม่มีข้อมูลชุดนั้นแล้ว (เช่น เปิดหน้าไว้นานหรือระบบเริ่มใหม่) จึงไม่ได้สร้างไฟล์ ตัวเลขล่าสุดอาจต่างจากที่เห็นบนหน้าเดิม</p>
<p>โหลดหน้า Dashboard ใหม่ ตรวจสอบตัวเลข แล้วกดส่งออกอีกครั้ง</p>
<p><a class="btn" data-testid="dashboard-reload-btn" href="${esc(reload)}">โหลด Dashboard ใหม่</a></p>`,
      });
    }
    return res.status(409).json({ code: STALE_CODE, message: STALE_MSG, reload });
  }

  /** ร้อยละปัดครึ่งขึ้น 1 ตำแหน่ง แบบจำนวนเต็ม: คืน "ร้อยละ × 10" เช่น 6/7 → 857 · ตัวหาร 0 → null */
  function pct10(num, den) {
    if (!den) return null;
    return Math.floor((num * 2000 + den) / (2 * den));
  }

  function kpis(snap, period, service) {
    let received = 0;
    let closed = 0;
    let onTime = 0;
    let backlog = 0;
    let overdue = 0;
    for (const r of snap.rows) {
      if (service !== 'ALL' && r.svc !== service) continue;
      if (r.paidMs != null && r.paidMs >= period.startMs && r.paidMs < period.endMs) received += 1;
      if (r.closedMs != null && r.closedMs >= period.startMs && r.closedMs < period.endMs) {
        closed += 1;
        if (r.onTime) onTime += 1;
      }
      if (r.open) {
        backlog += 1;
        if (r.overdueNow) overdue += 1;
      }
    }
    // [B10] หารด้วยรับเรื่องแทนปิดงาน
    const p10 = pct10(onTime, isBug('B10') ? received : closed);
    return { received, closed, onTime, ontimePct: p10 == null ? null : p10 / 10, ontimeText: p10 == null ? DASH : `${Math.floor(p10 / 10)}.${p10 % 10}%`, backlog, overdue };
  }

  /** ค่าตามที่แสดงบนจอ (ข้อความ) · ใช้ทั้งหน้า xlsx และ pdf */
  function display(k) {
    return {
      received: String(k.received),
      closed: String(k.closed),
      ontimePct: k.ontimeText,
      backlog: String(k.backlog),
      overdue: String(k.overdue),
    };
  }

  function makeReport(period, service, nowMs, workload, k) {
    return { period, service, nowMs, kpi: k, shown: display(k), workload };
  }
  /** รายงานจากข้อมูลปัจจุบัน */
  function report(period, service) {
    const snap = snapshot();
    return makeReport(period, service, snap.nowMs, snap.workload, kpis(snap, period, service));
  }

  function apiBody(r) {
    return {
      received: r.kpi.received,
      closed: r.kpi.closed,
      onTime: r.kpi.onTime,
      ontimePct: r.kpi.ontimePct,
      backlog: r.kpi.backlog,
      overdue: r.kpi.overdue,
      workload: r.workload.map((w) => ({ username: w.username, count: w.count })),
    };
  }

  // ---------- API ----------
  app.get('/api/dashboard', requireRole('executive'), (req, res) => {
    const q = parseQuery(req.query);
    if (!q) return apiError(res, 'BAD_REQUEST');
    const r = reportFor(req, q);
    if (!r) return staleResponse(req, res, q);
    return res.json(apiBody(r));
  });

  app.get('/api/dashboard/export', requireRole('executive'), wrap(async (req, res) => {
    const format = String(req.query.format || '').trim().toLowerCase();
    if (format !== 'xlsx' && format !== 'pdf') return apiError(res, 'BAD_REQUEST');
    const q = parseQuery(req.query);
    if (!q) return apiError(res, 'BAD_REQUEST');
    const r = reportFor(req, q);
    if (!r) return staleResponse(req, res, q); // หน้าเดิมหมดอายุ → ให้โหลดใหม่ ไม่ส่งไฟล์ที่อาจไม่เท่าจอ
    const buf = format === 'xlsx' ? await buildXlsx(r) : await buildPdf(r);
    const filename = `dashboard-${q.period.key}-${q.service}.${format}`;
    res.status(200);
    res.set('Content-Type', format === 'xlsx' ? XLSX_MIME : 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('Content-Length', String(buf.length));
    res.set('Cache-Control', 'no-store');
    if (req.method === 'HEAD') return res.end(); // ตอบเฉพาะ header · ไม่ได้ส่งไฟล์ → ไม่บันทึก EXPORT
    audit.log(req, { event: 'EXPORT', detail: `${format} ${q.period.key} ${q.service}` }); // CONTRACT 6.8
    return res.end(buf);
  }));

  // ---------- ไฟล์ส่งออก (CONTRACT 7 · A-50) ----------
  async function buildXlsx(r) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'e-Service เทศบาลนครก็อตแทม (สมมติ)';
    wb.created = new Date(r.nowMs);
    wb.modified = new Date(r.nowMs);

    // ชีตแรก: แถว 1 หัวตาราง · แถว 2–6 = 5 ตัวชี้วัด (คอลัมน์ B เป็นข้อความตามจอ)
    const ws = wb.addWorksheet('Dashboard');
    ws.columns = [{ width: 22 }, { width: 14 }];
    ws.addRow(['ตัวชี้วัด', 'ค่า']).font = { bold: true };
    for (const k of KPIS) ws.addRow([k.label, r.shown[k.key]]);
    ws.getColumn(2).alignment = { horizontal: 'right' };

    // ชีตที่สอง: บริบทของรายงาน + งานในมือ (ไม่มีข้อมูลส่วนบุคคล)
    const info = wb.addWorksheet('รายละเอียด');
    info.columns = [{ width: 30 }, { width: 40 }];
    info.addRow(['รายการ', 'ค่า']).font = { bold: true };
    info.addRow(['ช่วงเวลา', `${r.period.label} (${r.period.key})`]);
    info.addRow(['บริการ', serviceText(r.service)]);
    info.addRow(['ข้อมูล ณ', clock.fmtThai(r.nowMs)]);
    info.addRow(['หมายเหตุ', 'งานคงค้างและเกินกำหนดคงค้างเป็นค่า ณ เวลาที่ส่งออก ไม่ขึ้นกับช่วงเวลา']);
    info.addRow([]);
    info.addRow(['งานในมือรายเจ้าหน้าที่ (กำลังตรวจสอบ)', 'จำนวน']).font = { bold: true };
    for (const w of r.workload) info.addRow([w.username, String(w.count)]);

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  function asciiLine(r) {
    const v = { ...r.shown, ontimePct: r.kpi.ontimePct == null ? '-' : r.shown.ontimePct };
    return 'kpi ' + KPIS.map((k) => `${k.ascii}=${v[k.key]}`).join(' ');
  }

  function buildPdf(r) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 56,
        info: {
          Title: `Dashboard ${r.period.key} ${r.service}`,
          Author: 'e-Service',
          CreationDate: new Date(r.nowMs),
        },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.once('end', () => resolve(Buffer.concat(chunks)));
      doc.once('error', reject);

      let th = false;
      const fontBuf = thaiFont();
      if (fontBuf) {
        try {
          doc.registerFont('th', fontBuf);
          doc.font('th');
          th = true;
        } catch (_) {
          th = false;
        }
      }
      const shownPdf = { ...r.shown };
      if (th) {
        doc.fontSize(18).text('รายงานตัวชี้วัด e-Service (Dashboard)');
        doc.moveDown(0.5).fontSize(12)
          .text(`ช่วงเวลา: ${r.period.label} (${r.period.key})`)
          .text(`บริการ: ${serviceText(r.service)}`)
          .text(`ข้อมูล ณ: ${clock.fmtThai(r.nowMs)}`);
        doc.moveDown(0.5).fontSize(14);
        for (const k of KPIS) doc.text(`${k.label}: ${shownPdf[k.key]}`);
        doc.moveDown(0.5).fontSize(11).text('หมายเหตุ: งานคงค้าง/เกินกำหนดคงค้าง = ค่า ณ เวลาที่ส่งออก');
        doc.moveDown(0.5).fontSize(12).text('งานในมือรายเจ้าหน้าที่ (กำลังตรวจสอบ):');
        for (const w of r.workload) doc.text(`${w.username}: ${w.count}`);
      } else {
        doc.font('Helvetica').fontSize(18).text('e-Service Dashboard report');
        doc.moveDown(0.5).fontSize(12)
          .text(`Period: ${r.period.key}`)
          .text(`Service: ${r.service}`)
          .text(`As of: ${clock.toISO(r.nowMs)}`);
        doc.moveDown(0.5).fontSize(14);
        for (const k of KPIS) doc.text(`${k.en}: ${k.key === 'ontimePct' && r.kpi.ontimePct == null ? '-' : shownPdf[k.key]}`);
        doc.moveDown(0.5).fontSize(12).text('Workload (in review):');
        for (const w of r.workload) doc.text(`${w.username}: ${w.count}`);
      }
      // บรรทัด ASCII ที่เครื่องอ่านได้ (CONTRACT 7) · ฟอนต์มาตรฐาน + บรรทัดเดียวไม่ตัดคำ
      doc.moveDown(1).font('Helvetica').fontSize(10).text(asciiLine(r), { lineBreak: false });
      doc.end();
    });
  }

  // ---------- หน้า /dashboard (CONTRACT 2.9) ----------
  /** ตัวเลือกช่วง: รายเดือนตั้งแต่ ม.ค. ปีก่อนถึงเดือนปัจจุบัน (ใหม่ → เก่า) + รายปี (ปีนี้ ปีก่อน) · ค่าที่ขอแต่ไม่อยู่ในรายการจะถูกเพิ่มให้ */
  function periodOptions(nowMs, selected) {
    const p = clock.parts(nowMs);
    const months = [];
    for (let y = p.y, m = p.m; y > p.y - 2; ) {
      months.push(parsePeriod(`${y}-${String(m).padStart(2, '0')}`));
      m -= 1;
      if (m === 0) { m = 12; y -= 1; }
    }
    const years = [parsePeriod(String(p.y)), parsePeriod(String(p.y - 1))];
    const all = [...months, ...years];
    if (!all.some((x) => x.key === selected.key)) (selected.kind === 'year' ? years : months).unshift(selected);
    return { months, years };
  }

  const PAGE_CSS = `<style>
.dash-filters{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;align-items:flex-end}
.dash-filters .field{margin:0;flex:1 1 14rem;max-width:20rem}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr));gap:.75rem;margin:0 0 1rem}
.kpis .kpi{margin:0;display:flex;flex-direction:column;gap:.15rem}
.kpis dt{font-weight:600;color:#374151}
.kpis dd{margin:0}
.kpis .kpi-value{font-size:2rem;font-weight:700;line-height:1.2;color:#0b3d6e}
.kpis .kpi-note{font-size:.85rem;color:#4b5563}
.export-actions{display:flex;flex-wrap:wrap;gap:.5rem}
td.num,th.num{text-align:right}
</style>`;

  app.get('/dashboard', requireRole('executive'), (req, res) => {
    const snap = snapshot();
    const q = parseQuery(req.query) || parseQuery({});
    const { period, service } = q;
    const opts = periodOptions(snap.nowMs, period);
    const allPeriods = [...opts.months, ...opts.years];

    // ตัวเลขของทุกช่วง × บริการ จากข้อมูลชุดเดียวกัน → เปลี่ยน select แล้วอัปเดตได้ทันที
    // ผลชุดนี้ (ออบเจ็กต์เดียวกัน) ถูกเก็บไว้กับ token → ลิงก์ส่งออกได้ตัวเลขเท่าจอเสมอ
    const results = new Map();
    const data = {};
    for (const p of allPeriods) {
      for (const s of SERVICE_KEYS) {
        const k = kpis(snap, p, s);
        results.set(`${p.key}|${s}`, k);
        data[`${p.key}|${s}`] = { ...display(k), onTime: k.onTime, closedN: k.closed, label: p.label };
      }
    }
    const snapToken = keepSnapshot(req, { nowMs: snap.nowMs, workload: snap.workload, results });
    const cur = data[`${period.key}|${service}`];
    const exportHref = (fmt) => `/api/dashboard/export?format=${fmt}&period=${encodeURIComponent(period.key)}&service=${encodeURIComponent(service)}&snap=${snapToken}`;
    const opt = (value, text, sel) => `<option${attr({ value, selected: sel })}>${esc(text)}</option>`;
    const ontimeNote = (d) => (d.closedN ? `ทันกำหนด ${d.onTime} จากปิดงาน ${d.closedN} เรื่อง` : 'ยังไม่มีงานปิดในช่วงนี้');

    const kpiNotes = {
      received: 'ชำระสำเร็จในช่วงที่เลือก (รวมที่ยกเลิกภายหลัง)',
      closed: 'เสร็จสิ้น + ไม่อนุมัติ ในช่วงที่เลือก',
      ontimePct: null,
      backlog: 'ค่า ณ ตอนนี้ ไม่ขึ้นกับช่วงเวลา',
      overdue: 'ค่า ณ ตอนนี้ (ไม่นับรอแก้ไขเอกสาร)',
    };
    const kpiHtml = KPIS.map((k) => `<div class="card kpi">
      <dt>${esc(k.label)}</dt>
      <dd class="kpi-value" data-testid="${k.testid}">${esc(cur[k.key])}</dd>
      <dd class="kpi-note"${k.key === 'ontimePct' ? ' id="kpi-ontime-note"' : ''}>${esc(k.key === 'ontimePct' ? ontimeNote(cur) : kpiNotes[k.key])}</dd>
    </div>`).join('');

    const workloadRows = snap.workload.map((w) => `<tr data-testid="workload-row"${attr({ 'data-username': w.username })}>
      <td>${esc(w.name)} <span class="muted">(${esc(w.username)})</span></td>
      <td>${esc(C.DEPT_TH[w.dept] || '–')}</td>
      <td class="num" data-testid="workload-value">${w.count}</td>
    </tr>`).join('');

    const body = `
<h1>Dashboard ผู้บริหาร</h1>
<form class="card" method="get" action="/dashboard" id="dash-filter" aria-label="ตัวกรอง Dashboard">
  <div class="dash-filters">
    <div class="field">
      <label for="period-select">ช่วงเวลา (เดือน/ปี)</label>
      <select id="period-select" name="period" data-testid="period-select">
        <optgroup label="รายเดือน">${opts.months.map((p) => opt(p.key, p.label, p.key === period.key)).join('')}</optgroup>
        <optgroup label="รายปี (รวมทุกเดือน)">${opts.years.map((p) => opt(p.key, p.label, p.key === period.key)).join('')}</optgroup>
      </select>
    </div>
    <div class="field">
      <label for="service-select">บริการ</label>
      <select id="service-select" name="service" data-testid="service-select">
        ${SERVICE_KEYS.map((s) => opt(s, serviceText(s), s === service)).join('')}
      </select>
    </div>
    <noscript><button type="submit" class="btn">แสดงผล</button></noscript>
  </div>
</form>

<section aria-labelledby="kpi-heading">
  <h2 id="kpi-heading">ตัวชี้วัด · <span id="scope-period">${esc(period.label)}</span> · <span id="scope-service">${esc(serviceText(service))}</span></h2>
  <p class="muted">ข้อมูล ณ ${views.timeTag(clock.toISO(snap.nowMs), 'dashboard-as-of')} · ทันกำหนด = ปิดงานไม่เกินกำหนดเสร็จ (รวม 16:30:00)</p>
  <dl class="kpis" aria-live="polite">${kpiHtml}</dl>
</section>

<section aria-labelledby="export-heading" class="card">
  <h2 id="export-heading">ส่งออกรายงาน</h2>
  <p class="muted">ไฟล์มีค่าเท่ากับตัวชี้วัดบนจอตามช่วงและบริการที่เลือก (ไม่มีข้อมูลส่วนบุคคล)</p>
  <div class="export-actions">
    <a class="btn" data-testid="export-xlsx-btn" id="export-xlsx" href="${esc(exportHref('xlsx'))}">ส่งออก Excel</a>
    <a class="btn btn-secondary" data-testid="export-pdf-btn" id="export-pdf" href="${esc(exportHref('pdf'))}">ส่งออก PDF</a>
  </div>
</section>

<section aria-labelledby="workload-heading">
  <h2 id="workload-heading">งานในมือรายเจ้าหน้าที่</h2>
  <p class="muted">จำนวนคำขอสถานะกำลังตรวจสอบที่เจ้าหน้าที่แต่ละคนรับไว้ ณ ตอนนี้ (ไม่ขึ้นกับตัวกรอง)</p>
  <div class="table-wrap">
    <table>
      <caption class="muted" style="text-align:left">งานในมือ ณ ตอนนี้</caption>
      <thead><tr><th scope="col">เจ้าหน้าที่</th><th scope="col">แผนก</th><th scope="col" class="num">งานในมือ</th></tr></thead>
      <tbody>${workloadRows}</tbody>
    </table>
  </div>
</section>`;

    const json = JSON.stringify({ data, services: Object.fromEntries(SERVICE_KEYS.map((s) => [s, serviceText(s)])) })
      .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

    const scripts = `<script>
(function(){
  var D=${json};
  var KPI=${JSON.stringify(KPIS.map((k) => [k.key, k.testid]))};
  var SNAP=${JSON.stringify(snapToken)};
  var ps=document.getElementById('period-select'), ss=document.getElementById('service-select');
  function el(t){return document.querySelector('[data-testid="'+t+'"]')}
  function q(){return 'period='+encodeURIComponent(ps.value)+'&service='+encodeURIComponent(ss.value)}
  function href(fmt){return '/api/dashboard/export?format='+fmt+'&'+q()+'&snap='+SNAP}
  function paint(d){
    KPI.forEach(function(k){var e=el(k[1]); if(e) e.textContent=d[k[0]]});
    var n=document.getElementById('kpi-ontime-note');
    if(n) n.textContent=d.closedN?('ทันกำหนด '+d.onTime+' จากปิดงาน '+d.closedN+' เรื่อง'):'ยังไม่มีงานปิดในช่วงนี้';
    document.getElementById('scope-period').textContent=d.label||ps.options[ps.selectedIndex].text;
    document.getElementById('scope-service').textContent=D.services[ss.value]||ss.value;
  }
  function apply(){
    document.getElementById('export-xlsx').setAttribute('href',href('xlsx'));
    document.getElementById('export-pdf').setAttribute('href',href('pdf'));
    try{history.replaceState(null,'','/dashboard?'+q())}catch(e){}
    var d=D.data[ps.value+'|'+ss.value];
    if(d){paint(d);return}
    App.api('GET','/api/dashboard?'+q()+'&snap='+SNAP).then(function(r){
      if(!r.ok) return;
      var x=r.data, pct=x.ontimePct==null?'\\u2013':(x.ontimePct.toFixed(1)+'%');
      paint({received:String(x.received),closed:String(x.closed),ontimePct:pct,backlog:String(x.backlog),overdue:String(x.overdue),onTime:x.onTime,closedN:x.closed});
    });
  }
  ps.addEventListener('change',apply);
  ss.addEventListener('change',apply);
})();
</script>`;

    return render(req, res, { title: 'Dashboard', head: PAGE_CSS, body, scripts });
  });
};
