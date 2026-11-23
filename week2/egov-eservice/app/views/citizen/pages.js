'use strict';
// B06 · หน้าประชาชน (CONTRACT 2.4 /citizen · 2.5 /citizen/new/:service · 2.6 /citizen/cases/:caseNo)
// ฟังก์ชันคืนสตริง HTML ให้ ctx.render() ใส่ใน layout · สคริปต์ฝั่ง client ใช้ window.App จาก layout
// action-error / action-success อยู่ใน layout ที่เดียว (ห้าม render ซ้ำ)

const EVENT_TH = {
  SUBMITTED: 'ชำระเงินและส่งคำขอ',
  CLAIM: 'เจ้าหน้าที่รับเรื่อง',
  RETURN: 'ตีกลับให้แก้ไขเอกสาร',
  RESUBMIT: 'ส่งแก้ไขเอกสารแล้ว',
  FORWARD: 'ผ่าน/ส่งต่อขั้นถัดไป',
  APPROVE: 'อนุมัติ',
  REJECT: 'ไม่อนุมัติ',
  ISSUE: 'ออกเอกสาร',
  CANCEL: 'ผู้ยื่นยกเลิกคำขอ',
  AUTO_CANCEL: 'ยกเลิกอัตโนมัติ (เกินเวลาแก้ไข 168 ชั่วโมง)',
};
const NO_REFUND = 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน';

/** JSON ที่ฝังใน <script> ได้ปลอดภัย */
function safeJson(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function fmtSize(n) {
  if (n == null) return '';
  if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' ไบต์';
}

function feeRule(svc, money) {
  if (svc.id === 'SV-01') return `${money(svc.fee)} ต่อฉบับ (1–5 ฉบับ)`;
  if (svc.id === 'SV-03') return `${money(svc.fee)} (1–100 ตร.ม.) + ${money(svc.feePerSqm)} ต่อ ตร.ม. ส่วนเกิน (สูงสุด 500 ตร.ม.)`;
  return `${money(svc.fee)} คงที่`;
}

const EXTRA_CSS = `<style>
.svc-card h3{margin:.25rem 0 .5rem;font-size:1.1rem}
.svc-card p{margin:.25rem 0}
.steps{display:flex;flex-wrap:wrap;gap:.5rem;list-style:none;padding:0;margin:0 0 1rem}
.steps li{padding:.25rem .75rem;border:1px solid #9aa1ab;border-radius:1em;background:#fff}
.steps li[aria-current=step]{background:#0b4f9c;color:#fff;border-color:#0b4f9c;font-weight:600}
.fee-line{font-size:1.25rem;margin:.75rem 0}
.file-list{list-style:none;padding:0;margin:.5rem 0}
.file-list li{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.35rem 0;border-bottom:1px dashed #d5d9e0}
.file-list .btn{min-height:36px;padding:.2rem .7rem}
.upload-slot{margin-bottom:.75rem}
.qr-box img{width:200px;height:200px;max-width:100%;border:1px solid #d5d9e0;background:#fff}
.confirm-box{border:2px solid #a4161a;border-radius:8px;padding:.75rem 1rem;background:#fff;margin:.5rem 0}
.doc-qr{width:160px;height:160px}
</style>`;

// ======================================================================= /citizen
function home(p, { user, services, cases, drafts }) {
  const { esc, money, timeTag, statusBadge, levelBadge, serviceLabel } = p.views;
  const svcCards = services.map((s) => `
    <div class="card svc-card">
      <h3>${esc(s.id)} ${esc(s.name)}</h3>
      <p>ค่าธรรมเนียม: ${esc(feeRule(s, money))}</p>
      <p>ระยะเวลา: ${esc(s.sla)} วันทำการ</p>
      <a class="btn" data-testid="start-service-${esc(s.id)}" href="/citizen/new/${esc(s.id)}">เริ่มยื่น ${esc(s.name)}</a>
    </div>`).join('');

  const caseRows = cases.map((c) => `
      <tr data-testid="my-case-row" data-case-no="${esc(c.case_no)}" data-status="${esc(c.status)}">
        <td data-testid="row-case-no"><a href="/citizen/cases/${esc(c.case_no)}">${esc(c.case_no)}</a></td>
        <td data-testid="row-service">${esc(serviceLabel(c.service_id))}</td>
        <td>${statusBadge(c.status, 'row-status')}</td>
        <td>${timeTag(c.due_at, 'row-due')}</td>
        <td>${levelBadge(c.level, 'row-sla-level')}</td>
      </tr>`).join('');

  const draftRows = drafts.map((d) => `
      <tr data-testid="my-draft-row" data-draft-id="${esc(d.id)}" data-status="${esc(d.status)}">
        <td data-testid="row-draft-id">${esc(d.id)}</td>
        <td data-testid="row-service">${esc(serviceLabel(d.service_id))}</td>
        <td>${statusBadge(d.status, 'row-status')}</td>
        <td data-testid="row-fee">${esc(money(d.fee))}</td>
        <td class="actions">
          <a class="btn btn-secondary" data-testid="open-draft-btn" href="/citizen/new/${esc(d.service_id)}?draft=${esc(d.id)}">เปิดร่าง ${esc(d.id)}</a>
          <button type="button" class="btn btn-danger" data-testid="delete-draft-btn" data-draft-id="${esc(d.id)}">ลบร่าง ${esc(d.id)}</button>
        </td>
      </tr>`).join('');

  return `${EXTRA_CSS}
<h1 data-testid="citizen-welcome">สวัสดี ${esc(user.name)}</h1>
<section aria-labelledby="h-services">
  <h2 id="h-services">เริ่มยื่นคำขอ</h2>
  <div class="grid">${svcCards}</div>
</section>
<section aria-labelledby="h-cases">
  <h2 id="h-cases">คำขอของฉัน</h2>
  ${cases.length ? `<div class="table-wrap"><table>
    <caption class="muted">เรียงตามเลขคำขอล่าสุดก่อน</caption>
    <thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับเตือน</th></tr></thead>
    <tbody>${caseRows}</tbody></table></div>` : '<p data-testid="my-cases-empty" class="muted">ยังไม่มีคำขอ</p>'}
</section>
<section aria-labelledby="h-drafts">
  <h2 id="h-drafts">ร่างและรอชำระเงิน</h2>
  ${drafts.length ? `<div class="table-wrap"><table>
    <thead><tr><th scope="col">รหัสร่าง</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">ค่าธรรมเนียม</th><th scope="col">ดำเนินการ</th></tr></thead>
    <tbody>${draftRows}</tbody></table></div>` : '<p data-testid="my-drafts-empty" class="muted">ไม่มีร่าง</p>'}
</section>`;
}

function homeScript() {
  return `<script>
(function(){
  document.querySelectorAll('[data-testid="delete-draft-btn"]').forEach(function(b){
    b.addEventListener('click',function(){
      var id=b.getAttribute('data-draft-id');
      if(!window.confirm('ลบร่าง '+id+' ใช่หรือไม่')) return;
      App.api('DELETE','/api/drafts/'+encodeURIComponent(id)).then(function(r){ if(r.ok) location.reload(); });
    });
  });
})();
</script>`;
}

// ======================================================================= /citizen/new/:service
function wizard(p, { svc, draft }) {
  const { esc, money } = p.views;
  const docs = p.C.SERVICE_DOCS[svc.id];
  let input = '';
  if (svc.id === 'SV-01') {
    const v = draft && draft.qty != null ? draft.qty : 1;
    input = `<div class="field"><label for="qty-input">จำนวนฉบับ (1–5 ฉบับ)</label>
      <input id="qty-input" data-testid="qty-input" type="number" inputmode="numeric" step="1" value="${esc(v)}" aria-describedby="fee-error"></div>`;
  } else if (svc.id === 'SV-03') {
    const v = draft && draft.areaSqm != null ? draft.areaSqm : '';
    input = `<div class="field"><label for="area-input">พื้นที่ก่อสร้าง/ต่อเติม (ตร.ม. จำนวนเต็ม 1–500)</label>
      <input id="area-input" data-testid="area-input" type="number" inputmode="numeric" step="1" value="${esc(v)}" aria-describedby="fee-error"></div>`;
  }
  const slots = docs.concat([{ key: 'extra', name: 'เอกสารเพิ่มเติม', required: false }]).map((d) => {
    const note = d.pdfOnly ? ' (PDF เท่านั้น)' : d.key === 'extra' ? ' (ไม่บังคับ เลือกได้หลายไฟล์)' : d.required ? '' : ' (ไม่บังคับ)';
    return `<div class="upload-slot"><label for="up-${esc(d.key)}">${esc(d.name)}${d.required ? ' ✱' : ''}${esc(note)}</label>
      <input id="up-${esc(d.key)}" type="file" data-testid="upload-input-${esc(d.key)}" data-doc-key="${esc(d.key)}"${d.key === 'extra' ? ' multiple' : ''}
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"></div>`;
  }).join('');

  return `${EXTRA_CSS}
<h1>ยื่นคำขอ: <span data-testid="service-name">${esc(svc.name)}</span></h1>
<p data-testid="wizard-step" id="wizard-step" aria-live="polite">1/3 กรอกข้อมูล</p>
<ol class="steps" aria-label="ขั้นตอนการยื่น">
  <li data-step="1">1 กรอกข้อมูล</li><li data-step="2">2 แนบเอกสาร</li><li data-step="3">3 ชำระเงิน</li>
</ol>
<p id="draft-box"${draft ? '' : ' hidden'}>รหัสร่าง: <strong data-testid="draft-id">${draft ? esc(draft.draftId) : ''}</strong></p>

<section id="step-1" class="card" aria-labelledby="h-step1">
  <h2 id="h-step1" tabindex="-1">กรอกข้อมูล</h2>
  ${input}
  <p class="fee-line">ค่าธรรมเนียม: <output data-testid="fee-total" id="fee-total" aria-live="polite">${esc(money(svc.id === 'SV-03' ? null : svc.fee))}</output></p>
  <p data-testid="fee-error" id="fee-error" class="error" role="alert" hidden></p>
  <p class="muted">อัตรา: ${esc(feeRule(svc, money))}</p>
  <div class="actions">
    <button type="button" class="btn btn-secondary" data-testid="save-draft-btn" id="save-draft-btn">บันทึกร่าง</button>
    <button type="button" class="btn" data-testid="to-upload-btn" id="to-upload-btn">ถัดไป: แนบเอกสาร</button>
  </div>
</section>

<section id="step-2" class="card" aria-labelledby="h-step2" hidden>
  <h2 id="h-step2" tabindex="-1">แนบเอกสาร</h2>
  <p class="muted">รองรับ PDF, JPG, PNG ไฟล์ละไม่เกิน 5 MB รวมไม่เกิน 5 ไฟล์ต่อคำขอ · ✱ = บังคับ</p>
  ${slots}
  <p data-testid="upload-error" id="upload-error" class="error" role="alert" hidden></p>
  <h3>ไฟล์ที่แนบแล้ว</h3>
  <ul class="file-list" id="file-list"></ul>
  <div id="missing-wrap" aria-live="polite"></div>
  <div class="actions">
    <button type="button" class="btn btn-secondary" id="back-to-step1">ย้อนกลับ</button>
    <button type="button" class="btn" data-testid="to-payment-btn" id="to-payment-btn" disabled>ไปชำระเงิน</button>
  </div>
</section>

<section id="step-3" class="card" aria-labelledby="h-step3" hidden>
  <h2 id="h-step3" tabindex="-1">ชำระเงิน (PromptPay จำลอง)</h2>
  <p class="fee-line">ยอดที่ต้องชำระ: <strong data-testid="payment-amount" id="payment-amount"></strong></p>
  <div id="pay-box" aria-live="polite"></div>
  <div class="actions" id="back-to-upload-wrap">
    <button type="button" class="btn btn-secondary" id="back-to-step2">ย้อนกลับไปแนบเอกสาร</button>
  </div>
</section>`;
}

function wizardScript(state) {
  return `<script type="application/json" id="wiz-state">${safeJson(state)}</script>
<script>
(function(){
  var S=JSON.parse(document.getElementById('wiz-state').textContent);
  var draft=S.draft;
  var files=(draft&&draft.files)||[];
  var step=1, pollTimer=null, touched=false, busy=false, saving=null;
  // FR-07: key เดียวต่อการเปิดหน้า ส่งไปกับ POST /api/drafts ให้เซิร์ฟเวอร์รวมคำขอซ้ำเป็นร่างเดียว
  var clientKey='ck'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
  function T(id){return document.querySelector('[data-testid="'+id+'"]')}
  function byId(id){return document.getElementById(id)}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  var LABELS={1:'1/3 กรอกข้อมูล',2:'2/3 แนบเอกสาร',3:'3/3 ชำระเงิน'};
  var qty=T('qty-input'), area=T('area-input');

  // ---------- ขั้น 1: ค่าธรรมเนียม (BR-04 BR-05) ----------
  function toInt(v){v=String(v==null?'':v).trim();return /^[+-]?\\d+$/.test(v)?Number(v):NaN}
  function readInput(){
    if(S.serviceId==='SV-01') return {qty:qty.value};
    if(S.serviceId==='SV-03') return {areaSqm:area.value};
    return {};
  }
  function calc(){
    if(S.serviceId==='SV-01'){var q=toInt(qty.value);if(!(q>=1&&q<=5))return{error:'INVALID_QTY'};return{fee:S.fee*q}}
    if(S.serviceId==='SV-03'){var a=toInt(area.value);if(!(a>=1))return{error:'INVALID_AREA'};if(a>500)return{error:'AREA_TOO_LARGE'};
      return{fee:a>=S.extraFrom?S.fee+S.feePerSqm*(a-100):S.fee}}
    return{fee:S.fee};
  }
  function feeErr(msg){var e=byId('fee-error');e.textContent=msg||'';e.hidden=!msg}
  function updateFee(){
    var r=calc(), el=qty||area;
    byId('fee-total').textContent=r.error?'–':App.money(r.fee);
    var show=r.error&&(touched||(el&&String(el.value).trim()!==''));
    feeErr(show?S.errors[r.error]:'');
    if(el) el.setAttribute('aria-invalid',r.error?'true':'false');
    setSaveButtons();
  }
  function setSaveButtons(){
    var bad=!!calc().error;
    ['to-upload-btn','save-draft-btn'].forEach(function(id){var b=byId(id);b.disabled=bad||!!saving;b.setAttribute('aria-busy',saving?'true':'false')});
  }
  [qty,area].forEach(function(el){if(!el)return;['input','change'].forEach(function(ev){el.addEventListener(ev,function(){touched=true;updateFee()})})});
  if(draft&&draft.status!=='DRAFT'){[qty,area].forEach(function(el){if(el)el.readOnly=true});}

  function setDraft(d){
    var keep=draft||{};
    draft=Object.assign({},keep,d);
    if(d.files) files=d.files;
    byId('draft-box').hidden=false;
    T('draft-id').textContent=draft.draftId;
    var url=location.pathname+'?draft='+encodeURIComponent(draft.draftId);
    if(location.pathname+location.search!==url) history.replaceState(null,'',url);
  }
  // กันบันทึกซ้ำ: ระหว่างที่คำขอแรกยังค้าง ทุกการกด (บันทึก/ถัดไป) ได้ผลของคำขอเดิม และปุ่มถูกปิดไว้
  function saveDraft(){
    if(saving) return saving;
    saving=doSave().then(function(d){saving=null;setSaveButtons();return d},function(e){saving=null;setSaveButtons();throw e});
    setSaveButtons();
    return saving;
  }
  function doSave(){
    var r=calc();
    if(r.error){touched=true;updateFee();return Promise.resolve(null)}
    if(draft&&draft.status!=='DRAFT') return Promise.resolve(draft);
    var body=readInput(), req;
    if(draft){req=App.api('PATCH','/api/drafts/'+encodeURIComponent(draft.draftId),body,{silent:true})}
    else{body.serviceId=S.serviceId;body.clientKey=clientKey;req=App.api('POST','/api/drafts',body,{silent:true})}
    return req.then(function(res){
      if(!res.ok){var m=(res.data&&res.data.message)||('HTTP '+res.status);
        if(res.data&&/^(INVALID_QTY|INVALID_AREA|AREA_TOO_LARGE)$/.test(res.data.code))feeErr(m);else App.showError(m);
        if(res.status===401)location.href='/login';return null}
      setDraft(res.data);return draft;
    });
  }
  byId('save-draft-btn').addEventListener('click',function(){
    saveDraft().then(function(d){if(d)App.showSuccess('บันทึกร่าง '+d.draftId+' แล้ว')});
  });
  // ready = งานบันทึกร่าง+โหลดร่างที่กำลังทำ · การแนบไฟล์ต้องรอให้เสร็จก่อน ไม่เช่นนั้นไฟล์ที่เลือกเร็วจะหายเงียบ (B14)
  var ready=Promise.resolve();
  byId('to-upload-btn').addEventListener('click',function(){
    ready=saveDraft().then(function(d){if(!d)return;return refreshDraft().then(function(){goStep(2)})}).catch(function(){});
  });

  // ---------- ขั้น 2: แนบไฟล์ (BR-06 BR-07 BR-08) ----------
  function uploadErr(msg){var e=byId('upload-error');e.textContent=msg||'';e.hidden=!msg}
  function missing(){
    var keys={};files.forEach(function(f){keys[f.docKey]=1});
    return S.docs.filter(function(d){return d.required&&!keys[d.key]}).map(function(d){return d.name});
  }
  function fmtSize(n){return n>=1048576?(n/1048576).toFixed(2)+' MB':n>=1024?(n/1024).toFixed(1)+' KB':n+' ไบต์'}
  function docName(k){var d=S.docs.filter(function(x){return x.key===k})[0];return d?d.name:'เอกสารเพิ่มเติม'}
  function renderFiles(){
    var editable=!draft||draft.status==='DRAFT'||draft.status==='PENDING_PAYMENT';
    byId('file-list').innerHTML=files.length?files.map(function(f){
      return '<li data-testid="file-item" data-name="'+esc(f.name)+'" data-doc-key="'+esc(f.docKey)+'" data-file-id="'+esc(f.fileId)+'">'+
        '<span>'+esc(docName(f.docKey))+': <a href="/api/files/'+encodeURIComponent(f.fileId)+'" target="_blank" rel="noopener">'+esc(f.name)+'</a> ('+fmtSize(f.size)+')</span>'+
        (editable?'<button type="button" class="btn btn-secondary" data-testid="file-remove-btn" data-file-id="'+esc(f.fileId)+'" aria-label="ลบไฟล์ '+esc(f.name)+'">ลบ</button>':'')+'</li>';
    }).join(''):'<li class="muted" id="no-files">ยังไม่มีไฟล์</li>';
    var m=missing();
    byId('missing-wrap').innerHTML=m.length?'<p data-testid="missing-docs" class="error">ยังขาดเอกสาร: '+esc(m.join(', '))+'</p>':'';
    byId('to-payment-btn').disabled=m.length>0;
  }
  byId('file-list').addEventListener('click',function(ev){
    var b=ev.target.closest('[data-testid="file-remove-btn"]');if(!b||!draft)return;
    var id=b.getAttribute('data-file-id');b.disabled=true;
    App.api('DELETE','/api/drafts/'+encodeURIComponent(draft.draftId)+'/files/'+encodeURIComponent(id)).then(function(r){
      if(r.ok||r.status===404){setFiles(files.filter(function(f){return f.fileId!==id}))}else{b.disabled=false}
    });
  });
  function uploadOne(docKey,file){
    var fd=new FormData();fd.append('docKey',docKey);fd.append('file',file,file.name);
    return App.api('POST','/api/drafts/'+encodeURIComponent(draft.draftId)+'/files',fd,{silent:true});
  }
  var queue=Promise.resolve();
  document.querySelectorAll('input[type=file][data-doc-key]').forEach(function(inp){
    inp.addEventListener('change',function(){
      var list=Array.prototype.slice.call(inp.files||[]);var key=inp.getAttribute('data-doc-key');
      if(!list.length)return;
      queue=queue.then(function(){return ready}).then(function(){
        if(!draft)return;
        uploadErr('');
        var chain=Promise.resolve(true);
        list.forEach(function(f){
          chain=chain.then(function(ok){
            if(!ok)return false;
            return uploadOne(key,f).then(function(r){
              if(r.ok){files.push(r.data);renderFiles();return true}
              uploadErr((r.data&&r.data.message)||('HTTP '+r.status));return false;
            });
          });
        });
        return chain.then(function(){inp.value=''});
      });
    });
  });
  byId('to-payment-btn').addEventListener('click',function(){if(missing().length)return;goStep(3)});
  function setFiles(list){files=list;renderFiles();if(step===3)renderPay()}
  byId('back-to-step1').addEventListener('click',function(){goStep(1)});

  // ---------- ขั้น 3: ชำระเงิน ----------
  function refreshDraft(){
    if(!draft)return Promise.resolve();
    return App.api('GET','/api/drafts/'+encodeURIComponent(draft.draftId),undefined,{silent:true}).then(function(r){
      if(r.ok){draft=r.data;files=r.data.files||[];renderFiles();renderPay()}
    });
  }
  function renderPay(){
    if(!draft)return;
    var p=draft.payment;
    byId('payment-amount').textContent=App.money(draft.fee);
    var h='';
    var miss=missing();
    if(miss.length&&!(p&&p.status==='PAID')){
      // BR-08: เอกสารบังคับไม่ครบ → ไม่แสดง QR/ปุ่มสร้าง QR จนกว่าจะแนบครบ
      h='<p id="pay-missing" class="error" role="alert">ยังขาดเอกสาร: '+esc(miss.join(', '))+'</p>'+
        '<p class="muted">กรุณากลับไปแนบเอกสารบังคับให้ครบก่อนชำระเงิน</p>';
    }else if(!p){
      h='<button type="button" class="btn" data-testid="create-qr-btn" id="create-qr-btn">สร้าง QR</button>';
    }else{
      if(p.status!=='PAID'){
        h+='<div class="qr-box"><img data-testid="qr-image" src="/citizen/qr/'+encodeURIComponent(p.ref)+'" alt="QR ชำระเงินจำลอง เลขอ้างอิง '+esc(p.ref)+'"></div>';
      }
      h+='<dl class="kv"><dt>เลขอ้างอิง</dt><dd data-testid="qr-ref">'+esc(p.ref)+'</dd>'+
        '<dt>เวลาหมดอายุ QR</dt><dd><time data-testid="qr-expires" data-iso="'+esc(p.qrExpiresAt)+'" datetime="'+esc(p.qrExpiresAt)+'">หมดอายุ '+esc(App.fmtThai(p.qrExpiresAt))+'</time></dd>'+
        '<dt>สถานะ</dt><dd><span data-testid="payment-status" data-status="'+esc(p.status)+'" class="badge '+(p.status==='PAID'?'st-completed':p.status==='EXPIRED'?'st-rejected':'st-pending_payment')+'">'+esc(S.statusTh[p.status]||p.status)+'</span></dd></dl>';
      if(p.status==='EXPIRED'){
        h+='<p data-testid="qr-expired-msg" class="error" role="alert">QR หมดอายุ กรุณาสร้าง QR ใหม่</p>'+
           '<div class="actions"><button type="button" class="btn" data-testid="regenerate-qr-btn" id="regenerate-qr-btn">สร้าง QR ใหม่</button></div>';
      }else if(p.status==='PENDING'){
        h+='<p class="muted">สแกน QR เพื่อชำระ (ระบบจำลอง) แล้วกดตรวจสอบการชำระเงิน</p>';
      }
      if(p.status==='PAID'){
        h+='<div class="card" aria-labelledby="h-receipt"><h3 id="h-receipt">ใบเสร็จ</h3><dl class="kv">'+
          '<dt>เลขคำขอ</dt><dd data-testid="submitted-case-no">'+esc(p.caseNo)+'</dd>'+
          '<dt>เลขใบเสร็จ</dt><dd data-testid="receipt-no">'+esc(p.receiptNo)+'</dd>'+
          '<dt>ยอดชำระ</dt><dd data-testid="receipt-amount">'+esc(App.money(p.amount))+'</dd>'+
          '<dt>ชำระเมื่อ</dt><dd><time data-testid="receipt-paid-at" data-iso="'+esc(p.paidAt)+'" datetime="'+esc(p.paidAt)+'">'+esc(App.fmtThai(p.paidAt))+'</time></dd></dl>'+
          '<div class="actions"><a class="btn" data-testid="go-case-btn" href="/citizen/cases/'+encodeURIComponent(p.caseNo)+'">ดูคำขอ</a></div></div>';
      }else{
        h+='<div class="actions"><button type="button" class="btn btn-secondary" data-testid="refresh-payment-btn" id="refresh-payment-btn">ตรวจสอบการชำระเงิน</button></div>';
      }
    }
    byId('pay-box').innerHTML=h;
    byId('back-to-upload-wrap').hidden=!!(p&&p.status==='PAID');
    schedulePoll();
  }
  function createQr(){
    if(busy||!draft||missing().length)return;busy=true;
    App.api('POST','/api/drafts/'+encodeURIComponent(draft.draftId)+'/payment').then(function(r){
      busy=false;if(r.ok){App.clearMessages();return refreshDraft()}
    });
  }
  byId('pay-box').addEventListener('click',function(ev){
    var t=ev.target.closest('button');if(!t)return;
    var tid=t.getAttribute('data-testid');
    if(tid==='create-qr-btn'||tid==='regenerate-qr-btn')createQr();
    else if(tid==='refresh-payment-btn')refreshDraft();
  });
  function schedulePoll(){
    if(pollTimer){clearTimeout(pollTimer);pollTimer=null}
    if(step===3&&draft&&draft.payment&&draft.payment.status==='PENDING'&&!missing().length){pollTimer=setTimeout(refreshDraft,5000)}
  }
  byId('back-to-step2').addEventListener('click',function(){goStep(2)});

  function goStep(n){
    if(n===3&&missing().length&&!(draft&&draft.payment&&draft.payment.status==='PAID'))n=2; // BR-08
    step=n;
    if(n!==3&&pollTimer){clearTimeout(pollTimer);pollTimer=null}
    [1,2,3].forEach(function(i){byId('step-'+i).hidden=i!==n});
    T('wizard-step').textContent=LABELS[n];
    document.querySelectorAll('.steps li').forEach(function(li){
      if(Number(li.getAttribute('data-step'))===n)li.setAttribute('aria-current','step');else li.removeAttribute('aria-current');
    });
    byId('back-to-step1').hidden=!!(draft&&draft.status!=='DRAFT');
    if(n===2)renderFiles();
    if(n===3)renderPay();
    var h=byId('h-step'+n);if(h&&document.activeElement&&document.activeElement!==document.body)h.focus();
  }

  updateFee();
  renderFiles();
  if(draft&&draft.status!=='DRAFT')goStep(3);else goStep(1); // goStep(3) ตกไปขั้น 2 เองเมื่อเอกสารไม่ครบ
})();
</script>`;
}

// ======================================================================= /citizen/cases/:caseNo
function caseDetail(p, { c, level, idFull, files, doc, timeline, canCancel, canFix }) {
  const { esc, money, timeTag, statusBadge, levelBadge, serviceLabel } = p.views;
  const C = p.C;
  const amount = c.service_id === 'SV-01' && c.qty != null ? `${c.qty} ฉบับ`
    : c.service_id === 'SV-03' && c.area_sqm != null ? `${c.area_sqm} ตร.ม.` : null;

  const tl = timeline.map((e) => `
    <li data-testid="timeline-item" data-iso="${esc(e.at)}" data-event="${esc(e.event)}">
      <time datetime="${esc(e.at)}">${esc(p.views.dateTh(e.at))}</time> · ${esc(EVENT_TH[e.event] || e.event)}${e.actorName ? ` · ${esc(e.actorName)}` : ''}${e.fromStatus || e.toStatus ? ` <span class="muted">(${esc(C.STATUS_TH[e.fromStatus] || e.fromStatus || '–')} → ${esc(C.STATUS_TH[e.toStatus] || e.toStatus || '–')})</span>` : ''}${e.detail && ['RETURN', 'REJECT', 'FORWARD'].includes(e.event) ? `<br><span class="muted">${esc(e.detail)}</span>` : ''}
    </li>`).join('');

  const docItems = files.map((f) => `
    <li data-testid="doc-item" data-name="${esc(f.name)}" data-file-id="${esc(f.fileId)}" data-doc-key="${esc(f.docKey)}">
      <span>${esc(C.DOC_TYPES[f.docKey] || f.docKey)}: ${esc(f.name)} (${esc(fmtSize(f.size))})</span>
      <a data-testid="doc-download-link" href="/api/files/${encodeURIComponent(f.fileId)}" target="_blank" rel="noopener">ดาวน์โหลด ${esc(f.name)}</a>
    </li>`).join('');

  let fix = '';
  if (c.status === 'NEED_FIX') {
    fix = `<section class="card" aria-labelledby="h-fix">
      <h2 id="h-fix">ถูกตีกลับให้แก้ไขเอกสาร</h2>
      <dl class="kv">
        <dt>เหตุผล</dt><dd data-testid="return-reason-display">${esc(c.return_reason || '')}</dd>
        <dt>ส่งแก้ไขได้ถึง</dt><dd>${timeTag(c.fix_deadline, 'fix-deadline')}</dd>
      </dl>
      ${canFix ? `<div class="field"><label for="fix-upload-input">แนบไฟล์ใหม่ (ไม่บังคับ · PDF, JPG, PNG ไม่เกิน 5 MB)</label>
        <input id="fix-upload-input" data-testid="fix-upload-input" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"></div>
        <div class="actions"><button type="button" class="btn" data-testid="submit-fix-btn" id="submit-fix-btn">ส่งแก้ไข</button></div>`
        : '<p class="muted">พ้นเวลาส่งแก้ไขแล้ว</p>'}
    </section>`;
  }

  return `${EXTRA_CSS}
<p><a href="/citizen">← คำขอของฉัน</a></p>
<h1>คำขอ <span data-testid="case-no">${esc(c.case_no)}</span></h1>
<section class="card" aria-label="รายละเอียดคำขอ">
  <dl class="kv">
    <dt>สถานะ</dt><dd>${statusBadge(c.status, 'case-status')}</dd>
    <dt>บริการ</dt><dd data-testid="case-service">${esc(serviceLabel(c.service_id))}</dd>
    ${c.service_id === 'SV-03' && C.SV03_STEP_TH[c.step] ? `<dt>ขั้นตอน</dt><dd data-testid="case-step">${esc(C.SV03_STEP_TH[c.step])}</dd>` : ''}
    ${amount ? `<dt>${c.service_id === 'SV-01' ? 'จำนวน' : 'พื้นที่'}</dt><dd>${esc(amount)}</dd>` : ''}
    <dt>ค่าธรรมเนียม</dt><dd data-testid="case-fee">${esc(money(c.fee))}</dd>
    <dt>ชำระเมื่อ</dt><dd>${timeTag(c.paid_at, 'case-paid-at')} · ใบเสร็จ <span data-testid="case-receipt-no">${esc(c.receipt_no)}</span></dd>
    <dt>กำหนดเสร็จ</dt><dd>${timeTag(c.due_at, 'sla-due')}</dd>
    <dt>ระดับเตือน</dt><dd>${levelBadge(level, 'sla-level')}</dd>
    ${['COMPLETED', 'REJECTED'].includes(c.status) && c.closed_at ? `<dt>ปิดงานเมื่อ</dt><dd>${timeTag(c.closed_at, 'closed-at')}</dd>` : ''}
    ${c.status === 'CANCELLED' && c.cancelled_at ? `<dt>ยกเลิกเมื่อ</dt><dd>${timeTag(c.cancelled_at, 'cancelled-at')}</dd>` : ''}
    <dt>เลขบัตรประชาชนผู้ยื่น</dt><dd data-testid="case-id-full">${esc(idFull)}</dd>
  </dl>
  ${['REJECTED', 'CANCELLED'].includes(c.status) ? `<p data-testid="no-refund-note" class="alert alert-error">${NO_REFUND}</p>` : ''}
</section>
${fix}
${canCancel ? `<section class="card" aria-labelledby="h-cancel">
  <h2 id="h-cancel">ยกเลิกคำขอ</h2>
  <p class="muted">ยกเลิกได้เฉพาะก่อนเจ้าหน้าที่รับเรื่อง</p>
  <button type="button" class="btn btn-danger" data-testid="cancel-case-btn" id="cancel-case-btn" aria-controls="cancel-confirm" aria-expanded="false">ยกเลิกคำขอ</button>
  <div id="cancel-confirm" class="confirm-box" role="alertdialog" aria-labelledby="cancel-confirm-text" hidden>
    <p><strong>ยืนยันการยกเลิกคำขอ ${esc(c.case_no)}</strong></p>
    <p data-testid="cancel-confirm-text" id="cancel-confirm-text">${NO_REFUND}</p>
    <div class="actions">
      <button type="button" class="btn btn-danger" data-testid="confirm-cancel-btn" id="confirm-cancel-btn">ยืนยันยกเลิก</button>
      <button type="button" class="btn btn-secondary" id="dismiss-cancel-btn">ไม่ยกเลิก</button>
    </div>
  </div>
</section>` : ''}
${doc ? `<section class="card" aria-labelledby="h-doc">
  <h2 id="h-doc">เอกสารดิจิทัล</h2>
  <dl class="kv">
    <dt>เลขเอกสาร</dt><dd data-testid="doc-no">${esc(doc.docNo)}</dd>
    <dt>รหัสตรวจสอบ</dt><dd data-testid="verify-code">${esc(doc.verifyCode)}</dd>
    <dt>QR ตรวจสอบ</dt><dd><img class="doc-qr" data-testid="doc-qr" data-url="${esc(doc.verifyUrl)}" src="${esc(doc.qr)}" alt="QR สำหรับตรวจสอบเอกสาร ${esc(doc.docNo)} ที่ ${esc(doc.verifyUrl)}"></dd>
  </dl>
  <div class="actions"><a class="btn" data-testid="download-doc-btn" href="/api/documents/${encodeURIComponent(doc.docNo)}/pdf">ดาวน์โหลดเอกสาร</a></div>
</section>` : ''}
<section class="card" aria-labelledby="h-files">
  <h2 id="h-files">เอกสารแนบ</h2>
  ${files.length ? `<ul class="file-list">${docItems}</ul>` : '<p class="muted">ไม่มีไฟล์แนบ</p>'}
</section>
<section class="card" aria-labelledby="h-timeline">
  <h2 id="h-timeline">ไทม์ไลน์</h2>
  <ol data-testid="case-timeline" class="timeline">${tl}</ol>
</section>`;
}

function caseScript(caseNo) {
  // หลังยกเลิก/ส่งแก้สำเร็จ ดึงหน้านี้ใหม่แล้วแทนเนื้อหาใน <main> (ไม่ navigate) เพื่อให้ผู้เรียกอ่าน response ของ API ได้ครบ
  // (location.reload() ทันทีทำให้ body ของ response หายก่อนอ่าน · B14 แก้จาก TC-WORKFLOW-06)
  return `<script>
(function(){
  var no=${safeJson(caseNo)};
  function byId(id){return document.getElementById(id)}
  function refresh(msg){
    fetch(location.href,{credentials:'same-origin',headers:{'Accept':'text/html'}}).then(function(r){return r.text()}).then(function(html){
      var next=new DOMParser().parseFromString(html,'text/html').getElementById('main'), cur=byId('main');
      if(!next||!cur){location.reload();return}
      cur.innerHTML=next.innerHTML;init();if(msg)App.showSuccess(msg);
    }).catch(function(){location.reload()});
  }
  function init(){
    var cb=byId('cancel-case-btn'), box=byId('cancel-confirm');
    if(cb&&box){
      cb.addEventListener('click',function(){box.hidden=false;cb.setAttribute('aria-expanded','true');byId('confirm-cancel-btn').focus()});
      byId('dismiss-cancel-btn').addEventListener('click',function(){box.hidden=true;cb.setAttribute('aria-expanded','false');cb.focus()});
      byId('confirm-cancel-btn').addEventListener('click',function(){
        var b=this;b.disabled=true;
        App.api('POST','/api/cases/'+encodeURIComponent(no)+'/cancel').then(function(r){if(r.ok)refresh('ยกเลิกคำขอแล้ว');else b.disabled=false});
      });
    }
    var fb=byId('submit-fix-btn');
    if(fb){
      fb.addEventListener('click',function(){
        var inp=byId('fix-upload-input'), body;
        if(inp&&inp.files&&inp.files.length){body=new FormData();body.append('file',inp.files[0],inp.files[0].name)}
        fb.disabled=true;
        App.api('POST','/api/cases/'+encodeURIComponent(no)+'/resubmit',body).then(function(r){if(r.ok)refresh('ส่งแก้ไขเอกสารแล้ว');else fb.disabled=false});
      });
    }
  }
  init();
})();
</script>`;
}

module.exports = { home, homeScript, wizard, wizardScript, caseDetail, caseScript, EVENT_TH, NO_REFUND };
