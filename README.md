# Handoff

Generate a self-contained script that exposes an existing quote form to browser-based AI agents through the emerging WebMCP API.

Compatible agents can read the form's requirements and prepare it. The customer still reviews every value and submits.

**Live site:** https://handofftool.com

## What the generated script does

It registers two tools:

- `get_quote_requirements` — read-only. Returns fields, accepted values, and validation rules.
- `prepare_quote_request` — consequential. Fills the form, dispatches input events, and inserts a visible review notice. It never submits.

Registration uses `document.modelContext` with a `navigator.modelContext` fallback. Where neither exists, the script leaves the ordinary form untouched and exposes a local preparator.

The output is one static file. No backend, no API key, no analytics, no remote calls, no AI provider.

## Status

WebMCP support is emerging and may require a Chrome origin trial. The fixture at `/demo.html` reports what the current browser actually exposes. The site's agent demo is a local simulation of tool registration, not evidence of native agent execution.

## Repository layout

```
public/                 the deployed site
public/handoff-core.js  form preparation engine
public/generator.js     builds the downloadable script
test/                   core and generator tests
automation/Code.gs      Google Apps Script enquiry handler
automation/Code.test.cjs
.github/workflows/      test, then deploy public/ to GitHub Pages
```

## Local development

```bash
npm start   # http://127.0.0.1:4174
npm test
```

## Deploy

Push to `main`. The workflow runs the tests, uploads `public/`, and deploys to GitHub Pages. Pages must have its source set to **GitHub Actions** once, in repository settings.

## Tests

```bash
npm test
```

Covers form mapping, atomic validation, tool registration and annotations, compatibility fallback, generator escaping, and the Apps Script enquiry handler end to end.
