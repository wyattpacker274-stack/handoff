document.querySelector('form').addEventListener('submit', (event) => event.preventDefault());

Handoff.start({
  businessName: 'Northstar Cleaning',
  services: ['Deep cleaning', 'Move-out cleaning', 'Office cleaning']
}).then((result) => {
  document.querySelector('#fixture-status').textContent = JSON.stringify({
    webMCPSupported: result.supported,
    registrations: result.registrations || [],
    ordinaryFormAvailable: true
  }, null, 2);
}).catch((error) => {
  document.querySelector('#fixture-status').textContent = error.message;
});
