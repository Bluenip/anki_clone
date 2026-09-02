#!/bin/bash
set -e

echo "=== Setting up AnkiClone ==="

# Backend setup
echo ">>> Setting up Backend..."
cd backend
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn[standard] sqlalchemy python-jose[cryptography] passlib[bcrypt] python-multipart pydantic bcrypt
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
echo "To start backend:  cd backend && source venv/bin/activate && uvicorn main:app --reload --port 8000"
echo "To start frontend: cd frontend && npm run dev"
