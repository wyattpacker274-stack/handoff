(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HandoffGenerator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function buildScript(coreSource, rawConfig) {
    if (typeof coreSource !== 'string' || !coreSource.includes('registerTools')) {
      throw new Error('The Handoff core source is unavailable.');
    }
    const config = {
      businessName: String(rawConfig.businessName || '').trim(),
      services: Array.isArray(rawConfig.services) ? rawConfig.services : []
    };
    const serialized = JSON.stringify(config)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');

    return coreSource + '\n;Handoff.start(' + serialized + ').catch((error) => console.error("Handoff registration failed:", error));\n';
  }

  return { buildScript };
});
