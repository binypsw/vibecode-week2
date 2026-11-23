'use strict';
// Audit Trail (DECISIONS 13 · CONTRACT 2.10 · 6.4 · 6.8) + ไทม์ไลน์คำขอ (case_events)
//
//   audit.log(req, { event, caseNo, from, to, detail })   ← ผู้ทำ = req.user (username + role ตาม session)
//   audit.log(null, { username, role, event, ... })        ← ระบุผู้ทำเอง (เช่น STAFF_LOGIN ก่อนมี req.user)
//     · event ต้องเป็น 1 ใน 10 เหตุการณ์ (AUDIT_EVENTS)
//     · ถ้ามี caseNo และ event เป็นการกระทำกับคำขอ (CLAIM RETURN FORWARD APPROVE REJECT ISSUE) จะลงไทม์ไลน์ให้ด้วย
//       (ปิดด้วย { timeline: false })
//   audit.timeline({ caseNo, actor, role, event, from, to, detail })  ← ไทม์ไลน์อย่างเดียว (เช่น SUBMITTED RESUBMIT CANCEL AUTO_CANCEL)
//   audit.list({ actor, event, from, to })  → { count, items:[{id,time,username,role,event,caseNo,fromStatus,toStatus,detail}] }
//     · from/to = "YYYY-MM-DD" (รวมทั้งวันตามเวลาไทย) · เรียงใหม่ → เก่า
// เวลาทุกแถวมาจาก lib/clock (นาฬิกาทดสอบ)

const { db } = require('../db');
const clock = require('./clock');
const { AUDIT_EVENTS } = require('../db/constants');

const TIMELINE_EVENTS = new Set(['CLAIM', 'RETURN', 'FORWARD', 'APPROVE', 'REJECT', 'ISSUE']);

const insAudit = db.prepare(`INSERT INTO audit (time, username, role, event, case_no, from_status, to_status, detail)
  VALUES (@time, @username, @role, @event, @case_no, @from_status, @to_status, @detail)`);
const insEvent = db.prepare(`INSERT INTO case_events (case_no, at, actor, actor_role, event, from_status, to_status, detail)
  VALUES (@case_no, @at, @actor, @actor_role, @event, @from_status, @to_status, @detail)`);

function actorOf(req, e) {
  const u = req && req.user;
  return {
    username: e.username !== undefined ? e.username : u ? u.username : null,
    role: e.role !== undefined ? e.role : u ? u.role : null,
  };
}

function log(req, e) {
  if (!e || !AUDIT_EVENTS.includes(e.event)) throw new Error(`audit.log: unknown event ${e && e.event}`);
  const { username, role } = actorOf(req, e);
  const time = e.time || clock.nowISO();
  const row = {
    time, username, role, event: e.event, case_no: e.caseNo || null,
    from_status: e.from || null, to_status: e.to || null, detail: e.detail == null ? '' : String(e.detail),
  };
  const info = insAudit.run(row);
  if (row.case_no && TIMELINE_EVENTS.has(e.event) && e.timeline !== false) {
    insEvent.run({ case_no: row.case_no, at: time, actor: username, actor_role: role, event: e.event,
      from_status: row.from_status, to_status: row.to_status, detail: row.detail || null });
  }
  return info.lastInsertRowid;
}

function timeline(e) {
  return insEvent.run({
    case_no: e.caseNo, at: e.at || clock.nowISO(), actor: e.actor || null, actor_role: e.role || null,
    event: e.event, from_status: e.from || null, to_status: e.to || null, detail: e.detail == null ? null : String(e.detail),
  }).lastInsertRowid;
}

function timelineOf(caseNo) {
  return db.prepare('SELECT * FROM case_events WHERE case_no = ? ORDER BY at, id').all(caseNo).map((r) => ({
    id: r.id, at: r.at, actor: r.actor, role: r.actor_role, event: r.event, fromStatus: r.from_status, toStatus: r.to_status, detail: r.detail,
  }));
}

function mapRow(r) {
  return {
    id: r.id, time: r.time, username: r.username, role: r.role, event: r.event, caseNo: r.case_no,
    fromStatus: r.from_status, toStatus: r.to_status, detail: r.detail,
  };
}

/** กรอง: actor (username ตรงตัว) · event · from/to "YYYY-MM-DD" (รวมทั้งวัน เวลาไทย) */
function list(filters = {}) {
  const where = [];
  const args = {};
  if (filters.actor) { where.push('username = @actor'); args.actor = String(filters.actor).trim(); }
  if (filters.event) { where.push('event = @event'); args.event = String(filters.event); }
  if (filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from)) { where.push('time >= @from'); args.from = `${filters.from}T00:00:00+07:00`; }
  if (filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) { where.push('time <= @to'); args.to = `${filters.to}T23:59:59+07:00`; }
  const sql = `SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY time DESC, id DESC`;
  const items = db.prepare(sql).all(args).map(mapRow);
  return { count: items.length, items };
}

module.exports = { log, timeline, timelineOf, list, mapRow, TIMELINE_EVENTS, EVENTS: AUDIT_EVENTS };
