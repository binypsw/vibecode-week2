'use strict';
// โครงหน้าเว็บกลาง + header ตาม CONTRACT 2.1 + ตัวช่วยแสดงผล (A-04 · A-51 · CONTRACT 0.2–0.4)
//
//   const L = require('../views/layout');            (หรือ ctx.views)
//   L.render(req, res, { title, body, status?, error?, success?, head?, scripts? })
//   L.forbidden(req, res)      → 403 + forbidden-msg "ไม่มีสิทธิ์เข้าถึงหน้านี้"
//   L.notFound(req, res)       → 404 + not-found-msg "ไม่พบคำขอ"
//   ตัวช่วย: esc, attr, money(1010)→"฿1,010", dateTh(iso)→"4 ธ.ค. 2569 16:30", dateOnlyTh("2027-02-02")→"2 ก.พ. 2570",
//            timeTag(iso, testid, {text, dateOnly, tag}) → <time data-testid data-iso>…</time>,
//            statusBadge(status, testid='case-status'), levelBadge(level, testid='sla-level'),
//            serviceLabel('SV-01') → "SV-01 ขอหนังสือรับรอง"
//
// ข้อตกลงหน้า:
// - action-error (role=alert) และ action-success (role=status) มีอยู่แล้วใน layout "ที่เดียว" ห้ามหน้าอื่น render ซ้ำ
//   ฝั่งเซิร์ฟเวอร์: ส่ง { error, success } ให้ render() · ฝั่ง client: App.showError(msg) / App.showSuccess(msg)
// - client: App.api(method, url, body) → {ok,status,data} (error แสดงที่ action-error อัตโนมัติ ยกเว้นส่ง {silent:true})
//           App.fmtThai(iso) · App.money(n) · App.reload()
// - ตาราง: ห่อด้วย <div class="table-wrap"> เพื่อไม่ให้หน้าเลื่อนแนวนอนที่ 375 px (NFR-01)
// - ทุกช่องกรอกต้องมี <label for> (NFR-03) · ปุ่มที่ "ต้องไม่มี" ห้าม render · "ใช้ไม่ได้" ใช้ disabled

const clock = require('../lib/clock');
const { db } = require('../db');
const { ROLE_TH, STATUS_TH, LEVEL_TH, SERVICES } = require('../db/constants');

const APP_NAME = 'e-Service เทศบาลนครก็อตแทม';

// ---------- ตัวช่วยแสดงผล ----------
function esc(v) {
  if (v == null) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** แปลง object → แอตทริบิวต์ HTML (ข้ามค่า null/undefined/false · true = แอตทริบิวต์เปล่า) */
function attr(obj) {
  return Object.entries(obj || {})
    .filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`))
    .join('');
}
function money(n) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '–';
  return '฿' + Math.round(Number(n)).toLocaleString('en-US');
}
const dateTh = (iso) => clock.fmtThai(iso);
const dateOnlyTh = (d) => clock.fmtThaiDate(d);
function timeTag(iso, testid, opts = {}) {
  if (!iso) return `<span${attr({ 'data-testid': testid })}>${esc(opts.empty || '–')}</span>`;
  const tag = opts.tag || 'time';
  const text = opts.text != null ? opts.text : opts.dateOnly ? dateOnlyTh(iso) : dateTh(iso);
  const dataIso = opts.dataIso || iso;
  const extra = tag === 'time' ? { datetime: dataIso } : {};
  return `<${tag}${attr({ 'data-testid': testid, 'data-iso': dataIso, ...extra, class: opts.class })}>${esc(text)}</${tag}>`;
}
function statusBadge(status, testid = 'case-status', extra = {}) {
  return `<span${attr({ 'data-testid': testid, 'data-status': status, class: `badge st-${String(status || '').toLowerCase()}`, ...extra })}>${esc(STATUS_TH[status] || status)}</span>`;
}
function levelBadge(level, testid = 'sla-level', extra = {}) {
  return `<span${attr({ 'data-testid': testid, 'data-level': level, class: `badge lv-${level}`, ...extra })}>${esc(LEVEL_TH[level] || level)}</span>`;
}
function serviceName(id) {
  const r = db.prepare('SELECT name FROM services WHERE id = ?').get(id);
  return r ? r.name : (SERVICES[id] && SERVICES[id].name) || id;
}
function serviceLabel(id) {
  return `${id} ${serviceName(id)}`;
}

// ---------- header ----------
const NAV = {
  citizen: [['nav-my-cases', '/citizen', 'คำขอของฉัน']],
  officer: [['nav-queue', '/officer/queue', 'คิวงาน']],
  head: [['nav-queue', '/officer/queue', 'คิวงาน'], ['nav-approvals', '/head/approvals', 'รออนุมัติ']],
  executive: [['nav-dashboard', '/dashboard', 'Dashboard']],
  auditor: [['nav-audit', '/audit', 'Audit Trail']],
  admin: [
    ['nav-admin-services', '/admin/services', 'บริการ'],
    ['nav-admin-holidays', '/admin/holidays', 'วันหยุด'],
    ['nav-admin-users', '/admin/users', 'ผู้ใช้'],
  ],
};

const qBell = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE username = ?');

function header(req) {
  const u = req && req.user;
  if (!u) {
    return `<header class="app-header"><div class="brand"><a href="/">${esc(APP_NAME)}</a></div></header>`;
  }
  const path = req.path || '';
  const showNav = !(u.role === 'citizen' && !u.registered);
  const links = showNav
    ? (NAV[u.role] || []).map(([tid, href, text]) => {
        const cur = path === href || path.startsWith(href + '/');
        return `<a${attr({ 'data-testid': tid, href, 'aria-current': cur ? 'page' : null })}>${esc(text)}</a>`;
      })
    : [];
  if (showNav && (u.role === 'officer' || u.role === 'head')) {
    const n = qBell.get(u.username).n;
    links.push(`<a data-testid="nav-bell" href="/notifications" class="bell"><span aria-hidden="true">🔔</span> แจ้งเตือน <span data-testid="bell-count" class="count">${n}</span></a>`);
  }
  return `<header data-testid="app-header" class="app-header">
  <div class="brand"><a href="/">${esc(APP_NAME)}</a></div>
  ${links.length ? `<nav class="main-nav" aria-label="เมนูหลัก">${links.join('')}</nav>` : ''}
  <div class="who">
    <span data-testid="user-name" class="user-name">${esc(u.name)}</span>
    <span${attr({ 'data-testid': 'user-role', 'data-role': u.role, 'data-dept': u.role === 'officer' ? u.dept : null, class: 'user-role' })}>${esc(ROLE_TH[u.role] || u.role)}</span>
    <form method="post" action="/logout" class="logout-form"><button type="submit" data-testid="logout-btn" class="btn btn-ghost">ออกจากระบบ</button></form>
  </div>
</header>`;
}

// ---------- CSS / JS กลาง ----------
const CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:"Sarabun","Noto Sans Thai","Leelawadee UI","Tahoma",system-ui,sans-serif;font-size:16px;line-height:1.55;color:#1b1b1b;background:#f5f6f8;overflow-wrap:anywhere}
a{color:#0b4f9c}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #b35c00;outline-offset:2px}
.skip-link{position:absolute;left:-9999px;top:0;background:#fff;color:#0b4f9c;padding:.5rem 1rem;z-index:100}
.skip-link:focus{left:.5rem;top:.5rem}
.app-header{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;padding:.6rem 1rem;background:#0b3d6e;color:#fff}
.app-header a{color:#fff}
.app-header .brand a{font-weight:700;text-decoration:none}
.main-nav{display:flex;flex-wrap:wrap;gap:.25rem .75rem;flex:1 1 auto}
.main-nav a{padding:.25rem .4rem;border-radius:4px}
.main-nav a[aria-current=page]{background:#fff;color:#0b3d6e;text-decoration:none}
.bell .count{display:inline-block;min-width:1.5em;padding:0 .35em;border-radius:1em;background:#fff;color:#0b3d6e;font-weight:700;text-align:center}
.who{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .6rem;margin-left:auto}
.user-role{font-size:.85rem;padding:.05rem .5rem;border:1px solid #fff;border-radius:1em}
.logout-form{margin:0}
main{max-width:1200px;margin:0 auto;padding:1rem}
h1{font-size:1.5rem;margin:.5rem 0 1rem}
h2{font-size:1.2rem;margin:1.25rem 0 .5rem}
.card{background:#fff;border:1px solid #d5d9e0;border-radius:8px;padding:1rem;margin:0 0 1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:.75rem}
.btn{display:inline-block;font:inherit;padding:.45rem 1rem;border-radius:6px;border:1px solid #0b4f9c;background:#0b4f9c;color:#fff;cursor:pointer;text-decoration:none;min-height:44px}
.btn:hover{background:#093f7c}
.btn-secondary{background:#fff;color:#0b4f9c}
.btn-secondary:hover{background:#e8f0fb}
.btn-danger{background:#a4161a;border-color:#a4161a}
.btn-danger:hover{background:#85120f}
.btn-ghost{background:transparent;border-color:#fff;color:#fff;min-height:36px;padding:.25rem .75rem}
.btn[disabled],button[disabled]{background:#c9ced6;border-color:#c9ced6;color:#3d4450;cursor:not-allowed}
label{display:block;font-weight:600;margin:.5rem 0 .25rem}
input[type=text],input[type=number],input[type=tel],input[type=email],input[type=password],input[type=date],input:not([type]),select,textarea{font:inherit;width:100%;max-width:28rem;padding:.45rem .6rem;border:1px solid #6b7280;border-radius:6px;background:#fff;color:#1b1b1b}
input[readonly]{background:#eef0f3}
.check{display:flex;gap:.5rem;align-items:flex-start;font-weight:400}
.check input{margin-top:.35rem}
.field{margin-bottom:.75rem}
.actions{display:flex;flex-wrap:wrap;gap:.5rem;margin:.75rem 0}
.alert{padding:.6rem .9rem;border-radius:6px;margin:0 0 1rem;border:1px solid}
.alert[hidden]{display:none}
.alert-error,.error{color:#8a1116}
.alert-error{background:#fdecee;border-color:#e4a0a6}
.alert-success{background:#e7f5ec;border-color:#97cfa9;color:#145c2c}
.error{font-weight:600}
.muted{color:#4b5563}
.table-wrap{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;background:#fff}
th,td{padding:.45rem .6rem;border-bottom:1px solid #d5d9e0;text-align:left;vertical-align:top}
th{background:#eef1f6;font-weight:600;white-space:nowrap}
.badge{display:inline-block;padding:.05rem .55rem;border-radius:1em;border:1px solid;font-size:.9rem;font-weight:600;white-space:nowrap}
.st-draft,.st-pending_payment{background:#eef0f3;color:#30363d;border-color:#9aa1ab}
.st-submitted{background:#e8f0fb;color:#0b3d6e;border-color:#8fb0d9}
.st-in_review{background:#e6f1ff;color:#08427a;border-color:#7fa8d6}
.st-need_fix{background:#fff4ce;color:#5c4300;border-color:#d8b24a}
.st-pending_approval{background:#f1eafd;color:#4b2a85;border-color:#b49ae0}
.st-approved,.st-completed{background:#e7f5ec;color:#145c2c;border-color:#8dc8a0}
.st-rejected,.st-cancelled{background:#fdecee;color:#8a1116;border-color:#e4a0a6}
.lv-normal{background:#e7f5ec;color:#145c2c;border-color:#8dc8a0}
.lv-near{background:#fff4ce;color:#5c4300;border-color:#d8b24a}
.lv-overdue{background:#fdecee;color:#8a1116;border-color:#e4a0a6}
.lv-paused{background:#eef0f3;color:#30363d;border-color:#9aa1ab}
.lv-closed{background:#ececec;color:#30363d;border-color:#9aa1ab}
dl.kv{display:grid;grid-template-columns:minmax(8rem,max-content) 1fr;gap:.35rem 1rem;margin:0}
dl.kv dt{font-weight:600;color:#374151}
dl.kv dd{margin:0}
.timeline{list-style:none;padding:0;margin:0}
.timeline li{padding:.35rem 0;border-bottom:1px dashed #d5d9e0}
footer.app-footer{max-width:1200px;margin:1.5rem auto;padding:0 1rem;color:#4b5563;font-size:.85rem}
@media (max-width:600px){main{padding:.75rem}dl.kv{grid-template-columns:1fr}.who{margin-left:0}}
`;

const JS = `
(function(){
  var M=${JSON.stringify(clock.TH_MONTHS)};
  function pad(n){return (n<10?'0':'')+n}
  function parts(iso){var d=new Date(Date.parse(iso)+7*3600000);return{y:d.getUTCFullYear(),m:d.getUTCMonth()+1,d:d.getUTCDate(),hh:d.getUTCHours(),mm:d.getUTCMinutes()}}
  var App={
    fmtThai:function(iso){if(!iso)return'';var p=parts(iso);return p.d+' '+M[p.m-1]+' '+(p.y+543)+' '+pad(p.hh)+':'+pad(p.mm)},
    fmtThaiDate:function(iso){if(!iso)return'';var p=/^\\d{4}-\\d{2}-\\d{2}$/.test(iso)?parts(iso+'T00:00:00+07:00'):parts(iso);return p.d+' '+M[p.m-1]+' '+(p.y+543)},
    money:function(n){if(n===null||n===undefined||n===''||isNaN(Number(n)))return'–';return'฿'+Math.round(Number(n)).toLocaleString('en-US')},
    el:function(id){return document.querySelector('[data-testid="'+id+'"]')},
    clearMessages:function(){['action-error','action-success'].forEach(function(t){var e=App.el(t);if(e){e.textContent='';e.hidden=true}})},
    showError:function(msg){var s=App.el('action-success');if(s){s.hidden=true;s.textContent=''}var e=App.el('action-error');if(e){e.textContent=msg||'';e.hidden=!msg}},
    showSuccess:function(msg){var e=App.el('action-error');if(e){e.hidden=true;e.textContent=''}var s=App.el('action-success');if(s){s.textContent=msg||'';s.hidden=!msg}},
    api:function(method,url,body,opts){
      opts=opts||{};var init={method:method,headers:{'Accept':'application/json'},credentials:'same-origin'};
      if(body instanceof FormData){init.body=body}else if(body!==undefined&&body!==null){init.headers['Content-Type']='application/json';init.body=JSON.stringify(body)}
      return fetch(url,init).then(function(r){
        var ct=r.headers.get('content-type')||'';
        var p=ct.indexOf('application/json')>=0?r.json().catch(function(){return{}}):Promise.resolve({});
        return p.then(function(data){
          if(!r.ok&&!opts.silent){App.showError((data&&data.message)||('HTTP '+r.status))}
          if(r.status===401&&!opts.silent&&!opts.noRedirect){setTimeout(function(){location.href='/login'},50)}
          return{ok:r.ok,status:r.status,data:data}
        })
      })
    },
    reload:function(){location.reload()}
  };
  window.App=App;
})();
`;

// ---------- หน้า ----------
function page(req, opts = {}) {
  const title = opts.title ? `${opts.title} · ${APP_NAME}` : APP_NAME;
  const error = opts.error || '';
  const success = opts.success || '';
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
${opts.head || ''}
</head>
<body>
<a class="skip-link" href="#main">ข้ามไปเนื้อหาหลัก</a>
${header(req)}
<main id="main" tabindex="-1">
<div data-testid="action-error" role="alert" class="alert alert-error"${error ? '' : ' hidden'}>${esc(error)}</div>
<div data-testid="action-success" role="status" class="alert alert-success"${success ? '' : ' hidden'}>${esc(success)}</div>
${opts.body || ''}
</main>
<footer class="app-footer">ระบบสาธิต · หน่วยงานสมมติ · ThaiD / PromptPay / ลายเซ็นดิจิทัล เป็นตัวจำลอง</footer>
<script>${JS}</script>
${opts.scripts || ''}
</body>
</html>`;
}

function render(req, res, opts = {}) {
  res.status(opts.status || 200).type('html').send(page(req, opts));
}
function forbidden(req, res) {
  render(req, res, { status: 403, title: 'ไม่มีสิทธิ์', body: '<h1 data-testid="forbidden-msg">ไม่มีสิทธิ์เข้าถึงหน้านี้</h1>' });
}
function notFound(req, res, msg = 'ไม่พบคำขอ') {
  render(req, res, { status: 404, title: msg, body: `<h1 data-testid="not-found-msg">${esc(msg)}</h1>` });
}

module.exports = {
  APP_NAME, esc, attr, money, dateTh, dateOnlyTh, timeTag, statusBadge, levelBadge, serviceName, serviceLabel,
  header, page, render, forbidden, notFound, CSS, JS,
};
