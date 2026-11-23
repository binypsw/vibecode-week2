# INTEGRATION · B14 รวมระบบ + Playwright 51 TC + BUG_MODE B01–B12

run `egov-eservice-20261122-060252` · วันที่ 2026-11-22 · ผู้ทำ B14 (yolo2)

## 1. สรุปผลตามเกณฑ์เสร็จ

| เกณฑ์ | ผล | หลักฐาน |
|---|---|---|
| `docker compose up` ได้ | ✅ `TEST_MODE=1 BUG_MODE= docker compose up --build -d` build และ start ได้ · `/api/health` = `{"status":"ok"}` · โหลด route ครบ 9 ไฟล์ · hook `10:workflow.auto-cancel` `20:sla-notifications` | `docker compose logs` |
| 51 TC ผ่านหมดเมื่อไม่ตั้ง BUG_MODE | ✅ **51/51 สามรอบ** บน container ของ compose (รอบ 2 และ 3 รันติดกันโดยไม่ restart เว็บ · รอบ 4 รันหลังสลับ BUG_MODE=B01 แล้วกลับเป็นค่าว่าง) | `pw-report/normal-{2,3,4}.json/.log` |
| เปิด BUG_MODE ทีละตัว B01–B12 แล้ว TC ที่ BUGS.md ระบุล้มจริง | ✅ **ครบ 12/12 บั๊ก** TC ใน "TC ที่ต้องล้ม" ล้มทุกตัว และไม่มี TC ที่ควรล้มแต่ผ่าน · มี 1 ข้อที่ล้มเกินจากรายการ (TC-NOTI-02 ตอน B03 อธิบายในข้อ 5.3) | `pw-report/bug-*.json/.log` |
| รวมบั๊ก (BUGS.md §3 ขั้น 5) | ✅ `B03,B07` และ `B01,B05,B09` ล้มเท่ากับ union ของแต่ละตัว | `pw-report/bug-B03_B07.*` `bug-B01_B05_B09.*` |
| ปิดบั๊กแล้วกลับ 51/51 (ขั้น 6) | ✅ `normal-4` | |

## 2. วิธีรัน

```bash
cd /workspace/plans/egov-eservice/app
TEST_MODE=1 BUG_MODE= docker compose up --build -d          # เว็บถูกต้อง พอร์ต 3000 · DB อยู่ ./data/egov.db
BASE_URL=http://localhost:3000 DB_PATH=data/egov.db npx playwright test    # คาดหวัง 51 passed

TEST_MODE=1 BUG_MODE=B03 docker compose up -d               # เปลี่ยนชุดบั๊ก = รันคำสั่งนี้ใหม่ (container ถูกสร้างใหม่)

tests/bug-matrix.sh                     # รัน B01..B12 + B03,B07 + B01,B05,B09 ใน container แยกพอร์ต 3201.. (พร้อมกัน 4 ชุด)
node tests/bug-matrix-summary.js        # สรุป pw-report/*.json เทียบตาราง BUGS.md §2
```

- `playwright.config.js` บังคับ `workers: 1` เพราะทุก TC เรียก `/api/test/reset` ซึ่งล้างข้อมูลและ session ทั้งระบบ
- เครื่องนี้มี Chromium build 1252 แต่ Playwright 1.65 ต้องการ 1255 config จึงเลือก `/ms-playwright/chromium_headless_shell-125x` ที่มีอยู่ให้เอง (ตั้ง `CHROMIUM_PATH` เพื่อเลือกเองได้) ถ้าเครื่องไม่มีโฟลเดอร์นี้จะใช้ browser ปกติของ Playwright
- TC-NFR-04 อ่าน DB จาก `DB_PATH` และ log จาก `LOG_PATH` ถ้าไม่ตั้งจะใช้ `docker compose logs` ส่วน `bug-matrix.sh` เก็บ log ของ container ไว้ที่ `data/bug/<ชุด>/server.log` แล้วส่งเป็น `LOG_PATH` ให้
- ตรวจด้วย curl เพิ่ม: container ที่ไม่ตั้ง `TEST_MODE` ตอบ 404 ทั้ง `POST /api/test/reset` และ `GET /api/test/clock` ส่วน `/api/health` และ `/verify/K7M2Q9XA` ยังตอบ 200

## 3. ตรวจ route ชนกัน และ data-testid ตาม CONTRACT

**Route** ดึง `app.<method>('<path>')` จาก `server.js` และ `routes/*.js` แล้วนับซ้ำ เจอ method+path ซ้ำ 2 คู่ ซึ่งตั้งใจให้ซ้ำทั้งคู่:

| route | ไฟล์ | สถานะ |
|---|---|---|
| `GET /api/cases/:caseNo/files` | citizen.js:359 → officer.js:235 | ตั้งใจ: citizen.js ตอบเฉพาะประชาชน บทบาทอื่นส่งต่อด้วย `next()` (board B06/B08) |
| `GET /api/files/:fileId` | citizen.js:366 → officer.js:248 | ตั้งใจ แบบเดียวกัน |

route ใน `server.js` (health, test/reset, test/clock, `/`, logout, static) ไม่มีไฟล์ไหนประกาศซ้ำ · มีทุกหน้าใน CONTRACT §1 (16 route) และทุก API ใน §6/§8 · `PUT/PATCH/DELETE /api/audit[/:id]` ตอบ 405 จาก admin.js:184

**data-testid** ดึงชื่อใน backtick ของ CONTRACT §2 ได้ 233 ชื่อ เทียบกับ source แล้วมีครบ ชื่อที่ grep ตรงตัวไม่เจอเป็นชื่อที่สร้างตอนรันทั้งหมด ได้แก่ `audit-${key}` (admin.js:130) · `${kind}-reason/-submit` (officer.js:381) · `upload-input-${key}` (views/citizen/pages.js:139) ส่วน `audit-edit-btn` / `audit-delete-btn` CONTRACT ห้าม render และไม่มีจริง · ชื่อที่เหลือที่ grep ไม่เจอไม่ใช่ testid (เช่น `data-date` `disabled` `deed`) · ทั้ง 51 TC ใช้ testid เหล่านี้จริงและผ่านหมด

## 4. ผลรันโหมดปกติ (ไม่ตั้ง BUG_MODE)

| รอบ | เว็บ | ผล | หมายเหตุ |
|---|---|---|---|
| normal-1 | compose (โค้ดก่อนแก้) | 48/51 | ล้ม TC-WORKFLOW-01 · TC-WORKFLOW-06 · TC-NFR-01 เป็นเว็บผิดทั้ง 3 ข้อ (ข้อ 5.1) |
| normal-2 | compose (rebuild หลังแก้) | **51/51** (1.8m) | |
| normal-3 | compose ตัวเดิม ไม่ restart | **51/51** (2.4m) | ยืนยันว่า reset ทำให้ผลซ้ำได้ (BUGS.md §3 ขั้น 2) |
| normal-4 | compose หลังสลับ `BUG_MODE=B01` แล้วกลับเป็นค่าว่าง | **51/51** (2.0m) | รวม test TC-UPLOAD-01 ที่แก้ในข้อ 5.2 แล้ว |

## 5. ข้อที่ล้มและการจัดประเภท

### 5.1 เว็บผิด (แก้แล้วใน `views/citizen/pages.js` ของ B06)

| TC | อาการ | สาเหตุ | แก้ |
|---|---|---|---|
| TC-WORKFLOW-01 | `assertPdf`: `headers` เป็น undefined | ลิงก์ `download-doc-btn` มีแอตทริบิวต์ `download` ทำให้ Chromium ดาวน์โหลดตรงโดยข้าม `context.route()` (B08 แจ้งไว้บน board) | เอาแอตทริบิวต์ `download` ออก ไฟล์ยังถูกดาวน์โหลดเพราะ server ส่ง `Content-Disposition: attachment; filename="DOC-….pdf"` |
| TC-WORKFLOW-06 | `response.json: … navigated away from` | หลังส่งแก้สำเร็จ หน้าเรียก `location.reload()` ทันที body ของ response จึงหายก่อนจะอ่าน (B09 แจ้งไว้) | ยกเลิกคำขอ/ส่งแก้สำเร็จแล้วให้ดึงหน้าเดิมด้วย fetch แล้วแทนเนื้อหาใน `<main>` (ไม่ navigate) จากนั้นผูก handler ใหม่ แสดงข้อความสำเร็จ ถ้า fetch ล้มจึงค่อย reload |
| TC-NFR-01 | `to-payment-btn` ยัง disabled หลังแนบบัตรประชาชน | race: ถ้าเลือกไฟล์ก่อนบันทึกร่างเสร็จ (`draft` ยังเป็น null) handler `change` จะ return ทิ้งไฟล์ไปเงียบ ๆ ตาม trace ไม่มี `POST /files` เลย ผู้ใช้จริงที่เลือกไฟล์เร็วก็เจอได้ | เก็บ promise `ready` (บันทึกร่าง + โหลดร่าง) ไว้ แล้วให้การอัปโหลดรอ `ready` ก่อน |

### 5.2 test ผิด / เปราะ (แก้แล้ว ไม่เปลี่ยนค่าที่คาดหวัง)

| TC | อาการ | แก้ |
|---|---|---|
| TC-UPLOAD-01 (`tests/part-a.spec.js` ของ B02) | ตอน B02 ล้มก็จริง แต่ข้อความเป็น "element(s) not found" ของ `file-item` หลังรอ 10 วิ ซึ่งผิดกติกา BUGS.md §3 ขั้น 4 / §5 (ต้องบอกค่าจริงต่างจากที่คาด) | ให้รอ response ของ `POST /api/drafts/:id/files` ที่หน้าเว็บส่ง แล้ว assert status 201 ก่อน ตอนนี้ B02 ล้มด้วย `size-5242880.pdf uploaded from the page · Expected: 201 · Received: 400` · assert เดิมยังอยู่ครบ |

ข้อความที่ล้มใน BUG_MODE อื่นบอกค่าที่คาดกับค่าจริงอยู่แล้ว (ดูข้อ 6) จึงไม่ได้แก้ test ส่วนอื่น

### 5.3 โจทย์ผิด / ไม่ครบ (ไม่แก้เว็บ ส่งเป็นข้อสังเกต)

| เรื่อง | รายละเอียด | ข้อเสนอ |
|---|---|---|
| **B03 ทำให้ TC-NOTI-02 ล้มด้วย แต่ BUGS.md ไม่ได้ระบุ** | ขั้น "เริ่มประเมินครั้งแรกเมื่อเลยกำหนดแล้ว" (ส.5 ธ.ค. 10:00) คาดว่า off.reg2 มี 10 รายการ รวม `…000016` ใกล้ครบกำหนด (TEST-DATA บรรทัด 236: "เหลือ 1: อ.8 ธ.ค." เพราะ 7 ธ.ค. เป็นวันหยุดในตาราง) แต่ B03 ไม่สนตารางวันหยุด จึงนับ 7 ธ.ค. เป็นวันทำการ วันคงเหลือเลยเป็น 2 (ปกติ) และไม่มีแจ้งเตือน ผลคือ `bell-count` Expected "10" Received "9" ซึ่งเป็นกลไกเดียวกับที่ BUGS.md ยอมรับไว้แล้วสำหรับ TC-SLA-03 ส่วน B ("ฟังก์ชันวันทำการตัวเดียวกันใช้นับวันคงเหลือข้าม 7 ธ.ค.") | เพิ่ม TC-NOTI-02 ในช่อง "TC ที่อาจล้มด้วย" ของ B03 ไม่ควรแยกฟังก์ชันวันทำการของการแจ้งเตือนออกจากของ SLA เพราะระดับเตือนบนจอกับกระดิ่งจะไม่ตรงกัน (BR-14 กับ A-30 ใช้วันคงเหลือตัวเดียวกัน) |

## 6. ตารางบันทึกผล BUG_MODE (รูปแบบ BUGS.md §4)

แต่ละชุดรันใน container แยกจาก image เดียวกับ compose (`gotham-egov-eservice:latest`) ด้วย `tests/bug-matrix.sh` และรันชุดเต็ม 51 TC ทุกครั้ง

| บั๊ก | TC ที่คาดว่าล้ม (ตาราง 2) | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|
| (ปกติ) | – | – | – | – | 51/51 passed ✅ (×3) |
| B01 | TC-FEE-01 | TC-FEE-01: `fee` expected 1010 received 1000 | – | – | 50/51 ✅ |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01: `size-5242880.pdf` expected 201 received 400 | – | – | 50/51 ✅ |
| B03 | TC-SLA-01 · TC-SLA-02 (อาจ: SLA-03 · RBAC-04) | TC-SLA-01: `dueAt` expected `2026-12-08T16:30` received `2026-12-07T16:30` · TC-SLA-02: `dueAt` 12-08 → 12-07 · TC-RBAC-04 (อาจล้ม): `dueAt` 12-08 → 12-04 · TC-NOTI-02: `bell-count` 10 → 9 | **TC-NOTI-02** (ข้อ 5.3) | – | 47/51 ✅ (ล้มเกิน 1 ข้อ มีคำอธิบาย) · TC-SLA-03 ผ่าน |
| B04 | TC-SLA-02 | TC-SLA-02: `dueAt` expected `2026-12-08T16:30` received `2026-12-04T16:30` | – | – | 50/51 ✅ |
| B05 | TC-PAY-01 | TC-PAY-01: `pay PP-0001` expected 410 received 200 | – | – | 50/51 ✅ |
| B06 | TC-RBAC-01 | TC-RBAC-01: `/citizen/cases/EG-2569-000005` expected 404 received 200 | – | – | 50/51 ✅ |
| B07 | TC-RBAC-02 | TC-RBAC-02: `POST /api/cases/EG-2569-000014/approve` expected 403 received 200 | – | – | 50/51 ✅ |
| B08 | TC-QUEUE-02 | TC-QUEUE-02: `action-error` expected "มีเจ้าหน้าที่รับเรื่องนี้แล้ว" received "" | – | – | 50/51 ✅ |
| B09 | TC-PDPA-02 | TC-PDPA-02: off.reg1 `/api/officer/queue` มีเลข 13 หลัก expected false received true | – | – | 50/51 ✅ |
| B10 | TC-DASH-02 (อาจ: DASH-01 · DASH-03) | TC-DASH-02: `kpi-ontime-pct` expected "85.7%" received "23.1%" · TC-DASH-01 (อาจล้ม): "–" → "0.0%" · TC-DASH-03 (อาจล้ม): "85.7%" → "23.1%" | – | – | 48/51 ✅ |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03: `audit-count` expected "1" received "0" · TC-AUDIT-01: `audit-count` expected "16" received "15" | – | – | 49/51 ✅ |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04: `return-btn` count expected 0 received 1 | – | – | 50/51 ✅ |
| B03,B07 | union | SLA-01 · SLA-02 · RBAC-02 · RBAC-04 · NOTI-02 | NOTI-02 (เหมือน B03 เดี่ยว) | – | 46/51 ✅ = B03 ∪ B07 |
| B01,B05,B09 | union | FEE-01 · PAY-01 · PDPA-02 | – | – | 48/51 ✅ = B01 ∪ B05 ∪ B09 |

ทุก TC ที่ล้มในตารางนี้ล้มด้วยค่าที่ต่างจากที่คาด ไม่มีข้อไหนล้มเพราะหา element ไม่เจอหรือ timeout หลังแก้ข้อ 5.2

## 7. ไฟล์ที่ B14 เพิ่ม/แก้

| ไฟล์ | เจ้าของเดิม | เปลี่ยนอะไร |
|---|---|---|
| `playwright.config.js` | ใหม่ | testDir `tests` · workers 1 · reporter list + json (`PW_JSON`) · เลือก Chromium ในเครื่องให้อัตโนมัติ |
| `tests/bug-matrix.sh` · `tests/bug-matrix-summary.js` | ใหม่ | รันและสรุป BUG_MODE ตามข้อ 2 |
| `views/citizen/pages.js` | B06 | แก้ 3 จุดตามข้อ 5.1 |
| `tests/part-a.spec.js` | B02 | TC-UPLOAD-01 รอ response ของการอัปโหลดตามข้อ 5.2 (ค่าที่คาดหวังเหมือนเดิม) |
| `package.json` · `package-lock.json` | B01 | เพิ่ม devDependency `pdf-parse@^2.4.5` ที่ TC-DASH-03 ต้องใช้อ่านข้อความใน PDF (image ใน Docker ไม่ได้รับผลเพราะ `npm ci --omit=dev`) |
| `.dockerignore` | B01 | ไม่คัดลอก `pw-report` `playwright.config.js` `test-results-bug` เข้า image |
| `pw-report/` | ใหม่ | ผลรันทุกรอบ (`normal-1..4`, `bug-*`) เป็น `.json` + `.log` |

ไฟล์ route ของบล็อกอื่นไม่ได้แก้ (auth, citizen, payment, officer, workflow, notifications, documents, reports, admin, lib/sla)

## 8. ข้อสังเกตอื่น

- พบ `node server.js` ที่ B12 เปิดค้างไว้บนพอร์ต 3912/3913 (DB อยู่ `data/b12tmp/` ซึ่งถูกลบไปแล้ว) ไม่ได้ปิดเพราะไม่ใช่ process ของ B14 ไม่ชนกับพอร์ต 3000/3201–3214 ที่ใช้
- เวลาที่ใช้: ชุดเต็มบน compose ราว 2 นาที · bug matrix 14 ชุด (พร้อมกัน 4) ราว 12 นาที
- `NO_TEST_BASE_URL` ของ TC-NFR-03 เป็นค่าไม่บังคับ ในรอบนี้ไม่ได้ตั้ง แต่ตรวจด้วย curl แทนแล้ว (ข้อ 2)
