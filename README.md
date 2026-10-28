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

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
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
file, 100,000 notes/cards/media. `ANKI_IMPORT_*` settings in `.env.example` control
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
See [the implementation plan and verification results](backend/docs/IMPORT_COMPATIBILITY_PLAN.md).
