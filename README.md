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
