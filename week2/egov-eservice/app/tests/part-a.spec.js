const { test: baseTest, expect } = require('@playwright/test');
const { deflateSync } = require('node:zlib');

const BASE_URL = process.env.BASE_URL;
const SOMCHAI = '1101700123456';
const SOMYING = '3100600987659';
const PITI = '1909900555015';
const MANA = '5500400111221';
const OTP = '123456';
const PASSWORD = 'Test@1234';
const START = '2026-12-01T09:00:00+07:00';
const LOCKED_UNTIL = '2026-12-01T09:15:00+07:00';

const messages = {
  id: 'เลขบัตรประชาชนไม่ถูกต้อง',
  otp: 'รหัส OTP ไม่ถูกต้อง',
  locked: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที',
  staff: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  mobile: 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0',
  consent: 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)',
  qty: 'จำนวนฉบับต้อง 1–5 ฉบับ',
  area: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.',
  areaLimit: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
  plan: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น',
  fileSize: 'ไฟล์ใหญ่เกิน 5 MB',
  fileCount: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  fileType: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG',
  qr: 'QR หมดอายุ กรุณาสร้าง QR ใหม่',
  noRefund: 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน',
  cannotCancel: 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว',
  claimed: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว',
  workload: 'รับงานได้สูงสุด 10 เรื่อง',
};

const levels = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
};

const staffAccounts = [
  ['off.reg1', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 1', 'officer', 'เจ้าหน้าที่', 'registry'],
  ['off.reg2', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 2', 'officer', 'เจ้าหน้าที่', 'registry'],
  ['off.works1', '/officer/queue', 'เจ้าหน้าที่โยธา 1', 'officer', 'เจ้าหน้าที่', 'works'],
  ['head1', '/head/approvals', 'หัวหน้าฝ่าย', 'head', 'หัวหน้าฝ่าย'],
  ['exec1', '/dashboard', 'ผู้บริหาร', 'executive', 'ผู้บริหาร'],
  ['audit1', '/audit', 'ผู้ตรวจสอบภายใน', 'auditor', 'ผู้ตรวจสอบภายใน'],
  ['admin1', '/admin/services', 'ผู้ดูแลระบบ', 'admin', 'ผู้ดูแลระบบ'],
];

const caseNo = (number) => 'EG-2569-' + String(number).padStart(6, '0');
const caseApi = (number) => '/api/cases/' + caseNo(number);
const citizenCase = (number) => '/citizen/cases/' + caseNo(number);
const officerCase = (number) => '/officer/cases/' + caseNo(number);
const action = (number, verb) => '/api/officer/cases/' + caseNo(number) + '/' + verb;
const dec = (day, time) => '2026-12-' + String(day).padStart(2, '0') + 'T' + time + '+07:00';
const due = (day) => dec(day, '16:30:00');
const draftApi = (id) => '/api/drafts/' + id;
const newCase = (serviceId) => '/citizen/new/' + serviceId;
const paymentApi = (ref) => '/api/payments/' + ref;
const id = (page, name) => page.getByTestId(name);
const queueRow = (page, number) => id(page, 'queue-row').and(page.locator('[data-case-no="' + caseNo(number) + '"]'));
const paid = (number, duplicate = false, year = 2569) => {
  const suffix = year + '-' + String(number).padStart(6, '0');
  return { status: 'PAID', caseNo: 'EG-' + suffix, receiptNo: 'RC-' + suffix, duplicate };
};

async function json(responsePromise, status = 200, fields) {
  const response = await responsePromise;
  expect(response.status(), response.url()).toBe(status);
  const body = await response.json();
  if (fields) expect(body).toMatchObject(fields);
  return body;
}

function apiError(response, status, code, message, other = {}) {
  return json(response, status, { code, ...(message ? { message } : {}), ...other });
}

async function httpStatus(responsePromise, status) {
  const response = await responsePromise;
  expect(response.status(), response.url()).toBe(status);
}

async function clock(api, now) {
  await json(api.put('/api/test/clock', { data: { now } }), 200, { now });
}

function startOtp(api, idNo) {
  return api.post('/api/auth/thaid/start', { data: { idNo } });
}

function verifyOtp(api, idNo, otp = OTP) {
  return api.post('/api/auth/thaid/verify', { data: { idNo, otp } });
}

function staffLogin(api, username, password = PASSWORD) {
  return api.post('/api/auth/staff/login', { data: { username, password } });
}

async function apiCitizen(api, idNo = SOMCHAI, registered = true) {
  await json(startOtp(api, idNo), 200, { status: 'OTP_SENT' });
  await json(verifyOtp(api, idNo), 200, { registered });
}

async function apiStaff(api, username) {
  const [, landing, , role, , dept] = staffAccounts.find(([name]) => name === username);
  await json(staffLogin(api, username), 200, { landing, role, ...(dept ? { dept } : {}) });
}

// Reset affects the entire server. Use one Playwright worker for all specs sharing BASE_URL.
baseTest.describe.configure({ mode: 'default', timeout: 120_000 });
baseTest.use({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });

const test = baseTest.extend({
  app: async ({ request, browser }, use) => {
    expect(BASE_URL, 'Set BASE_URL to the TEST_MODE=1 server').toBeTruthy();
    const contexts = [];
    const reset = async () => {
      while (contexts.length) await contexts.pop().close();
      await json(request.post('/api/test/reset'), 200, { ok: true, now: START });
    };
    const page = async () => {
      const context = await browser.newContext({ baseURL: BASE_URL });
      contexts.push(context);
      return context.newPage();
    };
    const citizen = async (idNo = SOMCHAI) => {
      const session = await page();
      await apiCitizen(session.request, idNo);
      return session;
    };
    const staff = async (username) => {
      const session = await page();
      await apiStaff(session.request, username);
      return session;
    };
    await reset();
    try {
      await use({ page, citizen, staff, reset, clock: (now) => clock(request, now) });
    } finally {
      while (contexts.length) await contexts.pop().close();
    }
  },
});

async function expectPath(page, path) {
  await expect(page).toHaveURL(new URL(path, BASE_URL).href);
}

async function uiStartOtp(page, idNo) {
  await id(page, 'thaid-id-input').fill(idNo);
  await expect(id(page, 'thaid-id-input')).toHaveValue(idNo);
  await id(page, 'thaid-submit').click();
}

async function uiOtp(page, otp) {
  await id(page, 'otp-input').fill(otp);
  await id(page, 'otp-submit').click();
}

async function uiCitizen(page, idNo, path = '/citizen') {
  await page.goto('/login');
  await id(page, 'login-tab-citizen').click();
  await uiStartOtp(page, idNo);
  await uiOtp(page, OTP);
  await expectPath(page, path);
}

async function uiStaff(page, username, password = PASSWORD) {
  await id(page, 'login-tab-staff').click();
  await id(page, 'staff-username').fill(username);
  await id(page, 'staff-password').fill(password);
  await id(page, 'staff-submit').click();
}

async function logout(page) {
  await id(page, 'logout-btn').click();
  await expectPath(page, '/login');
}

function documentFixture(name, kind = 'pdf', size = 1024, mimeType) {
  let buffer;
  switch (kind) {
    case 'pdf': {
      const header = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
      const trailer = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
      buffer = Buffer.concat([header, Buffer.alloc(size - header.length - trailer.length, 32), trailer]);
      break;
    }
    case 'jpeg': {
      const header = Buffer.from('ffd8ffe000104a46494600010100000100010000fffe', 'hex');
      const length = Buffer.alloc(2);
      const padding = Buffer.alloc(size - header.length - 4, 'x');
      length.writeUInt16BE(padding.length + 2);
      buffer = Buffer.concat([header, length, padding, Buffer.from('ffd9', 'hex')]);
      break;
    }
    case 'png': {
      const signature = Buffer.from('89504e470d0a1a0a', 'hex');
      const header = pngChunk('IHDR', Buffer.from('00000001000000010802000000', 'hex'));
      const pixels = pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0])));
      const end = pngChunk('IEND', Buffer.alloc(0));
      const padding = Buffer.alloc(size - signature.length - header.length - pixels.length - end.length - 12, 'x');
      padding.write('k\0');
      buffer = Buffer.concat([signature, header, pixels, pngChunk('tEXt', padding), end]);
      break;
    }
    case 'exe':
      buffer = Buffer.alloc(size);
      buffer.write('MZ');
      break;
    case 'text':
      buffer = Buffer.from('hello');
      break;
  }
  const types = { pdf: 'application/pdf', jpeg: 'image/jpeg', png: 'image/png', text: 'text/plain', exe: 'image/png' };
  return { name, mimeType: mimeType || types[kind], buffer };
}

function pngChunk(type, data) {
  const content = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, content, checksum]);
}

function apiUpload(api, draftId, docKey, file) {
  return api.post(draftApi(draftId) + '/files', { multipart: { docKey, file: { name: file.name, mimeType: file.mimeType, buffer: file.buffer } } });
}

function uiUpload(page, docKey, file) {
  return id(page, 'upload-input-' + docKey).setInputFiles(file);
}

function fileItem(page, name) {
  return id(page, 'file-item').and(page.locator('[data-name="' + name + '"]'));
}

async function addDocument(page, docKey, name = docKey + '.pdf') {
  await uiUpload(page, docKey, documentFixture(name));
  await expect(fileItem(page, name)).toHaveAttribute('data-doc-key', docKey);
}

async function removeDocument(page, name) {
  await id(fileItem(page, name), 'file-remove-btn').click();
  await expect(fileItem(page, name)).toHaveCount(0);
}

async function createDraft(api, serviceId = 'SV-01', fields = { qty: 1 }) {
  return json(api.post('/api/drafts', { data: { serviceId, ...fields } }), 201);
}

async function createQr(api, serviceId = 'SV-01') {
  const settings = {
    'SV-01': [{ qty: 1 }, 20, ['id-card']],
    'SV-02': [{}, 500, ['id-card', 'map']],
    'SV-03': [{ areaSqm: 100 }, 1000, ['id-card', 'plan', 'deed']],
  };
  const [fields, amount, docs] = settings[serviceId];
  const { draftId, fee } = await createDraft(api, serviceId, fields);
  expect(fee).toBe(amount);
  for (const docKey of docs) {
    await json(apiUpload(api, draftId, docKey, documentFixture(docKey + '.pdf')), 201);
  }
  const payment = await json(api.post(draftApi(draftId) + '/payment'), 201, { amount });
  return { draftId, ...payment };
}

function pay(api, ref, amount) {
  return api.post('/api/test/payments/' + ref + '/pay', { data: { amount } });
}

async function newPaid(api, expected, serviceId = 'SV-01') {
  const { ref, amount } = await createQr(api, serviceId);
  await json(pay(api, ref, amount), 200, expected);
  await json(api.get(paymentApi(ref)), 200, {
    status: 'PAID', caseNo: expected.caseNo, receiptNo: expected.receiptNo,
  });
}

async function openUpload(page, serviceId, value) {
  await page.goto(newCase(serviceId));
  if (value !== undefined) await id(page, serviceId === 'SV-03' ? 'area-input' : 'qty-input').fill(String(value));
  await id(page, 'to-upload-btn').click();
  await expect(id(page, 'wizard-step')).toHaveText('2/3 แนบเอกสาร');
}

async function caseCount(api, count) {
  const { items } = await json(api.get('/api/cases'));
  expect(items).toHaveLength(count);
}

async function expectLevel(locator, level) {
  await expect(locator).toHaveText(levels[level]);
  await expect(locator).toHaveAttribute('data-level', level);
}

async function expectDue(page, number, iso, label) {
  await json(page.request.get(caseApi(number)), 200, { dueAt: iso });
  await expect(id(page, 'sla-due')).toHaveAttribute('data-iso', iso);
  if (label) await expect(id(page, 'sla-due')).toHaveText(label);
}

async function expectCaseStatus(page, status, label) {
  await expect(id(page, 'case-status')).toHaveText(label);
  await expect(id(page, 'case-status')).toHaveAttribute('data-status', status);
}

test('TC-AUTH-01 · เลขบัตร 13 หลักและ checksum', async ({ app }) => {
  const page = await app.page();
  const api = page.request;
  for (const invalid of ['110170012345', '11017001234567', '1101700123457', '11017001234ab']) {
    await test.step(invalid, async () => {
      await page.goto('/login');
      await id(page, 'login-tab-citizen').click();
      await uiStartOtp(page, invalid);
      await expect(id(page, 'thaid-error')).toHaveText(messages.id);
      await expect(id(page, 'otp-step')).toBeHidden();
      await apiError(startOtp(api, invalid), 400, 'INVALID_ID', messages.id);
    });
  }
  for (const valid of [SOMCHAI, SOMYING, PITI, MANA]) {
    await test.step(valid, async () => {
      await page.goto('/login');
      await id(page, 'login-tab-citizen').click();
      await uiStartOtp(page, valid);
      await expect(id(page, 'otp-step')).toBeVisible();
      await expect(id(page, 'thaid-error')).toBeHidden();
      await json(startOtp(api, valid), 200, { status: 'OTP_SENT' });
    });
  }
  await apiCitizen(api);
});

test('TC-AUTH-02 · ล็อก OTP 15 นาทีและรีเซ็ตตัวนับ', async ({ app }) => {
  const page = await app.page();
  await page.goto('/login');
  await id(page, 'login-tab-citizen').click();
  await uiStartOtp(page, PITI);
  for (const left of [2, 1]) {
    await uiOtp(page, '000000');
    await expect(id(page, 'otp-error')).toHaveText(messages.otp);
    await expect(id(page, 'otp-attempts-left')).toHaveText('เหลือ ' + left + ' ครั้ง');
  }
  await uiOtp(page, '000000');
  await expect(id(page, 'lock-message')).toHaveText(messages.locked);
  await expect(id(page, 'lock-until')).toHaveAttribute('data-iso', LOCKED_UNTIL);

  await app.reset();
  const { request: api } = await app.page();
  await json(startOtp(api, PITI), 200, { status: 'OTP_SENT' });
  for (const attemptsLeft of [2, 1]) {
    await apiError(verifyOtp(api, PITI, '000000'), 401, 'OTP_INVALID', messages.otp, { attemptsLeft });
  }
  const locked = { lockedUntil: LOCKED_UNTIL };
  await apiError(verifyOtp(api, PITI, '000000'), 423, 'LOCKED', messages.locked, locked);
  await apiError(verifyOtp(api, PITI), 423, 'LOCKED', messages.locked, locked);
  const other = await app.citizen();
  await json(other.request.get('/api/me'), 200, { role: 'citizen', name: 'สมชาย ใจดี' });
  await app.clock(dec(1, '09:14:59'));
  await apiError(verifyOtp(api, PITI), 423, 'LOCKED', messages.locked, locked);
  await app.clock(LOCKED_UNTIL);
  await apiError(verifyOtp(api, PITI, '000000'), 401, 'OTP_INVALID', messages.otp, { attemptsLeft: 2 });
  await json(verifyOtp(api, PITI), 200, { registered: true });

  await app.reset();
  const retry = await app.page();
  const retryApi = retry.request;
  await json(startOtp(retryApi, PITI), 200, { status: 'OTP_SENT' });
  for (const attemptsLeft of [2, 1]) {
    await apiError(verifyOtp(retryApi, PITI, '000000'), 401, 'OTP_INVALID', messages.otp, { attemptsLeft });
  }
  await json(verifyOtp(retryApi, PITI), 200, { registered: true });
  await httpStatus(retryApi.post('/api/auth/logout'), 204);
  await retry.goto('/login');
  await id(retry, 'login-tab-citizen').click();
  await uiStartOtp(retry, PITI);
  for (const left of [2, 1]) {
    await uiOtp(retry, '000000');
    await expect(id(retry, 'otp-attempts-left')).toHaveText('เหลือ ' + left + ' ครั้ง');
  }
  await uiOtp(retry, OTP);
  await expectPath(retry, '/citizen');
});

test('TC-AUTH-03 · ลงทะเบียนครั้งแรก', async ({ app }) => {
  const page = await app.page();
  await uiCitizen(page, MANA, '/register');
  const name = id(page, 'reg-name');
  await expect(name).toHaveJSProperty('readOnly', true);
  await name.focus();
  await page.keyboard.type('changed');
  await expect(name).toHaveValue('มานะ ตั้งใจ');

  for (const mobile of ['081234567', '08123456789', '1812345678', '08123abcde']) {
    await page.reload();
    await id(page, 'reg-consent').check();
    await id(page, 'reg-mobile').fill(mobile);
    await expect(id(page, 'reg-mobile')).toHaveValue(mobile);
    await id(page, 'reg-submit').click();
    await expect(id(page, 'reg-error-mobile')).toHaveText(messages.mobile);
    await expectPath(page, '/register');
  }
  await id(page, 'reg-mobile').fill('0845678901');
  await id(page, 'reg-consent').uncheck();
  await id(page, 'reg-submit').click();
  await expect(id(page, 'reg-error-consent')).toHaveText(messages.consent);
  await expectPath(page, '/register');
  await id(page, 'reg-consent').check();
  await id(page, 'reg-email').fill('');
  await id(page, 'reg-submit').click();
  await expectPath(page, '/citizen');
  await expect(id(page, 'citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ');
  await logout(page);
  await uiCitizen(page, MANA);

  await app.reset();
  const { request: api } = await app.page();
  await apiCitizen(api, MANA, false);
  await apiError(api.post('/api/auth/register', { data: { mobile: '081234567', email: '', consent: true } }),
    400, 'INVALID_MOBILE', messages.mobile);
  await apiError(api.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: false } }),
    400, 'CONSENT_REQUIRED', messages.consent);
});

test('TC-AUTH-04 · SSO และหน้าตั้งต้นของเจ้าหน้าที่ทุกบทบาท', async ({ app }) => {
  const page = await app.page();
  await page.goto('/login');
  await id(page, 'login-tab-staff').click();
  await expect(id(page, 'staff-submit')).toHaveText('เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)');
  for (const [username, path, name, role, roleText, department] of staffAccounts) {
    await test.step(username, async () => {
      await uiStaff(page, username);
      await expectPath(page, path);
      await expect(id(page, 'user-name')).toHaveText(name);
      await expect(id(page, 'user-role')).toHaveText(roleText);
      await expect(id(page, 'user-role')).toHaveAttribute('data-role', role);
      if (department) await expect(id(page, 'user-role')).toHaveAttribute('data-dept', department);
      await logout(page);
    });
  }
  for (const [username, password] of [['off.reg1', 'wrong'], ['nobody', PASSWORD], [SOMCHAI, PASSWORD]]) {
    await page.goto('/login');
    await uiStaff(page, username, password);
    await expect(id(page, 'staff-error')).toHaveText(messages.staff);
    await apiError(staffLogin(page.request, username, password), 401, 'INVALID_CREDENTIALS', messages.staff);
  }
  await page.goto('/officer/queue');
  await expectPath(page, '/login');
});

test('TC-FEE-01 · ค่าธรรมเนียมและค่าขอบของทั้งสามบริการ', async ({ app }) => {
  const page = await app.citizen();
  const cases = [
    ['SV-03', 'area-input', 'areaSqm', [
      [0, null, 'INVALID_AREA', messages.area], [-1, null, 'INVALID_AREA', messages.area],
      [1, 1000], [100, 1000], [101, 1010], [102, 1020], [250, 2500], [300, 3000], [499, 4990], [500, 5000],
      [501, null, 'AREA_TOO_LARGE', messages.areaLimit],
    ]],
    ['SV-01', 'qty-input', 'qty', [
      [0, null, 'INVALID_QTY', messages.qty], [1, 20], [2, 40], [3, 60], [4, 80], [5, 100],
      [6, null, 'INVALID_QTY', messages.qty],
    ]],
  ];
  for (const [serviceId, input, field, values] of cases) {
    await page.goto(newCase(serviceId));
    for (const [value, fee, code, message] of values) {
      await test.step(serviceId + ' ' + value, async () => {
        await id(page, input).fill(String(value));
        const response = page.request.post('/api/drafts', { data: { serviceId, [field]: value } });
        if (code) {
          await apiError(response, 400, code, message);
          await expect(id(page, 'fee-total')).toHaveText('–');
          await expect(id(page, 'fee-error')).toHaveText(message);
          await expect(id(page, 'to-upload-btn')).toBeDisabled();
        } else {
          await json(response, 201, { fee });
          await expect(id(page, 'fee-total')).toHaveText('฿' + fee.toLocaleString('en-US'));
          await expect(id(page, 'fee-error')).toBeHidden();
          await expect(id(page, 'to-upload-btn')).toBeEnabled();
        }
      });
    }
  }
  await page.goto(newCase('SV-02'));
  await expect(id(page, 'qty-input')).toHaveCount(0);
  await expect(id(page, 'area-input')).toHaveCount(0);
  await expect(id(page, 'fee-total')).toHaveText('฿500');
  expect((await createDraft(page.request, 'SV-02', {})).fee).toBe(500);
});

test('TC-SUBMIT-01 · ยื่น SV-01 ตั้งแต่กรอกข้อมูลถึงเข้าคิว', async ({ app }) => {
  const page = await app.citizen();
  await page.goto('/citizen');
  await id(page, 'start-service-SV-01').click();
  await expectPath(page, newCase('SV-01'));
  await expect(id(page, 'wizard-step')).toHaveText('1/3 กรอกข้อมูล');
  await expect(id(page, 'qty-input')).toHaveValue('1');
  await id(page, 'qty-input').fill('2');
  await expect(id(page, 'fee-total')).toHaveText('฿40');
  await id(page, 'to-upload-btn').click();
  await expect(id(page, 'wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await expect(id(page, 'to-payment-btn')).toBeDisabled();
  await addDocument(page, 'id-card');
  await expect(id(page, 'file-item')).toHaveCount(1);
  await expect(id(page, 'to-payment-btn')).toBeEnabled();
  await id(page, 'to-payment-btn').click();
  await expect(id(page, 'wizard-step')).toHaveText('3/3 ชำระเงิน');
  await expect(id(page, 'payment-amount')).toHaveText('฿40');
  await id(page, 'create-qr-btn').click();
  await expect(id(page, 'qr-ref')).toHaveText('PP-0002');
  await expect(id(page, 'qr-expires')).toHaveAttribute('data-iso', LOCKED_UNTIL);
  await expect(id(page, 'payment-status')).toHaveText('รอชำระ');
  await json(pay(page.request, 'PP-0002', 40), 200, paid(31));
  await id(page, 'refresh-payment-btn').click();
  await expect(id(page, 'payment-status')).toHaveText('ชำระแล้ว');
  await expect(id(page, 'submitted-case-no')).toHaveText(caseNo(31));
  await expect(id(page, 'receipt-no')).toHaveText('RC-2569-000031');
  await expect(id(page, 'receipt-amount')).toHaveText('฿40');
  await expect(id(page, 'receipt-paid-at')).toHaveAttribute('data-iso', START);

  await id(page, 'go-case-btn').click();
  await expectPath(page, citizenCase(31));
  await expectCaseStatus(page, 'SUBMITTED', 'ส่งคำขอแล้ว');
  await expect(id(page, 'case-fee')).toHaveText('฿40');
  await expectDue(page, 31, due(4), '4 ธ.ค. 2569 16:30');
  await expectLevel(id(page, 'sla-level'), 'normal');
  await expect(id(page, 'cancel-case-btn')).toHaveCount(1);
  await expect(id(page, 'case-step')).toHaveCount(0);

  const officer = await app.staff('off.reg1');
  await officer.goto('/officer/queue');
  const row = queueRow(officer, 31);
  await expect(id(row, 'row-owner')).toHaveText('');
  await expect(id(row, 'claim-btn')).toBeVisible();
  const rowsDueOnFourth = id(officer, 'queue-row').filter({
    has: id(officer, 'row-due').and(officer.locator('[data-iso="' + due(4) + '"]')),
  });
  await expect(rowsDueOnFourth).toHaveCount(7);
  await expect(rowsDueOnFourth.nth(5)).toHaveAttribute('data-case-no', caseNo(30));
  await expect(rowsDueOnFourth.last()).toHaveAttribute('data-case-no', caseNo(31));
});

async function missingDocs(page, names) {
  const payment = id(page, 'to-payment-btn');
  if (names) {
    await expect(payment).toBeDisabled();
    await expect(id(page, 'missing-docs')).toHaveText('ยังขาดเอกสาร: ' + names);
  } else {
    await expect(payment).toBeEnabled();
    await expect(id(page, 'missing-docs')).toBeHidden();
  }
}

test('TC-SUBMIT-02 · เอกสารบังคับครบก่อนชำระ', async ({ app }) => {
  const page = await app.citizen();
  await openUpload(page, 'SV-02');
  await addDocument(page, 'id-card');
  await missingDocs(page, 'แผนที่ตั้ง');
  await addDocument(page, 'map');
  await missingDocs(page);
  await removeDocument(page, 'map.pdf');
  await missingDocs(page, 'แผนที่ตั้ง');

  await openUpload(page, 'SV-03', 100);
  await addDocument(page, 'id-card');
  await missingDocs(page, 'แบบแปลน, โฉนด');
  await addDocument(page, 'deed');
  await missingDocs(page, 'แบบแปลน');
  await uiUpload(page, 'plan', documentFixture('plan-as-jpg.jpg', 'jpeg'));
  await expect(id(page, 'upload-error')).toHaveText(messages.plan);
  await expect(id(page, 'file-item')).toHaveCount(2);
  await expect(fileItem(page, 'plan-as-jpg.jpg')).toHaveCount(0);
  await missingDocs(page, 'แบบแปลน');
  await addDocument(page, 'plan');
  await missingDocs(page);

  const api = page.request;
  const { draftId } = await createDraft(api, 'SV-03', { areaSqm: 100 });
  for (const docKey of ['id-card', 'deed']) {
    await json(apiUpload(api, draftId, docKey, documentFixture(docKey + '.pdf')), 201);
  }
  await apiError(apiUpload(api, draftId, 'plan', documentFixture('plan-as-jpg.jpg', 'jpeg')),
    400, 'PLAN_NOT_PDF', messages.plan);
  await apiError(api.post(draftApi(draftId) + '/payment'), 409, 'MISSING_DOCS',
    'ยังขาดเอกสาร: แบบแปลน', { missing: ['แบบแปลน'] });
  await json(apiUpload(api, draftId, 'plan', documentFixture('plan.pdf')), 201);
  await json(api.post(draftApi(draftId) + '/payment'), 201);
});

function draftRow(page, draftId) {
  return id(page, 'my-draft-row').and(page.locator('[data-draft-id="' + draftId + '"]'));
}

test('TC-SUBMIT-03 · ร่าง การยกเลิก และยกเลิกชนกับรับเรื่อง', async ({ app }) => {
  await test.step('A · บันทึกร่าง', async () => {
    const page = await app.citizen();
    await page.goto('/citizen');
    await expect(id(page, 'my-case-row')).toHaveCount(10);
    await expect(id(page, 'my-draft-row')).toHaveCount(2);
    await expect(draftRow(page, 'DR-0001')).toHaveAttribute('data-status', 'DRAFT');
    await expect(draftRow(page, 'DR-0002')).toHaveAttribute('data-status', 'PENDING_PAYMENT');
    await expect(draftRow(page, 'DR-0001')).not.toContainText('EG-');
    await expect(draftRow(page, 'DR-0002')).not.toContainText('EG-');
    await id(draftRow(page, 'DR-0001'), 'open-draft-btn').click();
    await expect(id(page, 'qty-input')).toHaveValue('2');
    await expect(id(page, 'fee-total')).toHaveText('฿40');
    await page.goto(newCase('SV-01'));
    await id(page, 'qty-input').fill('3');
    await id(page, 'save-draft-btn').click();
    await expect(id(page, 'draft-id')).toHaveText('DR-0003');
    await page.goto('/citizen');
    await expect(id(page, 'my-case-row')).toHaveCount(10);
    await caseCount(page.request, 10);
    expect((await json(page.request.get('/api/drafts'))).items).toHaveLength(3);
  });

  await test.step('B · ยกเลิกก่อนเจ้าหน้าที่รับเรื่อง', async () => {
    await app.reset();
    const page = await app.citizen();
    await page.goto(citizenCase(30));
    await expect(id(page, 'cancel-case-btn')).toHaveCount(1);
    await id(page, 'cancel-case-btn').click();
    await expect(id(page, 'cancel-confirm-text')).toHaveText(messages.noRefund);
    await id(page, 'confirm-cancel-btn').click();
    await expectCaseStatus(page, 'CANCELLED', 'ยกเลิก');
    await expect(id(page, 'no-refund-note')).toHaveText(messages.noRefund);
    await expect(id(page, 'cancel-case-btn')).toHaveCount(0);
    const officer = await app.staff('off.reg1');
    await officer.goto('/officer/queue');
    await expect(id(officer, 'queue-row')).toHaveCount(16);
    await expect(queueRow(officer, 30)).toHaveCount(0);
    const executive = await app.staff('exec1');
    await executive.goto('/dashboard');
    await expect(id(executive, 'period-select')).toHaveValue('2026-12');
    await expect(id(executive, 'kpi-backlog')).toHaveText('20');
    await expect(id(executive, 'kpi-received')).toHaveText('3');
  });

  await test.step('C · ยกเลิกเคสที่เจ้าหน้าที่รับแล้ว', async () => {
    await app.reset();
    const officer = await app.staff('off.reg1');
    await json(officer.request.post(action(30, 'claim')), 200, { owner: 'off.reg1' });
    const page = await app.citizen();
    await page.goto(citizenCase(30));
    await expectCaseStatus(page, 'IN_REVIEW', 'กำลังตรวจสอบ');
    await expect(id(page, 'cancel-case-btn')).toHaveCount(0);
    for (const number of [30, 13]) {
      await apiError(page.request.post(caseApi(number) + '/cancel'), 409, 'CANNOT_CANCEL', messages.cannotCancel);
    }
  });

  await test.step('E · ลบร่างและตัด QR เดิม', async () => {
    await app.reset();
    const page = await app.citizen();
    const api = page.request;
    await httpStatus(api.delete(draftApi('DR-0001')), 204);
    await httpStatus(api.get(draftApi('DR-0001')), 404);
    await page.goto('/citizen');
    await expect(id(page, 'my-draft-row')).toHaveCount(1);
    await expect(draftRow(page, 'DR-0002')).toHaveCount(1);
    await httpStatus(api.delete(draftApi('DR-0002')), 204);
    await httpStatus(api.get(paymentApi('PP-0001')), 404);
    await httpStatus(pay(api, 'PP-0001', 500), 404);
    await caseCount(api, 10);
  });

  await test.step('F · ยกเลิกและรับเรื่องพร้อมกัน', async () => {
    await app.reset();
    const citizen = await app.citizen();
    const officer = await app.staff('off.reg1');
    const [cancelResponse, claimResponse] = await Promise.all([
      citizen.request.post(caseApi(30) + '/cancel'),
      officer.request.post(action(30, 'claim')),
    ]);
    const cancelWon = cancelResponse.status() === 200;
    if (cancelWon) {
      await json(cancelResponse, 200, { status: 'CANCELLED' });
      await apiError(claimResponse, 409, 'INVALID_STATE');
      const item = await json(citizen.request.get(caseApi(30)), 200, { status: 'CANCELLED' });
      expect([null, '']).toContain(item.owner);
    } else {
      await apiError(cancelResponse, 409, 'CANNOT_CANCEL', messages.cannotCancel);
      await json(claimResponse, 200, { owner: 'off.reg1' });
      await json(citizen.request.get(caseApi(30)), 200, { status: 'IN_REVIEW', owner: 'off.reg1' });
    }
    await officer.goto('/officer/queue');
    await expect(id(officer, 'workload-count')).toHaveText(cancelWon ? '3' : '4');
  });
});

test('TC-UPLOAD-01 · ขนาด 5 MB และจำนวนสูงสุด 5 ไฟล์', async ({ app }) => {
  const page = await app.citizen();
  await openUpload(page, 'SV-01', 1);
  const api = page.request;
  for (const size of [5242879, 5242880, 5242881]) {
    await test.step(String(size) + ' bytes', async () => {
      const file = documentFixture('size-' + size + '.pdf', 'pdf', size);
      expect(file.buffer.length).toBe(size);
      const { draftId } = await createDraft(api);
      // Wait for the page's own upload response so a rejection fails with the status (201 vs 400), not a missing element.
      const uploaded = page.waitForResponse((response) => response.request().method() === 'POST'
        && /^\/api\/drafts\/[^/]+\/files$/.test(new URL(response.url()).pathname));
      await uiUpload(page, 'id-card', file);
      const uploadResponse = await uploaded;
      if (size <= 5242880) {
        expect(uploadResponse.status(), file.name + ' uploaded from the page').toBe(201);
        await expect(fileItem(page, file.name)).toHaveAttribute('data-doc-key', 'id-card');
        await expect(id(page, 'file-item')).toHaveCount(1);
        await expect(id(page, 'upload-error')).toBeHidden();
        await json(apiUpload(api, draftId, 'id-card', file), 201, { name: file.name, docKey: 'id-card', size });
        await removeDocument(page, file.name);
      } else {
        await expect(id(page, 'upload-error')).toHaveText(messages.fileSize);
        await expect(id(page, 'file-item')).toHaveCount(0);
        await apiError(apiUpload(api, draftId, 'id-card', file), 400, 'FILE_TOO_LARGE', messages.fileSize);
      }
    });
  }

  const { draftId } = await createDraft(api);
  await addDocument(page, 'id-card');
  await json(apiUpload(api, draftId, 'id-card', documentFixture('id-card.pdf')), 201);
  const extras = [1, 2, 3, 4].map((n) => documentFixture('multi-' + n + '.pdf'));
  await uiUpload(page, 'extra', extras);
  for (const file of extras) {
    await expect(fileItem(page, file.name)).toHaveAttribute('data-doc-key', 'extra');
    await json(apiUpload(api, draftId, 'extra', file), 201);
  }
  await expect(id(page, 'file-item')).toHaveCount(5);
  const sixth = documentFixture('multi-5.pdf');
  await uiUpload(page, 'extra', sixth);
  await expect(id(page, 'upload-error')).toHaveText(messages.fileCount);
  await expect(id(page, 'file-item')).toHaveCount(5);
  await expect(fileItem(page, sixth.name)).toHaveCount(0);
  await apiError(apiUpload(api, draftId, 'extra', sixth), 400, 'FILE_COUNT', messages.fileCount);

  await removeDocument(page, 'multi-1.pdf');
  await uiUpload(page, 'extra', sixth);
  await expect(fileItem(page, sixth.name)).toHaveAttribute('data-doc-key', 'extra');
  await expect(id(page, 'file-item')).toHaveCount(5);
});

test('TC-UPLOAD-02 · ตรวจชนิดไฟล์จากเนื้อหาและไม่เก็บไฟล์ที่ปฏิเสธ', async ({ app }) => {
  const page = await app.citizen();
  await openUpload(page, 'SV-01', 1);
  const api = page.request;
  for (const [name, kind] of [['ok-id.pdf', 'pdf'], ['real.jpg', 'jpeg'], ['real.png', 'png']]) {
    const file = documentFixture(name, kind);
    const { draftId } = await createDraft(api);
    await uiUpload(page, 'id-card', file);
    await expect(fileItem(page, name)).toHaveAttribute('data-doc-key', 'id-card');
    await expect(id(page, 'file-item')).toHaveCount(1);
    await json(apiUpload(api, draftId, 'id-card', file), 201, { name, size: 1024 });
    await removeDocument(page, name);
  }

  const { draftId } = await createDraft(api);
  const rejected = [
    ['fake-text.pdf', 'text'], ['fake-text.jpg', 'text'], ['exe-as.png', 'exe'],
    ['notes.txt', 'text'], ['fake-text.pdf', 'text', 'application/pdf'],
  ];
  const before = await json(api.get(draftApi(draftId)));
  expect(before.files).toHaveLength(0);
  for (const [name, kind, mimeType] of rejected) {
    await test.step(name + ' · ' + (mimeType || kind), async () => {
      // Reload an empty persisted draft so each error assertion observes this upload.
      await page.goto(newCase('SV-01') + '?draft=' + draftId);
      await id(page, 'to-upload-btn').click();
      await expect(id(page, 'upload-error')).toBeHidden();
      const file = documentFixture(name, kind, 1024, mimeType);
      await uiUpload(page, 'id-card', file);
      await expect(id(page, 'upload-error')).toHaveText(messages.fileType);
      await expect(id(page, 'file-item')).toHaveCount(0);
      expect((await json(api.get(draftApi(draftId)))).files).toHaveLength(0);
    });
  }

  // Check API errors with a separate draft to prove each rejected request stores nothing.
  const separate = await createDraft(api);
  for (const [name, kind, mimeType] of rejected) {
    const file = documentFixture(name, kind, 1024, mimeType);
    await apiError(apiUpload(api, separate.draftId, 'id-card', file), 400, 'FILE_TYPE', messages.fileType);
    const after = await json(api.get(draftApi(separate.draftId)));
    expect(after.files).toHaveLength(0);
  }
});

test('TC-PAY-01 · QR ใช้ได้ก่อนครบ 15 นาทีและสร้างใหม่ได้', async ({ app }) => {
  const rounds = [
    [START, true],
    [dec(1, '09:09:59'), true],
    [dec(1, '09:10:00'), false],
    [dec(1, '09:10:01'), false],
  ];
  for (const [index, [now, accepted]] of rounds.entries()) {
    await test.step(now, async () => {
      if (index > 0) await app.reset();
      if (index > 0) await app.clock(now);
      const page = await app.citizen();
      const api = page.request;
      if (accepted) {
        await json(pay(api, 'PP-0001', 500), 200, paid(31));
        return;
      }
      await apiError(pay(api, 'PP-0001', 500), 410, 'QR_EXPIRED', messages.qr);
      await json(api.get(paymentApi('PP-0001')), 200, { status: 'EXPIRED' });
      await caseCount(api, 10);
      if (index === 2) {
        await page.goto(newCase('SV-02') + '?draft=DR-0002');
        await expect(id(page, 'qr-expired-msg')).toHaveText(messages.qr);
        await expect(id(page, 'payment-status')).toHaveText('QR หมดอายุ');
        await expect(id(page, 'payment-status')).toHaveAttribute('data-status', 'EXPIRED');
        await expect(id(page, 'regenerate-qr-btn')).toHaveCount(1);
        await id(page, 'regenerate-qr-btn').click();
        await expect(id(page, 'qr-ref')).toHaveText('PP-0002');
        await expect(id(page, 'qr-expires')).toHaveAttribute('data-iso', dec(1, '09:25:00'));
        await json(pay(api, 'PP-0002', 500), 200, paid(31));
      }
    });
  }
});

test('TC-PAY-02 · ยอดขาด ยอดเกิน และ callback ซ้ำ', async ({ app }) => {
  const { request: api } = await app.citizen();
  const { ref } = await createQr(api);
  expect(ref).toBe('PP-0002');
  for (const amount of [19, 21]) {
    await apiError(pay(api, ref, amount), 422, 'AMOUNT_MISMATCH', 'ยอดเงินไม่ตรงกับค่าธรรมเนียม');
    await json(api.get(paymentApi(ref)), 200, { status: 'PENDING' });
    await caseCount(api, 10);
  }
  await json(pay(api, ref, 20), 200, paid(31));
  await caseCount(api, 11);
  await json(pay(api, ref, 20), 200, paid(31, true));
  await caseCount(api, 11);
  await newPaid(api, paid(32));
});

test('TC-PAY-03 · ชำระพร้อมกันหกใบและแยกเจ้าของ', async ({ app }) => {
  const { request: first } = await app.citizen();
  const { request: second } = await app.citizen(SOMYING);
  const batch = [];
  for (const api of [first, second]) {
    for (let n = 0; n < 3; n++) {
      const { ref, amount } = await createQr(api);
      batch.push({ api, ref, amount });
    }
  }
  expect(batch.map(({ ref }) => ref)).toEqual(['PP-0002', 'PP-0003', 'PP-0004', 'PP-0005', 'PP-0006', 'PP-0007']);
  const outcomes = await Promise.all(batch.map(({ api, ref, amount }) =>
    json(pay(api, ref, amount), 200, { status: 'PAID', duplicate: false })));
  const sequence = [31, 32, 33, 34, 35, 36].map((n) => paid(n));
  expect(outcomes.map((item) => item.caseNo).sort()).toEqual(sequence.map((item) => item.caseNo));
  expect(outcomes.map((item) => item.receiptNo).sort()).toEqual(sequence.map((item) => item.receiptNo));
  for (const [api, seeded, start] of [[first, 10, 0], [second, 11, 3]]) {
    const { items } = await json(api.get('/api/cases'));
    expect(items).toHaveLength(seeded + 3);
    const ownCases = items.map((item) => item.caseNo).filter((number) => number >= caseNo(31));
    expect(ownCases.sort()).toEqual(outcomes.slice(start, start + 3).map((item) => item.caseNo).sort());
  }
  await newPaid(first, paid(37));
});

test('TC-PAY-04 · เลขคำขอและใบเสร็จข้ามปี', async ({ app }) => {
  const page = await app.citizen();
  const api = page.request;
  await app.clock(dec(31, '23:58:00'));
  const { ref, draftId } = await createQr(api);
  await caseCount(api, 10);
  await json(api.get(paymentApi(ref)), 200, { status: 'PENDING' });
  await page.goto(newCase('SV-01') + '?draft=' + draftId);
  await expect(id(page, 'submitted-case-no')).toHaveCount(0);
  await app.clock(dec(31, '23:59:00'));
  await json(pay(api, ref, 20), 200, paid(31));
  await id(page, 'refresh-payment-btn').click();
  await expect(id(page, 'receipt-paid-at')).toHaveAttribute('data-iso', dec(31, '23:59:00'));

  await app.clock('2027-01-01T00:00:00+07:00');
  await newPaid(api, paid(1, false, 2570));
  await newPaid(api, paid(2, false, 2570));
  await json(api.get(caseApi(31)), 200, { caseNo: caseNo(31) });
});

async function expectQueue(page, numbers) {
  const rows = id(page, 'queue-row');
  await expect(rows).toHaveCount(numbers.length);
  for (const [index, number] of numbers.entries()) {
    await expect(rows.nth(index)).toHaveAttribute('data-case-no', caseNo(number));
  }
}

test('TC-QUEUE-01 · ลำดับคิว ตัวกรอง และขอบเขตแผนก', async ({ app }) => {
  const reg1 = await app.staff('off.reg1');
  await reg1.goto('/officer/queue');
  await expect(id(reg1, 'queue-filter')).toHaveValue('all');
  const registry = [20, 22, 24, 23, 25, 26, 13, 15, 27, 28, 29, 30, 16, 18, 19, 12, 21];
  await expectQueue(reg1, registry);
  const groups = [
    [3, [23, 25, 26]], [4, [13, 15, 27, 28, 29, 30]], [9, [18, 19]], [11, [12, 21]],
  ];
  for (const [day, numbers] of groups) {
    for (const number of numbers) {
      await expect(id(queueRow(reg1, number), 'row-due')).toHaveAttribute('data-iso', due(day));
    }
  }
  for (const [number, level] of [[20, 'overdue'], [22, 'near'], [24, 'near']]) {
    await expectLevel(id(queueRow(reg1, number), 'row-sla-level'), level);
  }
  const unclaimed = [24, 28, 29, 30];
  await expect(id(reg1, 'claim-btn')).toHaveCount(4);
  for (const number of registry) {
    const row = queueRow(reg1, number);
    await expect(id(row, 'row-id-masked')).toHaveText(/^X-XXXX-XXXXX-\d{2}-\d$/);
    await expect(id(row, 'claim-btn')).toHaveCount(unclaimed.includes(number) ? 1 : 0);
  }
  for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 14, 17]) {
    await expect(queueRow(reg1, number)).toHaveCount(0);
  }
  await id(reg1, 'queue-filter').selectOption('unclaimed');
  await expectQueue(reg1, unclaimed);
  await id(reg1, 'queue-filter').selectOption('mine');
  await expectQueue(reg1, [20, 22, 23]);
  await expect(id(reg1, 'workload-count')).toHaveText('3');

  const reg2 = await app.staff('off.reg2');
  await reg2.goto('/officer/queue');
  await id(reg2, 'queue-filter').selectOption('mine');
  await expectQueue(reg2, [25, 26, 13, 15, 27, 16, 18, 12, 21]);
  await expect(id(reg2, 'workload-count')).toHaveText('9');

  const works = await app.staff('off.works1');
  await works.goto('/officer/queue');
  await expectQueue(works, [10]);

  const head = await app.staff('head1');
  await head.goto('/officer/queue');
  await expectQueue(head, [...registry.slice(0, 3), 10, ...registry.slice(3)]);
  await expect(id(head, 'claim-btn')).toHaveCount(0);
});

async function assertClaimAudit(app, number, owner) {
  const auditor = await app.staff('audit1');
  const { items } = await json(auditor.request.get('/api/audit?event=CLAIM'));
  const claims = items.filter((item) => item.event === 'CLAIM' && item.caseNo === caseNo(number));
  expect(claims).toHaveLength(1);
  expect(claims[0].username).toBe(owner);
  await auditor.goto('/audit');
  const row = id(auditor, 'audit-row').and(auditor.locator(
    '[data-event="CLAIM"][data-case-no="' + caseNo(number) + '"]',
  ));
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-actor', owner);
}

test('TC-QUEUE-02 · รับเรื่องชนกันบนหน้าเว็บและ API', async ({ app }) => {
  await test.step('กดรับเรื่องพร้อมกันจากสอง session', async () => {
    const users = ['off.reg1', 'off.reg2'];
    const pages = await Promise.all(users.map((username) => app.staff(username)));
    await Promise.all(pages.map((page) => page.goto('/officer/queue')));
    const rows = pages.map((page) => queueRow(page, 28));
    for (const row of rows) {
      await expect(row).toHaveAttribute('data-status', 'SUBMITTED');
      await expect(id(row, 'row-owner')).toHaveText('');
      await expect(id(row, 'claim-btn')).toBeVisible();
    }
    await Promise.all(rows.map((row) => id(row, 'claim-btn').click()));
    const { owner } = await json(pages[0].request.get(caseApi(28)), 200, { status: 'IN_REVIEW' });
    expect(users).toContain(owner);
    const winner = users.indexOf(owner);
    await expect(id(rows[winner], 'row-owner')).toHaveText(owner);
    await expect(id(pages[1 - winner], 'action-error')).toHaveText(messages.claimed);
    await assertClaimAudit(app, 28, owner);
  });

  await test.step('ส่งคำสั่งรับเรื่อง 10 ครั้งพร้อมกัน', async () => {
    await app.reset();
    const users = ['off.reg1', 'off.reg2'];
    const pages = await Promise.all(users.map((username) => app.staff(username)));
    const batch = await Promise.all(pages.flatMap(({ request }) =>
      Array.from({ length: 5 }, () => request.post(action(29, 'claim')))));
    const winners = batch.map((response, index) => ({ response, index }))
      .filter(({ response }) => response.status() === 200);
    expect(winners).toHaveLength(1);
    const { response: winner, index } = winners[0];
    const owner = users[Math.floor(index / 5)];
    await json(winner, 200, { owner });
    for (const response of batch.filter((item) => item !== winner)) {
      await apiError(response, 409, 'ALREADY_CLAIMED', messages.claimed);
    }
    await json(pages[0].request.get(caseApi(29)), 200, { status: 'IN_REVIEW', owner });
    await assertClaimAudit(app, 29, owner);
  });

  await test.step('รับเรื่องตามลำดับแล้วลองรับซ้ำ', async () => {
    await app.reset();
    const first = await app.staff('off.reg1');
    const second = await app.staff('off.reg2');
    await json(first.request.post(action(29, 'claim')), 200, { owner: 'off.reg1' });
    await apiError(second.request.post(action(29, 'claim')), 409, 'ALREADY_CLAIMED', messages.claimed);
    await json(first.request.get(caseApi(29)), 200, { owner: 'off.reg1', status: 'IN_REVIEW' });
    await second.goto('/officer/queue');
    await expect(id(second, 'workload-count')).toHaveText('9');
    await apiError(first.request.post(action(29, 'claim')), 409, 'ALREADY_CLAIMED', messages.claimed);
    await assertClaimAudit(app, 29, 'off.reg1');
  });
});

async function claimFromQueue(page, number, username, workload) {
  await id(queueRow(page, number), 'claim-btn').click();
  await expect(id(queueRow(page, number), 'row-owner')).toHaveText(username);
  await expect(id(page, 'workload-count')).toHaveText(String(workload));
}

async function returnFromCase(page) {
  await id(page, 'return-btn').click();
  await id(page, 'return-reason').fill('xxxxxxxxxx');
  await id(page, 'return-submit').click();
  await expectCaseStatus(page, 'NEED_FIX', 'รอแก้ไขเอกสาร');
}

async function resubmitFromCase(page) {
  await id(page, 'submit-fix-btn').click();
  await expectCaseStatus(page, 'IN_REVIEW', 'กำลังตรวจสอบ');
}

test('TC-QUEUE-03 · เพดาน 10 งานและส่งแก้คืนผู้ถือเดิม', async ({ app }) => {
  const reg2 = await app.staff('off.reg2');
  await reg2.goto('/officer/queue');
  await expect(id(reg2, 'workload-count')).toHaveText('9');
  await claimFromQueue(reg2, 28, 'off.reg2', 10);
  await id(queueRow(reg2, 29), 'claim-btn').click();
  await expect(id(reg2, 'action-error')).toHaveText(messages.workload);
  await apiError(reg2.request.post(action(29, 'claim')), 409, 'WORKLOAD_LIMIT', messages.workload);
  await expect(queueRow(reg2, 29)).toHaveAttribute('data-status', 'SUBMITTED');
  await expect(id(queueRow(reg2, 29), 'row-owner')).toHaveText('');
  await expect(id(reg2, 'workload-count')).toHaveText('10');

  await reg2.goto(officerCase(25));
  await id(reg2, 'approve-btn').click();
  await expectCaseStatus(reg2, 'APPROVED', 'อนุมัติ');
  await reg2.goto('/officer/queue');
  await expect(id(reg2, 'workload-count')).toHaveText('9');
  await claimFromQueue(reg2, 29, 'off.reg2', 10);
  const reg1 = await app.staff('off.reg1');
  await reg1.goto('/officer/queue');
  await expect(id(reg1, 'workload-count')).toHaveText('3');
  await claimFromQueue(reg1, 30, 'off.reg1', 4);

  await app.reset();
  const officer = await app.staff('off.reg2');
  await officer.goto(officerCase(25));
  await returnFromCase(officer);
  await officer.goto('/officer/queue');
  await expect(id(officer, 'workload-count')).toHaveText('8');
  await claimFromQueue(officer, 28, 'off.reg2', 9);
  await claimFromQueue(officer, 29, 'off.reg2', 10);

  const applicant = await app.citizen(SOMYING);
  await applicant.goto(citizenCase(25));
  await resubmitFromCase(applicant);
  await expect(id(applicant, 'action-error')).toBeHidden();
  await officer.goto(officerCase(25));
  await expect(id(officer, 'case-owner')).toHaveText('off.reg2');
  await officer.goto('/officer/queue');
  await expect(id(officer, 'workload-count')).toHaveText('11');
  await apiError(officer.request.post(action(30, 'claim')), 409, 'WORKLOAD_LIMIT', messages.workload);
  await officer.reload();
  await expect(id(officer, 'workload-count')).toHaveText('11');
});

test('TC-SLA-01 · กำหนดเสร็จตามวันทำการและเวลาตัดรอบ', async ({ app }) => {
  const samples = [
    ['a', 'SV-01', START, due(4), '4 ธ.ค. 2569 16:30'],
    ['b', 'SV-01', dec(1, '16:29:00'), due(4), '4 ธ.ค. 2569 16:30'],
    ['c', 'SV-01', due(1), due(8), '8 ธ.ค. 2569 16:30'],
    ['d', 'SV-01', dec(4, '10:00:00'), due(11), '11 ธ.ค. 2569 16:30'],
    ['e', 'SV-01', dec(5, '10:00:00'), due(14), '14 ธ.ค. 2569 16:30'],
    ['f', 'SV-02', START, due(17), '17 ธ.ค. 2569 16:30'],
    ['g', 'SV-03', START, due(24), '24 ธ.ค. 2569 16:30'],
    ['h', 'SV-01', dec(29, '10:00:00'), '2027-01-05T16:30:00+07:00', '5 ม.ค. 2570 16:30'],
    ['i', 'SV-01', dec(31, '23:59:00'), '2027-01-07T16:30:00+07:00', '7 ม.ค. 2570 16:30'],
  ];
  for (const [row, serviceId, when, iso, label] of samples) {
    await test.step(row + ' · ' + serviceId + ' · ' + when, async () => {
      if (row !== 'a') await app.reset();
      await app.clock(when);
      const page = await app.citizen();
      await newPaid(page.request, paid(31), serviceId);
      await page.goto(citizenCase(31));
      await expectDue(page, 31, iso, label);
    });
  }
});

async function returnNewCase(app, citizen, returnedAt) {
  await newPaid(citizen.request, paid(31));
  await citizen.goto(citizenCase(31));
  await expectDue(citizen, 31, due(4), '4 ธ.ค. 2569 16:30');
  await app.clock(returnedAt);
  const officer = await app.staff('off.reg1');
  await officer.goto(officerCase(31));
  await id(officer, 'claim-btn').click();
  await expect(id(officer, 'case-owner')).toHaveText('off.reg1');
  await returnFromCase(officer);
  await citizen.reload();
  return officer;
}

test('TC-SLA-02 · หยุดนับ SLA ระหว่างรอแก้และเริ่มนับอีกครั้ง', async ({ app }) => {
  await test.step('ตีกลับหนึ่งวันทำการก่อนส่งแก้', async () => {
    const citizen = await app.citizen();
    const officer = await returnNewCase(app, citizen, dec(2, '11:00:00'));
    await expectCaseStatus(citizen, 'NEED_FIX', 'รอแก้ไขเอกสาร');
    await expectLevel(id(citizen, 'sla-level'), 'paused');
    await expect(id(citizen, 'fix-deadline')).toHaveAttribute('data-iso', dec(9, '11:00:00'));
    await app.clock(dec(3, '10:00:00'));
    await resubmitFromCase(citizen);
    await officer.reload();
    await expect(id(officer, 'case-owner')).toHaveText('off.reg1');
    await expectDue(citizen, 31, due(8), '8 ธ.ค. 2569 16:30');
    await expectLevel(id(citizen, 'sla-level'), 'normal');
  });

  for (const [when, expected, label] of [
    [START, due(1), '1 ธ.ค. 2569 16:30'],
    [dec(4, '10:00:00'), due(4), '4 ธ.ค. 2569 16:30'],
  ]) {
    await test.step('ส่งแก้คำขอใน seed · ' + when, async () => {
      await app.reset();
      await app.clock(when);
      const citizen = await app.citizen();
      await citizen.goto(citizenCase(17));
      await expectLevel(id(citizen, 'sla-level'), 'paused');
      await expectDue(citizen, 17, '2026-11-27T16:30:00+07:00');
      await resubmitFromCase(citizen);
      await expectDue(citizen, 17, expected, label);
      await expectLevel(id(citizen, 'sla-level'), 'near');
      await json(citizen.request.get(caseApi(17)), 200, { owner: 'off.reg1' });
    });
  }

  await test.step('ตีกลับและส่งแก้ในวันเดียวกัน', async () => {
    await app.reset();
    const citizen = await app.citizen();
    await returnNewCase(app, citizen, dec(2, '09:00:00'));
    await app.clock(dec(2, '15:00:00'));
    await resubmitFromCase(citizen);
    await expectDue(citizen, 31, due(4), '4 ธ.ค. 2569 16:30');
  });

  await test.step('คร่อมวันหยุดและส่งแก้หลัง 16:30', async () => {
    await app.reset();
    const citizen = await app.citizen();
    await returnNewCase(app, citizen, dec(4, '10:00:00'));
    await expect(id(citizen, 'fix-deadline')).toHaveAttribute('data-iso', dec(11, '10:00:00'));
    await app.clock(dec(8, '17:00:00'));
    await resubmitFromCase(citizen);
    await expectDue(citizen, 31, due(8), '8 ธ.ค. 2569 16:30');
    await expectLevel(id(citizen, 'sla-level'), 'overdue');
  });
});

async function checkLevelAtEachTime(app, page, number, samples) {
  for (const [when, level] of samples) {
    await test.step(when + ' · ' + level, async () => {
      await app.clock(when);
      await page.goto(citizenCase(number));
      await expectLevel(id(page, 'sla-level'), level);
      await json(page.request.get(caseApi(number)), 200, { slaLevel: level });
    });
  }
}

test('TC-SLA-03 · ปกติ ใกล้ครบกำหนด เกินกำหนด หยุดนับ และปิดแล้ว', async ({ app }) => {
  const somchai = await app.citizen();
  await newPaid(somchai.request, paid(31));
  await json(somchai.request.get(caseApi(31)), 200, { dueAt: due(4) });
  await checkLevelAtEachTime(app, somchai, 31, [
    [START, 'normal'],
    [dec(2, '09:00:00'), 'normal'],
    [dec(3, '09:00:00'), 'near'],
    [due(4), 'near'],
    [dec(4, '16:30:01'), 'overdue'],
    [dec(4, '16:31:00'), 'overdue'],
    [dec(5, '10:00:00'), 'overdue'],
  ]);

  await app.reset();
  const piti = await app.citizen(PITI);
  await json(piti.request.get(caseApi(16)), 200, { dueAt: due(8) });
  await checkLevelAtEachTime(app, piti, 16, [
    [dec(3, '09:00:00'), 'normal'],
    [dec(4, '09:00:00'), 'near'],
    [due(8), 'near'],
    [dec(8, '16:31:00'), 'overdue'],
  ]);

  await app.reset();
  const officer = await app.staff('off.reg1');
  await officer.goto('/officer/queue');
  const seeds = [
    [20, '2026-11-30T16:30:00+07:00', 'overdue'],
    [22, due(1), 'near'], [24, due(2), 'near'], [25, due(3), 'normal'],
  ];
  for (const [number, iso, level] of seeds) {
    const row = queueRow(officer, number);
    await expectLevel(id(row, 'row-sla-level'), level);
    await expect(id(row, 'row-due')).toHaveAttribute('data-iso', iso);
  }
  for (const [number, , level] of seeds) {
    await officer.goto(officerCase(number));
    await expectLevel(id(officer, 'sla-level'), level);
  }
  await officer.goto(officerCase(17));
  await expectLevel(id(officer, 'sla-level'), 'paused');
  const somying = await app.citizen(SOMYING);
  await somying.goto(citizenCase(1));
  await expectLevel(id(somying, 'sla-level'), 'closed');
  await checkLevelAtEachTime(app, somying, 22, [[due(1), 'near'], [dec(1, '16:31:00'), 'overdue']]);
});

function notiText(number, level) {
  return 'คำขอ ' + caseNo(number) + ' ' + levels[level];
}

function notiItem(page, number, level) {
  const attributes = '[data-case-no="' + caseNo(number) + '"]' + (level ? '[data-level="' + level + '"]' : '');
  return id(page, 'noti-item').and(page.locator(attributes));
}

async function expectNotifications(page, expected) {
  await page.goto('/notifications');
  await expect(id(page, 'bell-count')).toHaveText(String(expected.length));
  await expect(id(page, 'noti-item')).toHaveCount(expected.length);
  if (expected.length === 0) await expect(id(page, 'noti-empty')).toHaveText('ไม่มีแจ้งเตือน');
  for (const [number, level] of expected) {
    await expect(notiItem(page, number, level)).toHaveCount(1);
    await expect(notiItem(page, number, level)).toHaveText(notiText(number, level));
  }
  const { items } = await json(page.request.get('/api/notifications'));
  expect(items.map(({ caseNo, level, text }) => [caseNo, level, text])).toEqual(expect.arrayContaining(
    expected.map(([number, level]) => [caseNo(number), level, notiText(number, level)]),
  ));
  expect(items).toHaveLength(expected.length);
}

const initialNotifications = {
  'off.reg1': [[24, 'near'], [22, 'near'], [20, 'overdue']],
  'off.reg2': [[24, 'near']],
  head1: [[20, 'overdue']],
  'off.works1': [],
};

const afterCutoffNotifications = {
  ...initialNotifications,
  'off.reg1': [...initialNotifications['off.reg1'], [22, 'overdue']],
  head1: [...initialNotifications.head1, [22, 'overdue']],
};

async function setupNotifications(app) {
  const pages = {};
  for (const [username, expected] of Object.entries(initialNotifications)) {
    pages[username] = await app.staff(username);
    await expectNotifications(pages[username], expected);
  }
  await app.clock(dec(1, '16:31:00'));
  for (const [username, expected] of Object.entries(afterCutoffNotifications)) {
    await expectNotifications(pages[username], expected);
  }
  return pages;
}

test('TC-NOTI-01 · ผู้รับแจ้งเตือนตามระดับและแผนก', async ({ app }) => {
  await setupNotifications(app);
});

const toLevel = (numbers, level) => numbers.map((number) => [number, level]);

async function expectCaseNotifications(page, number, expected) {
  await page.goto('/notifications');
  await expect(notiItem(page, number)).toHaveCount(expected.length);
  for (const level of expected) {
    await expect(notiItem(page, number, level)).toHaveCount(1);
    await expect(notiItem(page, number, level)).toHaveText(notiText(number, level));
  }
  const { items } = await json(page.request.get('/api/notifications'));
  expect(items.filter((item) => item.caseNo === caseNo(number)).map((item) => item.level).sort()).toEqual(
    [...expected].sort(),
  );
}

test('TC-NOTI-02 · แจ้งครั้งเดียวต่อระดับ ข้ามระดับ และส่งตามขั้นตอน', async ({ app }) => {
  await test.step('เปิดหน้าและเรียก API ซ้ำโดยไม่มีรายการเพิ่ม', async () => {
    const pages = await setupNotifications(app);
    for (const username of ['off.reg1', 'head1']) {
      const page = pages[username];
      const expected = afterCutoffNotifications[username];
      for (let n = 0; n < 3; n++) await expectNotifications(page, expected);
      for (let n = 0; n < 2; n++) {
        await page.goto('/officer/queue');
        await expect(id(page, 'bell-count')).toHaveText(String(expected.length));
      }
      await expectNotifications(page, expected);
    }
  });

  await test.step('เริ่มประเมินครั้งแรกเมื่อเลยกำหนดแล้ว', async () => {
    await app.reset();
    await app.clock(dec(5, '10:00:00'));
    const saturdayNotifications = {
      'off.reg1': toLevel([20, 22, 23, 24, 28, 29, 30], 'overdue'),
      'off.reg2': [...toLevel([13, 15, 24, 25, 26, 27, 28, 29, 30], 'overdue'), [16, 'near']],
      'off.works1': [[10, 'overdue']],
      head1: [...toLevel([10, 13, 14, 15, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30], 'overdue'), [11, 'near']],
    };
    for (const [username, expected] of Object.entries(saturdayNotifications)) {
      await expectNotifications(await app.staff(username), expected);
    }
  });

  await test.step('แจ้งหัวหน้าตอนรออนุมัติและแจ้งผู้ออกเอกสารตอนรอออก', async () => {
    await app.reset();
    await app.clock(dec(4, '09:00:00'));
    const head = await app.staff('head1');
    const reg1 = await app.staff('off.reg1');
    const reg2 = await app.staff('off.reg2');

    await expectCaseNotifications(head, 14, ['near']);
    await expectCaseNotifications(reg1, 14, []);
    await expectCaseNotifications(reg2, 14, []);

    await app.clock(dec(4, '16:31:00'));
    await expectCaseNotifications(head, 14, ['near', 'overdue']);
    await expectCaseNotifications(reg1, 14, []);
    await expectCaseNotifications(reg2, 14, []);

    await app.clock(dec(8, '09:00:00'));
    await expectCaseNotifications(reg1, 19, ['near']);
    await expectCaseNotifications(reg2, 19, []);
    await expectCaseNotifications(head, 19, []);

    await app.clock(dec(9, '16:31:00'));
    await expectCaseNotifications(reg1, 19, ['near', 'overdue']);
    await expectCaseNotifications(head, 19, ['overdue']);
    await expectCaseNotifications(reg2, 19, []);
  });
});
