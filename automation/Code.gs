const SHEET_NAME = 'Enquiries';
const HEADERS = [
  'Received at', 'Name', 'Email', 'Studio', 'Website', 'Plan', 'Message', 'Status',
  'Next follow-up at', 'Follow-ups sent', 'Unsubscribe token', 'Payment link sent at'
];
const COL = {
  receivedAt: 1, name: 2, email: 3, studio: 4, website: 5, plan: 6, message: 7,
  status: 8, nextFollowUpAt: 9, followUpsSent: 10, unsubscribeToken: 11, paymentSentAt: 12
};
const MAX_FOLLOW_UPS_PER_RUN = 50;
const FOLLOW_UP_STEPS = [
  { afterMs: 24 * 60 * 60 * 1000 },
  { afterMs: 48 * 60 * 60 * 1000 },
  { afterMs: 96 * 60 * 60 * 1000 }
];
const AUTOMATION_STATUS = 'new';

function setup() {
  const properties = PropertiesService.getScriptProperties();
  requireProperty_('OWNER_EMAIL');

  let spreadsheet;
  const existingId = properties.getProperty('SHEET_ID');
  if (existingId) {
    spreadsheet = SpreadsheetApp.openById(existingId);
  } else {
    spreadsheet = SpreadsheetApp.create('Handoff Pilot Enquiries');
    properties.setProperty('SHEET_ID', spreadsheet.getId());
  }

  const sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
  } else {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  sheet.setFrozenRows(1);

  ScriptApp.getProjectTriggers().forEach((trigger) => {
    const handler = trigger.getHandlerFunction();
    if (handler === 'runAutomation_' || handler === 'sendDueFollowUps_') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('runAutomation_').timeBased().everyHours(1).create();
  Logger.log('Enquiry sheet: ' + spreadsheet.getUrl());
}

function doPost(event) {
  try {
    const contents = event && event.postData && event.postData.contents ? event.postData.contents : '';
    if (contents.length > 12000) return htmlPage_('Request too large', 'Shorten the message and try again.');

    const parameters = event && event.parameter ? event.parameter : {};
    if (String(parameters.company_website || '').trim()) {
      return htmlPage_('Request received', 'Thanks. Your request has been received.');
    }

    const validation = validateLead_(parameters, new Date());
    if (!validation.ok) return htmlPage_('Check your request', validation.error);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let isNew;
    try {
      isNew = appendLeadIfNew_(validation.lead, new Date());
    } finally {
      lock.releaseLock();
    }

    if (isNew) {
      sendCustomerReply_(validation.lead);
      notifyOwner_(validation.lead);
    }

    return htmlPage_(
      'Request received',
      'Thanks, ' + validation.lead.name + '. Your fit review request is in. Handoff will review the site and workflow before any invoice or commitment.'
    );
  } catch (error) {
    console.error(error);
    return htmlPage_('Something went wrong', 'Your request could not be completed. Return to Handoff and try again.');
  }
}

function doGet(event) {
  try {
    const parameters = event && event.parameter ? event.parameter : {};
    const token = String(parameters.unsubscribe || '').trim();
    if (!token) return htmlPage_('Not found', 'This link is incomplete.');
    if (!/^[a-f0-9-]{8,64}$/i.test(token)) return htmlPage_('Not found', 'This link is not valid.');

    const sheet = getLeadSheet_();
    const rows = sheet.getDataRange().getValues();
    for (let index = 1; index < rows.length; index += 1) {
      if (String(rows[index][COL.unsubscribeToken - 1] || '').trim() !== token) continue;
      const name = String(rows[index][COL.name - 1]).replace(/^'/, '');
      if (String(parameters.confirm || '') !== '1') {
        return htmlLinkPage_(
          'Stop emailing me?',
          'Confirm that Handoff should stop sending reminder emails to ' + name + '.',
          confirmLink_(token),
          'Unsubscribe'
        );
      }
      sheet.getRange(index + 1, COL.status).setValue('unsubscribed');
      sheet.getRange(index + 1, COL.nextFollowUpAt).setValue('');
      return htmlPage_('Unsubscribed', 'Done. No further emails will be sent to this address.');
    }
    return htmlPage_('Not found', 'This address is not on the list.');
  } catch (error) {
    console.error(error);
    return htmlPage_('Something went wrong', 'The request could not be completed.');
  }
}

function runAutomation_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getLeadSheet_();
    if (sheet.getLastRow() < 2) return;
    const rows = sheet.getDataRange().getValues();
    const now = new Date();
    let sent = 0;

    for (let index = 1; index < rows.length && sent < MAX_FOLLOW_UPS_PER_RUN; index += 1) {
      const status = String(rows[index][COL.status - 1] || '').trim().toLowerCase();
      const row = index + 1;

      if (status === AUTOMATION_STATUS) {
        const nextAt = new Date(rows[index][COL.nextFollowUpAt - 1]);
        if (Number.isNaN(nextAt.getTime()) || nextAt > now) continue;
        const stepIndex = getFollowUpCount_(rows[index][COL.followUpsSent - 1]);
        if (stepIndex >= FOLLOW_UP_STEPS.length) continue;

        const lead = leadFromRow_(rows[index]);
        try {
          sendFollowUp_(lead, stepIndex);
          const nextStep = FOLLOW_UP_STEPS[stepIndex + 1];
          sheet.getRange(row, COL.followUpsSent).setValue(stepIndex + 1);
          sheet.getRange(row, COL.nextFollowUpAt).setValue(nextStep ? new Date(now.getTime() + nextStep.afterMs) : '');
          if (!nextStep) sheet.getRange(row, COL.status).setValue('followed-up');
          sent += 1;
        } catch (error) {
          console.error('Follow-up failed for row ' + row + ': ' + error);
        }
        continue;
      }

      if (status === 'qualified' && !rows[index][COL.paymentSentAt - 1]) {
        const checkoutUrl = getPropertyOrEmpty_('CHECKOUT_URL');
        if (!checkoutUrl) continue;
        try {
          sendPaymentLink_(leadFromRow_(rows[index]), checkoutUrl);
          sheet.getRange(row, COL.paymentSentAt).setValue(now);
          sheet.getRange(row, COL.status).setValue('invoiced');
        } catch (error) {
          console.error('Payment link failed for row ' + row + ': ' + error);
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function validateLead_(input, now) {
  const lead = {
    name: String(input.name || '').trim(),
    email: String(input.email || '').trim().toLowerCase(),
    studio: String(input.studio || '').trim(),
    website: String(input.website || '').trim(),
    plan: String(input.plan || '').trim(),
    message: String(input.message || '').trim()
  };

  if (input.consent !== 'yes') return { ok: false, error: 'Confirm that Handoff may respond to this enquiry.' };
  if (lead.name.length < 2 || lead.name.length > 80 || hasLineBreak_(lead.name)) {
    return { ok: false, error: 'Enter a name using 2 to 80 characters on one line.' };
  }
  if (!isValidEmail_(lead.email)) return { ok: false, error: 'Enter a valid email address.' };
  if (lead.studio.length < 2 || lead.studio.length > 100 || hasLineBreak_(lead.studio)) {
    return { ok: false, error: 'Enter a studio or business name using 2 to 100 characters.' };
  }
  if (lead.website && (lead.website.length > 200 || !/^https?:\/\/[^\s]+$/i.test(lead.website))) {
    return { ok: false, error: 'Use a complete http:// or https:// website address, or leave it empty.' };
  }
  if (!['guided', 'agency'].includes(lead.plan)) return { ok: false, error: 'Choose an installation or agency pilot.' };
  if (lead.message.length > 1200 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(lead.message)) {
    return { ok: false, error: 'The note is too long or contains unsupported characters.' };
  }

  const startedAt = Number(input.formStartedAt);
  const elapsed = now.getTime() - startedAt;
  if (!Number.isFinite(startedAt) || elapsed < 2000 || elapsed > 2 * 60 * 60 * 1000) {
    return { ok: false, error: 'This form has expired. Refresh Handoff and try again.' };
  }

  return { ok: true, lead };
}

function appendLeadIfNew_(lead, now) {
  const sheet = getLeadSheet_();
  if (isRecentDuplicate_(sheet, lead.email, now)) return false;
  lead.token = newToken_();
  sheet.appendRow([
    now,
    safeCell_(lead.name),
    safeCell_(lead.email),
    safeCell_(lead.studio),
    safeCell_(lead.website),
    lead.plan,
    safeCell_(lead.message),
    AUTOMATION_STATUS,
    new Date(now.getTime() + FOLLOW_UP_STEPS[0].afterMs),
    0,
    lead.token,
    ''
  ]);
  return true;
}

function isRecentDuplicate_(sheet, email, now) {
  if (sheet.getLastRow() < 2) return false;
  const rows = sheet.getDataRange().getValues();
  let checked = 0;
  for (let index = rows.length - 1; index >= 1 && checked < 25; index -= 1, checked += 1) {
    const receivedAt = new Date(rows[index][COL.receivedAt - 1]);
    const rowEmail = String(rows[index][COL.email - 1]).replace(/^'/, '').toLowerCase();
    if (rowEmail === email && now.getTime() - receivedAt.getTime() < 10 * 60 * 1000) return true;
  }
  return false;
}

function getFollowUpCount_(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function leadFromRow_(row) {
  const token = String(row[COL.unsubscribeToken - 1] || '').trim();
  return {
    name: String(row[COL.name - 1]).replace(/^'/, ''),
    email: String(row[COL.email - 1]).replace(/^'/, ''),
    studio: String(row[COL.studio - 1]).replace(/^'/, ''),
    website: String(row[COL.website - 1]).replace(/^'/, ''),
    plan: String(row[COL.plan - 1]),
    token
  };
}

function sendCustomerReply_(lead) {
  MailApp.sendEmail({
    to: lead.email,
    name: 'Handoff',
    subject: 'Your Handoff ' + planName_(lead.plan) + ' fit review',
    textBody: 'Hi ' + lead.name + ',\n\n' +
      'We received your ' + planName_(lead.plan) + ' request for ' + lead.studio + '.\n\n' +
      'The next step is a fit review of the existing form and workflow. There is no charge or commitment from submitting this request. If it fits the standard installation, you will receive the scope and next step before any invoice.\n\n' +
      'Reply to this email if you need to add a detail.\n' +
      optOut_(lead)
  });
}

function sendFollowUp_(lead, stepIndex) {
  const bodies = [
    'Quick check on the Handoff ' + planName_(lead.plan) + ' request for ' + lead.studio + '.\n\n' +
      'The fit review starts with one thing: the link to the quote form you already have. Send it and you will get a short written assessment of whether the standard installation applies.\n\n' +
      'No charge and no commitment at that stage.',
    'One detail that decides most fit reviews: whether the quote form has a fixed set of services with known field names.\n\n' +
      'If it does, installation is a single script tag plus a configuration file, and the customer still reviews and submits every request. If it does not, the honest answer is that it needs custom work first.\n\n' +
      'If you want that assessment, reply with the form link.',
    'Closing the loop on this one.\n\n' +
      'If the timing is wrong, ignore this and nothing else arrives. If a customer ever asks whether your site can be quoted by an AI agent, the answer will depend on work done before that question is asked.\n\n' +
      'The form link is all the fit review needs.'
  ];
  MailApp.sendEmail({
    to: lead.email,
    name: 'Handoff',
    subject: stepIndex === 2 ? 'Closing the loop on your Handoff request' : 'Handoff fit review for ' + lead.studio,
    textBody: 'Hi ' + lead.name + ',\n\n' + bodies[stepIndex] + '\n' + optOut_(lead)
  });
}

function sendPaymentLink_(lead, checkoutUrl) {
  MailApp.sendEmail({
    to: lead.email,
    name: 'Handoff',
    subject: 'Your Handoff ' + planName_(lead.plan) + ' — next step',
    textBody: 'Hi ' + lead.name + ',\n\n' +
      'Your form qualified for the standard Handoff installation.\n\n' +
      'Start here: ' + checkoutUrl + '\n\n' +
      'After payment you will receive the installation steps, the configuration file for ' + lead.studio + ', and the generated handoff.js. Reply to this email if anything about the scope is unclear before you pay.\n' +
      optOut_(lead)
  });
}

function notifyOwner_(lead) {
  MailApp.sendEmail({
    to: requireProperty_('OWNER_EMAIL'),
    name: 'Handoff',
    subject: 'New ' + planName_(lead.plan) + ' request: ' + lead.studio,
    textBody: 'A new Handoff fit-review request arrived.\n\n' +
      'Name: ' + lead.name + '\nStudio: ' + lead.studio + '\nEmail: ' + lead.email +
      '\nWebsite: ' + (lead.website || 'Not provided') + '\nPlan: ' + planName_(lead.plan) +
      '\n\nNote:\n' + (lead.message || 'Not provided') +
      '\n\nAutomation: three reminder emails are scheduled. Changing Status away from new stops them. ' +
      'Set Status to qualified to send the payment link automatically' +
      (getPropertyOrEmpty_('CHECKOUT_URL') ? '.' : ' (add a CHECKOUT_URL script property first).') +
      '\n\nReview the form before quoting custom work.'
  });
}

function optOut_(lead) {
  const url = unsubscribeUrl_(lead.token);
  return '\n\n— Handoff\n\nStop these emails: ' + url + '\n';
}

function unsubscribeUrl_(token) {
  if (!token) return getPropertyOrEmpty_('SITE_URL') || 'https://handofftool.com/';
  const base = String(ScriptApp.getService().getUrl() || getPropertyOrEmpty_('SITE_URL') || '').trim();
  if (!base) return 'https://handofftool.com/';
  return base + '?unsubscribe=' + encodeURIComponent(token);
}

function confirmLink_(token) {
  return unsubscribeUrl_(token) + '&confirm=1';
}

function planName_(plan) {
  return plan === 'agency' ? 'agency pilot' : 'guided installation';
}

function getLeadSheet_() {
  const sheet = SpreadsheetApp.openById(requireProperty_('SHEET_ID')).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('The Enquiries sheet is missing. Run setup again.');
  return sheet;
}

function newToken_() {
  return String(Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
}

function getPropertyOrEmpty_(name) {
  try {
    return String(PropertiesService.getScriptProperties().getProperty(name) || '').trim();
  } catch (error) {
    return '';
  }
}

function requireProperty_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value || !value.trim()) throw new Error('Missing Script Property: ' + name);
  return value.trim();
}

function isValidEmail_(email) {
  return email.length <= 160 && !hasLineBreak_(email) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hasLineBreak_(value) {
  return /[\r\n]/.test(value);
}

function safeCell_(value) {
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

function htmlLinkPage_(title, message, href, label) {
  const safeTitle = escapeHtml_(title);
  const safeMessage = escapeHtml_(message).replace(/\n/g, '<br>');
  const safeHref = escapeHtml_(href);
  return HtmlService.createHtmlOutput(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<title>' + safeTitle + '</title></head>' +
    '<body style="margin:0;padding:24px;display:grid;place-items:center;min-height:90vh;background:#f6f5ef;color:#19192b;font-family:system-ui,sans-serif">' +
    '<main style="max-width:560px;padding:36px;background:white;border:1px solid #dcdce2;border-radius:20px">' +
    '<p style="font-size:12px;font-weight:800;letter-spacing:.12em;color:#6d6ddb">HANDOFF</p>' +
    '<h1 style="font-family:Georgia,serif;font-weight:500">' + safeTitle + '</h1>' +
    '<p style="line-height:1.7;color:#696879">' + safeMessage + '</p>' +
    '<p><a href="' + safeHref + '" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#19192b;color:#fff;text-decoration:none;font-weight:700">' + escapeHtml_(label) + '</a></p>' +
    '</main></body></html>'
  ).setTitle(title);
}

function htmlPage_(title, message) {
  const safeTitle = escapeHtml_(title);
  const safeMessage = escapeHtml_(message).replace(/\n/g, '<br>');
  return HtmlService.createHtmlOutput(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<title>' + safeTitle + '</title></head>' +
    '<body style="margin:0;padding:24px;display:grid;place-items:center;min-height:90vh;background:#f6f5ef;color:#19192b;font-family:system-ui,sans-serif">' +
    '<main style="max-width:560px;padding:36px;background:white;border:1px solid #dcdce2;border-radius:20px">' +
    '<p style="font-size:12px;font-weight:800;letter-spacing:.12em;color:#6d6ddb">HANDOFF</p>' +
    '<h1 style="font-family:Georgia,serif;font-weight:500">' + safeTitle + '</h1>' +
    '<p style="line-height:1.7;color:#696879">' + safeMessage + '</p></main></body></html>'
  ).setTitle(title);
}

function escapeHtml_(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}
