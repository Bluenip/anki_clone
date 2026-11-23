# AnkiWeb Clone — frontend

React + TypeScript + Vite single-page app for the AnkiWeb Clone. See the [project README](../README.md) for the whole stack, the backend and Docker deployment.

```bash
npm install
npm run dev      # dev server; proxies /api to the backend on http://localhost:8000
npm test         # Vitest (jsdom)
npm run lint     # Oxlint (.oxlintrc.json)
npm run build    # tsc -b and vite build into dist/
```

- `src/pages/` — routed pages; `src/components/` — shared UI; `src/api/` — Axios client per backend area.
- `src/i18n/en.ts` and `src/i18n/vi.ts` — UI strings; add every new key to both.
- `VITE_PACKAGE_API_URL` (build time, optional) sends package uploads through a separate ingress; leave it unset to use the normal API.
