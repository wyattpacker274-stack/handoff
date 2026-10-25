(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Handoff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_FIELDS = {
    name: '[name="name"]',
    email: '[name="email"]',
    phone: '[name="phone"]',
    service: '[name="service"]',
    preferredDate: '[name="preferredDate"]',
    details: '[name="message"]'
  };

  function normalizeConfig(config) {
    const businessName = String(config && config.businessName || '').trim();
    const services = [...new Set((config && Array.isArray(config.services) ? config.services : [])
      .map((service) => String(service).trim())
      .filter(Boolean))];

    if (businessName.length < 2 || businessName.length > 100 || /[\r\n]/.test(businessName)) {
      throw new Error('Business name must contain 2 to 100 characters on one line.');
    }
    if (!services.length || services.length > 12 || services.some((service) => service.length > 80 || /[\r\n]/.test(service))) {
      throw new Error('Provide 1 to 12 services, each using 80 characters or fewer on one line.');
    }

    return {
      businessName,
      services,
      fields: { ...DEFAULT_FIELDS, ...(config && config.fields || {}) }
    };
  }

  function makeEvent(doc, type, detail) {
    const view = doc.defaultView || {};
    if (detail && typeof view.CustomEvent === 'function') {
      return new view.CustomEvent(type, { bubbles: true, detail });
    }
    if (typeof view.Event === 'function') {
      return new view.Event(type, { bubbles: true });
    }
    if (typeof Event === 'function') {
      return new Event(type, { bubbles: true });
    }
    return { type, bubbles: true, detail };
  }

  function findForm(doc) {
    const marked = doc.querySelector('form[data-handoff-quote]');
    if (marked) return marked;
    return Array.from(doc.forms || []).find((form) => (
      form.querySelector(DEFAULT_FIELDS.name) &&
      form.querySelector(DEFAULT_FIELDS.email) &&
      form.querySelector(DEFAULT_FIELDS.service) &&
      form.querySelector(DEFAULT_FIELDS.details)
    )) || null;
  }

  function validateInput(input, config) {
    const value = {
      name: String(input && input.name || '').trim(),
      email: String(input && input.email || '').trim().toLowerCase(),
      phone: String(input && input.phone || '').trim(),
      service: String(input && input.service || '').trim(),
      preferredDate: String(input && input.preferredDate || '').trim(),
      details: String(input && input.details || '').trim()
    };
    const errors = {};

    if (!value.name || value.name.length > 80 || /[\r\n]/.test(value.name)) {
      errors.name = 'Enter a name using 1 to 80 characters on one line.';
    }
    if (value.email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
      errors.email = 'Enter a valid email address.';
    }
    if (value.phone && !/^[0-9+().\-\s]{7,40}$/.test(value.phone)) {
      errors.phone = 'Enter a valid phone number or leave it empty.';
    }
    if (!config.services.includes(value.service)) {
      errors.service = 'Choose one of the configured services.';
    }
    if (value.preferredDate) {
      const date = new Date(value.preferredDate + 'T00:00:00Z');
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value.preferredDate) {
        errors.preferredDate = 'Use a valid date in YYYY-MM-DD format.';
      }
    }
    if (value.details.length < 5 || value.details.length > 1500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value.details)) {
      errors.details = 'Describe the request using 5 to 1,500 supported characters.';
    }

    return { value, errors };
  }

  function createQuoteTools(rawConfig, doc) {
    const config = normalizeConfig(rawConfig);

    function getRequirements() {
      return {
        businessName: config.businessName,
        services: config.services.slice(),
        required: ['name', 'email', 'service', 'details'],
        optional: ['phone', 'preferredDate'],
        submission: 'customer_review_required'
      };
    }

    function prepareQuote(input) {
      const { value, errors } = validateInput(input, config);
      if (Object.keys(errors).length) {
        return { ok: false, status: 'invalid_input', errors };
      }

      const form = findForm(doc);
      if (!form) {
        return { ok: false, status: 'form_not_found', errors: { form: 'Add data-handoff-quote to the quote form.' } };
      }

      const elements = {};
      for (const name of Object.keys(DEFAULT_FIELDS)) {
        elements[name] = form.querySelector(config.fields[name]);
      }
      for (const name of ['name', 'email', 'service', 'details']) {
        if (!elements[name]) errors[name] = 'Add a matching ' + DEFAULT_FIELDS[name] + ' field to the quote form.';
      }
      if (Object.keys(errors).length) {
        return { ok: false, status: 'field_mapping_missing', errors };
      }

      if (elements.service && String(elements.service.tagName).toLowerCase() === 'select') {
        const choices = Array.from(elements.service.options || []);
        const match = choices.some((option) => (
          String(option.value).toLowerCase() === value.service.toLowerCase() ||
          String(option.text).toLowerCase() === value.service.toLowerCase()
        ));
        if (!match) {
          return { ok: false, status: 'service_choice_missing', errors: { service: 'Add the configured service as an option in the form select.' } };
        }
      }

      for (const name of Object.keys(DEFAULT_FIELDS)) {
        const element = elements[name];
        if (!element) continue;
        if (name === 'service' && String(element.tagName).toLowerCase() === 'select') {
          const choice = Array.from(element.options).find((option) => (
            String(option.value).toLowerCase() === value.service.toLowerCase() ||
            String(option.text).toLowerCase() === value.service.toLowerCase()
          ));
          element.value = choice.value;
        } else {
          element.value = value[name];
        }
        element.dispatchEvent(makeEvent(doc, 'input'));
        element.dispatchEvent(makeEvent(doc, 'change'));
      }

      let review = form.querySelector('[data-handoff-review]');
      if (!review) {
        review = doc.createElement('div');
        review.setAttribute('data-handoff-review', '');
        review.setAttribute('role', 'status');
        review.style.cssText = 'margin:12px 0;padding:12px 14px;border:1px solid #9bc4ac;border-radius:10px;background:#eef8f0;color:#173b35;font:14px system-ui,sans-serif';
        form.prepend(review);
      }
      review.textContent = 'AI draft ready. Review the details, then submit when you are happy.';
      form.setAttribute('data-handoff-prepared', 'true');
      form.dispatchEvent(makeEvent(doc, 'handoff:ready', { businessName: config.businessName }));

      if (typeof form.scrollIntoView === 'function') {
        const reduceMotion = doc.defaultView && typeof doc.defaultView.matchMedia === 'function' && doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches;
        form.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      }

      return {
        ok: true,
        status: 'review_required',
        message: 'The quote form is ready for the customer to review. It has not been submitted.'
      };
    }

    return { config, getRequirements, prepareQuote };
  }

  async function registerTools(config, doc, navigatorObject) {
    const tools = createQuoteTools(config, doc);
    const browserNavigator = navigatorObject || doc.defaultView && doc.defaultView.navigator;
    const modelContext = doc.modelContext && typeof doc.modelContext.registerTool === 'function'
      ? doc.modelContext
      : browserNavigator && browserNavigator.modelContext && typeof browserNavigator.modelContext.registerTool === 'function'
        ? browserNavigator.modelContext
        : null;

    if (!modelContext) {
      return { supported: false, ...tools };
    }

    const registrations = [];
    await modelContext.registerTool({
      name: 'get_quote_requirements',
      description: 'Get the services and customer details needed to prepare a quote request for ' + tools.config.businessName + '.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true, consequentialHint: false },
      execute: async () => JSON.stringify(tools.getRequirements())
    });
    registrations.push('get_quote_requirements');

    await modelContext.registerTool({
      name: 'prepare_quote_request',
      description: 'Fill the quote form for ' + tools.config.businessName + ' using confirmed customer details. The customer must review and submit it.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Customer name' },
          email: { type: 'string', description: 'Customer email address' },
          phone: { type: 'string', description: 'Optional customer phone number' },
          service: { type: 'string', enum: tools.config.services, description: 'Requested service' },
          preferredDate: { type: 'string', description: 'Optional preferred date in YYYY-MM-DD format' },
          details: { type: 'string', description: 'Confirmed details about the work requested' }
        },
        required: ['name', 'email', 'service', 'details']
      },
      annotations: { readOnlyHint: false, consequentialHint: true },
      execute: async (input) => JSON.stringify(tools.prepareQuote(input))
    });
    registrations.push('prepare_quote_request');

    return { supported: true, registrations, ...tools };
  }

  async function start(config, doc) {
    const targetDocument = doc || (typeof document !== 'undefined' ? document : null);
    if (!targetDocument) throw new Error('Handoff requires a browser document.');
    if (targetDocument.__handoffPromise) return targetDocument.__handoffPromise;
    targetDocument.__handoffPromise = registerTools(config, targetDocument);
    return targetDocument.__handoffPromise;
  }

  return { normalizeConfig, createQuoteTools, registerTools, start };
});
