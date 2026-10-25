const businessInput = document.querySelector('#business-name');
const servicesInput = document.querySelector('#services');
const generatorForm = document.querySelector('#generator-form');
const generatorStatus = document.querySelector('#generator-status');
const quoteForm = document.querySelector('#quote-form');
const serviceSelect = document.querySelector('#quote-service');
const runDemoButton = document.querySelector('#run-demo');
const resetDemoButton = document.querySelector('#reset-demo');
const agentResult = document.querySelector('#agent-result');
const submitStatus = document.querySelector('#demo-submit-status');
let coreSourcePromise;
let currentTools;

function readConfig() {
  return {
    businessName: businessInput.value.trim(),
    services: servicesInput.value.split(',').map((service) => service.trim()).filter(Boolean)
  };
}

function renderConfig() {
  const rawConfig = readConfig();
  let config = rawConfig;
  try {
    config = Handoff.normalizeConfig(rawConfig);
    currentTools = Handoff.createQuoteTools(config, document);
    generatorStatus.textContent = 'The file is generated in your browser. Your entries never leave this page.';
  } catch (error) {
    currentTools = null;
    generatorStatus.textContent = error.message;
  }

  document.querySelector('#config-code').textContent = JSON.stringify(config, null, 2);
  document.querySelectorAll('[data-business-name]').forEach((element) => {
    element.textContent = config.businessName || 'Your business';
  });

  const selectedService = serviceSelect.value;
  serviceSelect.replaceChildren();
  config.services.forEach((service) => {
    const option = document.createElement('option');
    option.value = service;
    option.textContent = service;
    serviceSelect.append(option);
  });
  if (config.services.includes(selectedService)) serviceSelect.value = selectedService;
}

businessInput.addEventListener('input', renderConfig);
servicesInput.addEventListener('input', renderConfig);

generatorForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const config = Handoff.normalizeConfig(readConfig());
    generatorStatus.textContent = 'Building your self-contained script…';
    coreSourcePromise ||= fetch('handoff-core.js').then((response) => {
      if (!response.ok) throw new Error('Unable to load the Handoff core.');
      return response.text();
    });
    const script = HandoffGenerator.buildScript(await coreSourcePromise, config);
    const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'handoff.js';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    generatorStatus.textContent = 'handoff.js downloaded. Add the form attribute and script tag from the install steps.';
  } catch (error) {
    generatorStatus.textContent = error.message;
  }
});

runDemoButton.addEventListener('click', () => {
  if (!currentTools) {
    agentResult.textContent = 'Fix the generator configuration before running the demo.';
    return;
  }

  const services = currentTools.config.services;
  const result = currentTools.prepareQuote({
    name: 'Maya Chen',
    email: 'maya@example.com',
    service: services[0],
    details: 'Three-bedroom home, two bathrooms, and a small dog. Looking for a thorough first visit.'
  });
  agentResult.textContent = JSON.stringify(result, null, 2);
  runDemoButton.innerHTML = result.ok ? 'Run it again <span aria-hidden="true">↻</span>' : 'Try the handoff again <span aria-hidden="true">→</span>';
});

resetDemoButton.addEventListener('click', () => {
  quoteForm.reset();
  quoteForm.querySelector('[data-handoff-review]')?.remove();
  quoteForm.removeAttribute('data-handoff-prepared');
  agentResult.textContent = 'Waiting for the tool call…';
  submitStatus.textContent = 'Nothing sends until the customer uses this button.';
  runDemoButton.innerHTML = 'Run the agent handoff <span aria-hidden="true">→</span>';
});

quoteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!quoteForm.reportValidity()) return;
  submitStatus.textContent = 'Demo complete. No request was sent anywhere.';
});

const pilotForm = document.querySelector('#pilot-form');
const pilotStatus = document.querySelector('#pilot-status');
const leadEndpoint = window.HANDOFF_CONFIG?.leadEndpoint?.trim();
document.querySelector('#form-started-at').value = String(Date.now());

if (leadEndpoint) pilotForm.action = leadEndpoint;
pilotForm.addEventListener('submit', (event) => {
  if (!leadEndpoint) {
    event.preventDefault();
    pilotStatus.textContent = 'Preview only: connect the enquiry endpoint before publishing this form.';
    pilotStatus.classList.add('error');
    return;
  }
  if (!pilotForm.reportValidity()) {
    event.preventDefault();
    return;
  }
  pilotStatus.classList.remove('error');
  pilotStatus.textContent = 'Sending your fit-review request…';
  pilotForm.querySelector('button[type="submit"]').disabled = true;
});

const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('.site-nav');
menuButton.addEventListener('click', () => {
  const open = navigation.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
});
navigation.addEventListener('click', (event) => {
  if (event.target.closest('a')) {
    navigation.classList.remove('open');
    menuButton.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    navigation.classList.remove('open');
    menuButton.setAttribute('aria-expanded', 'false');
  }
});

const hasWebMCP = typeof document.modelContext?.registerTool === 'function' || typeof navigator.modelContext?.registerTool === 'function';
document.querySelector('#browser-support').textContent = hasWebMCP
  ? 'WebMCP API detected in this browser'
  : 'Demo mode · WebMCP is not exposed in this browser';
document.querySelector('#year').textContent = new Date().getFullYear();
renderConfig();
