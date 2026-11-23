'use strict';
// Schema กลางของทุกบล็อก (SQLite) · ข้อตกลง:
// - เวลาทุกคอลัมน์ *_at / time / due_at / fix_deadline / qr_* เป็นสตริง ISO "YYYY-MM-DDTHH:mm:ss+07:00"
//   (ใช้ clock.toISO() เสมอ → เทียบ/เรียงด้วย SQL แบบสตริงได้ถูกต้อง) · วันที่ล้วน (holidays.date, documents.valid_until) = "YYYY-MM-DD"
// - เงิน = จำนวนเต็มบาท
// - ข้อมูลส่วนบุคคล: users.id_no_enc / users.mobile_enc = AES-256-GCM (lib/crypto.encrypt) · ค้นเลขบัตรด้วย users.id_no_hash = crypto.blindIndex(idNo)
//   ห้ามมีคอลัมน์ใดเก็บเลขบัตร 13 หลัก/เบอร์ 10 หลักแบบ plaintext (TC-NFR-04)
// - ถ้าแก้ DDL ในไฟล์นี้ ฐานข้อมูลเดิมจะถูกสร้างใหม่ + seed อัตโนมัติตอนเปิดเซิร์ฟเวอร์ (เทียบ hash ของ DDL)

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ตัวนับเลขลำดับ (db.nextSeq): 'case:2569' 'receipt:2569' 'doc:2569' 'draft' 'payment' 'file'
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- ผู้ใช้ทุกบทบาท · ประชาชน: username = NULL, ค้นด้วย id_no_hash · เจ้าหน้าที่: username + password_hash
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE,
  password_hash TEXT,
  name          TEXT NOT NULL,                 -- ชื่อ-สกุล (ประชาชน) / ชื่อแสดง (เจ้าหน้าที่)
  role          TEXT NOT NULL CHECK (role IN ('citizen','officer','head','executive','auditor','admin')),
  dept          TEXT CHECK (dept IS NULL OR dept IN ('registry','works')),
  id_no_enc     TEXT,                          -- AES-256-GCM ของเลขบัตร 13 หลัก
  id_no_hash    TEXT UNIQUE,                   -- blindIndex(เลขบัตร)
  mobile_enc    TEXT,                          -- AES-256-GCM ของเบอร์มือถือ
  email         TEXT,
  registered    INTEGER NOT NULL DEFAULT 1,    -- ประชาชนเข้าครั้งแรก = 0 จนกว่าลงทะเบียน
  consent_at    TEXT,
  created_at    TEXT NOT NULL
);

-- session (cookie "sid" HttpOnly) · role/dept = ค่าตอนล็อกอิน (admin เปลี่ยนบทบาท มีผลครั้งถัดไป)
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  role       TEXT NOT NULL,
  dept       TEXT,
  created_at TEXT NOT NULL
);

-- ตัวนับ OTP ผิด/การล็อก ต่อเลขบัตร (คีย์ = blindIndex(เลขบัตร) ห้ามเก็บเลขบัตรตรง ๆ)
CREATE TABLE IF NOT EXISTS otp_state (
  id_hash      TEXT PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at   TEXT
);

-- แคตตาล็อกบริการ (admin แก้ fee / fee_per_sqm / sla_days) · SV-01 fee = ต่อฉบับ · SV-02 fee = คงที่ · SV-03 fee = ฐาน (1–100 ตร.ม.)
CREATE TABLE IF NOT EXISTS services (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  fee         INTEGER NOT NULL,
  fee_per_sqm INTEGER,
  sla_days    INTEGER NOT NULL,
  route       TEXT NOT NULL,                   -- JSON เช่น ["registry","works","head"]
  approver    TEXT NOT NULL,                   -- 'officer' | 'head'
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS holidays (
  date       TEXT PRIMARY KEY,                 -- YYYY-MM-DD (ค.ศ.)
  name       TEXT NOT NULL,
  created_at TEXT
);

-- ร่าง/รอชำระ (ยังไม่มีเลขคำขอ) · status: DRAFT | PENDING_PAYMENT | SUBMITTED (ชำระแล้ว → case_no)
-- fee = ยอดที่คำนวณ (ล็อกเมื่อเข้า PENDING_PAYMENT · A-42)
CREATE TABLE IF NOT EXISTS drafts (
  id         TEXT PRIMARY KEY,                 -- DR-0001
  user_id    INTEGER NOT NULL,
  service_id TEXT NOT NULL,
  qty        INTEGER,                          -- SV-01
  area_sqm   INTEGER,                          -- SV-03
  fee        INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'DRAFT',
  case_no    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_id);

-- QR ชำระเงินจำลอง · status เก็บ PENDING | PAID (EXPIRED คิดจากนาฬิกา: now − qr_created_at ≥ 15:00 และยังไม่ PAID)
CREATE TABLE IF NOT EXISTS payments (
  ref           TEXT PRIMARY KEY,              -- PP-0001
  draft_id      TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  qr_created_at TEXT NOT NULL,
  qr_expires_at TEXT NOT NULL,
  paid_at       TEXT,
  case_no       TEXT,
  receipt_no    TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_draft ON payments(draft_id);

-- คำขอที่มีเลขแล้ว (ชำระสำเร็จ)
--  dept   = คิวแผนกที่คำขออยู่ ('registry'|'works') · NULL เมื่ออยู่ขั้นหัวหน้า (PENDING_APPROVAL) หรือปิด/ยกเลิกแล้ว
--           (APPROVED รอออกเอกสาร = 'registry' · NEED_FIX = แผนกเดิม)
--  owner  = username ผู้ถือเรื่องปัจจุบัน (IN_REVIEW / NEED_FIX) · NULL = ยังไม่มีผู้รับ / ขั้นหัวหน้า / APPROVED / ปิดแล้ว
--  issuer = เจ้าหน้าที่ทะเบียนที่รับเรื่องขั้นแรก = ผู้ออกเอกสาร (A-27)
--  step   = SV-03 เท่านั้น 1 ทะเบียน · 2 โยธา · 3 หัวหน้า (บริการอื่น NULL)
--  returned_at / return_reason = การตีกลับครั้งล่าสุด · fix_deadline = returned_at + 168 ชม. (มีค่าเฉพาะตอน NEED_FIX)
--  closed_at = เวลาปิดงาน COMPLETED/REJECTED เท่านั้น · cancelled_at = เวลายกเลิก (CANCELLED ไม่ใช่ปิดงาน)
CREATE TABLE IF NOT EXISTS cases (
  case_no       TEXT PRIMARY KEY,              -- EG-2569-000001
  year_be       INTEGER NOT NULL,
  seq           INTEGER NOT NULL,
  draft_id      TEXT,
  user_id       INTEGER NOT NULL,              -- ผู้ยื่น (users.id)
  service_id    TEXT NOT NULL,
  qty           INTEGER,
  area_sqm      INTEGER,
  fee           INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('SUBMITTED','IN_REVIEW','NEED_FIX','PENDING_APPROVAL','APPROVED','COMPLETED','REJECTED','CANCELLED')),
  step          INTEGER,
  dept          TEXT,
  owner         TEXT,
  issuer        TEXT,
  approved_by   TEXT,
  approved_at   TEXT,
  return_count  INTEGER NOT NULL DEFAULT 0,
  returned_at   TEXT,
  return_reason TEXT,
  fix_deadline  TEXT,
  paid_at       TEXT NOT NULL,
  receipt_no    TEXT NOT NULL UNIQUE,
  due_at        TEXT NOT NULL,
  closed_at     TEXT,
  cancelled_at  TEXT,
  doc_no        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (year_be, seq)
);
CREATE INDEX IF NOT EXISTS idx_cases_user   ON cases(user_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_owner  ON cases(owner);

-- ไทม์ไลน์ของคำขอ (case-timeline) · แยกจาก audit (audit ว่างหลัง reset แต่ไทม์ไลน์ seed มีประวัติ)
-- event: SUBMITTED CLAIM RETURN RESUBMIT FORWARD APPROVE REJECT ISSUE CANCEL AUTO_CANCEL
CREATE TABLE IF NOT EXISTS case_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no     TEXT NOT NULL,
  at          TEXT NOT NULL,
  actor       TEXT,                            -- username (เจ้าหน้าที่) · NULL = ประชาชน/ระบบ
  actor_role  TEXT,                            -- citizen | officer | head | system
  event       TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_case_events_case ON case_events(case_no, at);

-- ไฟล์แนบ (เก็บเนื้อไฟล์ใน DB) · ผูกกับร่าง (draft_id) และ/หรือคำขอ (case_no เมื่อชำระแล้ว)
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,                -- fileId เช่น F-000001
  draft_id    TEXT,
  case_no     TEXT,
  doc_key     TEXT NOT NULL,                   -- id-card map site-photo plan deed extra
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mime        TEXT NOT NULL,                   -- จาก magic bytes: application/pdf image/jpeg image/png
  content     BLOB NOT NULL,
  uploaded_at TEXT NOT NULL,
  uploaded_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attach_draft ON attachments(draft_id);
CREATE INDEX IF NOT EXISTS idx_attach_case  ON attachments(case_no);

-- เอกสารดิจิทัล · signature = crypto.signDocument({docNo,caseNo,applicant,serviceId,issuedAt,validUntil,signer})
-- tamper (test hook) แก้ฟิลด์ที่เก็บ (เช่น applicant) โดยไม่คำนวณ signature ใหม่
CREATE TABLE IF NOT EXISTS documents (
  doc_no      TEXT PRIMARY KEY,                -- DOC-2569-000001
  case_no     TEXT NOT NULL UNIQUE,
  verify_code TEXT NOT NULL UNIQUE,            -- [A-Z0-9]{8}
  applicant   TEXT NOT NULL,                   -- ชื่อเต็มผู้ยื่น
  service_id  TEXT NOT NULL,
  issued_at   TEXT NOT NULL,
  valid_until TEXT NOT NULL,                   -- YYYY-MM-DD วันสุดท้ายที่ใช้ได้ (A-43)
  signer      TEXT NOT NULL,                   -- ชื่อแสดงผู้ลงนาม (= ผู้อนุมัติ)
  signature   TEXT NOT NULL,
  issued_by   TEXT                             -- username ผู้กดออกเอกสาร
);

-- แจ้งเตือนกระดิ่ง · 1 ครั้งต่อ (ผู้รับ, คำขอ, ระดับ) → INSERT OR IGNORE
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  case_no    TEXT NOT NULL,
  level      TEXT NOT NULL CHECK (level IN ('near','overdue')),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at    TEXT,
  UNIQUE (username, case_no, level)
);
CREATE INDEX IF NOT EXISTS idx_noti_user ON notifications(username);

-- Audit Trail: เพิ่มได้อย่างเดียว (trigger กัน UPDATE/DELETE · reset เท่านั้นที่ล้างได้)
CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  time        TEXT NOT NULL,
  username    TEXT,
  role        TEXT,
  event       TEXT NOT NULL,
  case_no     TEXT,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit(time);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN
  SELECT RAISE(ABORT, 'audit trail is append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
WHEN (SELECT value FROM meta WHERE key = 'allow_audit_wipe') IS NULL
BEGIN
  SELECT RAISE(ABORT, 'audit trail is append-only');
END;
`;

/** ตารางที่ reset ล้าง (meta เก็บไว้: schema_version · clock) */
const DATA_TABLES = [
  'sessions', 'otp_state', 'notifications', 'audit', 'case_events', 'attachments', 'documents',
  'payments', 'cases', 'drafts', 'holidays', 'services', 'users', 'counters',
];

module.exports = { DDL, DATA_TABLES };
