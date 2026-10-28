# AnkiWeb Clone 🌟

A modern, full-stack web application clone of AnkiWeb, built with **React** (TypeScript/Vite) on the frontend and **FastAPI** (Python/SQLite) on the backend. This application features a robust Spaced Repetition (SM-2) algorithm, dynamic UI with glassmorphism design, and a full suite of flashcard management features.

## ✨ Features

- **Spaced Repetition (SM-2):** Intelligent card scheduling based on your performance (Again, Hard, Good, Easy).
- **Daily Limits:** Enforces daily limits for new cards and reviews to prevent burnout.
- **Card Browser:** Search, view, and edit all your saved cards in a dual-pane master-detail interface.
- **Shared Decks:** Download and import community-created flashcard decks (categorized by topics like Biology, Languages, etc.).
- **User Accounts:** Full authentication system (Sign Up, Log In) with account management.
- **Modern UI:** Responsive, dark-mode focused design with dynamic animations and glassmorphism elements.

## 🛠️ Technology Stack

- **Frontend:** React, TypeScript, Vite, React Router, Context API, Vanilla CSS.
- **Backend:** FastAPI, Python 3, SQLAlchemy, SQLite, JWT Authentication.

---

## 🚀 Getting Started

You can run this project locally on your machine. Ensure you have **Python 3.14** (backend CI also covers Python 3.12) and **Node.js (v20+)** installed.

### Option 1: Quick Start (Automated Script)
If you are on Linux/macOS, you can use the provided setup script to install all dependencies; the script prints the commands to start both servers:
```bash
bash setup.sh
```

### Option 2: Manual Setup

#### 1. Start the Backend
On this machine, copy the following block into a terminal (requires `python3.14`):
```bash
cd /mnt/BACKUP/Code/anki_clone/backend
python3.14 -m venv venv
source venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

# Run the backend server (FastAPI)
python -m uvicorn main:app --reload --port 8000
```
The backend API will be available at `http://localhost:8000`, with interactive API documentation at `http://localhost:8000/docs`. On another machine, adjust the `cd` path to your project location.
*(Note: An SQLite database `anki.db` will be automatically generated upon startup).*

If you have a virtual environment created with an older Python version, deactivate it and rename it before running the block above; virtual environments should be recreated when changing Python versions. The existing environment on this machine has already been rebuilt for Python 3.14. Database and media files are kept separately from `venv`.

To run backend regression tests:
```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

#### 2. Start the Frontend
Open a new, separate terminal and navigate to the `frontend` folder:
```bash
cd frontend
npm install

# Run the frontend development server
npm run dev
```
#### 3. Docker Compose Deployment

To deploy using Docker Compose:

1. Create a local `.env` file for Docker Compose with your `JWT_SECRET_KEY`. Keep it on the server; do not commit credentials.
2. Generate a secure secret and set it in `.env`:
   ```bash
   # Generate secret:
   openssl rand -hex 32
   ```
   Set `JWT_SECRET_KEY` in `.env`. Note that in production (`APP_ENV=production`), the backend will immediately fail to start if `JWT_SECRET_KEY` is omitted, default, or less than 32 characters.

3. Start services:
   ```bash
   docker compose up -d --build
   ```
   The application will be accessible at `http://localhost:3456`.

---

## 📝 License
This is an educational prototype and portfolio project.

### Online study and LaTeX

The site requires a network connection. Local deck downloads, offline editing,
PWA installation and background synchronization have been removed. Existing
browsers automatically retire the previous service worker and its local caches.

Full `[latex]...[/latex]` rendering uses `latex`, `dvipng`, `bubblewrap` and
`prlimit`. These are installed in the backend Docker image. Linux must allow
unprivileged user namespaces for the isolated compiler; rendering fails closed
if the sandbox cannot start. Only TeX runtime directories and temporary output
are mounted, with no network or access to application data. Header/footer can
be edited under Note types. Install additional trusted TeX packages in the
server image as needed. Existing native Anki LaTeX images work without a compiler;
inline math retains the browser fallback when the toolchain is unavailable.

Reference syntax: [Anki TTS](https://docs.ankiweb.net/templates/fields.html),
[Anki LaTeX](https://docs.ankiweb.net/math.html). Scheduling uses the pinned Python scheduler on the server.

On Linux x86_64 without system TeX, a portable runtime can be installed for the
current user with `backend/venv/bin/python backend/setup_latex_runtime.py`.
It verifies Tectonic 0.17.0 against the official release SHA-256 and primes a
trusted example with AMS math, TikZ and mhchem. It requires existing `bwrap`,
`prlimit` and `pdftoppm`. Files stay in `~/.cache/anki-latex` (override with
`ANKI_TECTONIC_DIR`). Initial setup uses the network; card rendering uses only
cached packages, in a sandbox with no network. Additional packages must be
prepared by the server administrator rather than downloaded by untrusted notes.

### Importing Anki packages

Use **Import File**, select `.apkg`, review the preview and warnings, then choose
**Import package**. Upload and processing progress are shown separately. You can
cancel before the final commit; failures/cancellation roll back collection and
media changes. The existing synchronous `/api/apkg/import` API remains available.

Package jobs run in a background thread with an independent database session.
Their status is stored under `DATABASE_DIR/import-jobs`, and file locks serialize
package jobs across API workers on the same Linux host/filesystem. This is not a
distributed queue. If a worker stops, its job is marked interrupted on the next
status request: check the collection before retrying, as a stop during final
commit may have succeeded. Reloading the deck page in the same browser tab
reconnects to the last job. Keep the API running until imports finish.

Defaults: 1 GiB upload, 3 GiB decompressed data, 2 GiB media, 256 MiB per media
file, 100,000 notes/cards/media. `ANKI_IMPORT_*` settings documented in `backend/import_config.py` control
these budgets; export them before launching a local backend (the app does not
auto-load `.env`), or use Docker Compose, which forwards them. Nginx allows
1100 MiB including multipart overhead; raise its limit too if increasing uploads
beyond 1 GiB. Large decks still need sufficient RAM and temporary disk space;
100,000 is a validation ceiling, not a performance guarantee.

Completed/failed/cancelled jobs delete their uploaded package. Unconfirmed
previews expire after 24 hours; expiry and seven-day status cleanup run on status
reads/new submissions. Cleanup is lazy, so on an idle server those files remain
until the next request. A browser disconnect during upload can leave the job
running if the upload was already accepted. Avoid restarting the API mid-import.

The importer supports the existing old/new package adapters, font media and a
conservative static SVG mode (enabled by the new UI). SVG scripts, CSS,
foreign objects, animation and external links are removed, so complex SVGs may
look different; the preview warns when SVGs are sanitized. The synchronous API
keeps raw SVG rejected unless `sanitize_svg=true` is selected. Disguised SVGs
remain rejected. Missing media and disabled template scripts generate warnings;
unsupported template filters/note types stop the import with an identified note
type/source note. JavaScript/add-ons are not executed. There is no claim of full
AnkiWeb compatibility or a measured coverage percentage.

The optional real-world music regression runs entirely against temporary data:

```bash
ANKI_TEST_MUSIC_APKG=/path/to/Classical_Music_Themes_-_Part_I.apkg \
  backend/venv/bin/python -m pytest backend/tests/test_music_package.py -q
```

It covers preview, import, duplicate handling, every media file's bytes, original
fields/GUIDs and counts against upstream Anki, plus the background HTTP workflow.


Package uploads now use authenticated adaptive chunks (initially 256 KiB, at most 1 MiB) before creating the preview
job. Each request stays small enough for Cloudflare/proxy limits and has a
timeout. Temporary network/proxy failures retry from the last acknowledged
offset. Slow transfers automatically reduce chunk size; interrupted uploads can
be resumed with the same file, while cancelled uploads are removed. Old multipart endpoints
remain available for API clients. Deploy backend and frontend from the same
commit; the UI reports when the backend does not support chunked upload yet.

If a connection remains unavailable after retries, use **Resume upload**. The
last acknowledged bytes remain saved, including across a page reload when you
select the same file again in that tab. Resume state is scoped to the signed-in
account and verifies file metadata plus samples from both ends. Unconfirmed
uploads expire after 24 hours. Only explicit cancellation or a permanent file
error discards received bytes.

If upload is fast directly to the origin but slow through Cloudflare Tunnel,
compare the connector transport instead of increasing application timeouts.
`backend/ops/cloudflared-http2.sh --dry-run` shows an optional systemd override
for a QUIC-to-HTTP/2 comparison. A server administrator can run it with `sudo`;
it briefly reconnects the shared tunnel. Token files and ingress routes are
preserved. The script rolls back its new override if the tunnel fails readiness;
use `--restore` to undo a successful test if performance does not improve.

For slow client-to-site anycast routes, package requests can use a separate HTTPS
ingress while reaching the same backend, database, and user-owned upload IDs.
Set `VITE_PACKAGE_API_URL=https://anki-upload-relay.pages.dev` in the deployment's
environment and rebuild the frontend. Leave it unset to use the normal API.
Only resumable uploads, import jobs, and package limits use this ingress. A relay
network/5xx failure makes subsequent requests use the original API for 60 seconds;
the uploader reconciles the saved offset before retrying and never replays a
mutation in the transport interceptor.

The relay source and API deployment metadata live in `backend/ops/`:

- Upload `upload-relay.mjs` with `upload-relay.metadata.json` to the Worker
  `anki-upload-relay` using the Workers multipart script API. Its bindings fix the
  upstream and allowed browser origin to `https://thaituan.site`; JWT validation
  and upload/job ownership checks remain on the backend. Enable logs/traces as
  specified in the metadata; do not log authorization headers or request bodies.
- `upload-relay-pages.json` configures the Pages project with a service binding to
  that Worker. Direct-upload `upload-relay-pages.mjs` as `_worker.js`, with an
  empty asset `manifest` (`{}`), to its `main` branch. The stable entry point is
  `https://anki-upload-relay.pages.dev`. The Pages entry point is intentional:
  its anycast address pool performed much better than the site's and
  `workers.dev`'s routes on the affected connection. No client IP pinning is used.
- Keep the Worker's public `workers.dev`/preview endpoints disabled. The Pages
  ingress calls it via the service binding. Requests and responses stream without
  storing package contents at the relay. Only the listed package endpoints are
  accepted, browser CORS is restricted, redirects are rejected, and every API
  response is private/no-store.

Check the relay with `node --test backend/ops/upload-relay.test.mjs` and run the
frontend package transport/upload/panel tests. Validate deployments with full real
APKG uploads through the browser, preview and confirmation in a disposable
account, followed by account/media/job cleanup. A successful health/probe request
alone does not establish upload or import performance. To roll back, unset
`VITE_PACKAGE_API_URL` and rebuild; the original site/tunnel needs no changes.
