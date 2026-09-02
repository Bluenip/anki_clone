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

You can run this project locally on your machine. Ensure you have **Python 3.10+** and **Node.js (v20+)** installed.

### Option 1: Quick Start (Automated Script)
If you are on Linux/macOS, you can use the provided setup script to automatically install all dependencies and run both servers:
```bash
bash setup.sh
```

### Option 2: Manual Setup

#### 1. Start the Backend
Open a terminal and navigate to the `backend` folder:
```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Run the backend server (FastAPI)
uvicorn main:app --reload --port 8000
```
The backend API will be available at `http://localhost:8000`. 
*(Note: An SQLite database `anki.db` will be automatically generated upon startup).*

#### 2. Start the Frontend
Open a new, separate terminal and navigate to the `frontend` folder:
```bash
cd frontend
npm install

# Run the frontend development server
npm run dev
```
The frontend will be available at `http://localhost:5173`. Open this link in your browser to start using the app!

---

## 📝 License
This is an educational prototype and portfolio project.
