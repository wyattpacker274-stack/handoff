const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildScript } = require('../public/generator.js');

const core = fs.readFileSync(path.join(__dirname, '../public/handoff-core.js'), 'utf8');

test('generated script is self-contained and starts the configured registration', () => {
  const script = buildScript(core, { businessName: 'Northstar Cleaning', services: ['Deep clean'] });
  const registered = [];
  const document = {
    modelContext: { registerTool: async (tool) => registered.push(tool) },
    defaultView: { navigator: {} }
  };
  const context = { document, console, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(script, context);

  assert.equal(script.includes('createQuoteTools'), true);
  assert.equal(typeof context.Handoff, 'object');
  assert.equal(typeof context.document.__handoffPromise.then, 'function');
});

test('generated configuration escapes script-sensitive characters', () => {
  const script = buildScript(core, { businessName: '</script><script>alert(1)</script>', services: ['Deep clean'] });
  assert.equal(script.includes('"</script><script>'), false);
  assert.equal(script.includes('console.error("Handoff registration failed:"'), true);
});

test('generator rejects a missing core source', () => {
  assert.throws(() => buildScript('', { businessName: 'Northstar', services: ['Deep clean'] }));
});
