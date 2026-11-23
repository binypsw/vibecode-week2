'use strict';
// จุดลงทะเบียน hook ที่ server.js เรียก (CONTRACT 0.7 · A-30 · A-46)
//
//  onRequest(name, fn, order)  — เรียกทุก HTTP request ยกเว้น /api/test/* และไฟล์ static
//      fn(ctx, req) ทำงานแบบ synchronous ภายใน DB transaction เดียว ตามลำดับ order น้อย → มาก
//      ลำดับที่ตกลงกัน: 10 = ยกเลิกอัตโนมัติเมื่อเลย 168 ชม. (B09 · A-46)  ·  20 = ประเมินแจ้งเตือน SLA (B10 · A-30)
//      (ยกเลิกก่อน แล้วค่อยประเมินแจ้งเตือน เพื่อไม่แจ้งเตือนคำขอที่เพิ่งถูกยกเลิก)
//  onReset(name, fn)           — เรียกหลัง POST /api/test/reset ล้างและ seed DB แล้ว (ใช้ล้าง state ในหน่วยความจำของบล็อก)
//
// ลงทะเบียนชื่อเดิมซ้ำ = แทนที่ของเดิม (กัน hot-reload ซ้ำซ้อน)

const requestHooks = new Map(); // name → {fn, order}
const resetHooks = new Map();   // name → fn

function onRequest(name, fn, order = 50) {
  if (typeof fn !== 'function') throw new TypeError('hook fn must be a function');
  requestHooks.set(String(name), { fn, order: Number(order) || 0 });
}
function onReset(name, fn) {
  if (typeof fn !== 'function') throw new TypeError('hook fn must be a function');
  resetHooks.set(String(name), fn);
}
function sortedRequestHooks() {
  return [...requestHooks.entries()]
    .map(([name, h]) => ({ name, ...h }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}
/** เรียก hook ทุกตัว · hook ตัวใดพังจะ log แล้วทำตัวถัดไปต่อ (ไม่ทำให้ request ล้ม) */
function runRequestHooks(ctx, req) {
  for (const h of sortedRequestHooks()) {
    try {
      h.fn(ctx, req);
    } catch (err) {
      console.error(`[hooks] onRequest "${h.name}" failed:`, err && err.stack ? err.stack : err);
    }
  }
}
function runResetHooks(ctx) {
  for (const [name, fn] of resetHooks) {
    try {
      fn(ctx);
    } catch (err) {
      console.error(`[hooks] onReset "${name}" failed:`, err && err.stack ? err.stack : err);
    }
  }
}
function list() {
  return { onRequest: sortedRequestHooks().map((h) => `${h.order}:${h.name}`), onReset: [...resetHooks.keys()] };
}

module.exports = { onRequest, onReset, runRequestHooks, runResetHooks, list };
