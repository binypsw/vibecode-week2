const { test: base, expect } = require('@playwright/test')
const { AxeBuilder } = require('@axe-core/playwright')
const { readFile, stat } = require('node:fs/promises')
const { resolve } = require('node:path')
const { execFileSync } = require('node:child_process')
const ExcelJS = require('exceljs')

const startTime = '2026-12-01T09:00:00+07:00'
const somchai = '1101700123456'
const somying = '3100600987659'
const mana = '5500400111221'
const verifyPattern = /^[A-Z0-9]{8}$/
const maskPattern = /^X-XXXX-XXXXX-\d{2}-\d$/
const reason = 'xxxxxxxxxx'
const reasonError = 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร'
const unmaskReason = 'ตรวจสอบตัวตนซ้ำ'
const noRefund = 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน'

const statuses = {
  DRAFT: 'ร่าง',
  PENDING_PAYMENT: 'รอชำระเงิน',
  SUBMITTED: 'ส่งคำขอแล้ว',
  IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร',
  PENDING_APPROVAL: 'รออนุมัติ',
  APPROVED: 'อนุมัติ',
  COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ',
  CANCELLED: 'ยกเลิก',
}
const levels = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
}
const verifyResults = {
  VALID: 'เอกสารถูกต้อง',
  EXPIRED: 'เอกสารหมดอายุ',
  NOT_FOUND: 'ไม่พบเอกสาร',
  TAMPERED: 'ลายเซ็นไม่ถูกต้อง',
}

const id = (page, name) => page.getByTestId(name)
const caseNo = number => `EG-2569-${String(number).padStart(6, '0')}`
const caseApi = number => `/api/cases/${caseNo(number)}`
const casePage = (number, role = 'officer') => `/${role}/cases/${caseNo(number)}`
const docApi = docNo => `/api/documents/${docNo}/pdf`
const dashboardApi = (period = '2026-12', service = 'ALL') => `/api/dashboard?period=${period}&service=${service}`
const row = (page, testId, name, value) => id(page, testId).and(page.locator(`[data-${name}="${value}"]`))
const caseRow = (page, testId, number) => row(page, testId, 'case-no', caseNo(number))

async function json(pending, status = 200, fields) {
  const response = await pending
  expect(response.status(), `${response.url()}: HTTP status`).toBe(status)
  expect(response.headers()['content-type']).toMatch(/^application\/json\b/i)
  const body = await response.json()
  if (fields) expect(body).toMatchObject(fields)
  return body
}

const error = (pending, status, code, message) =>
  json(pending, status, message ? { code, message } : { code })

const test = base.extend({
  app: async ({ browser, baseURL, playwright }, use) => {
    const url = (process.env.BASE_URL || baseURL || 'http://localhost:3000').replace(/\/$/, '')
    const hook = await playwright.request.newContext({ baseURL: url })
    const contexts = new Set()

    async function closeSessions() {
      await Promise.all([...contexts].map(context => context.close()))
      contexts.clear()
    }

    async function reset() {
      await closeSessions()
      await json(hook.post('/api/test/reset'), 200, { ok: true, now: startTime })
    }

    async function session({ username, idNo } = {}) {
      const context = await browser.newContext({ baseURL: url, acceptDownloads: true })
      contexts.add(context)
      const api = context.request
      let login
      if (username) {
        login = await json(api.post('/api/auth/staff/login', {
          data: { username, password: 'Test@1234' },
        }))
      }
      if (idNo) {
        await json(api.post('/api/auth/thaid/start', { data: { idNo } }), 200, { status: 'OTP_SENT' })
        login = await json(api.post('/api/auth/thaid/verify', { data: { idNo, otp: '123456' } }),
          200, { registered: idNo !== mana })
      }
      return { context, api, login, page: await context.newPage() }
    }

    try {
      await reset()
      await use({
        url, hook, reset,
        clock: now => json(hook.put('/api/test/clock', { data: { now } }), 200, { now }),
        staff: username => session({ username }),
        citizen: (idNo = somchai) => session({ idNo }),
        anon: () => session(),
      })
    } finally {
      await closeSessions()
      await hook.dispose()
    }
  },
})

test.describe.configure({ mode: 'default', timeout: 60000 })

async function open(page, path, status = 200) {
  const response = await page.goto(path)
  expect(response.status(), `${path}: HTTP status`).toBe(status)
  return response
}

async function caseStatus(page, status) {
  await expect(id(page, 'case-status')).toHaveText(statuses[status])
  await expect(id(page, 'case-status')).toHaveAttribute('data-status', status)
}

async function iso(page, testId, value) {
  await expect(id(page, testId)).toHaveAttribute('data-iso', value)
}

async function buttons(page, expected) {
  for (const [name, count] of Object.entries(expected)) {
    await expect(id(page, `${name}-btn`)).toHaveCount(count)
  }
}

async function caseRows(page, testId, numbers) {
  await expect(id(page, testId)).toHaveCount(numbers.length)
  await expect.poll(() => id(page, testId).evaluateAll(rows => rows.map(row => row.dataset.caseNo)))
    .toEqual(numbers.map(caseNo))
}

function postAction(api, number, action, data) {
  const path = ['approve', 'reject', 'resubmit', 'cancel'].includes(action)
    ? caseApi(number)
    : `/api/officer/cases/${caseNo(number)}`
  return api.post(`${path}/${action}`, { data })
}

async function approve(api, number) {
  await json(postAction(api, number, 'approve'), 200, { status: 'APPROVED' })
}

async function issue(api, number, docNo) {
  const body = await json(postAction(api, number, 'issue'), 200, { status: 'COMPLETED', docNo })
  expect(body.verifyCode).toMatch(verifyPattern)
  return body.verifyCode
}

async function reasonForm(page, action, value) {
  if (!(await id(page, `${action}-reason`).isVisible())) {
    await id(page, `${action === 'unmask' ? 'show-full-id' : action}-btn`).click()
  }
  await id(page, `${action}-reason`).fill(value)
  await id(page, `${action}-submit`).click()
}

async function verify(page, code, result = 'VALID', expires) {
  const path = `/verify/${code}`
  await open(page, path, result === 'NOT_FOUND' ? 404 : 200)
  await expect(page).toHaveURL(new RegExp(`${path}$`))
  await expect(id(page, 'verify-result')).toHaveText(verifyResults[result])
  await expect(id(page, 'verify-result')).toHaveAttribute('data-result', result)
  if (expires) await iso(page, 'verify-expires', expires)
  if (result === 'NOT_FOUND' || result === 'TAMPERED') {
    await expect(id(page, 'verify-applicant')).toHaveCount(0)
    await expect(id(page, 'verify-doc-no')).toHaveCount(0)
  }
}

async function verifyDetails(page, { docNo, applicant, issued, signer }) {
  await expect(id(page, 'verify-doc-no')).toHaveText(docNo)
  await expect(id(page, 'verify-applicant')).toHaveText(applicant)
  await expect(id(page, 'verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง')
  await iso(page, 'verify-issued', issued)
  await expect(id(page, 'verify-signer')).toHaveText(signer)
}

async function download(page, button, endpoint) {
  let headers
  const matches = url => url.pathname === endpoint
  const capture = async route => {
    const response = await route.fetch()
    headers = response.headers()
    await route.fulfill({ response })
  }

  if (endpoint) await page.context().route(matches, capture)
  try {
    const [file] = await Promise.all([page.waitForEvent('download'), button.click()])
    const path = await file.path()
    return { name: file.suggestedFilename(), body: await readFile(path), headers }
  } finally {
    if (endpoint) await page.context().unroute(matches, capture)
  }
}

function assertPdf(headers, docNo) {
  expect(headers['content-type']).toMatch(/^application\/pdf\b/i)
  if (docNo) {
    expect(headers['content-disposition']).toContain(`${docNo}.pdf`)
  }
}

async function dashboard(api, fields, period, service) {
  return json(api.get(dashboardApi(period, service)), 200, fields)
}

async function auditFilter(page, { actor = '', event = '', from = '', to = '' } = {}) {
  await id(page, 'audit-filter-actor').fill(actor)
  await id(page, 'audit-filter-event').selectOption(event)
  await id(page, 'audit-filter-from').fill(from)
  await id(page, 'audit-filter-to').fill(to)
  await id(page, 'audit-apply-btn').click()
}

async function auditCount(page, count) {
  await expect(id(page, 'audit-count')).toHaveText(String(count))
  await expect(id(page, 'audit-row')).toHaveCount(count)
}

function pdfUpload(name = 'id-card.pdf') {
  const head = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n'
  const tail = '\ntrailer<</Root 1 0 R>>\n%%EOF\n'
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(head.padEnd(1024 - tail.length) + tail) }
}

async function newPaid(app, api, expectedNo, amount, time = startTime) {
  await app.clock(time)
  const draft = await json(api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } }),
    201, { fee: amount })
  await json(api.post(`/api/drafts/${draft.draftId}/files`, {
    multipart: { docKey: 'id-card', file: pdfUpload() },
  }), 201)
  const payment = await json(api.post(`/api/drafts/${draft.draftId}/payment`), 201, { amount })
  await json(app.hook.post(`/api/test/payments/${payment.ref}/pay`, { data: { amount } }),
    200, { status: 'PAID', caseNo: caseNo(expectedNo) })
  await json(api.get(`/api/payments/${payment.ref}`), 200, { status: 'PAID', caseNo: caseNo(expectedNo) })
}

test('TC-WORKFLOW-01 อนุมัติและออกเอกสาร SV-01', async ({ app }) => {
  const officer = await app.staff('off.reg2')
  const { page } = officer
  await open(page, casePage(25))
  await caseStatus(page, 'IN_REVIEW')
  await buttons(page, { approve: 1, return: 1, reject: 1, forward: 0, issue: 0 })
  await expect(id(page, 'case-fee')).toHaveText('฿60')

  const otherOfficer = await app.staff('off.reg1')
  await error(postAction(otherOfficer.api, 26, 'approve'), 403, 'FORBIDDEN')

  await id(page, 'approve-btn').click()
  await caseStatus(page, 'APPROVED')
  await buttons(page, { issue: 1, approve: 0 })
  await id(page, 'issue-btn').click()
  await caseStatus(page, 'COMPLETED')
  const docNo = 'DOC-2569-000002'
  await expect(id(page, 'doc-no')).toHaveText(docNo)
  await expect(id(page, 'verify-code')).toHaveText(verifyPattern)
  await iso(page, 'closed-at', startTime)
  await expect(id(page, 'sla-level')).toHaveText('ปิดแล้ว')

  const citizen = await app.citizen(somying)
  await open(citizen.page, casePage(25, 'citizen'))
  await caseStatus(citizen.page, 'COMPLETED')
  const downloadButton = id(citizen.page, 'download-doc-btn')
  await expect(downloadButton).toHaveCount(1)
  const file = await download(citizen.page, downloadButton, docApi(docNo))
  assertPdf(file.headers, docNo)
  expect(file.name).toBe(`${docNo}.pdf`)
  expect(file.body.toString('latin1')).toContain(`docNo=${docNo} caseNo=${caseNo(25)}`)

  const executive = await app.staff('exec1')
  await dashboard(executive.api, { received: 3, closed: 1, onTime: 1, backlog: 20 })
})

test('TC-WORKFLOW-02 ส่ง SV-02 ผ่านหัวหน้าและออกเอกสาร', async ({ app }) => {
  const officer = await app.staff('off.reg2')
  await open(officer.page, casePage(13))
  await buttons(officer.page, { approve: 0, forward: 1 })
  await expect(id(officer.page, 'forward-target')).toHaveCount(0)
  await id(officer.page, 'forward-btn').click()
  await caseStatus(officer.page, 'PENDING_APPROVAL')
  await open(officer.page, '/officer/queue')
  await expect(id(officer.page, 'workload-count')).toHaveText('8')
  await expect(caseRow(officer.page, 'queue-row', 13)).toHaveCount(0)

  const head = await app.staff('head1')
  await open(head.page, '/head/approvals')
  await caseRows(head.page, 'approval-row', [13, 14, 11])
  await id(caseRow(head.page, 'approval-row', 13), 'approval-open').click()
  await buttons(head.page, { approve: 1, reject: 1, issue: 0 })
  await id(head.page, 'approve-btn').click()
  await caseStatus(head.page, 'APPROVED')
  await buttons(head.page, { issue: 0 })

  const otherOfficer = await app.staff('off.reg1')
  await open(otherOfficer.page, casePage(13))
  await buttons(otherOfficer.page, { issue: 0 })
  await error(postAction(otherOfficer.api, 13, 'issue'), 403, 'FORBIDDEN')

  async function issueFromPage(page, number) {
    await open(page, casePage(number))
    await id(page, 'issue-btn').click()
    await caseStatus(page, 'COMPLETED')
    await expect(id(page, 'doc-no')).toHaveText('DOC-2569-000002')
    await expect(id(page, 'verify-code')).toHaveText(verifyPattern)
    const publicPage = (await app.anon()).page
    await verify(publicPage, (await id(page, 'verify-code').innerText()).trim())
    await expect(id(publicPage, 'verify-signer')).toHaveText('หัวหน้าฝ่าย')
  }

  await issueFromPage(officer.page, 13)
  await app.reset()
  await issueFromPage((await app.staff('off.reg1')).page, 19)
})

test('TC-WORKFLOW-03 ส่ง SV-03 ผ่านทะเบียน โยธา และหัวหน้า', async ({ app }) => {
  const registry = await app.staff('off.reg2')
  await open(registry.page, casePage(12))
  await expect(id(registry.page, 'case-step')).toHaveText('ขั้นตอน 1/3 · ฝ่ายทะเบียน')
  await expect(id(registry.page, 'case-fee')).toHaveText('฿1,010')
  await buttons(registry.page, { forward: 1 })
  await id(registry.page, 'forward-btn').click()
  await caseStatus(registry.page, 'IN_REVIEW')
  await expect(id(registry.page, 'case-step')).toHaveText('ขั้นตอน 2/3 · ฝ่ายโยธา')
  await expect(id(registry.page, 'case-owner')).toHaveText('ยังไม่มีผู้รับ')
  await open(registry.page, '/officer/queue')
  await expect(id(registry.page, 'workload-count')).toHaveText('8')
  await expect(id(registry.page, 'queue-row')).toHaveCount(16)
  await expect(caseRow(registry.page, 'queue-row', 12)).toHaveCount(0)

  const works = await app.staff('off.works1')
  await open(works.page, '/officer/queue')
  await caseRows(works.page, 'queue-row', [10, 12])
  await buttons(works.page, { claim: 2 })
  await error(postAction((await app.staff('off.reg1')).api, 12, 'claim'), 403, 'FORBIDDEN')
  await id(caseRow(works.page, 'queue-row', 12), 'claim-btn').click()
  // The queue can stay open after claim. Wait for its result before opening the case.
  await expect.poll(async () => (await json(works.api.get(caseApi(12)))).owner).toBe('off.works1')
  await open(works.page, casePage(12))
  await expect(id(works.page, 'case-owner')).toHaveText('off.works1')
  await id(works.page, 'forward-btn').click()
  await caseStatus(works.page, 'PENDING_APPROVAL')
  await expect(id(works.page, 'case-step')).toHaveText('ขั้นตอน 3/3 · หัวหน้าฝ่าย')

  const head = await app.staff('head1')
  await open(head.page, '/head/approvals')
  await expect(id(head.page, 'approval-row')).toHaveCount(3)
  await id(caseRow(head.page, 'approval-row', 12), 'approval-open').click()
  await id(head.page, 'approve-btn').click()
  await caseStatus(head.page, 'APPROVED')

  await open(works.page, casePage(12))
  await buttons(works.page, { issue: 0 })
  await open(registry.page, casePage(12))
  await buttons(registry.page, { issue: 1 })
  await id(registry.page, 'issue-btn').click()
  await caseStatus(registry.page, 'COMPLETED')
  await expect(id(registry.page, 'verify-code')).toHaveText(verifyPattern)
  const publicPage = (await app.anon()).page
  await verify(publicPage, (await id(registry.page, 'verify-code').innerText()).trim())
  await expect(id(publicPage, 'verify-signer')).toHaveText('หัวหน้าฝ่าย')
})

test('TC-WORKFLOW-04 ตีกลับได้สูงสุดสองครั้งและรักษาสิทธิ์ตามบริการ', async ({ app }) => {
  async function twoReturns(number, username) {
    const officer = await app.staff(username)
    const citizen = await app.citizen()
    await open(officer.page, casePage(number))
    await expect(id(officer.page, 'return-count')).toHaveText('0')
    for (const count of [1, 2]) {
      await reasonForm(officer.page, 'return', reason)
      await caseStatus(officer.page, 'NEED_FIX')
      await expect(id(officer.page, 'return-count')).toHaveText(String(count))
      await open(citizen.page, casePage(number, 'citizen'))
      await id(citizen.page, 'submit-fix-btn').click()
      await caseStatus(citizen.page, 'IN_REVIEW')
      await open(officer.page, casePage(number))
      await caseStatus(officer.page, 'IN_REVIEW')
      await expect(id(officer.page, 'case-owner')).toHaveText(username)
    }
    return officer
  }

  async function assertLimit(officer, number) {
    await expect(id(officer.page, 'return-count')).toHaveText('2')
    await buttons(officer.page, { return: 0, approve: 1, reject: 1 })
    await error(postAction(officer.api, number, 'return', { reason }),
      409, 'RETURN_LIMIT', 'ตีกลับได้สูงสุด 2 ครั้ง')
    await json(officer.api.get(caseApi(number)), 200, { status: 'IN_REVIEW', returnCount: 2 })
  }

  await assertLimit(await twoReturns(20, 'off.reg1'), 20)

  await app.reset()
  const seeded = await app.staff('off.reg1')
  await open(seeded.page, casePage(23))
  await assertLimit(seeded, 23)

  await app.reset()
  const officer = await twoReturns(13, 'off.reg2')
  await buttons(officer.page, { return: 0, approve: 0, reject: 0, forward: 1 })
  await error(postAction(officer.api, 13, 'reject', { reason }), 403, 'FORBIDDEN')
  const note = 'ส่งต่อให้หัวหน้าพิจารณา'
  await id(officer.page, 'forward-note').fill(note)
  await id(officer.page, 'forward-btn').click()
  await caseStatus(officer.page, 'PENDING_APPROVAL')

  const auditor = await app.staff('audit1')
  await open(auditor.page, '/audit')
  const forward = caseRow(auditor.page, 'audit-row', 13).and(auditor.page.locator('[data-event="FORWARD"]'))
  await expect(id(forward, 'audit-detail')).toContainText(note)
  const head = await app.staff('head1')
  await open(head.page, casePage(13))
  await buttons(head.page, { reject: 1, approve: 1 })
})

test('TC-WORKFLOW-05 เหตุผลตีกลับและไม่อนุมัติอย่างน้อยสิบตัวอักษร', async ({ app }) => {
  const registry = await app.staff('off.reg1')
  await open(registry.page, casePage(20))
  for (const value of ['xxxxxxxxx', ' '.repeat(10)]) {
    await reasonForm(registry.page, 'return', value)
    await expect(id(registry.page, 'return-reason-error')).toHaveText(reasonError)
    await error(postAction(registry.api, 20, 'return', { reason: value }), 400, 'REASON_TOO_SHORT', reasonError)
    await caseStatus(registry.page, 'IN_REVIEW')
  }
  await reasonForm(registry.page, 'return', reason)
  await caseStatus(registry.page, 'NEED_FIX')
  const applicant = await app.citizen()
  await open(applicant.page, casePage(20, 'citizen'))
  await expect(id(applicant.page, 'return-reason-display')).toHaveText(reason)

  await app.reset()
  const officer = await app.staff('off.reg2')
  await open(officer.page, casePage(26))
  await reasonForm(officer.page, 'reject', 'xxxxxxxxx')
  await expect(id(officer.page, 'reject-reason-error')).toHaveText(reasonError)
  await error(postAction(officer.api, 26, 'reject', { reason: 'xxxxxxxxx' }), 400, 'REASON_TOO_SHORT')
  await reasonForm(officer.page, 'reject', reason)
  await caseStatus(officer.page, 'REJECTED')
  await iso(officer.page, 'closed-at', startTime)
  await expect(id(officer.page, 'sla-level')).toHaveText('ปิดแล้ว')
  const citizen = await app.citizen()
  await open(citizen.page, casePage(26, 'citizen'))
  await expect(id(citizen.page, 'no-refund-note')).toHaveText(noRefund)
  await dashboard((await app.staff('exec1')).api, { closed: 1, onTime: 1 })

  await app.reset()
  const head = await app.staff('head1')
  await error(postAction(head.api, 11, 'reject', { reason: 'xxxxxxxxx' }), 400, 'REASON_TOO_SHORT')
  await json(postAction(head.api, 11, 'reject', { reason }), 200, { status: 'REJECTED' })
})

test('TC-WORKFLOW-06 ขอบเวลาแก้ไข 168 ชั่วโมง', async ({ app }) => {
  const path = casePage(17, 'citizen')
  const deadline = '2026-12-04T14:00:00+07:00'
  const initial = await app.citizen()
  await open(initial.page, path)
  await caseStatus(initial.page, 'NEED_FIX')
  await expect(id(initial.page, 'return-reason-display')).toHaveText('ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข')
  await expect(id(initial.page, 'fix-deadline')).toHaveText('4 ธ.ค. 2569 14:00')
  await iso(initial.page, 'fix-deadline', deadline)
  await buttons(initial.page, { 'submit-fix': 1 })

  await app.reset()
  await app.clock('2026-12-04T13:59:00+07:00')
  const before = await app.citizen()
  await open(before.page, path)
  await expect(id(before.page, 'submit-fix-btn')).toBeEnabled()
  const [resubmit] = await Promise.all([
    before.page.waitForResponse(response =>
      new URL(response.url()).pathname === `${caseApi(17)}/resubmit` && response.request().method() === 'POST'),
    id(before.page, 'submit-fix-btn').click(),
  ])
  await json(resubmit, 200, { status: 'IN_REVIEW' })
  await caseStatus(before.page, 'IN_REVIEW')

  await app.reset()
  await app.clock(deadline)
  const expired = await app.citizen()
  await open(expired.page, path)
  await caseStatus(expired.page, 'CANCELLED')
  await buttons(expired.page, { 'submit-fix': 0 })
  await expect(id(expired.page, 'no-refund-note')).toHaveText(noRefund)
  await error(postAction(expired.api, 17, 'resubmit'), 409, 'FIX_WINDOW_EXPIRED')
  const timeline = id(expired.page, 'case-timeline')
  await expect(row(timeline, 'timeline-item', 'iso', deadline)).toHaveCount(1)
  await dashboard((await app.staff('exec1')).api, { backlog: 20 })
})

test('TC-DOC-01 ออก PDF และตรวจข้อมูลเอกสาร', async ({ app }) => {
  const officer = await app.staff('off.reg2')
  const docNo = 'DOC-2569-000002'
  const expires = '2027-02-28'
  await approve(officer.api, 25)
  const code = await issue(officer.api, 25, docNo)

  const citizen = await app.citizen(somying)
  const pdf = await citizen.api.get(docApi(docNo))
  expect(pdf.status()).toBe(200)
  assertPdf(pdf.headers(), docNo)
  const content = (await pdf.body()).toString('latin1')
  const machineLine = `docNo=${docNo} caseNo=${caseNo(25)} verify=${code} validUntil=${expires}`
  const marker = content.indexOf(machineLine)
  expect(marker).toBeGreaterThanOrEqual(0)
  expect(content[marker + machineLine.length] || '').not.toMatch(/\d/)

  const publicSession = await app.anon()
  await verify(publicSession.page, code, 'VALID', expires)
  await verifyDetails(publicSession.page, {
    docNo, applicant: 'สมหญิง ร***', issued: startTime, signer: 'เจ้าหน้าที่ทะเบียน 2',
  })
  await open(citizen.page, casePage(25, 'citizen'))
  await expect(id(citizen.page, 'doc-qr')).toHaveAttribute('data-url', `${app.url}/verify/${code}`)
  await json(publicSession.api.get(`/api/verify/${code}`), 200, {
    result: 'VALID', validUntil: expires, issuedAt: startTime,
  })

  const nonOwner = await app.citizen()
  expect((await nonOwner.api.get(docApi(docNo))).status()).toBe(404)
  await error(postAction(officer.api, 25, 'issue'), 409, 'INVALID_STATE')
  await json(citizen.api.get(caseApi(25)), 200, { docNo, verifyCode: code, status: 'COMPLETED' })
  await issue((await app.staff('off.reg1')).api, 19, 'DOC-2569-000003')
})

test('TC-DOC-02 ตรวจเอกสารสาธารณะและปิดบังข้อมูล', async ({ app }) => {
  const { page, api } = await app.anon()
  await verify(page, 'K7M2Q9XA', 'VALID', '2027-02-02')
  await verifyDetails(page, {
    docNo: 'DOC-2569-000001', applicant: 'สมชาย ใ***',
    issued: '2026-11-05T10:00:00+07:00', signer: 'เจ้าหน้าที่ทะเบียน 1',
  })
  await expect(page.locator('body')).not.toContainText('ใจดี')
  await expect(page.locator('body')).not.toContainText(somchai)
  await verify(page, 'ZZZZZZZZ', 'NOT_FOUND')
  await json(api.get('/api/verify/K7M2Q9XA'), 200, { result: 'VALID', applicantMasked: 'สมชาย ใ***' })
  expect(await json(api.get('/api/verify/ZZZZZZZZ'), 404)).toEqual({ result: 'NOT_FOUND' })
})

test('TC-DOC-03 ขอบวันหมดอายุ วันอธิกสุรทิน และความถูกต้องของลายเซ็น', async ({ app }) => {
  async function checkExpiry(page, code, expires, nextDay) {
    await app.clock(`${expires}T23:59:00+07:00`)
    await verify(page, code, 'VALID', expires)
    await app.clock(`${nextDay}T00:00:00+07:00`)
    await verify(page, code, 'EXPIRED', expires)
  }

  const officer = await app.staff('off.reg2')
  await approve(officer.api, 25)
  const sv01 = await issue(officer.api, 25, 'DOC-2569-000002')
  await checkExpiry((await app.anon()).page, sv01, '2027-02-28', '2027-03-01')

  await app.reset()
  const sv02 = await issue((await app.staff('off.reg1')).api, 19, 'DOC-2569-000002')
  await checkExpiry((await app.anon()).page, sv02, '2027-11-30', '2027-12-01')

  await app.reset()
  await checkExpiry((await app.anon()).page, 'K7M2Q9XA', '2027-02-02', '2027-02-03')

  await app.reset()
  await app.clock('2028-02-29T10:00:00+07:00')
  const leapOfficer = await app.staff('off.reg2')
  await approve(leapOfficer.api, 25)
  const leapSv01 = await issue(leapOfficer.api, 25, 'DOC-2571-000001')
  const leapSv02 = await issue((await app.staff('off.reg1')).api, 19, 'DOC-2571-000002')
  const leapPage = (await app.anon()).page
  await checkExpiry(leapPage, leapSv01, '2028-05-28', '2028-05-29')
  await checkExpiry(leapPage, leapSv02, '2029-02-27', '2029-02-28')

  await app.reset()
  await json(app.hook.post('/api/test/documents/DOC-2569-000001/tamper'), 200, { ok: true })
  const tampered = (await app.anon()).page
  await verify(tampered, 'K7M2Q9XA', 'TAMPERED')
  await app.clock('2027-03-01T00:00:00+07:00')
  await verify(tampered, 'K7M2Q9XA', 'TAMPERED')
})

test('TC-PDPA-01 ปิดบังเลขบัตรเจ้าหน้าที่และให้เจ้าของเห็นเลขเต็ม', async ({ app }) => {
  const { page } = await app.staff('off.reg2')
  await open(page, '/officer/queue')
  const masks = id(page, 'row-id-masked')
  expect(await masks.count()).toBeGreaterThan(0)
  for (const mask of await masks.all()) await expect(mask).toHaveText(maskPattern)

  await expect(id(caseRow(page, 'queue-row', 25), 'row-id-masked')).toHaveText('X-XXXX-XXXXX-65-9')
  await expect(id(caseRow(page, 'queue-row', 26), 'row-id-masked')).toHaveText('X-XXXX-XXXXX-45-6')
  await open(page, casePage(25))
  await expect(id(page, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9')
  const html = await page.content()
  expect(html.includes(somying)).toBe(false)
  expect(html.includes('3-1006-00987-65-9')).toBe(false)

  const head = await app.staff('head1')
  await open(head.page, casePage(25))
  await expect(id(head.page, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9')
  for (const [idNo, number, formatted] of [
    [somying, 25, '3-1006-00987-65-9'],
    [somchai, 20, '1-1017-00123-45-6'],
  ]) {
    const citizen = await app.citizen(idNo)
    await open(citizen.page, casePage(number, 'citizen'))
    await expect(id(citizen.page, 'case-id-full')).toHaveText(formatted)
  }
})

function containsKey(value, key) {
  return value !== null && typeof value === 'object' &&
    (Object.hasOwn(value, key) || Object.values(value).some(child => containsKey(child, key)))
}

test('TC-PDPA-02 จำกัดข้อมูลเลขบัตรใน JSON เจ้าหน้าที่และหัวหน้า', async ({ app }) => {
  const endpoints = [
    '/api/officer/queue?filter=all', caseApi(25), caseApi(26), caseApi(20),
    '/api/notifications', `${caseApi(25)}/files`,
  ]
  for (const username of ['off.reg1', 'head1']) {
    const { api } = await app.staff(username)
    for (const path of endpoints) {
      const body = await json(api.get(path))
      const serialized = JSON.stringify(body)
      const target = `${username} ${path}`
      expect(/\d{13}|\d-\d{4}-\d{5}-\d{2}-\d/.test(serialized), target).toBe(false)
      expect(containsKey(body, 'idNo'), target).toBe(false)
      for (const idNo of [somchai, somying, '1909900555015']) {
        expect(serialized.includes(idNo), target).toBe(false)
      }
      if (path === endpoints[0]) {
        expect(body.items.length, target).toBeGreaterThan(0)
        for (const item of body.items) expect(item.idMasked, target).toMatch(maskPattern)
      } else if ([caseApi(25), caseApi(26), caseApi(20)].includes(path)) {
        expect(body.idMasked, target).toMatch(maskPattern)
      }
    }
  }
})

test('TC-PDPA-03 แสดงเลขเต็มหลังให้เหตุผลและบันทึก Audit ครั้งเดียว', async ({ app }) => {
  const { page, api } = await app.staff('off.reg2')
  await open(page, casePage(25))
  for (const value of ['', '   ']) {
    await reasonForm(page, 'unmask', value)
    await expect(id(page, 'unmask-error')).toHaveText('กรุณากรอกเหตุผล')
    await expect(id(page, 'full-id')).toHaveCount(0)
    await error(postAction(api, 25, 'unmask', { reason: value }), 400, 'REASON_REQUIRED', 'กรุณากรอกเหตุผล')
  }
  await reasonForm(page, 'unmask', unmaskReason)
  await expect(id(page, 'full-id')).toHaveText('3-1006-00987-65-9')
  await page.reload()
  await expect(id(page, 'applicant-id')).toHaveText('X-XXXX-XXXXX-65-9')
  await expect(id(page, 'full-id')).toHaveCount(0)

  const auditor = await app.staff('audit1')
  await open(auditor.page, '/audit')
  await auditFilter(auditor.page, { event: 'UNMASK' })
  await auditCount(auditor.page, 1)
  const auditRow = id(auditor.page, 'audit-row')
  await expect(auditRow).toHaveAttribute('data-actor', 'off.reg2')
  await expect(id(auditRow, 'audit-role')).toHaveText('officer')
  await expect(id(auditRow, 'audit-case-no')).toHaveText(caseNo(25))
  await expect(id(auditRow, 'audit-event')).toHaveText('UNMASK')
  await expect(id(auditRow, 'audit-detail')).toContainText(unmaskReason)
  await iso(auditRow, 'audit-time', startTime)

  const executive = await app.staff('exec1')
  const citizen = await app.citizen(somying)
  for (const session of [executive, auditor, citizen]) {
    await error(postAction(session.api, 25, 'unmask', { reason: 'x' }), 403, 'FORBIDDEN')
  }
})

const backlogByService = {
  ALL: [21, 1],
  'SV-01': [11, 1],
  'SV-02': [7, 0],
  'SV-03': [3, 0],
}
const kpis = ['received', 'closed', 'ontime-pct', 'backlog', 'overdue']

async function assertKpis(page, expected) {
  for (const [index, name] of kpis.entries()) {
    await expect(id(page, `kpi-${name}`)).toHaveText(String(expected[index]))
  }
}

function assertNoPersonalData(text, label) {
  expect(/\d{13}|0\d{9}|สมชาย|สมหญิง|ปิติ|มานะ/.test(text), label).toBe(false)
}

async function dashboardCase(session, period, service, received, closed, onTime, ontimePct) {
  const { page, api } = session
  await id(page, 'period-select').selectOption(period)
  await id(page, 'service-select').selectOption(service)
  const [backlog, overdue] = backlogByService[service]
  const pctText = ontimePct === null ? '–' : `${ontimePct.toFixed(1)}%`
  await assertKpis(page, [received, closed, pctText, backlog, overdue])
  return dashboard(api, { received, closed, onTime, ontimePct, backlog, overdue }, period, service)
}

test('TC-DASH-01 ตัวเลขเริ่มต้นและตัวกรองบริการ', async ({ app }) => {
  const executive = await app.staff('exec1')
  const { page } = executive
  await open(page, '/dashboard')
  await expect(id(page, 'period-select')).toHaveValue('2026-12')
  await expect(id(page, 'service-select')).toHaveValue('ALL')
  await assertKpis(page, [3, 0, '–', 21, 1])
  await expect(id(page, 'workload-row')).toHaveCount(3)
  const workload = [
    { username: 'off.reg1', count: 3 }, { username: 'off.reg2', count: 9 }, { username: 'off.works1', count: 0 },
  ]
  for (const { username, count } of workload) {
    const officer = row(page, 'workload-row', 'username', username)
    await expect(id(officer, 'workload-value')).toHaveText(String(count))
  }
  const data = await dashboard(executive.api, {
    received: 3, closed: 0, onTime: 0, ontimePct: null, backlog: 21, overdue: 1,
  })
  expect(data.workload).toHaveLength(3)
  expect(data.workload).toEqual(expect.arrayContaining(workload.map(item => expect.objectContaining(item))))
  assertNoPersonalData(await page.locator('body').innerText(), 'Dashboard')

  for (const [service, received] of [['SV-01', 3], ['SV-02', 0], ['SV-03', 0]]) {
    await dashboardCase(executive, '2026-12', service, received, 0, 0, null)
  }
})

test('TC-DASH-02 ตัวเลขย้อนหลังและเปอร์เซ็นต์จากจำนวนปิดงาน', async ({ app }) => {
  const executive = await app.staff('exec1')
  await open(executive.page, '/dashboard')
  for (const entry of [
    ['2026-10', 'ALL', 1, 1, 1, 100],
    ['2026-11', 'ALL', 26, 7, 6, 85.7],
    ['2026-11', 'SV-01', 12, 3, 3, 100],
    ['2026-11', 'SV-02', 10, 3, 2, 66.7],
    ['2026-11', 'SV-03', 4, 1, 1, 100],
    ['2026', 'ALL', 30, 8, 7, 87.5],
    ['2026', 'SV-01', 16, 4, 4, 100],
    ['2026', 'SV-02', 10, 3, 2, 66.7],
    ['2026', 'SV-03', 4, 1, 1, 100],
  ]) {
    await test.step(`${entry[0]} ${entry[1]}`, () => dashboardCase(executive, ...entry))
  }
})

async function pdfText(buffer) {
  let pdfParse
  try {
    pdfParse = require('pdf-parse')
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND' || !err.message.startsWith("Cannot find module 'pdf-parse'")) {
      throw err
    }
    try {
      return execFileSync('pdftotext', ['-enc', 'UTF-8', '-', '-'], { input: buffer, encoding: 'utf8' })
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('TC-DASH-03 requires pdf-parse or pdftotext')
      throw err
    }
  }
  if (typeof pdfParse === 'function') return (await pdfParse(buffer)).text

  const parser = new pdfParse.PDFParse({ data: new Uint8Array(buffer) })
  try {
    return (await parser.getText()).text
  } finally {
    await parser.destroy()
  }
}

const kpiLabels = ['รับเรื่อง', 'ปิดงาน', 'ทันกำหนด %', 'งานคงค้าง', 'เกินกำหนดคงค้าง']

async function assertSpreadsheet(buffer, expected) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const sheet = workbook.worksheets[0]
  expect([sheet.getCell('A1').text, sheet.getCell('B1').text]).toEqual(['ตัวชี้วัด', 'ค่า'])
  for (const [index, label] of kpiLabels.entries()) {
    expect(sheet.getCell(index + 2, 1).text).toBe(label)
    expect(sheet.getCell(index + 2, 2).value).toBe(expected[index])
  }

  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow(cells => cells.eachCell(cell => assertNoPersonalData(cell.text, 'Excel cell')))
  }
}

test('TC-DASH-03 ส่งออก Excel/PDF ตรงกับ KPI และไม่มีข้อมูลส่วนบุคคล', async ({ app }) => {
  const { page } = await app.staff('exec1')
  await open(page, '/dashboard')
  await id(page, 'period-select').selectOption('2026-11')
  await id(page, 'service-select').selectOption('ALL')
  const november = ['26', '7', '85.7%', '21', '1']
  await assertKpis(page, november)
  const novemberXlsx = await download(page, id(page, 'export-xlsx-btn'))
  expect(novemberXlsx.name).toMatch(/\.xlsx$/i)
  await assertSpreadsheet(novemberXlsx.body, november)
  const pdf = await download(page, id(page, 'export-pdf-btn'), '/api/dashboard/export')
  expect(pdf.name).toMatch(/\.pdf$/i)
  assertPdf(pdf.headers)
  const extracted = await pdfText(pdf.body)
  // The contract permits the ASCII machine-readable line apart from visible page text.
  const asciiKpi = 'kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1'
  const metadataLines = pdf.body.toString('utf8').split(/\r?\n/)
    .filter(line => /^%?\s*kpi received=/.test(line))
  const kpiLines = [...extracted.split(/\r?\n/), ...metadataLines]
    .map(line => line.trim().replace(/^%\s*/, ''))
    .filter(line => line.startsWith('kpi received='))
  expect([...new Set(kpiLines)]).toEqual([asciiKpi])
  assertNoPersonalData(extracted, 'PDF text')
  for (const line of metadataLines) assertNoPersonalData(line, 'PDF KPI')

  await id(page, 'period-select').selectOption('2026-12')
  const december = ['3', '0', '–', '21', '1']
  await assertKpis(page, december)
  const decemberXlsx = await download(page, id(page, 'export-xlsx-btn'))
  expect(decemberXlsx.name).toMatch(/\.xlsx$/i)
  await assertSpreadsheet(decemberXlsx.body, december)

  const auditor = await app.staff('audit1')
  await open(auditor.page, '/audit')
  await auditFilter(auditor.page, { event: 'EXPORT' })
  await auditCount(auditor.page, 3)
  for (const [index, detail] of ['xlsx 2026-12', 'pdf 2026-11', 'xlsx 2026-11'].entries()) {
    const exportRow = id(auditor.page, 'audit-row').nth(index)
    await expect(exportRow).toHaveAttribute('data-actor', 'exec1')
    await expect(id(exportRow, 'audit-role')).toHaveText('executive')
    await expect(id(exportRow, 'audit-detail')).toContainText(detail)
  }
})

test('TC-DASH-04 ขอบเวลาปิดงาน 16:29:59 / 16:30:00 / 16:30:01', async ({ app }) => {
  await app.clock('2026-12-03T16:00:00+07:00')
  const first = await app.staff('off.reg1')
  const second = await app.staff('off.reg2')
  const executive = await app.staff('exec1')
  await approve(second.api, 25)
  await approve(first.api, 23)
  for (const [closed, number, session, action, time, onTime] of [
    [1, 25, second, 'issue', '16:29:59', 1],
    [2, 26, second, 'reject', '16:30:00', 2],
    [3, 23, first, 'issue', '16:30:01', 2],
  ]) {
    const now = `2026-12-03T${time}+07:00`
    const status = action === 'issue' ? 'COMPLETED' : 'REJECTED'
    await app.clock(now)
    await json(postAction(session.api, number, action, action === 'reject' ? { reason } : undefined),
      200, { status })
    await open(session.page, casePage(number))
    await caseStatus(session.page, status)
    await iso(session.page, 'closed-at', now)
    await dashboard(executive.api, { closed, onTime })
    await open(executive.page, '/dashboard')
    await expect(id(executive.page, 'kpi-closed')).toHaveText(String(closed))
  }
  await expect(id(executive.page, 'kpi-backlog')).toHaveText('18')
  await dashboard(executive.api, { backlog: 18 })
})

test('TC-AUDIT-01 บันทึกเหตุการณ์ ฟิลด์ ตัวกรอง และ CSV', async ({ app }) => {
  const second = await app.staff('off.reg2')
  await json(postAction(second.api, 28, 'claim'), 200, { owner: 'off.reg2' })
  const first = await app.staff('off.reg1')
  await json(postAction(first.api, 20, 'return', { reason }), 200, { status: 'NEED_FIX' })
  await json(postAction(second.api, 13, 'forward'), 200, { status: 'PENDING_APPROVAL' })
  const head = await app.staff('head1')
  await approve(head.api, 13)
  await approve(second.api, 25)
  await issue(second.api, 25, 'DOC-2569-000002')
  await json(postAction(second.api, 26, 'reject', { reason }), 200, { status: 'REJECTED' })
  await json(postAction(second.api, 25, 'unmask', { reason: unmaskReason }), 200, { idNo: somying })

  const executive = await app.staff('exec1')
  expect((await executive.api.get('/api/dashboard/export?format=xlsx&period=2026-12&service=ALL')).status()).toBe(200)
  const admin = await app.staff('admin1')
  await json(admin.api.put('/api/admin/services/SV-01', { data: { fee: 25, sla: 3 } }))
  const { page } = await app.staff('audit1')
  await open(page, '/audit')
  await auditCount(page, 16)

  // The events are listed in reverse order of the requests that created them.
  const events = [
    ['STAFF_LOGIN', 'audit1', 'auditor'],
    ['ADMIN_CHANGE', 'admin1', 'admin', null, null, 'SV-01 fee 20 → 25'],
    ['STAFF_LOGIN', 'admin1', 'admin'],
    ['EXPORT', 'exec1', 'executive', null, null, 'xlsx 2026-12'],
    ['STAFF_LOGIN', 'exec1', 'executive'],
    ['UNMASK', 'off.reg2', 'officer', 25, null, unmaskReason],
    ['REJECT', 'off.reg2', 'officer', 26, 'IN_REVIEW → REJECTED', reason],
    ['ISSUE', 'off.reg2', 'officer', 25, 'APPROVED → COMPLETED', 'DOC-2569-000002'],
    ['APPROVE', 'off.reg2', 'officer', 25, 'IN_REVIEW → APPROVED'],
    ['APPROVE', 'head1', 'head', 13, 'PENDING_APPROVAL → APPROVED'],
    ['STAFF_LOGIN', 'head1', 'head'],
    ['FORWARD', 'off.reg2', 'officer', 13, 'IN_REVIEW → PENDING_APPROVAL'],
    ['RETURN', 'off.reg1', 'officer', 20, 'IN_REVIEW → NEED_FIX', reason],
    ['STAFF_LOGIN', 'off.reg1', 'officer'],
    ['CLAIM', 'off.reg2', 'officer', 28, 'SUBMITTED → IN_REVIEW'],
    ['STAFF_LOGIN', 'off.reg2', 'officer'],
  ]
  const auditRows = id(page, 'audit-row')
  const auditIds = await auditRows.evaluateAll(rows => rows.map(row => Number(row.dataset.id)))
  for (const [index, [event, actor, role, number, transition, detail]] of events.entries()) {
    if (index > 0) expect(auditIds[index - 1]).toBeGreaterThan(auditIds[index])
    const item = auditRows.nth(index)
    await expect(item).toHaveAttribute('data-event', event)
    await expect(item).toHaveAttribute('data-actor', actor)
    await expect(id(item, 'audit-event')).toHaveText(event)
    await expect(id(item, 'audit-actor')).toHaveText(actor)
    await expect(id(item, 'audit-role')).toHaveText(role)
    await expect(id(item, 'audit-case-no')).toHaveText(number ? caseNo(number) : /^(?:–)?$/)
    await expect(id(item, 'audit-transition')).toHaveText(transition || '–')
    if (detail) await expect(id(item, 'audit-detail')).toContainText(detail)
    await iso(item, 'audit-time', startTime)
  }

  await auditFilter(page, { actor: 'off.reg2' })
  await auditCount(page, 7)
  await expect(auditRows).toHaveCount(7)
  expect(await auditRows.evaluateAll(rows => rows.map(row => row.dataset.actor))).toEqual(Array(7).fill('off.reg2'))
  await auditFilter(page, { event: 'APPROVE' })
  await auditCount(page, 2)
  expect(await auditRows.evaluateAll(rows => rows.map(row => row.dataset.actor))).toEqual(['off.reg2', 'head1'])
  await auditFilter(page, { actor: 'off.reg2', event: 'APPROVE' })
  await auditCount(page, 1)
  await expect(auditRows).toHaveAttribute('data-actor', 'off.reg2')
  await expect(auditRows).toHaveAttribute('data-event', 'APPROVE')

  await auditFilter(page)
  await auditCount(page, 16)
  const csv = await download(page, id(page, 'audit-export-csv-btn'))
  expect(csv.name).toMatch(/\.csv$/i)
  const [header, ...records] = csv.body.toString('utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/)
  expect(header).toBe('time,username,role,event,caseNo,fromStatus,toStatus,detail')
  expect(records).toHaveLength(16)
  for (const [index, [event, actor, role, number, transition]] of events.entries()) {
    const [from = '', to = ''] = transition?.split(' → ') || []
    const fields = [startTime, actor, role, event, number ? caseNo(number) : '', from, to]
    // These fields contain neither commas nor quotes. CSV permits quoting any field.
    expect(records[index].split(',', 7).map(field => field.replace(/^"(.*)"$/, '$1'))).toEqual(fields)
  }

  await open(page, '/audit')
  await auditCount(page, 17)
  const exported = auditRows.first()
  await expect(exported).toHaveAttribute('data-actor', 'audit1')
  await expect(id(exported, 'audit-event')).toHaveText('EXPORT')
  await expect(id(exported, 'audit-detail')).toContainText('audit-csv')
})

test('TC-AUDIT-02 API และหน้าจอไม่อนุญาตให้แก้หรือลบ Audit', async ({ app }) => {
  const auditor = await app.staff('audit1')
  const before = await json(auditor.api.get('/api/audit'), 200, { count: 1 })
  expect(before.items).toHaveLength(1)
  expect(before.items[0]).toMatchObject({ username: 'audit1', event: 'STAFF_LOGIN' })
  const target = `/api/audit/${before.items[0].id}`
  const admin = await app.staff('admin1')

  for (const { api } of [admin, auditor]) {
    for (const [method, path] of [
      ['PUT', target], ['PATCH', target], ['DELETE', target], ['PUT', '/api/audit'], ['PATCH', '/api/audit'],
      ['DELETE', '/api/audit'], ['DELETE', '/api/audit/999999'],
    ]) {
      const data = method === 'PUT' || method === 'PATCH' ? { detail: 'x' } : undefined
      await error(api.fetch(path, { method, data }), 405, 'METHOD_NOT_ALLOWED')
    }
  }

  const after = await json(auditor.api.get('/api/audit'), 200, { count: 2 })
  expect(after.items).toHaveLength(2)
  expect(after.items[0]).toMatchObject({ username: 'admin1', role: 'admin', event: 'STAFF_LOGIN' })
  expect(after.items.slice(1)).toEqual(before.items)
  await open(auditor.page, '/audit')
  await buttons(auditor.page, { 'audit-edit': 0, 'audit-delete': 0 })
  await error(admin.api.get('/api/audit'), 403, 'FORBIDDEN')
})

test('TC-AUDIT-03 ช่วงวันที่ Audit ใช้เขตเวลาไทย', async ({ app }) => {
  const logs = [
    ['off.reg1', '2026-11-30T23:59:59+07:00'],
    ['off.reg2', '2026-12-01T00:00:00+07:00'],
    ['off.works1', '2026-12-01T23:59:59+07:00'],
    ['off.reg1', '2026-12-02T00:00:00+07:00'],
    ['audit1', '2026-12-02T09:00:00+07:00'],
  ]
  for (const [actor, time] of logs.slice(0, -1)) {
    await app.clock(time)
    await app.staff(actor)
  }
  await app.clock(logs[4][1])
  const { page, api } = await app.staff('audit1')
  await open(page, '/audit')

  const november = '2026-11-30'
  const first = '2026-12-01'
  const second = '2026-12-02'
  for (const [from, to, expected, actor = ''] of [
    [first, first, [3, 2]], [november, november, [1]], [november, first, [3, 2, 1]],
    [second, '', [5, 4]], ['', november, [1]], [first, second, [5, 4, 3, 2]],
    [first, first, [2], 'off.reg2'],
  ]) {
    await test.step(`${from || '…'} ถึง ${to || '…'} ${actor}`, async () => {
      await auditFilter(page, { from, to, actor })
      await auditCount(page, expected.length)
      const query = new URLSearchParams({ from, to, actor })
      const data = await json(api.get(`/api/audit?${query}`), 200, { count: expected.length })
      expect(data.items.map(({ username, time }) => [username, time])).toEqual(expected.map(number => logs[number - 1]))
      for (const [index, number] of expected.entries()) {
        const [username, time] = logs[number - 1]
        const result = id(page, 'audit-row').nth(index)
        await expect(result).toHaveAttribute('data-actor', username)
        await iso(result, 'audit-time', time)
      }
    })
  }
})

test('TC-RBAC-01 จำกัดการเปิดคำขอและเอกสารให้เฉพาะเจ้าของ', async ({ app }) => {
  const { page, api } = await app.citizen(somying)
  await open(page, casePage(5, 'citizen'), 404)
  await expect(id(page, 'not-found-msg')).toHaveText('ไม่พบคำขอ')
  await expect(id(page, 'case-no')).toHaveCount(0)
  await expect(id(page, 'case-status')).toHaveCount(0)
  expect((await page.content()).includes('สมชาย')).toBe(false)

  const other = await api.get(caseApi(5))
  const missing = await api.get(caseApi(999999))
  expect(other.status()).toBe(404)
  expect(missing.status()).toBe(404)
  expect(await other.json()).toEqual({ code: 'NOT_FOUND', message: 'ไม่พบคำขอ' })
  expect(await missing.text()).toBe(await other.text())
  expect((await api.get(docApi('DOC-2569-000001'))).status()).toBe(404)
  await error(api.get('/api/drafts/DR-0001'), 404, 'NOT_FOUND')
  await error(postAction(api, 30, 'cancel'), 404, 'NOT_FOUND')

  await open(page, casePage(7, 'citizen'))
  await expect(id(page, 'case-no')).toHaveText(caseNo(7))
  await json((await app.citizen()).api.get(caseApi(5)), 200, { caseNo: caseNo(5) })
})

test('TC-RBAC-02 เฉพาะหัวหน้าอนุมัติและไม่อนุมัติ SV-02', async ({ app }) => {
  const officer = await app.staff('off.reg2')
  for (const [number, status] of [[14, 'PENDING_APPROVAL'], [13, 'IN_REVIEW']]) {
    await error(postAction(officer.api, number, 'approve'), 403, 'FORBIDDEN')
    await json(officer.api.get(caseApi(number)), 200, { status })
  }
  await error(postAction(officer.api, 14, 'reject', { reason }), 403, 'FORBIDDEN')
  await json(officer.api.get(caseApi(14)), 200, { status: 'PENDING_APPROVAL' })
  for (const number of [13, 14]) {
    await open(officer.page, casePage(number))
    await buttons(officer.page, { approve: 0 })
  }

  const head = await app.staff('head1')
  await error(postAction(head.api, 25, 'approve'), 403, 'FORBIDDEN')
  await approve(head.api, 14)
  const { page } = await app.staff('audit1')
  await open(page, '/audit')
  await auditFilter(page, { event: 'APPROVE' })
  await auditCount(page, 1)
  await expect(id(page, 'audit-row')).toHaveAttribute('data-actor', 'head1')
  await expect(id(page, 'audit-case-no')).toHaveText(caseNo(14))
})

test('TC-RBAC-03 ตารางสิทธิ์หน้า API เมนู และแผนก', async ({ app }, testInfo) => {
  testInfo.setTimeout(120000)
  const roles = [
    ['anon', () => app.anon(), []],
    ['citizen', () => app.citizen(), ['my-cases']],
    ['officer', () => app.staff('off.reg1'), ['queue', 'bell']],
    ['head', () => app.staff('head1'), ['queue', 'approvals', 'bell']],
    ['executive', () => app.staff('exec1'), ['dashboard']],
    ['auditor', () => app.staff('audit1'), ['audit']],
    ['admin', () => app.staff('admin1'), ['admin-services', 'admin-holidays', 'admin-users']],
  ]
  const navNames = [...new Set(roles.flatMap(([, , nav]) => nav))]
  const pages = [
    ['/citizen', ['citizen']],
    ['/officer/queue', ['officer', 'head']],
    ['/head/approvals', ['head']],
    ['/dashboard', ['executive']],
    ['/audit', ['auditor']],
    ['/admin/services', ['admin']],
    ['/admin/holidays', ['admin']],
    ['/admin/users', ['admin']],
    ['/notifications', ['officer', 'head']],
    ['/verify/K7M2Q9XA', roles.map(([role]) => role)],
  ]
  for (const [role, login, nav] of roles) {
    await test.step(role, async () => {
      await app.reset()
      const { page, api } = await login()
      await open(page, '/')
      for (const name of navNames) await expect(id(page, `nav-${name}`)).toHaveCount(nav.includes(name) ? 1 : 0)
      for (const [path, allowed] of pages) {
        const permitted = allowed.includes(role)
        if (!permitted && role === 'anon') {
          // The final 200 alone does not prove redirection from the protected route.
          const response = await api.get(path, { maxRedirects: 0 })
          expect(response.status(), path).toBeGreaterThanOrEqual(300)
          expect(response.status(), path).toBeLessThan(400)
          await open(page, path)
          await expect(page).toHaveURL(/\/login$/)
        } else {
          await open(page, path, permitted ? 200 : 403)
          if (!permitted) await expect(id(page, 'forbidden-msg')).toHaveText('ไม่มีสิทธิ์เข้าถึงหน้านี้')
        }
      }

      const caseOwner = role === 'citizen' ? (await app.citizen(somying)).api : api
      for (const [request, allowed, success] of [
        [() => api.get('/api/officer/queue'), ['officer', 'head'], 200],
        [() => api.get('/api/notifications'), ['officer', 'head'], 200],
        [() => api.get(dashboardApi()), ['executive'], 200],
        [() => api.get('/api/audit'), ['auditor'], 200],
        [() => api.get('/api/admin/services'), ['admin'], 200],
        [() => api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } }), ['citizen'], 201],
        [() => caseOwner.get(caseApi(25)), ['citizen', 'officer', 'head'], 200],
        [() => postAction(api, 28, 'claim'), ['officer'], 200],
      ]) {
        if (allowed.includes(role)) await json(request(), success)
        else if (role === 'anon') await error(request(), 401, 'UNAUTHENTICATED')
        else await error(request(), 403, 'FORBIDDEN')
      }
    })
  }

  await app.reset()
  const works = await app.staff('off.works1')
  const registry = await app.staff('off.reg1')
  await error(postAction(works.api, 28, 'claim'), 403, 'FORBIDDEN')
  await error(postAction(registry.api, 10, 'claim'), 403, 'FORBIDDEN')
  await open(works.page, '/officer/queue')
  await caseRows(works.page, 'queue-row', [10])
})

async function saveService(page, serviceId) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/admin/services/${serviceId}`),
    id(page, `svc-save-${serviceId}`).click(),
  ])
  expect(response.status()).toBe(200)
  await expect(id(page, 'action-success')).toBeVisible()
}

async function assertAdminChanges(page, details) {
  await open(page, '/audit')
  await auditFilter(page, { event: 'ADMIN_CHANGE' })
  await auditCount(page, details.length)
  for (const [index, detail] of details.entries()) {
    const entry = id(page, 'audit-row').nth(index)
    await expect(entry).toHaveAttribute('data-actor', 'admin1')
    await expect(id(entry, 'audit-role')).toHaveText('admin')
    await expect(id(entry, 'audit-detail')).toContainText(detail)
  }
}

test('TC-RBAC-04 เปลี่ยนบริการ วันหยุด บทบาท และตรวจยอดที่ล็อก', async ({ app }) => {
  const admin = await app.staff('admin1')
  const { page } = admin
  await open(page, '/admin/holidays')
  await expect(id(page, 'holiday-row')).toHaveCount(4)
  for (const date of ['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01']) {
    await expect(row(page, 'holiday-row', 'date', date)).toHaveCount(1)
  }

  const citizen = await app.citizen()
  await newPaid(app, citizen.api, 31, 20)
  const originalDue = '2026-12-04T16:30:00+07:00'
  await json(citizen.api.get(caseApi(31)), 200, { dueAt: originalDue })

  await open(page, '/admin/services')
  for (const [service, fee] of [['SV-01', 25], ['SV-02', 600]]) {
    await id(page, `svc-fee-${service}`).fill(String(fee))
    await saveService(page, service)
  }

  await open(citizen.page, '/citizen/new/SV-01')
  await id(citizen.page, 'qty-input').fill('5')
  await expect(id(citizen.page, 'fee-total')).toHaveText('฿125')
  await id(citizen.page, 'qty-input').fill('1')
  await expect(id(citizen.page, 'fee-total')).toHaveText('฿25')
  await open(citizen.page, '/citizen/new/SV-02')
  await expect(id(citizen.page, 'fee-total')).toHaveText('฿600')
  await open(citizen.page, casePage(30, 'citizen'))
  await expect(id(citizen.page, 'case-fee')).toHaveText('฿20')

  await open(citizen.page, '/citizen/new/SV-02?draft=DR-0002')
  await expect(id(citizen.page, 'payment-amount')).toHaveText('฿500')
  const paySeed = amount => app.hook.post('/api/test/payments/PP-0001/pay', { data: { amount } })
  await error(paySeed(600), 422, 'AMOUNT_MISMATCH')
  await json(paySeed(500), 200, { status: 'PAID', caseNo: caseNo(32) })

  const holiday = '2026-12-02'
  await open(page, '/admin/holidays')
  await id(page, 'holiday-date-input').fill(holiday)
  await id(page, 'holiday-name-input').fill('วันหยุดทดสอบ')
  await id(page, 'holiday-add-btn').click()
  await expect(id(page, 'holiday-row')).toHaveCount(5)
  await json(citizen.api.get(caseApi(31)), 200, { dueAt: originalDue })
  await newPaid(app, citizen.api, 33, 25)
  await json(citizen.api.get(caseApi(33)), 200, { dueAt: '2026-12-08T16:30:00+07:00' })

  await json(admin.api.put('/api/admin/users/exec1', { data: { role: 'auditor', dept: '' } }))
  const executive = await app.staff('exec1')
  expect(executive.login).toMatchObject({ role: 'auditor', landing: '/audit' })
  await open(executive.page, '/')
  await expect(executive.page).toHaveURL(/\/audit$/)
  await open(executive.page, '/dashboard', 403)
  const changes = ['exec1 role executive → auditor', 'holiday add 2026-12-02', 'SV-02 fee 500 → 600', 'SV-01 fee 20 → 25']
  await assertAdminChanges(executive.page, changes)
  await error(admin.api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } }), 403, 'FORBIDDEN')

  await id(row(page, 'holiday-row', 'date', holiday), 'holiday-delete-btn').click()
  await expect(id(page, 'holiday-row')).toHaveCount(4)
  await expect(row(page, 'holiday-row', 'date', holiday)).toHaveCount(0)
  await assertAdminChanges(executive.page, ['holiday delete 2026-12-02', ...changes])
})

test('TC-RBAC-05 ขอบเขตการแสดงรายการและดาวน์โหลดไฟล์แนบ', async ({ app }) => {
  const registry = await app.staff('off.reg1')
  const registry2 = await app.staff('off.reg2')
  const works = await app.staff('off.works1')
  const head = await app.staff('head1')
  const somyingSession = await app.citizen(somying)
  const somchaiSession = await app.citizen()
  const oneFile = ['id-card.pdf']
  const threeFiles = ['id-card.pdf', 'plan.pdf', 'deed.pdf']
  const fileIds = new Map()

  for (const [session, number, names] of [
    [registry, 25, oneFile],
    [registry2, 12, threeFiles],
    [works, 10, threeFiles],
    [registry, 10, threeFiles],
    [works, 11, threeFiles],
    [head, 25, oneFile],
    [head, 10, threeFiles],
    [head, 12, threeFiles],
    [somyingSession, 25, oneFile],
  ]) {
    const { api } = session
    const { items } = await json(api.get(`${caseApi(number)}/files`))
    expect(items.map(({ name }) => name).sort()).toEqual([...names].sort())
    expect(new Set(items.map(item => item.fileId)).size).toBe(names.length)
    if (session === somyingSession || !fileIds.has(number)) {
      fileIds.set(number, items.map(item => item.fileId))
    }
    for (const file of items) {
      expect(file.fileId).toBeTruthy()
      const response = await api.get(`/api/files/${encodeURIComponent(file.fileId)}`)
      expect(response.status()).toBe(200)
      assertPdf(response.headers())
      const body = await response.body()
      expect(body.subarray(0, 4).toString()).toBe('%PDF')
    }
  }

  const executive = await app.staff('exec1')
  const auditor = await app.staff('audit1')
  const admin = await app.staff('admin1')
  const anon = await app.anon()
  for (const [session, number, status, code] of [
    [works, 25, 403, 'FORBIDDEN'], [works, 12, 403, 'FORBIDDEN'],
    [somchaiSession, 25, 404, 'NOT_FOUND'],
    [executive, 25, 403, 'FORBIDDEN'], [auditor, 25, 403, 'FORBIDDEN'], [admin, 25, 403, 'FORBIDDEN'],
    [anon, 25, 401, 'UNAUTHENTICATED'],
  ]) {
    await error(session.api.get(`${caseApi(number)}/files`), status, code)
    for (const fileId of fileIds.get(number)) {
      await error(session.api.get(`/api/files/${encodeURIComponent(fileId)}`), status, code)
    }
  }
  await error(registry.api.get('/api/files/F-999999'), 404, 'NOT_FOUND')

  await open(registry.page, casePage(25))
  await expect(id(registry.page, 'doc-item')).toHaveCount(1)
  const doc = row(registry.page, 'doc-item', 'name', 'id-card.pdf')
  const file = await download(registry.page, id(doc, 'doc-download-link'))
  expect(file.body.byteLength).toBeGreaterThan(0)
  await open(registry2.page, casePage(12))
  await expect(id(registry2.page, 'doc-item')).toHaveCount(3)
  await open(somyingSession.page, casePage(25, 'citizen'))
  await expect(id(somyingSession.page, 'doc-item')).toHaveCount(1)
})

test('TC-RBAC-06 ค่าขอบค่าธรรมเนียม SLA วันหยุด และการแก้บทบาทตนเอง', async ({ app }) => {
  const { page, api } = await app.staff('admin1')
  const path = '/api/admin/services/SV-01'
  const save = id(page, 'svc-save-SV-01')
  const messages = {
    INVALID_FEE: 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท',
    INVALID_SLA: 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ',
  }
  let accepted = { fee: 20, sla: 3 }
  for (const [field, value, code] of [
    ['fee', -1, 'INVALID_FEE'], ['fee', 0], ['fee', 100000], ['fee', 100001, 'INVALID_FEE'],
    ['sla', 0, 'INVALID_SLA'], ['sla', 1], ['sla', 60], ['sla', 61, 'INVALID_SLA'],
  ]) {
    await test.step(`${field} = ${value}`, async () => {
      await open(page, '/admin/services')
      const input = id(page, `svc-${field}-SV-01`)
      await expect(input).toHaveValue(String(accepted[field]))
      await input.fill(String(value))
      const submitted = { ...accepted, [field]: value }
      if (code) {
        await save.click()
        await expect(id(page, 'action-error')).toHaveText(messages[code])
        await error(api.put(path, { data: submitted }), 400, code, messages[code])
      } else {
        // The UI's PUT proves the API accepts the boundary and applies it only once.
        await saveService(page, 'SV-01')
        accepted = submitted
      }

      const services = await json(api.get('/api/admin/services'))
      expect(services.items.find(item => item.id === 'SV-01')).toMatchObject(accepted)
    })
  }

  await error(api.post('/api/admin/holidays', { data: { date: '2026-12-07', name: 'ซ้ำ' } }),
    409, 'DUPLICATE_HOLIDAY', 'มีวันหยุดนี้อยู่แล้ว')
  await open(page, '/admin/holidays')
  await expect(id(page, 'holiday-row')).toHaveCount(4)
  await json(api.post('/api/admin/holidays', { data: { date: '2026-12-05', name: 'วันเสาร์' } }), 201)
  await open(page, '/admin/holidays')
  await expect(id(page, 'holiday-row')).toHaveCount(5)
  await expect(row(page, 'holiday-row', 'date', '2026-12-05')).toHaveCount(1)
  await error(api.put('/api/admin/users/admin1', { data: { role: 'executive', dept: '' } }),
    409, 'SELF_ROLE_CHANGE')
  await json(api.get('/api/me'), 200, { role: 'admin' })

  await assertAdminChanges((await app.staff('audit1')).page, [
    'holiday add 2026-12-05', 'SV-01 sla 1 → 60', 'SV-01 sla 3 → 1',
    'SV-01 fee 0 → 100000', 'SV-01 fee 20 → 0',
  ])
})

async function loginCitizenUi(page) {
  await open(page, '/login')
  await id(page, 'thaid-id-input').fill(somchai)
  await id(page, 'thaid-submit').click()
  await id(page, 'otp-input').fill('123456')
  await id(page, 'otp-submit').click()
  await expect(page).toHaveURL(/\/citizen$/)
}

test('TC-NFR-01 Responsive 375 / 768 / 1280 และยื่นคำขอที่ 375px', async ({ app }, testInfo) => {
  testInfo.setTimeout(90000)
  const publicPage = (await app.anon()).page
  const citizen = (await app.citizen()).page
  const officer = (await app.staff('off.reg1')).page
  const head = (await app.staff('head1')).page
  const executive = (await app.staff('exec1')).page
  const auditor = (await app.staff('audit1')).page
  const admin = (await app.staff('admin1')).page
  const pages = [
    [publicPage, '/login'], [citizen, '/citizen'], [citizen, '/citizen/new/SV-03'],
    [citizen, casePage(13, 'citizen')], [officer, '/officer/queue'], [officer, casePage(20)],
    [head, '/head/approvals'], [executive, '/dashboard'], [auditor, '/audit'],
    [admin, '/admin/services'], [publicPage, '/verify/K7M2Q9XA'],
  ]
  for (const [width, height] of [[375, 812], [768, 1024], [1280, 800]]) {
    for (const [page, path] of pages) {
      await test.step(`${width}×${height} ${path}`, async () => {
        await page.setViewportSize({ width, height })
        await open(page, path)
        const widths = await page.evaluate(() => ({
          document: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
        }))
        expect.soft(widths.document, `${path} at ${width}px`).toBeLessThanOrEqual(widths.viewport)
      })
    }
  }

  const { page } = await app.anon()
  await page.setViewportSize({ width: 375, height: 812 })
  await loginCitizenUi(page)
  await id(page, 'start-service-SV-01').click()
  await id(page, 'qty-input').fill('1')
  await expect(id(page, 'fee-total')).toHaveText('฿20')
  await id(page, 'to-upload-btn').click()
  await id(page, 'upload-input-id-card').setInputFiles(pdfUpload())
  await expect(id(page, 'to-payment-btn')).toBeEnabled()
  await id(page, 'to-payment-btn').click()
  const createQr = id(page, 'create-qr-btn')
  await expect(createQr).toBeVisible()
  const bounds = await createQr.boundingBox()
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(375)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
})

async function checkLabels(page, path) {
  const unnamed = await page.locator('input:visible, select:visible, textarea:visible').evaluateAll(controls =>
    controls.filter(control => {
      const ariaLabel = control.getAttribute('aria-label')?.trim()
      const references = (control.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      const referencedText = references.some(id => {
        const label = document.getElementById(id)
        return Boolean(label?.getAttribute('aria-label')?.trim() || label?.textContent.trim())
      })
      const nativeLabel = Array.from(control.labels || []).some(label => label.textContent.trim())
      return !ariaLabel && !referencedText && !nativeLabel
    }).map(control => control.dataset.testid || control.id || control.outerHTML))
  expect.soft(unnamed, `${path} controls without labels`).toEqual([])
}

async function checkStatusText(page, path) {
  const badges = [
    ['case-status', 'status', statuses],
    ['row-status', 'status', statuses],
    ['sla-level', 'level', levels],
    ['row-sla-level', 'level', levels],
  ]
  const text = []
  for (const [testId, attribute, translations] of badges) {
    for (const locator of await id(page, testId).all()) {
      await expect.soft(locator, `${path} ${testId} visible`).toBeVisible()
      const code = await locator.evaluate((node, field) =>
        node.getAttribute(`data-${field}`) ||
          node.closest(field === 'level' ? '[data-sla-level]' : '[data-status]')
            ?.getAttribute(field === 'level' ? 'data-sla-level' : 'data-status'), attribute)
      expect.soft(Object.hasOwn(translations, code), `${path} ${testId} data-${attribute}`).toBe(true)
      const displayed = (await locator.innerText()).trim()
      expect.soft(displayed, `${path} ${testId}`).toBe(translations[code])
      text.push(displayed)
    }
  }
  return text
}

async function tabTo(page, testId) {
  const target = id(page, testId)
  await expect(target).toBeVisible()
  for (let tab = 0; tab < 60; tab++) {
    const focus = await page.evaluate(() => {
      const element = document.activeElement
      if (!element || element === document.body || element === document.documentElement) return null
      const style = getComputedStyle(element)
      return {
        name: element.dataset.testid || element.id || element.tagName,
        visibleRing: (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
          style.boxShadow !== 'none',
      }
    })
    if (focus) expect.soft(focus.visibleRing, `keyboard focus indicator on ${focus.name}`).toBe(true)
    if (await target.evaluate(element => element === document.activeElement)) {
      await expect(target).toBeFocused()
      return
    }
    await page.keyboard.press('Tab')
  }
  await expect(target, `reachable with Tab: ${testId}`).toBeFocused({ timeout: 250 })
}

test('TC-NFR-02 WCAG axe คีย์บอร์ด label และข้อความสถานะ', async ({ app }, testInfo) => {
  testInfo.setTimeout(120000)
  const publicPage = (await app.anon()).page
  const registration = (await app.citizen(mana)).page
  const citizen = (await app.citizen()).page
  const officer = (await app.staff('off.reg1')).page
  const head = (await app.staff('head1')).page
  const executive = (await app.staff('exec1')).page
  const auditor = (await app.staff('audit1')).page
  const admin = (await app.staff('admin1')).page
  const pages = [
    [publicPage, '/login'], [registration, '/register'], [citizen, '/citizen'],
    [citizen, '/citizen/new/SV-01'], [citizen, casePage(17, 'citizen')],
    [officer, '/officer/queue'], [officer, casePage(20)], [head, '/head/approvals'],
    [executive, '/dashboard'], [auditor, '/audit'], [admin, '/admin/services'],
    [officer, '/notifications'], [publicPage, '/verify/K7M2Q9XA'],
  ]
  for (const [page, path] of pages) {
    await test.step(path, async () => {
      await open(page, path)
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
      const highImpact = results.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')
      expect.soft(highImpact.map(({ id, impact, nodes }) => ({
        id, impact, targets: nodes.map(node => node.target),
      })), `${path} serious or critical axe violations`).toEqual([])
      await checkLabels(page, path)
      const original = await checkStatusText(page, path)

      await page.emulateMedia({ forcedColors: 'active' })
      try {
        expect(await checkStatusText(page, path), `${path} forced-colors text`).toEqual(original)
      } finally {
        await page.emulateMedia({ forcedColors: 'none' })
      }
    })
  }

  await test.step('ยื่นคำขอโดยใช้คีย์บอร์ด', async () => {
    const { page } = await app.anon()
    await open(page, '/login')
    await tabTo(page, 'thaid-id-input')
    await page.keyboard.type(somchai)
    await page.keyboard.press('Enter')
    await tabTo(page, 'otp-input')
    await page.keyboard.type('123456')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/citizen$/)

    await tabTo(page, 'start-service-SV-01')
    await page.keyboard.press('Enter')
    await tabTo(page, 'qty-input')
    await expect(id(page, 'qty-input')).toHaveValue('1')
    await page.keyboard.press('Control+A')
    await page.keyboard.type('1')
    await expect(id(page, 'qty-input')).toHaveValue('1')
    await tabTo(page, 'to-upload-btn')
    await page.keyboard.press('Enter')

    await tabTo(page, 'upload-input-id-card')
    // Playwright supplies the file to the focused control in place of the OS file picker.
    await id(page, 'upload-input-id-card').setInputFiles(pdfUpload())
    await expect(id(page, 'to-payment-btn')).toBeEnabled()
    await tabTo(page, 'to-payment-btn')
    await page.keyboard.press('Enter')
    await expect(id(page, 'create-qr-btn')).toBeVisible()
    await tabTo(page, 'create-qr-btn')
  })
})

test('TC-NFR-03 Health เวลาโหลด นาฬิกา และผลหลัง reset ที่ทำซ้ำได้', async ({ app, playwright }) => {
  const publicSession = await app.anon()
  expect(await json(publicSession.api.get('/api/health'))).toEqual({ status: 'ok' })
  const citizen = await app.citizen()
  const officer = await app.staff('off.reg1')
  const executive = await app.staff('exec1')
  const auditor = await app.staff('audit1')
  for (const [page, path] of [
    [publicSession.page, '/login'], [citizen.page, '/citizen'],
    [officer.page, '/officer/queue'], [executive.page, '/dashboard'], [auditor.page, '/audit'],
  ]) {
    await open(page, path)
    const start = performance.now()
    const response = await page.goto(path, { waitUntil: 'load' })
    const elapsed = performance.now() - start
    expect(response.status()).toBe(200)
    expect.soft(elapsed, `warm load of ${path}`).toBeLessThanOrEqual(3000)
  }

  async function snapshot(queueApi, executiveApi) {
    const clock = await json(app.hook.get('/api/test/clock'), 200, { now: startTime })
    const { items } = await json(queueApi.get('/api/officer/queue'))
    expect(items).toHaveLength(17)
    return {
      clock,
      queue: items.map(({ caseNo, dueAt, status, owner }) => ({ caseNo, dueAt, status, owner })),
      dashboard: await dashboard(executiveApi),
    }
  }

  const before = await snapshot(officer.api, executive.api)
  const changedTime = '2026-12-10T12:00:00+07:00'
  await app.clock(changedTime)
  await json(postAction(officer.api, 28, 'claim'), 200, { owner: 'off.reg1' })
  await newPaid(app, citizen.api, 31, 20, changedTime)

  await app.reset()
  const after = await snapshot((await app.staff('off.reg1')).api, (await app.staff('exec1')).api)
  expect(after).toEqual(before)
  await error(app.hook.put('/api/test/clock', { data: { now: '2026-12-01 09:00' } }), 400, 'INVALID_TIME')

  const withoutHooks = process.env.NO_TEST_BASE_URL
  if (withoutHooks) {
    const api = await playwright.request.newContext({ baseURL: withoutHooks })
    try {
      expect((await api.post('/api/test/reset')).status()).toBe(404)
    } finally {
      await api.dispose()
    }
  }
})

async function optionalFile(path) {
  try {
    return await readFile(path)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

test('TC-NFR-04 ตรวจเลขบัตรและเบอร์โทรใน DB ดัมพ์ และ log', async ({ app }, testInfo) => {
  const registration = await app.citizen(mana)
  const mobile = '0845678901'
  await json(registration.api.post('/api/auth/register', { data: { mobile, email: '', consent: true } }), 201)
  await open(registration.page, '/citizen')
  await expect(id(registration.page, 'citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ')

  const privateValues = [
    somchai, somying, '1909900555015', mana, '0812345678', '0823456789', '0834567890', mobile,
    '1-1017-00123-45-6', '3-1006-00987-65-9', '1-9099-00555-01-5', '5-5004-00111-22-1',
  ]
  function scan(source, content) {
    for (const [index, value] of privateValues.entries()) {
      expect.soft(content.includes(value), `${source}, seed value #${index + 1}`).toBe(false)
    }
  }

  const dbPath = resolve(process.env.DB_PATH || 'data/egov.db')
  expect((await stat(dbPath)).isFile(), 'DB_PATH must point to the SQLite database file').toBe(true)
  const dbFile = await readFile(dbPath)
  expect(dbFile.subarray(0, 16).toString()).toBe('SQLite format 3\0')
  scan('database', dbFile)
  for (const ext of ['-wal', '-journal']) {
    const content = await optionalFile(dbPath + ext)
    if (content) scan(`SQLite ${ext}`, content)
  }

  const Database = require('better-sqlite3')
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()
    expect(tables.length).toBeGreaterThan(0)
    for (const { name } of tables) {
      const query = `SELECT * FROM "${name.replaceAll('"', '""')}"`
      const values = []
      for (const record of db.prepare(query).iterate()) {
        for (const value of Object.values(record)) {
          if (value !== null) values.push(Buffer.isBuffer(value) ? value.toString('latin1') : String(value))
        }
      }
      scan(`table ${name}`, values.join('\n'))
    }
  } finally {
    db.close()
  }

  const dumpPath = process.env.DB_DUMP_PATH
  if (dumpPath) scan('database dump', await readFile(resolve(dumpPath)))

  const logPath = process.env.LOG_PATH
  if (logPath) {
    scan('server log', await readFile(resolve(logPath)))
  } else {
    const localLog = await optionalFile(resolve('server.log'))
    if (localLog) {
      scan('server.log', localLog)
    } else {
      let composeLog
      try {
        composeLog = execFileSync('docker', ['compose', 'logs', '--no-color'], {
          stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
        })
      } catch (err) {
        if (!['ENOENT', 'ETIMEDOUT'].includes(err.code) && typeof err.status !== 'number') throw err
      }
      if (composeLog) scan('Docker Compose logs', composeLog)
      else testInfo.annotations.push({ type: 'inspection', description: 'Server logs unavailable. Set LOG_PATH to inspect a file.' })
    }
  }

  const citizen = await app.citizen()
  await json(citizen.api.get(caseApi(5)), 200, { idNo: somchai })
  testInfo.annotations.push({ type: 'encryption', description: 'AES-256-GCM (documented by B01)' })
})
