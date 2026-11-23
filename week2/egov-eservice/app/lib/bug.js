'use strict';
// BUG_MODE=B03,B07 → isBug('B03') === true · ไม่ตั้ง/ว่าง = เว็บถูกต้อง 100% (BUGS.md)
// อ่านครั้งเดียวตอนโหลด (restart เว็บเพื่อเปลี่ยนชุดบั๊ก) · บั๊กกระทบเฉพาะตรรกะฝั่งเซิร์ฟเวอร์ ไม่กระทบ seed (A-35)

function parse(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^B\d{2}$/.test(s))
  );
}

let active = parse(process.env.BUG_MODE);

function isBug(code) {
  return active.has(String(code).toUpperCase());
}

function list() {
  return [...active].sort();
}

// ใช้ในสคริปต์ทดสอบภายในเท่านั้น
function _setForTest(raw) {
  active = parse(raw);
}

module.exports = { isBug, list, _setForTest };
