const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');
const headerRow = ['Received at', 'Name', 'Email', 'Studio', 'Website', 'Plan', 'Message', 'Status', 'Follow-up at', 'Follow-up sent at'];

function createSheet(rows = [headerRow]) {
  return {
    rows,
    appendRow(row) { this.rows.push(row); },
    getLastRow() { return this.rows.length; },
    getDataRange() { return { getValues: () => this.rows.map((row) => row.slice()) }; },
    getRange(row, column) { return { setValue: (value) => { this.rows[row - 1][column - 1] = value; } }; },
    setFrozenRows(value) { this.frozenRows = value; }
  };
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
    HtmlService: {
      createHtmlOutput: (content) => ({
        content,
        setTitle(title) { this.title = title; return this; }
      })
    },
    ScriptApp: {
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

test('setup creates the enquiry sheet and one hourly follow-up trigger', () => {
  const sheet = createSheet([]);
  const oldTrigger = { getHandlerFunction: () => 'sendDueFollowUps_' };
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

test('a valid request stores the lead and sends customer and owner emails', () => {
  const { context, sheet, sent } = loadAutomation();
  const response = context.doPost(post(validParameters({ name: '=HYPERLINK("bad")' })));
  assert.match(response.content, /Request received/);
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.rows[1][1], "'=HYPERLINK(\"bad\")");
  assert.equal(sheet.rows[1][5], 'agency');
  assert.equal(sheet.rows[1][7], 'new');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, 'maya@example.com');
  assert.equal(sent[1].to, 'owner@example.com');
  assert.doesNotMatch(response.content, /<script/);
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

test('only due new enquiries receive one follow-up; active and closed leads are skipped', () => {
  const now = Date.now();
  const sheet = createSheet([
    headerRow,
    [new Date(now - 90000000), 'Due Lead', 'due@example.com', 'Studio', '', 'guided', '', 'new', new Date(now - 1000), ''],
    [new Date(now), 'Future Lead', 'future@example.com', 'Studio', '', 'guided', '', 'new', new Date(now + 100000), ''],
    [new Date(now - 90000000), 'Qualified Lead', 'qualified@example.com', 'Studio', '', 'guided', '', 'qualified', new Date(now - 1000), ''],
    [new Date(now - 90000000), 'Closed Lead', 'closed@example.com', 'Studio', '', 'guided', '', 'won', new Date(now - 1000), '']
  ]);
  const { context, sent } = loadAutomation({ sheet });
  context.sendDueFollowUps_();
  context.sendDueFollowUps_();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'due@example.com');
  assert.equal(sheet.rows[1][7], 'followed-up');
  assert.ok(sheet.rows[1][9] instanceof Date);
  assert.equal(sheet.rows[2][7], 'new');
});

test('a failed follow-up remains new so the next scheduled run can retry', () => {
  const now = Date.now();
  const sheet = createSheet([
    headerRow,
    [new Date(now - 90000000), 'Due Lead', 'due@example.com', 'Studio', '', 'guided', '', 'new', new Date(now - 1000), '']
  ]);
  const { context, errors } = loadAutomation({ sheet, failMail: true });
  context.sendDueFollowUps_();
  assert.equal(sheet.rows[1][7], 'new');
  assert.equal(sheet.rows[1][9], '');
  assert.equal(errors.length, 1);
});
