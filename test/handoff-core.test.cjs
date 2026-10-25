const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeConfig,
  createQuoteTools,
  registerTools,
  start
} = require('../public/handoff-core.js');

const config = { businessName: 'Northstar Cleaning', services: ['Deep clean', 'Move-out clean'] };
const input = {
  name: 'Maya Chen',
  email: 'Maya@Example.com',
  phone: '+1 555 010 2030',
  service: 'Deep clean',
  preferredDate: '2027-01-15',
  details: 'Three bedrooms, two bathrooms, and a small dog.'
};

function element(tagName = 'INPUT') {
  return {
    tagName,
    value: '',
    events: [],
    attributes: {},
    style: {},
    dispatchEvent(event) { this.events.push(event); },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

function createDocument(options = {}) {
  const fields = Object.fromEntries(['name', 'email', 'phone', 'service', 'preferredDate', 'details'].map((name) => [name, element(name === 'service' && options.select ? 'SELECT' : 'INPUT')]));
  if (options.select) {
    fields.service.options = options.serviceChoices || [
      { value: 'Deep clean', text: 'Deep clean' },
      { value: 'Move-out clean', text: 'Move-out clean' }
    ];
  }
  if (options.missingField) delete fields[options.missingField];

  const form = {
    fields,
    events: [],
    submitted: false,
    querySelector(selector) {
      if (selector === '[data-handoff-review]') return this.review || null;
      const match = selector.match(/^\[name="(.+)"\]$/);
      const fieldName = match && match[1] === 'message' ? 'details' : match && match[1];
      return fieldName ? fields[fieldName] || null : null;
    },
    prepend(review) { this.review = review; },
    dispatchEvent(event) { this.events.push(event); },
    setAttribute(name, value) { this.prepared = value; },
    scrollIntoView() { this.scrolled = true; },
    requestSubmit() { this.submitted = true; }
  };

  const document = {
    forms: [form],
    defaultView: {
      Event: class { constructor(type, init) { this.type = type; this.bubbles = init.bubbles; } },
      CustomEvent: class { constructor(type, init) { this.type = type; this.bubbles = init.bubbles; this.detail = init.detail; } },
      navigator: options.navigator || {},
      matchMedia: () => ({ matches: true })
    },
    querySelector: (selector) => selector === 'form[data-handoff-quote]' && options.marked !== false ? form : null,
    createElement: () => element('DIV'),
    modelContext: options.modelContext
  };
  return { document, form, fields };
}

test('configuration trims and deduplicates services', () => {
  const normalized = normalizeConfig({ businessName: '  Northstar Cleaning  ', services: [' Deep clean ', 'Deep clean', 'Move-out clean'] });
  assert.equal(normalized.businessName, 'Northstar Cleaning');
  assert.deepEqual(normalized.services, ['Deep clean', 'Move-out clean']);
  assert.throws(() => normalizeConfig({ businessName: 'X', services: [] }));
  assert.throws(() => normalizeConfig({ businessName: 'Valid Name', services: [] }));
});

test('requirements expose configured services and mandatory customer review', () => {
  const { document } = createDocument();
  const tools = createQuoteTools(config, document);
  assert.deepEqual(tools.getRequirements().services, config.services);
  assert.equal(tools.getRequirements().submission, 'customer_review_required');
});

test('a valid agent request fills every field, emits events, and never submits', () => {
  const { document, form, fields } = createDocument();
  const tools = createQuoteTools(config, document);
  const result = tools.prepareQuote(input);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'review_required');
  assert.equal(fields.name.value, 'Maya Chen');
  assert.equal(fields.email.value, 'maya@example.com');
  assert.equal(fields.service.value, 'Deep clean');
  assert.equal(fields.details.value, input.details);
  assert.equal(fields.name.events.filter((event) => event.type === 'input').length, 1);
  assert.equal(form.review.textContent.includes('Review'), true);
  assert.equal(form.prepared, 'true');
  assert.equal(form.events[0].type, 'handoff:ready');
  assert.equal(form.submitted, false);
});

test('invalid input changes nothing', () => {
  const { document, fields } = createDocument();
  const tools = createQuoteTools(config, document);
  const result = tools.prepareQuote({ ...input, email: 'wrong', service: 'Unknown service' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid_input');
  assert.deepEqual(Object.keys(result.errors).sort(), ['email', 'service']);
  assert.equal(fields.name.value, '');
});

test('a missing required form field prevents partial edits', () => {
  const { document, fields } = createDocument({ missingField: 'email' });
  const tools = createQuoteTools(config, document);
  const result = tools.prepareQuote(input);

  assert.equal(result.status, 'field_mapping_missing');
  assert.equal(fields.name.value, '');
});

test('select fields accept configured choices and reject missing choices', () => {
  const supported = createDocument({ select: true });
  const tools = createQuoteTools(config, supported.document);
  assert.equal(tools.prepareQuote(input).ok, true);

  const missing = createDocument({ select: true, serviceChoices: [{ value: 'Other', text: 'Other' }] });
  const otherTools = createQuoteTools(config, missing.document);
  assert.equal(otherTools.prepareQuote(input).status, 'service_choice_missing');
  assert.equal(missing.fields.name.value, '');
});

test('unsupported browsers retain the ordinary form and expose a local preparator', async () => {
  const { document } = createDocument();
  const result = await registerTools(config, document);
  assert.equal(result.supported, false);
  assert.equal(result.prepareQuote(input).status, 'review_required');
});

test('document.modelContext registers read and prepare tools with review-safe annotations', async () => {
  const registered = [];
  const modelContext = { registerTool: async (tool) => registered.push(tool) };
  const { document, form } = createDocument({ modelContext });
  const result = await registerTools(config, document);

  assert.equal(result.supported, true);
  assert.deepEqual(result.registrations, ['get_quote_requirements', 'prepare_quote_request']);
  assert.equal(registered[0].annotations.readOnlyHint, true);
  assert.equal(registered[1].annotations.consequentialHint, true);
  const execution = JSON.parse(await registered[1].execute(input));
  assert.equal(execution.status, 'review_required');
  assert.equal(form.submitted, false);
});

test('navigator.modelContext remains a compatibility fallback', async () => {
  const registered = [];
  const navigator = { modelContext: { registerTool: async (tool) => registered.push(tool) } };
  const { document } = createDocument({ navigator });
  const result = await registerTools(config, document);
  assert.equal(result.supported, true);
  assert.equal(registered.length, 2);
});

test('start is idempotent on the same document', async () => {
  let count = 0;
  const modelContext = { registerTool: async () => { count += 1; } };
  const { document } = createDocument({ modelContext });
  await Promise.all([start(config, document), start(config, document)]);
  assert.equal(count, 2);
});
