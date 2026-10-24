#!/bin/bash
set -e

echo "=== Setting up AnkiClone ==="

# Backend setup
echo ">>> Setting up Backend..."
cd backend
"${PYTHON:-python3.14}" -m venv venv
source venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
echo ">>> Backend ready!"

# Frontend setup
echo ">>> Setting up Frontend..."
cd ../frontend
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 2>/dev/null || true
npm install
npm install react-router-dom axios
rm -f src/App.css src/assets/react.svg
echo ">>> Frontend ready!"

echo "=== Setup complete! ==="
echo "To start backend:  cd backend && source venv/bin/activate && python -m uvicorn main:app --reload --port 8000"
echo "To start frontend: cd frontend && npm run dev"
