'use strict';

const sla = require('../lib/sla');

module.exports = function registerNotifications(app, ctx) {
  const { db, clock, hooks, requireRole, render, views, C } = ctx;
  const openStatuses = C.OPEN_STATUSES.map(() => '?').join(', ');
  const openCases = db.prepare(`
    SELECT case_no, status, due_at, owner, dept, issuer
    FROM cases WHERE status IN (${openStatuses})
  `);
  const insertNotifications = db.prepare(`
    INSERT INTO notifications (username, case_no, level, text, created_at)
    SELECT u.username, @caseNo, @level, @text, @createdAt
    FROM users u
    WHERE u.username IS NOT NULL
      AND (
        u.username = @assignee
        OR (u.role = 'officer' AND u.dept = @queueDept)
        OR (u.role = 'head' AND @notifyHead = 1)
      )
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.username = u.username AND n.case_no = @caseNo AND n.level = @level
      )
  `);

  hooks.onRequest('sla-notifications', () => {
    const createdAt = clock.nowISO();
    const holidays = sla.holidays();

    for (const row of openCases.all(...C.OPEN_STATUSES)) {
      const level = sla.slaLevel(row, createdAt, holidays);
      if (level !== 'near' && level !== 'overdue') continue;

      const pendingApproval = row.status === 'PENDING_APPROVAL';
      const approved = row.status === 'APPROVED';
      const assignee = pendingApproval ? null : approved ? row.issuer : row.owner;
      const queueDept = pendingApproval || approved || assignee ? null : row.dept;
      insertNotifications.run({
        assignee,
        queueDept,
        notifyHead: Number(pendingApproval || level === 'overdue'),
        caseNo: row.case_no,
        level,
        text: `คำขอ ${row.case_no} ${sla.levelText(level)}`,
        createdAt,
      });
    }
  }, 20);

  const listNotifications = db.prepare(`
    SELECT id, case_no AS caseNo, level, text, created_at AS createdAt
    FROM notifications WHERE username = ?
    ORDER BY created_at DESC, id DESC
  `);
  const canView = requireRole('officer', 'head');

  app.get('/api/notifications', canView, (req, res) => {
    res.json({ items: listNotifications.all(req.user.username) });
  });

  app.get('/notifications', canView, (req, res) => {
    const items = listNotifications.all(req.user.username);
    const { attr, esc } = views;
    const rows = items.map((item) => {
      const attrs = attr({ 'data-case-no': item.caseNo, 'data-level': item.level });
      return `<li data-testid="noti-item"${attrs}>${esc(item.text)}</li>`;
    });
    const content = rows.length
      ? `<ul>${rows.join('')}</ul>`
      : '<p data-testid="noti-empty">ไม่มีแจ้งเตือน</p>';
    render(req, res, { title: 'แจ้งเตือน', body: `<h1>แจ้งเตือน</h1><div class="card">${content}</div>` });
  });
};
