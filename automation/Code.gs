const SHEET_NAME = 'Enquiries';
const HEADERS = ['Received at', 'Name', 'Email', 'Studio', 'Website', 'Plan', 'Message', 'Status', 'Follow-up at', 'Follow-up sent at'];
const MAX_FOLLOW_UPS_PER_RUN = 50;
const FOLLOW_UP_DELAY_MS = 24 * 60 * 60 * 1000;

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
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  sheet.setFrozenRows(1);

  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === 'sendDueFollowUps_') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('sendDueFollowUps_').timeBased().everyHours(1).create();
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
  sheet.appendRow([
    now,
    safeCell_(lead.name),
    safeCell_(lead.email),
    safeCell_(lead.studio),
    safeCell_(lead.website),
    lead.plan,
    safeCell_(lead.message),
    'new',
    new Date(now.getTime() + FOLLOW_UP_DELAY_MS),
    ''
  ]);
  return true;
}

function isRecentDuplicate_(sheet, email, now) {
  if (sheet.getLastRow() < 2) return false;
  const rows = sheet.getDataRange().getValues();
  let checked = 0;
  for (let index = rows.length - 1; index >= 1 && checked < 25; index -= 1, checked += 1) {
    const receivedAt = new Date(rows[index][0]);
    const rowEmail = String(rows[index][2]).replace(/^'/, '').toLowerCase();
    if (rowEmail === email && now.getTime() - receivedAt.getTime() < 10 * 60 * 1000) return true;
  }
  return false;
}

function sendDueFollowUps_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getLeadSheet_();
    if (sheet.getLastRow() < 2) return;
    const rows = sheet.getDataRange().getValues();
    const now = new Date();
    let sent = 0;

    for (let index = 1; index < rows.length && sent < MAX_FOLLOW_UPS_PER_RUN; index += 1) {
      const status = String(rows[index][7]).toLowerCase();
      const followUpAt = new Date(rows[index][8]);
      const alreadySent = rows[index][9];
      const isDue = !Number.isNaN(followUpAt.getTime()) && followUpAt <= now;
      if (status !== 'new' || !isDue || alreadySent) continue;

      const lead = {
        name: String(rows[index][1]).replace(/^'/, ''),
        email: String(rows[index][2]).replace(/^'/, ''),
        studio: String(rows[index][3]).replace(/^'/, ''),
        plan: String(rows[index][5])
      };

      try {
        sendCustomerFollowUp_(lead);
        sheet.getRange(index + 1, 8).setValue('followed-up');
        sheet.getRange(index + 1, 10).setValue(now);
        sent += 1;
      } catch (error) {
        console.error('Follow-up failed for row ' + (index + 1) + ': ' + error);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function sendCustomerReply_(lead) {
  MailApp.sendEmail({
    to: lead.email,
    name: 'Handoff',
    subject: 'Your Handoff ' + planName_(lead.plan) + ' fit review',
    textBody: 'Hi ' + lead.name + ',\n\n' +
      'We received your ' + planName_(lead.plan) + ' request for ' + lead.studio + '.\n\n' +
      'The next step is a fit review of the existing form and workflow. There is no charge or commitment from submitting this request. If it fits the standard installation, you will receive the scope and next step before any invoice.\n\n' +
      'Reply to this email if you need to add a detail.\n\n— Handoff'
  });
}

function sendCustomerFollowUp_(lead) {
  MailApp.sendEmail({
    to: lead.email,
    name: 'Handoff',
    subject: 'Still considering the Handoff pilot?',
    textBody: 'Hi ' + lead.name + ',\n\n' +
      'This is one follow-up about your ' + planName_(lead.plan) + ' request for ' + lead.studio + '.\n\n' +
      'If you still want the fit review, reply with the best link to the existing quote form. If the timing is wrong, no action is needed; this is the only scheduled follow-up.\n\n— Handoff'
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
      '\n\nReview the form before quoting custom work. Change the sheet Status from new when you take ownership so the scheduled follow-up stops.'
  });
}

function planName_(plan) {
  return plan === 'agency' ? 'agency pilot' : 'guided installation';
}

function getLeadSheet_() {
  const sheet = SpreadsheetApp.openById(requireProperty_('SHEET_ID')).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('The Enquiries sheet is missing. Run setup again.');
  return sheet;
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

function htmlPage_(title, message) {
  const safeTitle = escapeHtml_(title);
  const safeMessage = escapeHtml_(message);
  return HtmlService.createHtmlOutput(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
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
