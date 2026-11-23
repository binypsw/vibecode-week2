#!/usr/bin/env node
// สรุปผล pw-report/*.json เทียบกับตาราง BUGS.md §2 (TC ที่ต้องล้ม / อาจล้มด้วย)
//   node tests/bug-matrix-summary.js                 # ทุกไฟล์ normal-*.json และ bug-*.json
//   node tests/bug-matrix-summary.js pw-report/bug-B03.json
const fs = require('node:fs')
const path = require('node:path')

const EXPECT = {
  B01: { must: ['TC-FEE-01'], may: [] },
  B02: { must: ['TC-UPLOAD-01'], may: [] },
  B03: { must: ['TC-SLA-01', 'TC-SLA-02'], may: ['TC-SLA-03', 'TC-RBAC-04'] },
  B04: { must: ['TC-SLA-02'], may: [] },
  B05: { must: ['TC-PAY-01'], may: [] },
  B06: { must: ['TC-RBAC-01'], may: [] },
  B07: { must: ['TC-RBAC-02'], may: ['TC-WORKFLOW-01'] },
  B08: { must: ['TC-QUEUE-02'], may: [] },
  B09: { must: ['TC-PDPA-02'], may: [] },
  B10: { must: ['TC-DASH-02'], may: ['TC-DASH-01', 'TC-DASH-03'] },
  B11: { must: ['TC-PDPA-03', 'TC-AUDIT-01'], may: [] },
  B12: { must: ['TC-WORKFLOW-04'], may: [] },
}

function expected(mode) {
  const must = new Set(); const may = new Set()
  for (const code of mode ? mode.split(',') : []) {
    const e = EXPECT[code]
    if (!e) throw new Error(`unknown bug ${code}`)
    e.must.forEach(t => must.add(t)); e.may.forEach(t => may.add(t))
  }
  return { must, may }
}

function collect(suite, out) {
  for (const spec of suite.specs || []) {
    const tc = (spec.title.match(/TC-[A-Z]+-\d+/) || [spec.title])[0]
    for (const t of spec.tests || []) {
      const last = t.results[t.results.length - 1] || {}
      const err = (last.errors && last.errors[0]) || last.error || {}
      const msg = String(err.message || '').replace(/\u001b\[[0-9;]*m/g, '')
      out.push({ tc, status: last.status, ok: t.status === 'expected', error: msg })
    }
  }
  for (const s of suite.suites || []) collect(s, out)
  return out
}

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync('pw-report').filter(f => /^(normal|bug)-.*\.json$/.test(f)).sort().map(f => path.join('pw-report', f))

const rows = []
for (const file of files) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  const tests = []
  for (const s of report.suites) collect(s, tests)
  const name = path.basename(file, '.json')
  const mode = name.startsWith('bug-') ? name.slice(4).replace(/_/g, ',') : ''
  const { must, may } = expected(mode)
  const failed = tests.filter(t => !t.ok)
  const failedSet = new Set(failed.map(t => t.tc))
  const missing = [...must].filter(t => !failedSet.has(t))
  const extra = failed.map(t => t.tc).filter(t => !must.has(t) && !may.has(t))
  const sideEffects = failed.map(t => t.tc).filter(t => may.has(t))
  const passed = tests.length - failed.length
  const verdict = missing.length === 0 && extra.length === 0 ? 'OK' : 'MISMATCH'
  rows.push({ name, mode: mode || '(none)', total: tests.length, passed, failed, missing, extra, sideEffects, verdict })
}

for (const r of rows) {
  console.log(`\n## ${r.name}  BUG_MODE=${r.mode}  →  ${r.passed}/${r.total} passed · ${r.failed.length} failed · ${r.verdict}`)
  if (r.missing.length) console.log(`   should fail but passed: ${r.missing.join(', ')}`)
  if (r.extra.length) console.log(`   failed outside the expected list: ${r.extra.join(', ')}`)
  if (r.sideEffects.length) console.log(`   allowed side effects that failed: ${r.sideEffects.join(', ')}`)
  for (const f of r.failed) {
    const lines = f.error.split('\n').map(l => l.trim()).filter(Boolean)
    const first = lines[0] || ''
    const detail = lines.filter(l => /^(Locator|Expected|Received|[-+] +"|[-+] +\S)/.test(l) && !/^[-+] +(Expected|Received) +[-+] \d+$/.test(l))
    const head = [first, ...detail.slice(0, 4)].join(' | ').slice(0, 400)
    console.log(`   - ${f.tc} [${f.status}] ${head}`)
  }
}
console.log('\n| run | BUG_MODE | passed | failed TCs | should fail but passed | unexpected | result |')
console.log('|---|---|---|---|---|---|---|')
for (const r of rows) {
  console.log(`| ${r.name} | ${r.mode} | ${r.passed}/${r.total} | ${r.failed.map(f => f.tc).join(' · ') || '–'} | ${r.missing.join(' · ') || '–'} | ${r.extra.join(' · ') || '–'} | ${r.verdict} |`)
}
