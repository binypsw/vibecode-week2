'use strict';
// B04 · ล็อกอินประชาชน (ThaiD จำลอง + OTP) / เจ้าหน้าที่ (SSO จำลอง) / ลงทะเบียนครั้งแรก
//   REQUIREMENTS FR-01..03 · BR-01..03 · DECISIONS 2 · CONTRACT 1, 2.2, 2.3, 5, 6.1
//
// หน้า:  GET /login · GET /register
// API:   POST /api/auth/thaid/start · POST /api/auth/thaid/verify · POST /api/auth/register
//        POST /api/auth/staff/login · POST /api/auth/logout · GET /api/me
//
// กฎ:
//   BR-01  เลขบัตร = ตัวเลข 13 หลักพอดี + checksum (ctx.crypto.isValidThaiId) · ผิดทุกกรณี → 400 INVALID_ID
//   BR-02  OTP = 123456 · ผิดติดกัน 3 ครั้ง → ล็อกเลขบัตรนั้น 15 นาทีนับจากครั้งที่ 3 (เวลาจาก ctx.clock)
//          ล็อกอยู่ (now < lockedUntil) → 423 LOCKED แม้ OTP ถูก · now ≥ lockedUntil → ปลดล็อก ตัวนับเริ่มที่ 0
//          OTP ถูก → ตัวนับเป็น 0 · state เก็บใน otp_state คีย์ blindIndex(เลขบัตร) (ไม่เก็บเลขบัตร plaintext)
//   BR-03  ลงทะเบียน: ชื่อจาก ThaiD (readOnly) · เบอร์ /^0\d{9}$/ บังคับ · อีเมลไม่บังคับ · consent บังคับ
//   FR-03  เจ้าหน้าที่ username + รหัสผ่าน → หน้าตั้งต้นตามบทบาท · บันทึก Audit STAFF_LOGIN

const TEST_OTP = '123456';
const MAX_FAILS = 3;
const LOCK_MINUTES = 15;
const MOBILE_RE = /^0\d{9}$/;
const THAID_DEFAULT_NAME = 'ผู้ใช้ ThaiD (จำลอง)';

module.exports = function registerAuth(app, ctx) {
  const { db, clock, crypto: pii, auth, apiError, views, tx, audit, C } = ctx;
  const { esc } = views;

  // ---------- otp_state ----------
  const qOtp = db.prepare('SELECT fail_count, locked_until FROM otp_state WHERE id_hash = ?');
  const upOtp = db.prepare(`INSERT INTO otp_state (id_hash, fail_count, locked_until, updated_at)
    VALUES (@h, @n, @until, @now)
    ON CONFLICT(id_hash) DO UPDATE SET fail_count = excluded.fail_count, locked_until = excluded.locked_until, updated_at = excluded.updated_at`);

  /** เวลาปลดล็อกถ้ายังล็อกอยู่ ณ now · ไม่งั้น null */
  function activeLock(st, now) {
    if (st && st.locked_until && clock.cmp(now, st.locked_until) < 0) return st.locked_until;
    return null;
  }

  /**
   * ตรวจ OTP แบบ atomic → { ok:true } | { locked: iso } | { attemptsLeft: n }
   */
  function checkOtp(idNo, otp) {
    return tx(() => {
      const h = pii.blindIndex(idNo);
      const now = clock.nowISO();
      let st = qOtp.get(h);
      const lock = activeLock(st, now);
      if (lock) return { locked: lock };
      if (st && st.locked_until) {
        // ล็อกหมดอายุแล้ว → ปลดล็อก ตัวนับเริ่มที่ 0
        upOtp.run({ h, n: 0, until: null, now });
        st = { fail_count: 0, locked_until: null };
      }
      if (otp === TEST_OTP) {
        upOtp.run({ h, n: 0, until: null, now });
        return { ok: true };
      }
      const n = (st ? st.fail_count : 0) + 1;
      if (n >= MAX_FAILS) {
        const until = clock.addMinutes(now, LOCK_MINUTES);
        upOtp.run({ h, n: 0, until, now });
        return { locked: until };
      }
      upOtp.run({ h, n, until: null, now });
      return { attemptsLeft: MAX_FAILS - n };
    });
  }

  // ---------- ผู้ใช้ / session ----------
  const qUserByHash = db.prepare('SELECT * FROM users WHERE id_no_hash = ?');
  const insCitizen = db.prepare(`INSERT INTO users (username, password_hash, name, role, dept, id_no_enc, id_no_hash, mobile_enc, email, registered, consent_at, created_at)
    VALUES (NULL, NULL, @name, 'citizen', NULL, @enc, @hash, NULL, NULL, 0, NULL, @now)`);
  const delSession = db.prepare('DELETE FROM sessions WHERE sid = ?');
  const qUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const updRegister = db.prepare(`UPDATE users SET mobile_enc = @mobile, email = @email, registered = 1, consent_at = @now
    WHERE id = @id AND registered = 0`);

  /** หาแถวประชาชนจากเลขบัตร · ไม่มี → สร้างผู้ใช้ใหม่ที่ยังไม่ลงทะเบียน (ThaiD จำลองคืนชื่อแทน) */
  function findOrCreateCitizen(idNo) {
    return tx(() => {
      const hash = pii.blindIndex(idNo);
      let u = qUserByHash.get(hash);
      if (!u) {
        const info = insCitizen.run({ name: THAID_DEFAULT_NAME, enc: pii.encrypt(idNo), hash, now: clock.nowISO() });
        u = qUser.get(info.lastInsertRowid);
      }
      return u;
    });
  }

  /** ทิ้ง session เดิม (ถ้ามี) แล้วสร้างใหม่ · ไม่ล้าง cookie ก่อนเพื่อไม่ให้มี Set-Cookie ซ้อน */
  function startSession(req, res, user) {
    const old = (req.cookies && req.cookies[auth.COOKIE]) || (req.user && req.user.sid);
    if (old) delSession.run(old);
    auth.createSession(res, user);
  }

  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
  const str = (v) => (v == null ? '' : String(v)).trim();
  const isTrue = (v) => v === true || v === 1 || ['true', 'on', '1', 'yes'].includes(String(v).toLowerCase());
  const lockedBody = (until) => ({ lockedUntil: until });

  // ---------- API: ThaiD ----------
  app.post('/api/auth/thaid/start', (req, res) => {
    const idNo = str(body(req).idNo);
    if (!pii.isValidThaiId(idNo)) return apiError(res, 'INVALID_ID');
    const lock = activeLock(qOtp.get(pii.blindIndex(idNo)), clock.nowISO());
    if (lock) return apiError(res, 'LOCKED', lockedBody(lock));
    return res.status(200).json({ status: 'OTP_SENT' });
  });

  app.post('/api/auth/thaid/verify', (req, res) => {
    const b = body(req);
    const idNo = str(b.idNo);
    if (!pii.isValidThaiId(idNo)) return apiError(res, 'INVALID_ID');
    const r = checkOtp(idNo, str(b.otp));
    if (r.locked) return apiError(res, 'LOCKED', lockedBody(r.locked));
    if (!r.ok) return apiError(res, 'OTP_INVALID', { attemptsLeft: r.attemptsLeft });
    const user = findOrCreateCitizen(idNo);
    startSession(req, res, user);
    const registered = !!user.registered;
    return res.status(200).json({ registered, landing: registered ? C.LANDING.citizen : '/register' });
  });

  // ---------- API: ลงทะเบียน ----------
  app.post('/api/auth/register', auth.requireRole(['citizen'], { allowUnregistered: true }), (req, res) => {
    if (req.user.registered) return apiError(res, 'INVALID_STATE');
    const b = body(req);
    const mobile = str(b.mobile);
    const email = str(b.email).slice(0, 254);
    if (!MOBILE_RE.test(mobile)) return apiError(res, 'INVALID_MOBILE');
    if (!isTrue(b.consent)) return apiError(res, 'CONSENT_REQUIRED');
    const info = updRegister.run({ id: req.user.id, mobile: pii.encrypt(mobile), email: email || null, now: clock.nowISO() });
    if (!info.changes) return apiError(res, 'INVALID_STATE');
    return res.status(201).json({ registered: true, landing: C.LANDING.citizen });
  });

  // ---------- API: เจ้าหน้าที่ ----------
  app.post('/api/auth/staff/login', (req, res) => {
    const b = body(req);
    const username = str(b.username);
    const password = b.password == null ? '' : String(b.password);
    const user = username ? ctx.dbm.getUserByUsername(username) : null;
    if (!user || user.role === 'citizen' || !pii.verifyPassword(password, user.password_hash)) {
      return apiError(res, 'INVALID_CREDENTIALS');
    }
    tx(() => {
      startSession(req, res, user);
      audit.log(null, { username: user.username, role: user.role, event: 'STAFF_LOGIN' });
    });
    return res.status(200).json({ role: user.role, dept: user.dept || null, landing: auth.landingFor({ role: user.role, registered: true }) });
  });

  app.post('/api/auth/logout', (req, res) => {
    auth.destroySession(req, res);
    return res.status(204).end();
  });

  app.get('/api/me', (req, res) => {
    const u = req.user;
    if (!u) return apiError(res, 'UNAUTHENTICATED');
    return res.status(200).json({ username: u.username, name: u.name, role: u.role, dept: u.dept || null, registered: !!u.registered });
  });

  // method อื่นของ API ในบล็อกนี้ → 405
  const methodNotAllowed = (req, res) => apiError(res, 'METHOD_NOT_ALLOWED');
  for (const p of ['/api/auth/thaid/start', '/api/auth/thaid/verify', '/api/auth/register', '/api/auth/staff/login', '/api/auth/logout']) {
    app.all(p, methodNotAllowed);
  }
  app.all('/api/me', methodNotAllowed);

  // ---------- หน้า ----------
  const PAGE_CSS = `<style>
[hidden]{display:none!important}
.login-wrap{max-width:34rem;margin:0 auto}
.tabs{display:flex;flex-wrap:wrap;gap:.25rem;border-bottom:2px solid #0b3d6e;margin:0 0 1rem}
.tabs [role=tab]{font:inherit;min-height:44px;padding:.45rem 1rem;border:1px solid #0b3d6e;border-bottom:none;border-radius:6px 6px 0 0;background:#fff;color:#0b3d6e;cursor:pointer}
.tabs [role=tab][aria-selected=true]{background:#0b3d6e;color:#fff;font-weight:700}
.tabs [role=tab]:focus-visible{outline:3px solid #b35c00;outline-offset:2px}
.lock-box{border:1px solid #e4a0a6;background:#fdecee;color:#8a1116;border-radius:6px;padding:.6rem .9rem;margin:.75rem 0}
.lock-box p{margin:.15rem 0}
.otp-step{border-top:1px dashed #d5d9e0;margin-top:1rem;padding-top:.5rem}
.hint{font-size:.9rem;color:#4b5563;margin:.25rem 0}
.field-error{margin:.25rem 0 0}
</style>`;

  function loginPage(req, res) {
    const tab = req.query && req.query.tab === 'staff' ? 'staff' : 'citizen';
    const citizenSel = tab === 'citizen';
    const html = `
<div class="login-wrap">
<h1>เข้าสู่ระบบ</h1>
${req.user ? `<p class="muted">คุณเข้าสู่ระบบอยู่ในชื่อ ${esc(req.user.name)} · <a href="${esc(auth.landingFor(req.user))}">ไปหน้าหลัก</a></p>` : ''}
<div class="tabs" role="tablist" aria-label="ประเภทผู้ใช้">
  <button type="button" role="tab" id="tab-citizen" data-testid="login-tab-citizen" aria-controls="panel-citizen" aria-selected="${citizenSel}" tabindex="${citizenSel ? 0 : -1}">ประชาชน (ThaiD)</button>
  <button type="button" role="tab" id="tab-staff" data-testid="login-tab-staff" aria-controls="panel-staff" aria-selected="${!citizenSel}" tabindex="${citizenSel ? -1 : 0}">เจ้าหน้าที่</button>
</div>

<section role="tabpanel" id="panel-citizen" aria-labelledby="tab-citizen" class="card"${citizenSel ? '' : ' hidden'}>
  <form id="thaid-form" novalidate>
    <div class="field">
      <label for="thaid-id">เลขบัตรประจำตัวประชาชน 13 หลัก</label>
      <input type="text" id="thaid-id" name="idNo" data-testid="thaid-id-input" inputmode="numeric" autocomplete="off" aria-describedby="thaid-error" required>
      <p id="thaid-error" data-testid="thaid-error" class="error field-error" role="alert" hidden></p>
    </div>
    <button type="submit" class="btn" data-testid="thaid-submit">เข้าสู่ระบบด้วย ThaiD (จำลอง)</button>
  </form>

  <div class="lock-box" data-testid="lock-box" id="lock-box" hidden>
    <p data-testid="lock-message" id="lock-message" role="alert"></p>
    <p>ปลดล็อกได้เวลา <time data-testid="lock-until" id="lock-until" data-iso=""></time></p>
  </div>

  <div class="otp-step" data-testid="otp-step" id="otp-step" hidden>
    <form id="otp-form" novalidate>
      <p class="hint">ระบบส่งรหัส OTP ไปยังเบอร์มือถือที่ลงทะเบียนกับ ThaiD แล้ว (โหมดทดสอบ)</p>
      <div class="field">
        <label for="otp-input">รหัส OTP 6 หลัก</label>
        <input type="text" id="otp-input" name="otp" data-testid="otp-input" inputmode="numeric" autocomplete="one-time-code" aria-describedby="otp-error otp-attempts-left" required>
        <p id="otp-error" data-testid="otp-error" class="error field-error" role="alert" hidden></p>
        <p id="otp-attempts-left" data-testid="otp-attempts-left" class="error field-error" hidden></p>
      </div>
      <button type="submit" class="btn" data-testid="otp-submit">ยืนยัน OTP</button>
    </form>
  </div>
</section>

<section role="tabpanel" id="panel-staff" aria-labelledby="tab-staff" class="card"${citizenSel ? ' hidden' : ''}>
  <form id="staff-form" novalidate>
    <div class="field">
      <label for="staff-username">ชื่อผู้ใช้</label>
      <input type="text" id="staff-username" name="username" data-testid="staff-username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
    </div>
    <div class="field">
      <label for="staff-password">รหัสผ่าน</label>
      <input type="password" id="staff-password" name="password" data-testid="staff-password" autocomplete="current-password" aria-describedby="staff-error" required>
    </div>
    <p id="staff-error" data-testid="staff-error" class="error field-error" role="alert" hidden></p>
    <button type="submit" class="btn" data-testid="staff-submit">เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)</button>
  </form>
</section>
</div>`;

    const script = `<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  function show(el,text){if(text!==undefined)el.textContent=text;el.hidden=false}
  function hide(el){el.hidden=true;el.textContent=''}
  function msgOf(r,fallback){return (r&&r.data&&r.data.message)||fallback}
  var tabs=[$('tab-citizen'),$('tab-staff')];
  function select(tab,focus){
    tabs.forEach(function(t){
      var on=t===tab;t.setAttribute('aria-selected',on?'true':'false');t.tabIndex=on?0:-1;
      $(t.getAttribute('aria-controls')).hidden=!on;
    });
    if(focus)tab.focus();
  }
  tabs.forEach(function(t,i){
    t.addEventListener('click',function(){select(t,false)});
    t.addEventListener('keydown',function(e){
      var k=e.key,n=null;
      if(k==='ArrowRight'||k==='ArrowLeft'){n=tabs[(i+1)%tabs.length]}
      else if(k==='Home'){n=tabs[0]}else if(k==='End'){n=tabs[tabs.length-1]}
      if(n){e.preventDefault();select(n,true)}
    });
  });

  var idInput=$('thaid-id'),thaidErr=$('thaid-error'),lockBox=$('lock-box'),lockMsg=$('lock-message'),lockUntil=$('lock-until');
  var otpStep=$('otp-step'),otpInput=$('otp-input'),otpErr=$('otp-error'),otpLeft=$('otp-attempts-left');
  var currentId=null,busy=false;
  function clearLock(){lockBox.hidden=true;lockMsg.textContent='';lockUntil.textContent='';lockUntil.setAttribute('data-iso','')}
  function showLock(r){
    lockMsg.textContent=msgOf(r,'');
    var iso=(r.data&&r.data.lockedUntil)||'';
    lockUntil.setAttribute('data-iso',iso);lockUntil.setAttribute('datetime',iso);lockUntil.textContent=App.fmtThai(iso);
    lockBox.hidden=false;
  }
  function clearOtpMsgs(){hide(otpErr);hide(otpLeft);otpInput.removeAttribute('aria-invalid')}
  idInput.addEventListener('input',function(){
    if(currentId!==null&&idInput.value.trim()!==currentId){currentId=null;otpStep.hidden=true;clearOtpMsgs();clearLock()}
  });

  $('thaid-form').addEventListener('submit',function(e){
    e.preventDefault();if(busy)return;busy=true;
    var idNo=idInput.value.trim();
    hide(thaidErr);idInput.removeAttribute('aria-invalid');clearLock();clearOtpMsgs();
    App.api('POST','/api/auth/thaid/start',{idNo:idNo},{silent:true}).then(function(r){
      if(r.ok){currentId=idNo;otpStep.hidden=false;otpInput.value='';otpInput.focus();return}
      currentId=null;otpStep.hidden=true;
      if(r.status===423){showLock(r);return}
      if(r.data&&r.data.code==='INVALID_ID'){show(thaidErr,msgOf(r,''));idInput.setAttribute('aria-invalid','true');idInput.focus();return}
      App.showError(msgOf(r,'HTTP '+r.status));
    }).catch(function(){App.showError('เชื่อมต่อระบบไม่สำเร็จ')}).then(function(){busy=false});
  });

  $('otp-form').addEventListener('submit',function(e){
    e.preventDefault();if(busy)return;busy=true;
    var idNo=currentId||idInput.value.trim();
    clearOtpMsgs();
    App.api('POST','/api/auth/thaid/verify',{idNo:idNo,otp:otpInput.value.trim()},{silent:true}).then(function(r){
      if(r.ok){location.href=(r.data&&r.data.landing)||(r.data&&r.data.registered?'/citizen':'/register');return}
      var code=r.data&&r.data.code;
      if(r.status===423){showLock(r);otpInput.value='';return}
      if(code==='OTP_INVALID'){
        show(otpErr,msgOf(r,''));otpInput.setAttribute('aria-invalid','true');
        if(typeof r.data.attemptsLeft==='number')show(otpLeft,'เหลือ '+r.data.attemptsLeft+' ครั้ง');
        otpInput.select();return;
      }
      if(code==='INVALID_ID'){otpStep.hidden=true;show(thaidErr,msgOf(r,''));idInput.focus();return}
      App.showError(msgOf(r,'HTTP '+r.status));
    }).catch(function(){App.showError('เชื่อมต่อระบบไม่สำเร็จ')}).then(function(){busy=false});
  });

  var staffErr=$('staff-error');
  $('staff-form').addEventListener('submit',function(e){
    e.preventDefault();if(busy)return;busy=true;
    hide(staffErr);
    App.api('POST','/api/auth/staff/login',{username:$('staff-username').value.trim(),password:$('staff-password').value},{silent:true}).then(function(r){
      if(r.ok){location.href=(r.data&&r.data.landing)||'/';return}
      if(r.data&&r.data.code==='INVALID_CREDENTIALS'){show(staffErr,msgOf(r,''));$('staff-password').value='';return}
      App.showError(msgOf(r,'HTTP '+r.status));
    }).catch(function(){App.showError('เชื่อมต่อระบบไม่สำเร็จ')}).then(function(){busy=false});
  });
})();
</script>`;

    return views.render(req, res, { title: 'เข้าสู่ระบบ', head: PAGE_CSS, body: html, scripts: script });
  }

  app.get('/login', loginPage);

  app.get('/register', auth.requireRole(['citizen'], { allowUnregistered: true }), (req, res) => {
    if (req.user.registered) return res.redirect(302, C.LANDING.citizen);
    const html = `
<div class="login-wrap">
<h1>ลงทะเบียนผู้ใช้ใหม่</h1>
<p class="muted">เข้าใช้งานครั้งแรก กรุณากรอกข้อมูลติดต่อและยินยอมการประมวลผลข้อมูลส่วนบุคคล</p>
<form id="reg-form" class="card" novalidate>
  <div class="field">
    <label for="reg-name">ชื่อ-สกุล (จาก ThaiD แก้ไขไม่ได้)</label>
    <input type="text" id="reg-name" data-testid="reg-name" value="${esc(req.user.name)}" readonly aria-readonly="true">
  </div>
  <div class="field">
    <label for="reg-mobile">เบอร์มือถือ (บังคับ)</label>
    <input type="tel" id="reg-mobile" name="mobile" data-testid="reg-mobile" inputmode="numeric" autocomplete="tel-national" aria-describedby="reg-mobile-hint reg-error-mobile" required>
    <p id="reg-mobile-hint" class="hint">ตัวเลข 10 หลัก ขึ้นต้นด้วย 0 เช่น 0812345678</p>
    <p id="reg-error-mobile" data-testid="reg-error-mobile" class="error field-error" role="alert" hidden></p>
  </div>
  <div class="field">
    <label for="reg-email">อีเมล (ไม่บังคับ)</label>
    <input type="email" id="reg-email" name="email" data-testid="reg-email" autocomplete="email">
  </div>
  <div class="field">
    <label class="check" for="reg-consent"><input type="checkbox" id="reg-consent" name="consent" data-testid="reg-consent" aria-describedby="reg-error-consent" required>
      <span>ข้าพเจ้ายินยอมให้เทศบาลเก็บรวบรวม ใช้ และประมวลผลข้อมูลส่วนบุคคลเพื่อให้บริการ e-Service ตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล (PDPA)</span></label>
    <p id="reg-error-consent" data-testid="reg-error-consent" class="error field-error" role="alert" hidden></p>
  </div>
  <button type="submit" class="btn" data-testid="reg-submit">ลงทะเบียน</button>
</form>
</div>`;
    const script = `<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  var M=${JSON.stringify({ mobile: C.ERRORS.INVALID_MOBILE[1], consent: C.ERRORS.CONSENT_REQUIRED[1] })};
  var mobile=$('reg-mobile'),consent=$('reg-consent'),eM=$('reg-error-mobile'),eC=$('reg-error-consent'),busy=false;
  function set(el,input,msg){el.textContent=msg||'';el.hidden=!msg;if(msg)input.setAttribute('aria-invalid','true');else input.removeAttribute('aria-invalid')}
  $('reg-form').addEventListener('submit',function(e){
    e.preventDefault();if(busy)return;
    var m=mobile.value.trim(),okM=/^0\\d{9}$/.test(m),okC=consent.checked;
    set(eM,mobile,okM?'':M.mobile);set(eC,consent,okC?'':M.consent);
    if(!okM){mobile.focus();return}
    if(!okC){consent.focus();return}
    busy=true;
    App.api('POST','/api/auth/register',{mobile:m,email:$('reg-email').value.trim(),consent:true},{silent:true}).then(function(r){
      if(r.ok){location.href=(r.data&&r.data.landing)||'/citizen';return}
      var code=r.data&&r.data.code,msg=(r.data&&r.data.message)||('HTTP '+r.status);
      if(code==='INVALID_MOBILE'){set(eM,mobile,msg);mobile.focus();return}
      if(code==='CONSENT_REQUIRED'){set(eC,consent,msg);consent.focus();return}
      if(code==='INVALID_STATE'){location.href='/citizen';return}
      if(r.status===401){location.href='/login';return}
      App.showError(msg);
    }).catch(function(){App.showError('เชื่อมต่อระบบไม่สำเร็จ')}).then(function(){busy=false});
  });
})();
</script>`;
    return views.render(req, res, { title: 'ลงทะเบียน', head: PAGE_CSS, body: html, scripts: script });
  });
};
