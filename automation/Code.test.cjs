const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');
const headerRow = [
  'Received at', 'Name', 'Email', 'Studio', 'Website', 'Plan', 'Message', 'Status',
  'Next follow-up at', 'Follow-ups sent', 'Unsubscribe token', 'Payment link sent at'
];

function createSheet(rows = [headerRow.slice()]) {
  const sheet = {
    rows,
    frozenRows: 0,
    appendRow(row) { this.rows.push(row); },
    getLastRow() { return this.rows.length; },
    getDataRange() { return { getValues: () => this.rows.map((row) => row.slice()) }; },
    setFrozenRows(value) { this.frozenRows = value; }
  };
  sheet.getRange = (row, column, numRows = 1, numColumns = 1) => ({
    setValue(value) { sheet.rows[row - 1][column - 1] = value; },
    setValues(values) {
      values.forEach((line, rowOffset) => {
        const target = row - 1 + rowOffset;
        if (!sheet.rows[target]) sheet.rows[target] = [];
        line.forEach((value, columnOffset) => {
          sheet.rows[target][column - 1 + columnOffset] = value;
        });
      });
    }
  });
  return sheet;
}

function loadAutomation(options = {}) {
  const sheet = options.sheet || createSheet();
  const sent = [];
  const errors = [];
  const properties = new Map(Object.entries({
    OWNER_EMAIL: 'owner@example.com',
    SHEET_ID: 'sheet-1',
    ...options.properties
  }));
  const triggers = options.triggers || [];
  const createdTriggers = [];
  const deletedTriggers = [];
  let uuidCounter = 0;
  const spreadsheet = {
    getId: () => 'new-sheet-id',
    getUrl: () => 'https://sheets.example/new-sheet-id',
    getSheetByName: (name) => name === 'Enquiries' ? sheet : null,
    insertSheet: () => sheet
  };
  const context = {
    Date,
    console: { error: (message) => errors.push(String(message)) },
    Logger: { log: () => {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties.get(key) || null,
        setProperty: (key, value) => properties.set(key, value)
      })
    },
    SpreadsheetApp: { openById: () => spreadsheet, create: () => spreadsheet },
    MailApp: {
      sendEmail: (message) => {
        if (options.failMail) throw new Error('Mail unavailable');
        sent.push(message);
      }
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => '00000000-0000-4000-8000-' + String(++uuidCounter).padStart(12, '0')
    },
    HtmlService: {
      createHtmlOutput: (content) => ({
        content,
        setTitle(title) { this.title = title; return this; }
      })
    },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.example/exec' }),
      getProjectTriggers: () => triggers,
      deleteTrigger: (trigger) => deletedTriggers.push(trigger),
      newTrigger: (handler) => ({
        handler,
        timeBased() { return this; },
        everyHours(hours) { this.hours = hours; return this; },
        create() { createdTriggers.push(this); return this; }
      })
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, sheet, sent, errors, properties, createdTriggers, deletedTriggers };
}

function validParameters(overrides = {}) {
  return {
    name: 'Maya Chen',
    email: 'Maya@Example.com',
    studio: 'Northstar Studio',
    website: 'https://studio.example',
    plan: 'agency',
    message: 'Three existing client quote forms.',
    consent: 'yes',
    formStartedAt: String(Date.now() - 10000),
    company_website: '',
    ...overrides
  };
}

function post(parameters) {
  return { parameter: parameters, postData: { contents: new URLSearchParams(parameters).toString() } };
}

function leadRow(overrides = {}) {
  const now = Date.now();
  const row = [
    new Date(now - 90000000), 'Due Lead', 'due@example.com', 'Studio', '', 'guided', '',
    'new', new Date(now - 1000), 0, 'abc00000000000000000000000000001', ''
  ];
  Object.entries(overrides).forEach(([index, value]) => { row[Number(index)] = value; });
  return row;
}

test('setup creates the enquiry sheet and one hourly automation trigger', () => {
  const sheet = createSheet([]);
  const oldTrigger = { getHandlerFunction: () => 'runAutomation_' };
  const { context, properties, createdTriggers, deletedTriggers } = loadAutomation({
    sheet,
    triggers: [oldTrigger],
    properties: { OWNER_EMAIL: 'owner@example.com', SHEET_ID: '' }
  });
  context.setup();
  assert.equal(properties.get('SHEET_ID'), 'new-sheet-id');
  assert.deepEqual(JSON.parse(JSON.stringify(sheet.rows)), [headerRow]);
  assert.equal(sheet.frozenRows, 1);
  assert.equal(deletedTriggers.length, 1);
  assert.equal(createdTriggers.length, 1);
  assert.equal(createdTriggers[0].hours, 1);
});

test('validation accepts and normalizes a complete opted-in enquiry', () => {
  const { context } = loadAutomation();
  const result = context.validateLead_(validParameters(), new Date());
  assert.equal(result.ok, true);
  assert.equal(result.lead.email, 'maya@example.com');
  assert.equal(result.lead.plan, 'agency');
});

test('validation rejects unsafe or incomplete enquiry boundaries', () => {
  const { context } = loadAutomation();
  const cases = [
    { consent: '' },
    { email: 'not-an-email' },
    { website: 'javascript:alert(1)' },
    { plan: 'enterprise' },
    { formStartedAt: String(Date.now()) },
    { name: 'Maya\nBcc: victim@example.com' },
    { message: 'x'.repeat(1201) }
  ];
  for (const override of cases) {
    assert.equal(context.validateLead_(validParameters(override), new Date()).ok, false);
  }
});

test('a valid request stores the lead with its automation columns and sends both emails', () => {
  const { context, sheet, sent } = loadAutomation();
  const response = context.doPost(post(validParameters({ name: '=HYPERLINK("bad")' })));
  assert.match(response.content, /Request received/);
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.rows[1][1], "'=HYPERLINK(\"bad\")");
  assert.equal(sheet.rows[1][5], 'agency');
  assert.equal(sheet.rows[1][7], 'new');
  assert.equal(sheet.rows[1][9], 0);
  assert.match(String(sheet.rows[1][10]), /^[a-f0-9]{32}$/);
  assert.ok(sheet.rows[1][8] instanceof Date);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, 'maya@example.com');
  assert.equal(sent[1].to, 'owner@example.com');
  assert.doesNotMatch(response.content, /<script/);
});

test('every customer email carries a working opt-out link', () => {
  const { context, sent } = loadAutomation();
  context.doPost(post(validParameters()));
  assert.match(sent[0].textBody, /https:\/\/script\.example\/exec\?unsubscribe=/);
});

test('confirmation HTML escapes user-provided content', () => {
  const { context } = loadAutomation();
  const response = context.doPost(post(validParameters({ name: '<img src=x onerror=alert(1)>' })));
  assert.doesNotMatch(response.content, /<img src=x/);
  assert.match(response.content, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('duplicate submissions within ten minutes do not duplicate leads or emails', () => {
  const { context, sheet, sent } = loadAutomation();
  context.doPost(post(validParameters()));
  context.doPost(post(validParameters()));
  assert.equal(sheet.rows.length, 2);
  assert.equal(sent.length, 2);
});

test('honeypot submissions return a neutral response without side effects', () => {
  const { context, sheet, sent } = loadAutomation();
  const response = context.doPost(post(validParameters({ company_website: 'spam.example' })));
  assert.match(response.content, /Request received/);
  assert.equal(sheet.rows.length, 1);
  assert.equal(sent.length, 0);
});

test('due new enquiries advance one step and stay new until the sequence ends', () => {
  const sheet = createSheet([
    headerRow.slice(),
    leadRow(),
    leadRow({ 1: 'Future Lead', 2: 'future@example.com', 8: new Date(Date.now() + 100000) }),
    leadRow({ 1: 'Qualified Lead', 2: 'qualified@example.com', 7: 'qualified' }),
    leadRow({ 1: 'Closed Lead', 2: 'closed@example.com', 7: 'won' }),
    leadRow({ 1: 'Opted Out', 2: 'out@example.com', 7: 'unsubscribed' })
  ]);
  const { context, sent } = loadAutomation({ sheet });
  context.runAutomation_();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'due@example.com');
  assert.equal(sheet.rows[1][9], 1);
  assert.equal(sheet.rows[1][7], 'new');
  assert.ok(sheet.rows[1][8] instanceof Date);

  context.runAutomation_();
  assert.equal(sent.length, 1, 'a second run must not resend the same step');
});

test('the third follow-up closes the sequence', () => {
  const sheet = createSheet([headerRow.slice(), leadRow({ 9: 2 })]);
  const { context, sheet: resultSheet, sent } = loadAutomation({ sheet });
  context.runAutomation_();
  assert.equal(sent.length, 1);
  assert.equal(resultSheet.rows[1][9], 3);
  assert.equal(resultSheet.rows[1][8], '');
  assert.equal(resultSheet.rows[1][7], 'followed-up');
});

test('a failed follow-up keeps the row eligible so the next run retries', () => {
  const sheet = createSheet([headerRow.slice(), leadRow()]);
  const { context, errors } = loadAutomation({ sheet, failMail: true });
  context.runAutomation_();
  assert.equal(sheet.rows[1][7], 'new');
  assert.equal(sheet.rows[1][9], 0);
  assert.ok(sheet.rows[1][8] instanceof Date);
  assert.equal(errors.length, 1);
});

test('unsubscribe asks for confirmation before changing the row', () => {
  const sheet = createSheet([headerRow.slice(), leadRow()]);
  const { context } = loadAutomation({ sheet });

  const prompt = context.doGet({ parameter: { unsubscribe: 'abc00000000000000000000000000001' } });
  assert.match(prompt.content, /Stop emailing me/);
  assert.match(prompt.content, /confirm=1/);
  assert.equal(sheet.rows[1][7], 'new');

  const done = context.doGet({ parameter: { unsubscribe: 'abc00000000000000000000000000001', confirm: '1' } });
  assert.match(done.content, /Unsubscribed/);
  assert.equal(sheet.rows[1][7], 'unsubscribed');
  assert.equal(sheet.rows[1][8], '');
});

test('an unknown or malformed unsubscribe token does nothing', () => {
  const sheet = createSheet([headerRow.slice(), leadRow()]);
  const { context } = loadAutomation({ sheet });
  assert.match(context.doGet({ parameter: { unsubscribe: 'deadbeefdeadbeefdeadbeefdeadbeef' } }).content, /not on the list/);
  assert.match(context.doGet({ parameter: { unsubscribe: '<script>' } }).content, /not valid/);
  assert.equal(sheet.rows[1][7], 'new');
});

test('qualifying a lead sends the payment link once when a checkout URL exists', () => {
  const sheet = createSheet([headerRow.slice(), leadRow({ 7: 'qualified' })]);
  const { context, sheet: resultSheet, sent } = loadAutomation({
    sheet,
    properties: { CHECKOUT_URL: 'https://buy.example/handoff' }
  });
  context.runAutomation_();
  assert.equal(sent.length, 1);
  assert.match(sent[0].textBody, /https:\/\/buy\.example\/handoff/);
  assert.equal(resultSheet.rows[1][7], 'invoiced');
  assert.ok(resultSheet.rows[1][11] instanceof Date);

  context.runAutomation_();
  assert.equal(sent.length, 1, 'the payment link must not be resent');
});

test('qualifying a lead does nothing while no checkout URL is configured', () => {
  const sheet = createSheet([headerRow.slice(), leadRow({ 7: 'qualified' })]);
  const { context, sent } = loadAutomation({ sheet });
  context.runAutomation_();
  assert.equal(sent.length, 0);
  assert.equal(sheet.rows[1][7], 'qualified');
});
