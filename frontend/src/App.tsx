import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import DecksPage from './pages/DecksPage';
import DeckDetailPage from './pages/DeckDetailPage';
import StudyPage from './pages/StudyPage';
import CardEditorPage from './pages/CardEditorPage';
import SharedDecksPage from './pages/SharedDecksPage';
import SharedDeckDetailPage from './pages/SharedDeckDetailPage';
import AddPage from './pages/AddPage';
import AccountPage from './pages/AccountPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import BrowsePage from './pages/BrowsePage';

import DeckOptionsPage from './pages/DeckOptionsPage';

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="app-layout">
          <Navbar />
          <main className="main-content">
            <Routes>
              <Route path="/" element={<Navigate to="/decks" replace />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/decks" element={<ProtectedRoute><DecksPage /></ProtectedRoute>} />
              <Route path="/decks/:id" element={<ProtectedRoute><DeckDetailPage /></ProtectedRoute>} />
              <Route path="/decks/:deckId/cards" element={<ProtectedRoute><CardEditorPage /></ProtectedRoute>} />
              <Route path="/decks/:deckId/options" element={<ProtectedRoute><DeckOptionsPage /></ProtectedRoute>} />
              <Route path="/add" element={<ProtectedRoute><AddPage /></ProtectedRoute>} />
              <Route path="/browse" element={<ProtectedRoute><BrowsePage /></ProtectedRoute>} />
              <Route path="/account" element={<ProtectedRoute><AccountPage /></ProtectedRoute>} />
              <Route path="/study/:deckId" element={<ProtectedRoute><StudyPage /></ProtectedRoute>} />
              <Route path="/shared" element={<SharedDecksPage />} />
              <Route path="/shared/:id" element={<SharedDeckDetailPage />} />
            </Routes>
          </main>
          <Footer />
        </div>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
