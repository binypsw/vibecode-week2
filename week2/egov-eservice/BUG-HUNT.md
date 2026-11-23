# BUG-HUNT · egov-eservice (เทศบาลนครก็อตแทม)

ผลรัน Playwright ชุดเต็ม 51 TC กับเว็บที่เปิด `BUG_MODE` ทีละตัว (BUGS.md §3) รันเองใน container `multi-account` เมื่อ 2026-11-22 ด้วย `app/tests/bug-matrix.sh` (container ต่อชุดบั๊ก พอร์ต 3201+) ผลดิบอยู่ที่ [`test-report/bug-matrix/bug-*.json`](test-report/bug-matrix/)

ก่อนรันผมลบผลเก่าที่ agent B14 สร้างไว้ทิ้ง เพื่อให้ตารางด้านล่างมาจากการรันใหม่ทั้งหมด การเทียบกับ BUGS.md ทำด้วยสคริปต์แยกที่อ่านตาราง BUGS.md §2 เอง ไม่ได้ใช้ `bug-matrix-summary.js` ของ B14

## ขั้นตอนตาม BUGS.md §3

| ขั้น | ผล |
|---|---|
| 1 รันเว็บถูกต้อง (`TEST_MODE=1`, ไม่ตั้ง `BUG_MODE`) | ✅ 51/51 |
| 2 รันซ้ำทันทีโดยไม่ restart เว็บ | ✅ 51/51 (รันต่อกัน 3 รอบบน container เดิม) |
| 3 B01–B12 ทีละตัว | ✅ ทุกตัว TC ที่ต้องล้มล้มครบ · มี 1 กรณีล้มเกินจากรายการ (B03, ดูด้านล่าง) |
| 4 ข้อความที่ล้มบอกค่าจริงต่างจากค่าที่คาด | ✅ ทุกตัว (ดูคอลัมน์ "ข้อความที่ล้ม") |
| 5 รวมบั๊ก | ✅ `B03,B07` และ `B01,B05,B09` ล้มเท่ากับ union ของแต่ละตัวพอดี |
| 6 ปิดบั๊กแล้วกลับมาผ่าน | ✅ 51/51 (รันหลังเมทริกซ์จบ, `BUG_MODE=` ว่าง) |

## ตารางบันทึกผล (รูปแบบ BUGS.md §4)

| บั๊ก | TC ที่คาดว่าล้ม | TC ที่ล้มจริง | TC ล้มเกินที่คาด | TC ที่ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|
| (ปกติ) | – | – | – | – | 51/51 passed |
| B01 | TC-FEE-01 | TC-FEE-01 | – | – | 50 passed · 1 failed ✅ |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | 50 passed · 1 failed ✅ |
| B03 | TC-SLA-01 · TC-SLA-02 (อาจล้มด้วย TC-SLA-03 · TC-RBAC-04) | TC-SLA-01 · TC-SLA-02 · TC-RBAC-04 · TC-NOTI-02 | **TC-NOTI-02** | – | 47 passed · 4 failed ⚠️ จับได้ครบ แต่ล้มเกินรายการ 1 ข้อ |
| B04 | TC-SLA-02 | TC-SLA-02 | – | – | 50 passed · 1 failed ✅ |
| B05 | TC-PAY-01 | TC-PAY-01 | – | – | 50 passed · 1 failed ✅ |
| B06 | TC-RBAC-01 | TC-RBAC-01 | – | – | 50 passed · 1 failed ✅ |
| B07 | TC-RBAC-02 | TC-RBAC-02 | – | – | 50 passed · 1 failed ✅ |
| B08 | TC-QUEUE-02 | TC-QUEUE-02 | – | – | 50 passed · 1 failed ✅ |
| B09 | TC-PDPA-02 | TC-PDPA-02 | – | – | 50 passed · 1 failed ✅ |
| B10 | TC-DASH-02 (อาจล้มด้วย TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | – (อยู่ในรายการที่ยอมรับ) | – | 48 passed · 3 failed ✅ |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-PDPA-03 · TC-AUDIT-01 | – | – | 49 passed · 2 failed ✅ |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | 50 passed · 1 failed ✅ |
| B03,B07 | union ของ B03 และ B07 | TC-SLA-01 · TC-SLA-02 · TC-NOTI-02 · TC-RBAC-02 · TC-RBAC-04 | – | – | 46 passed · 5 failed ✅ = union |
| B01,B05,B09 | union ของ B01 B05 B09 | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | – | – | 48 passed · 3 failed ✅ = union |

**สรุป: จับได้ 12 จาก 12 บั๊ก** (TC ที่ BUGS.md ระบุให้ล้มล้มครบทุกตัว ไม่มี TC ที่ควรล้มแต่ผ่าน)

## ข้อความที่ล้ม (ค่าจริงต่างจากค่าที่คาด)

| บั๊ก | TC | ข้อความ |
|---|---|---|
| B01 | TC-FEE-01 | `fee` expected `1010` received `1000` (พื้นที่ 101) |
| B02 | TC-UPLOAD-01 | `size-5242880.pdf` อัปโหลดจากหน้าเว็บ expected status `201` received `400` |
| B03 | TC-SLA-01 | `dueAt` expected `2026-12-08T16:30:00+07:00` received `2026-12-07T16:30:00+07:00` |
| B03 | TC-SLA-02 | `dueAt` expected `2026-12-08T16:30:00+07:00` received `2026-12-07T16:30:00+07:00` |
| B03 | TC-RBAC-04 | `dueAt` expected `2026-12-08T16:30:00+07:00` received `2026-12-04T16:30:00+07:00` |
| B03 | TC-NOTI-02 | `bell-count` expected `10` received `9` |
| B04 | TC-SLA-02 | `dueAt` expected `2026-12-08T16:30:00+07:00` received `2026-12-04T16:30:00+07:00` |
| B05 | TC-PAY-01 | `POST /api/test/payments/PP-0001/pay` (อายุ 15:00) expected `410` received `200` |
| B06 | TC-RBAC-01 | `/citizen/cases/EG-2569-000005` expected HTTP `404` received `200` |
| B07 | TC-RBAC-02 | `POST /api/cases/EG-2569-000014/approve` (off.reg2) expected `403` received `200` |
| B08 | TC-QUEUE-02 | `action-error` expected `มีเจ้าหน้าที่รับเรื่องนี้แล้ว` received `` (ว่าง เพราะคนที่ 2 รับเรื่องได้ ไม่มี error) |
| B09 | TC-PDPA-02 | `/api/officer/queue?filter=all` (off.reg1) มี `idNo` เต็ม expected `false` received `true` |
| B10 | TC-DASH-01 | `kpi-ontime-pct` expected `–` received `0.0%` |
| B10 | TC-DASH-02 · TC-DASH-03 | `kpi-ontime-pct` expected `85.7%` received `23.1%` (6 ÷ 26 แทน 6 ÷ 7) |
| B11 | TC-PDPA-03 | `audit-count` (กรอง UNMASK) expected `1` received `0` |
| B11 | TC-AUDIT-01 | `audit-count` expected `16` received `15` |
| B12 | TC-WORKFLOW-04 | `return-btn` expected count `0` received `1` (ตีกลับครั้งที่ 3 ยังทำได้) |

ข้อสังเกต B08: ข้อความล้มเป็นการเทียบข้อความ (expected เทียบ received ว่าง) ผ่านการรอ `toHaveText` 10 วินาที ไม่ใช่การหา element ไม่เจอ แต่ค่า received เป็นสตริงว่างเพราะไม่มี error ปรากฏ ซึ่งสะท้อนบั๊กจริง (คนที่ 2 รับเรื่องสำเร็จ)

## Triage: ข้อที่ผลไม่ตรงรายการ

| บั๊ก | อาการ | จำแนก | เหตุผล |
|---|---|---|---|
| B03 | TC-NOTI-02 ล้มด้วย (`bell-count` expected `10` received `9`) ทั้งที่ BUGS.md ไม่ได้ระบุ | **โจทย์ไม่ครบ** (BUGS.md) ไม่ใช่เว็บหรือ test ผิด | ขั้น "เริ่มประเมินครั้งแรกเมื่อเลยกำหนดแล้ว" (ส. 5 ธ.ค. 10:00) คาดว่ามีแจ้งเตือน `…000016` ระดับใกล้ครบกำหนด (เหลือ 1 วัน: อ. 8 ธ.ค. เพราะ 7 ธ.ค. เป็นวันหยุด) แต่ B03 ไม่ข้ามวันหยุดในตาราง วันคงเหลือจึงเป็น 2 (ปกติ) ไม่มีแจ้งเตือน เป็นกลไกเดียวกับที่ BUGS.md ยอมรับไว้แล้วสำหรับ TC-SLA-03 (ฟังก์ชันวันทำการตัวเดียวกันนับวันคงเหลือ) |

ข้อเสนอถึง TA: เพิ่ม TC-NOTI-02 ในช่อง "TC ที่อาจล้มด้วย" ของ B03 ใน BUGS.md (ตาราง §2, §4, §6) และไม่ควรแยกฟังก์ชันวันทำการของการแจ้งเตือนออกจากของ SLA เพราะระดับเตือนบนจอกับกระดิ่งจะไม่ตรงกัน (BR-14 กับ A-30 ใช้วันคงเหลือตัวเดียวกัน)

ไม่ได้แก้ test หรือเว็บในรอบนี้ ผมไม่ได้เปลี่ยนค่าที่คาดหวังของ test ใด

## ข้อจำกัดของหลักฐานนี้

- บั๊ก 12 ตัวครอบคลุม 16 TC จาก 51 ส่วนที่เหลือไม่ได้พิสูจน์ด้วย mutation
- ไม่มี transcript ของ agent ที่เขียน/แก้ test (Codex เป็น ephemeral, session ของ B14 ไม่ถูกเก็บ) จึงยืนยันไม่ได้ว่าไม่มีการแก้ test ให้ตรงหน้าจอ หลักฐานทางอ้อมคือ (1) test จับบั๊กได้ครบ 12/12 (2) ยิง API ตรงด้วยตัวเลขจาก spec 20 จุด เว็บตรงทั้งหมด โดยไม่ผ่านตัว test (3) `part-a.spec.js` ใหญ่ขึ้นหลัง B14 เพียง ~439 ไบต์
- `part-b.spec.js` ถูก B03 เขียนใหม่ตอน resume หลังมีโค้ดเว็บแล้ว (ขนาด 81.6 KB → 77.1 KB)
