'use strict';

const AUDIT_COLUMNS = ['time', 'username', 'role', 'event', 'caseNo', 'fromStatus', 'toStatus', 'detail'];
const AUDIT_FILTERS = ['actor', 'event', 'from', 'to'];

function auditFilters(query) {
  return Object.fromEntries(AUDIT_FILTERS.map((key) => [
    key, typeof query[key] === 'string' ? query[key].trim() : '',
  ]));
}

function csvCell(value) {
  let text = String(value ?? '');
  // Keep free-text cells from being interpreted as spreadsheet formulas.
  if (/^(?:\s*[=+@-]|[\t\r\n])/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function isIntegerInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

const PAGE_SCRIPT = `<script>
  async function runAction(button, action) {
    if (document.querySelector('button[data-pending]')) return;
    button.dataset.pending = '';
    button.disabled = true;
    App.clearMessages();
    try {
      await action();
    } catch {
      App.showError('เกิดข้อผิดพลาดในการเชื่อมต่อ กรุณาลองใหม่');
    } finally {
      delete button.dataset.pending;
      button.disabled = false;
    }
  }

  async function refreshSection(id) {
    const response = await fetch(location.href);
    if (!response.ok) throw new Error('Page refresh failed');
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    const section = page.getElementById(id);
    if (!section) throw new Error('Section missing');
    document.getElementById(id).replaceChildren(...section.childNodes);
  }

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (form.id === 'audit-export') {
      event.preventDefault();
      runAction(event.submitter, async () => {
        const exportUrl = new URL(form.action);
        exportUrl.search = new URLSearchParams(new FormData(form));
        const response = await fetch(exportUrl);
        if (!response.ok) {
          const { message } = await response.json();
          App.showError(message);
          return;
        }
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = 'audit.csv';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        await refreshSection('audit-results');
      });
      return;
    }
    if (!form.dataset.method) return;
    event.preventDefault();
    runAction(event.submitter, async () => {
      const method = form.dataset.method;
      const fields = Object.fromEntries(new FormData(form));
      for (const input of form.querySelectorAll('input[type="number"]')) {
        fields[input.name] = input.valueAsNumber;
      }
      const response = await App.api(method, form.action, method === 'DELETE' ? undefined : fields);
      if (!response.ok) return;
      if (form.dataset.refresh) {
        await refreshSection(form.dataset.refresh);
        if (method === 'DELETE') App.el('holiday-date-input').focus();
        else form.reset();
      }
      App.showSuccess(method === 'DELETE' ? 'ลบวันหยุดแล้ว' : 'บันทึกสำเร็จ');
    });
  });
</script>`;

module.exports = function registerAdmin(app, ctx) {
  const { db, dbm, tx, clock, audit, requireRole, apiError, render, views, C } = ctx;
  const { esc, attr, timeTag } = views;
  const auditorOnly = requireRole('auditor');
  const adminOnly = requireRole('admin');

  const updateService = db.prepare('UPDATE services SET fee = ?, fee_per_sqm = ?, sla_days = ? WHERE id = ?');
  const insertHoliday = db.prepare('INSERT INTO holidays (date, name, created_at) VALUES (?, ?, ?) ON CONFLICT(date) DO NOTHING');
  const deleteHoliday = db.prepare('DELETE FROM holidays WHERE date = ?');
  const listUsers = db.prepare('SELECT username, name, role, dept FROM users WHERE username IS NOT NULL ORDER BY username');
  const updateUser = db.prepare('UPDATE users SET role = ?, dept = ? WHERE id = ?');

  function logChange(req, detail) {
    audit.log(req, { event: 'ADMIN_CHANGE', detail });
  }

  function options(choices, current) {
    return choices.map(([value, label]) =>
      `<option${attr({ value, selected: value === current })}>${esc(label)}</option>`).join('');
  }

  function field(id, label, attributes, choices) {
    const attrs = attr({ id, 'data-testid': id, ...attributes });
    const control = choices === undefined ? `<input${attrs}>` : `<select${attrs}>${choices}</select>`;
    return `<div class="field"><label for="${id}">${esc(label)}</label>${control}</div>`;
  }

  function table(label, headings, rows) {
    return `<div class="table-wrap" role="region" aria-label="${esc(label)}" tabindex="0"><table>
      <thead><tr>${headings.map((heading) => `<th scope="col">${esc(heading)}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function auditRow(item) {
    const row = attr({
      'data-testid': 'audit-row', 'data-id': item.id, 'data-event': item.event,
      'data-actor': item.username ?? '', 'data-case-no': item.caseNo ?? '',
    });
    const cell = (key, value) => `<td data-testid="audit-${key}">${esc(value || '–')}</td>`;
    const transition = item.fromStatus || item.toStatus ? `${item.fromStatus || '–'} → ${item.toStatus || '–'}` : '–';
    return `<tr${row}>
      <td>${timeTag(item.time, 'audit-time')}</td>
      ${cell('actor', item.username)}${cell('role', item.role)}${cell('event', item.event)}
      ${cell('case-no', item.caseNo)}${cell('transition', transition)}${cell('detail', item.detail)}
    </tr>`;
  }

  app.get('/audit', auditorOnly, (req, res) => {
    const filters = auditFilters(req.query);
    const { count, items } = audit.list(filters);
    const eventOptions = [['', 'ทั้งหมด'], ...C.AUDIT_EVENTS.map((event) => [event, event])];
    const hiddenFilters = AUDIT_FILTERS.map((name) =>
      `<input${attr({ type: 'hidden', name, value: filters[name] })}>`).join('');
    render(req, res, {
      title: 'Audit Trail',
      scripts: PAGE_SCRIPT,
      body: `<h1>Audit Trail</h1>
        <form class="card" method="get" action="/audit">
          <div class="grid">
            ${field('audit-filter-actor', 'ชื่อผู้ใช้', { name: 'actor', value: filters.actor })}
            ${field('audit-filter-event', 'เหตุการณ์', { name: 'event' }, options(eventOptions, filters.event))}
            ${field('audit-filter-from', 'ตั้งแต่วันที่ (ค.ศ.)', { name: 'from', type: 'date', value: filters.from })}
            ${field('audit-filter-to', 'ถึงวันที่ (ค.ศ.)', { name: 'to', type: 'date', value: filters.to })}
          </div>
          <button class="btn" type="submit" data-testid="audit-apply-btn">ค้นหา</button>
        </form>
        <form id="audit-export" class="actions" method="get" action="/api/audit/export.csv">
          ${hiddenFilters}
          <button class="btn btn-secondary" type="submit" data-testid="audit-export-csv-btn">ส่งออก CSV</button>
        </form>
        <div id="audit-results">
          <p role="status">พบ <span data-testid="audit-count">${count}</span> รายการ</p>
          ${table('รายการ Audit Trail', ['เวลา', 'ชื่อผู้ใช้', 'บทบาท', 'เหตุการณ์', 'เลขคำขอ', 'สถานะก่อน → หลัง', 'รายละเอียด'],
            items.map(auditRow).join(''))}
        </div>`,
    });
  });

  app.get('/api/audit', auditorOnly, (req, res) => res.json(audit.list(auditFilters(req.query))));

  app.get('/api/audit/export.csv', auditorOnly, (req, res) => {
    const csv = tx(() => {
      const { items } = audit.list(auditFilters(req.query));
      const lines = [AUDIT_COLUMNS.join(','), ...items.map((item) =>
        AUDIT_COLUMNS.map((column) => csvCell(item[column])).join(','))];
      if (req.method === 'GET') audit.log(req, { event: 'EXPORT', detail: 'audit-csv' });
      return lines.join('\r\n') + '\r\n';
    });
    return res.attachment('audit.csv').type('text/csv').send(csv);
  });

  const auditPaths = ['/api/audit', '/api/audit/:id', '/audit', '/audit/:id'];
  for (const method of ['put', 'patch', 'delete']) {
    app[method](auditPaths, (req, res) => apiError(res.set('Allow', 'GET, HEAD'), 'METHOD_NOT_ALLOWED'));
  }

  app.get('/admin/services', adminOnly, (req, res) => {
    const services = dbm.listServices().map(({ id, name, fee, feePerSqm, sla }) => {
      const sv03 = id === 'SV-03';
      const feeLabel = { 'SV-01': 'ค่าธรรมเนียมต่อฉบับ (บาท)', 'SV-02': 'ค่าธรรมเนียมคงที่ (บาท)', 'SV-03': 'ค่าธรรมเนียมฐาน 1–100 ตร.ม. (บาท)' }[id];
      const feeInput = { type: 'number', min: 0, max: 100000, step: 1, required: true };
      return `<form class="card" data-testid="service-row" data-service-id="${id}"
          aria-labelledby="service-${id}" action="/api/admin/services/${id}" data-method="PUT" novalidate>
        <h2 id="service-${id}">${esc(id)} ${esc(name)}</h2>
        <div class="grid">
          ${field(`svc-fee-${id}`, feeLabel, { ...feeInput, name: sv03 ? 'feeBase' : 'fee', value: fee })}
          ${sv03 ? field('svc-fee-per-sqm-SV-03', 'ค่าธรรมเนียมต่อ ตร.ม. ที่เกิน 100 (บาท)', { ...feeInput, name: 'feePerSqm', value: feePerSqm }) : ''}
          ${field(`svc-sla-${id}`, 'SLA (วันทำการ)', { name: 'sla', type: 'number', min: 1, max: 60, step: 1, required: true, value: sla })}
        </div>
        <button class="btn" type="submit" data-testid="svc-save-${id}">บันทึก</button>
      </form>`;
    });
    render(req, res, { title: 'จัดการบริการ', body: `<h1>จัดการบริการ</h1>${services.join('')}`, scripts: PAGE_SCRIPT });
  });

  app.get('/api/admin/services', adminOnly, (req, res) => {
    const items = dbm.listServices().map(({ id, fee, feePerSqm, sla }) => ({ id, fee, feePerSqm, sla }));
    return res.json({ items });
  });

  app.put('/api/admin/services/:id', adminOnly, (req, res) => {
    const { id } = req.params;
    const { fee: flatFee, feeBase, feePerSqm: perSqm, sla } = req.body || {};
    if (!C.SERVICE_IDS.includes(id)) return apiError(res, 'NOT_FOUND');
    const sv03 = id === 'SV-03';
    const fee = sv03 ? feeBase : flatFee;
    const feePerSqm = sv03 ? perSqm : null;
    if (!isIntegerInRange(fee, 0, 100000) || (sv03 && !isIntegerInRange(feePerSqm, 0, 100000))) {
      return apiError(res, 'INVALID_FEE');
    }
    if (!isIntegerInRange(sla, 1, 60)) return apiError(res, 'INVALID_SLA');
    tx(() => {
      const previous = dbm.getService(id);
      const changes = Object.entries({ fee, feePerSqm, sla })
        .filter(([key, value]) => value !== previous[key])
        .map(([key, value]) => `${id} ${key} ${previous[key]} → ${value}`);
      if (changes.length) {
        // The catalogue controls future quotes. Draft and payment amounts are stored separately.
        updateService.run(fee, feePerSqm, sla, id);
        logChange(req, changes.join(' · '));
      }
    });
    return res.json({ ok: true });
  });

  app.get('/admin/holidays', adminOnly, (req, res) => {
    const rows = dbm.listHolidays().map(({ date, name }) => `<tr data-testid="holiday-row" data-date="${esc(date)}">
      <td>${timeTag(`${date}T00:00:00+07:00`, null, { dateOnly: true })}</td><td>${esc(name)}</td>
      <td><form action="/api/admin/holidays/${esc(date)}" data-method="DELETE" data-refresh="holiday-list">
        <button class="btn btn-danger" type="submit" data-testid="holiday-delete-btn" data-date="${esc(date)}"
          aria-label="ลบ ${esc(name)}">ลบ</button>
      </form></td>
    </tr>`).join('');
    render(req, res, {
      title: 'จัดการวันหยุด',
      scripts: PAGE_SCRIPT,
      body: `<h1>จัดการวันหยุด</h1>
        <form class="card" method="post" action="/api/admin/holidays" data-method="POST" data-refresh="holiday-list">
          <div class="grid">
            ${field('holiday-date-input', 'วันที่ (ค.ศ.)', { name: 'date', type: 'date', required: true })}
            ${field('holiday-name-input', 'ชื่อวันหยุด', { name: 'name', required: true })}
          </div>
          <button class="btn" type="submit" data-testid="holiday-add-btn">เพิ่มวันหยุด</button>
        </form>
        <div id="holiday-list">${table('รายการวันหยุด', ['วันที่', 'ชื่อวันหยุด', 'จัดการ'], rows)}</div>`,
    });
  });

  app.get('/api/admin/holidays', adminOnly, (req, res) => res.json({ items: dbm.listHolidays() }));

  app.post('/api/admin/holidays', adminOnly, (req, res) => {
    const { date, name } = req.body || {};
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        clock.parseStrictISO(`${date}T00:00:00+07:00`) === null ||
        typeof name !== 'string' || !name.trim()) return apiError(res, 'BAD_REQUEST');
    const added = tx(() => {
      if (!insertHoliday.run(date, name.trim(), clock.nowISO()).changes) return false;
      logChange(req, `holiday add ${date}`);
      return true;
    });
    return added ? res.status(201).json({ ok: true }) : apiError(res, 'DUPLICATE_HOLIDAY');
  });

  app.delete('/api/admin/holidays/:date', adminOnly, (req, res) => {
    const { date } = req.params;
    const removed = tx(() => {
      if (!deleteHoliday.run(date).changes) return false;
      logChange(req, `holiday delete ${date}`);
      return true;
    });
    return removed ? res.json({ ok: true }) : apiError(res, 'NOT_FOUND');
  });

  app.get('/admin/users', adminOnly, (req, res) => {
    const roles = C.ROLES.map((role) => [role, C.ROLE_TH[role]]);
    const depts = [['', 'ไม่มีแผนก'], ...C.DEPTS.map((dept) => [dept, C.DEPT_TH[dept]])];
    const rows = listUsers.all().map(({ username, name, role, dept }, index) => {
      const own = username === req.user.username;
      return `<form class="card" data-testid="user-row" data-username="${esc(username)}"
          aria-labelledby="username-${index}" action="/api/admin/users/${esc(encodeURIComponent(username))}" data-method="PUT">
        <h2 id="username-${index}">${esc(name)} (${esc(username)})</h2>
        <div class="grid">
          ${field(`user-role-${index}`, 'บทบาท', { name: 'role', 'data-testid': 'user-role-select', disabled: own }, options(roles, role))}
          ${field(`user-dept-${index}`, 'แผนก', { name: 'dept', 'data-testid': 'user-dept-select', disabled: own }, options(depts, dept || ''))}
        </div>
        ${own ? '<p>บัญชีของคุณ</p>' : ''}
        <button class="btn" type="submit" data-testid="user-save-btn"${own ? ' disabled' : ''}>บันทึก</button>
      </form>`;
    });
    render(req, res, { title: 'จัดการผู้ใช้', body: `<h1>จัดการผู้ใช้</h1>${rows.join('')}`, scripts: PAGE_SCRIPT });
  });

  app.get('/api/admin/users', adminOnly, (req, res) => res.json({ items: listUsers.all() }));

  app.put('/api/admin/users/:username', adminOnly, (req, res) => {
    const { username } = req.params;
    if (username === req.user.username) return apiError(res, 'SELF_ROLE_CHANGE');
    const { role, dept } = req.body || {};
    const nextDept = dept == null || dept === '' ? null : dept;
    if (!C.ROLES.includes(role) || (nextDept !== null && !C.DEPTS.includes(nextDept)) ||
        (role === 'officer' && nextDept === null)) return apiError(res, 'BAD_REQUEST');
    const found = tx(() => {
      const user = dbm.getUserByUsername(username);
      if (!user) return false;
      const changes = [];
      if (user.role !== role) changes.push(`${username} role ${user.role} → ${role}`);
      if (user.dept !== nextDept) changes.push(`${username} dept ${user.dept || '–'} → ${nextDept || '–'}`);
      if (changes.length) {
        updateUser.run(role, nextDept, user.id);
        logChange(req, changes.join(' · '));
      }
      return true;
    });
    return found ? res.json({ ok: true }) : apiError(res, 'NOT_FOUND');
  });
};
