'use strict';

const { brotliDecompressSync } = require('node:zlib');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const VERIFY_LABELS = {
  VALID: 'เอกสารถูกต้อง',
  EXPIRED: 'เอกสารหมดอายุ',
  TAMPERED: 'ลายเซ็นไม่ถูกต้อง',
  NOT_FOUND: 'ไม่พบเอกสาร',
};

function lastValidDay(clock, issuedAt, serviceId) {
  if (serviceId === 'SV-01') return clock.addDays(clock.ymd(issuedAt), 89);

  const { y, m, d } = clock.parts(issuedAt);
  let anniversary = clock.fromParts(y + 1, m, d);
  if (clock.parts(anniversary).m !== m) anniversary = clock.fromParts(y + 1, m, 28);
  return clock.addDays(clock.ymd(anniversary), -1);
}

function verificationDetails(verification, views) {
  const { esc, timeTag, serviceLabel } = views;
  const { docNo, applicantMasked, serviceId, issuedAt, validUntil, signer } = verification;
  return `<dl class="kv">
    <dt>เลขเอกสาร</dt><dd data-testid="verify-doc-no">${esc(docNo)}</dd>
    <dt>ชื่อผู้ยื่น</dt><dd data-testid="verify-applicant">${esc(applicantMasked)}</dd>
    <dt>บริการ</dt><dd data-testid="verify-service">${esc(serviceLabel(serviceId))}</dd>
    <dt>วันออก</dt><dd>${timeTag(issuedAt, 'verify-issued')}</dd>
    <dt>ใช้ได้ถึง</dt><dd>${timeTag(validUntil, 'verify-expires', { dateOnly: true })}</dd>
    <dt>ผู้ลงนาม</dt><dd data-testid="verify-signer">${esc(signer)}</dd>
  </dl>`;
}

module.exports = function registerDocuments(app, ctx) {
  const { db, dbm, clock, crypto, audit, views, render, apiError, requireRole, wrap, config } = ctx;
  const docFields = `doc_no AS docNo, case_no AS caseNo, applicant, service_id AS serviceId,
    issued_at AS issuedAt, valid_until AS validUntil, signer, verify_code AS verifyCode, signature`;
  const byCode = db.prepare(`SELECT ${docFields} FROM documents WHERE verify_code = ?`);
  const byNumber = db.prepare(`SELECT ${docFields} FROM documents WHERE doc_no = ?`);
  const insertDoc = db.prepare(`INSERT INTO documents
    (doc_no, case_no, applicant, service_id, issued_at, valid_until, signer, verify_code, signature, issued_by)
    VALUES (@docNo, @caseNo, @applicant, @serviceId, @issuedAt, @validUntil, @signer, @verifyCode, @signature, @issuedBy)`);
  const completeCase = db.prepare(`UPDATE cases
    SET status = 'COMPLETED', doc_no = @docNo, closed_at = @issuedAt, updated_at = @issuedAt,
        dept = NULL, owner = NULL
    WHERE case_no = @caseNo`);
  const tamperDoc = db.prepare("UPDATE documents SET applicant = applicant || ' (แก้ไข)' WHERE doc_no = ?");

  const issue = db.transaction((req) => {
    const { caseNo } = req.params;
    const row = dbm.getCase(caseNo);
    if (!row) return { error: 'NOT_FOUND' };

    const issuer = row.service_id === 'SV-01' ? (row.approved_by ?? row.issuer) : row.issuer;
    if (req.user.username !== issuer) return { error: 'FORBIDDEN' };
    if (row.status !== 'APPROVED' || !row.approved_by) return { error: 'INVALID_STATE' };

    let verifyCode;
    do {
      verifyCode = crypto.randomVerifyCode();
    } while (byCode.get(verifyCode));

    const issuedAt = clock.nowISO();
    const { docNo } = dbm.next.docNo(issuedAt);
    const doc = {
      docNo,
      caseNo,
      applicant: dbm.getUserById(row.user_id).name,
      serviceId: row.service_id,
      issuedAt,
      validUntil: lastValidDay(clock, issuedAt, row.service_id),
      signer: dbm.staffName(row.approved_by),
      verifyCode,
    };
    insertDoc.run({ ...doc, signature: crypto.signDocument(doc), issuedBy: req.user.username });
    completeCase.run(doc);
    audit.log(req, { event: 'ISSUE', caseNo, from: 'APPROVED', to: 'COMPLETED', detail: docNo, time: issuedAt });
    return { docNo, verifyCode, status: 'COMPLETED' };
  });

  function verify(code) {
    const doc = byCode.get(code);
    if (!doc) return { result: 'NOT_FOUND' };
    if (doc.signature.length !== 64 || !/^[0-9a-f]+$/i.test(doc.signature) || !crypto.verifyDocumentSignature(doc, doc.signature)) {
      return { result: 'TAMPERED' };
    }

    const { docNo, applicant, serviceId, issuedAt, validUntil, signer } = doc;
    const name = applicant.trim();
    return {
      result: clock.ymd() > validUntil ? 'EXPIRED' : 'VALID',
      docNo,
      applicantMasked: /\s/.test(name) ? crypto.maskName(name) : `${name} ***`,
      serviceId,
      issuedAt,
      validUntil,
      signer,
    };
  }

  app.post('/api/officer/cases/:caseNo/issue', requireRole('officer'), (req, res) => {
    const result = issue.immediate(req);
    if (result.error) return apiError(res, result.error);
    return res.json(result);
  });

  app.get('/verify/:code', (req, res) => {
    const verification = verify(req.params.code);
    const { result, docNo } = verification;
    const label = VERIFY_LABELS[result];
    return render(req, res, {
      title: 'ตรวจสอบเอกสาร',
      status: result === 'NOT_FOUND' ? 404 : 200,
      body: `<section class="card">
        <h1 data-testid="verify-result" data-result="${result}">${label}</h1>
        ${docNo ? verificationDetails(verification, views) : ''}
      </section>`,
    });
  });

  app.get('/api/verify/:code', (req, res) => {
    const verification = verify(req.params.code);
    return res.status(verification.result === 'NOT_FOUND' ? 404 : 200).json(verification);
  });

  app.get('/api/documents/:docNo/pdf', wrap(async (req, res) => {
    const user = req.user;
    const isStaff = user?.role === 'officer' || user?.role === 'head';
    const isCitizen = user?.role === 'citizen' && user.registered;
    if (!isStaff && !isCitizen) return apiError(res, 'NOT_FOUND');

    const doc = byNumber.get(req.params.docNo);
    if (!doc || (isCitizen && dbm.getCase(doc.caseNo)?.user_id !== user.id)) return apiError(res, 'NOT_FOUND');

    const pdf = await makePdf(doc, ctx);
    return res.attachment(`${doc.docNo}.pdf`).type('application/pdf').send(pdf);
  }));

  app.post('/api/test/documents/:docNo/tamper', (req, res) => {
    if (!tamperDoc.run(req.params.docNo).changes) return apiError(res, 'NOT_FOUND');
    return res.json({ ok: true });
  });
};

async function makePdf(doc, { clock, views, config }) {
  const { docNo, caseNo, applicant, serviceId, issuedAt, validUntil, signer, verifyCode, signature } = doc;
  const qrUrl = `${config.BASE_URL}/verify/${verifyCode}`;
  const qr = await QRCode.toBuffer(qrUrl);
  const pdf = new PDFDocument({
    size: 'A4',
    info: {
      Title: docNo,
      Subject: `docNo=${docNo} caseNo=${caseNo} verify=${verifyCode} validUntil=${validUntil}`,
      Keywords: `HMAC-SHA256 ${signature}`,
      CreationDate: new Date(clock.toMs(issuedAt)),
    },
  });

  return new Promise((resolve, reject) => {
    const chunks = [];
    pdf.on('data', (chunk) => chunks.push(chunk));
    pdf.once('end', () => resolve(Buffer.concat(chunks)));
    pdf.once('error', reject);

    pdf.font(SARABUN_FONT).fontSize(20).text('เอกสารดิจิทัล เทศบาลนครก็อตแทม');
    pdf.moveDown().fontSize(13)
      .text(`เลขเอกสาร: ${docNo}`)
      .text(`เลขคำขอ: ${caseNo}`)
      .text(`ชื่อผู้ยื่น: ${applicant}`)
      .text(`บริการ: ${views.serviceLabel(serviceId)}`)
      .text(`วันออก: ${clock.fmtThai(issuedAt)}`)
      .text(`ใช้ได้ถึง: ${clock.fmtThaiDate(validUntil)}`)
      .text(`ผู้ลงนาม: ${signer}`)
      .text(`รหัสตรวจสอบ: ${verifyCode}`)
      .moveDown().image(qr, { width: 128, link: qrUrl });
    pdf.moveDown().text(qrUrl, { link: qrUrl });
    pdf.end();
  });
}

/**
 * Sarabun Regular TrueType, limited to printable ASCII and Thai, with en/em dashes.
 * Served by the Google Fonts CSS API from the Sarabun project.
 * Compressed with Brotli and embedded here for PDF rendering in the slim Docker image.
 *
 * Copyright 2018 The Sarabun Project Authors (https://github.com/cadsondemak/Sarabun)
 *
 * This Font Software is licensed under the SIL Open Font License, Version 1.1.
 * This license is copied below, and is also available with a FAQ at:
 * http://scripts.sil.org/OFL
 *
 *
 * -----------------------------------------------------------
 * SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
 * -----------------------------------------------------------
 *
 * PREAMBLE
 * The goals of the Open Font License (OFL) are to stimulate worldwide
 * development of collaborative font projects, to support the font creation
 * efforts of academic and linguistic communities, and to provide a free and
 * open framework in which fonts may be shared and improved in partnership
 * with others.
 *
 * The OFL allows the licensed fonts to be used, studied, modified and
 * redistributed freely as long as they are not sold by themselves. The
 * fonts, including any derivative works, can be bundled, embedded, 
 * redistributed and/or sold with any software provided that any reserved
 * names are not used by derivative works. The fonts and derivatives,
 * however, cannot be released under any other type of license. The
 * requirement for fonts to remain under this license does not apply
 * to any document created using the fonts or their derivatives.
 *
 * DEFINITIONS
 * "Font Software" refers to the set of files released by the Copyright
 * Holder(s) under this license and clearly marked as such. This may
 * include source files, build scripts and documentation.
 *
 * "Reserved Font Name" refers to any names specified as such after the
 * copyright statement(s).
 *
 * "Original Version" refers to the collection of Font Software components as
 * distributed by the Copyright Holder(s).
 *
 * "Modified Version" refers to any derivative made by adding to, deleting,
 * or substituting -- in part or in whole -- any of the components of the
 * Original Version, by changing formats or by porting the Font Software to a
 * new environment.
 *
 * "Author" refers to any designer, engineer, programmer, technical
 * writer or other person who contributed to the Font Software.
 *
 * PERMISSION & CONDITIONS
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of the Font Software, to use, study, copy, merge, embed, modify,
 * redistribute, and sell modified and unmodified copies of the Font
 * Software, subject to the following conditions:
 *
 * 1) Neither the Font Software nor any of its individual components,
 * in Original or Modified Versions, may be sold by itself.
 *
 * 2) Original or Modified Versions of the Font Software may be bundled,
 * redistributed and/or sold with any software, provided that each copy
 * contains the above copyright notice and this license. These can be
 * included either as stand-alone text files, human-readable headers or
 * in the appropriate machine-readable metadata fields within text or
 * binary files as long as those fields can be easily viewed by the user.
 *
 * 3) No Modified Version of the Font Software may use the Reserved Font
 * Name(s) unless explicit written permission is granted by the corresponding
 * Copyright Holder. This restriction only applies to the primary font name as
 * presented to the users.
 *
 * 4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
 * Software shall not be used to promote, endorse or advertise any
 * Modified Version, except to acknowledge the contribution(s) of the
 * Copyright Holder(s) and the Author(s) or with their explicit written
 * permission.
 *
 * 5) The Font Software, modified or unmodified, in part or in whole,
 * must be distributed entirely under this license, and must not be
 * distributed under any other license. The requirement for fonts to
 * remain under this license does not apply to any document created
 * using the Font Software.
 *
 * TERMINATION
 * This license becomes null and void if any of the above conditions are
 * not met.
 *
 * DISCLAIMER
 * THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
 * OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
 * COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 * INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
 * DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
 * OTHER DEALINGS IN THE FONT SOFTWARE.
 */
const SARABUN_FONT = brotliDecompressSync(Buffer.from(`
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
`, 'base64'));
