import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const Navbar = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
    setMobileMenuOpen(false);
  };

  const closeMenu = () => setMobileMenuOpen(false);

  return (
    <nav className="desktop-navbar">
      <div className="top-menu-bar">
        <div className="top-menu-left">
          <Link to="/" className="navbar-brand" onClick={closeMenu}>
            AnkiWeb <span className="brand-icon">🌟</span>
          </Link>
          {user && (
            <div className="nav-links">
              <NavLink to="/decks" className={({ isActive }) => isActive ? "menu-item active" : "menu-item"}>Decks</NavLink>
              <NavLink to="/add" className={({ isActive }) => isActive ? "menu-item active" : "menu-item"}>Add</NavLink>
              <NavLink to="/browse" className={({ isActive }) => isActive ? "menu-item active" : "menu-item"}>Browse</NavLink>
            </div>
          )}
        </div>
        <div className="top-menu-right">
          {user ? (
            <>
              <NavLink to="/account" className={({ isActive }) => isActive ? "menu-item active" : "menu-item"}>Account</NavLink>
              <span className="menu-item" onClick={handleLogout} style={{ cursor: 'pointer' }}>Log Out</span>
            </>
          ) : (
            <>
              <NavLink to="/login" className={({ isActive }) => isActive ? "menu-item active" : "menu-item"}>Log In</NavLink>
              <NavLink to="/register" className={({ isActive }) => isActive ? "menu-item active" : "menu-item"}>Sign Up</NavLink>
            </>
          )}
        </div>
        <button
          className="hamburger-btn"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? '✕' : '☰'}
        </button>
      </div>
      {mobileMenuOpen && (
        <div className="mobile-nav-menu">
          {user ? (
            <>
              <NavLink to="/decks" className={({ isActive }) => isActive ? "mobile-nav-item active" : "mobile-nav-item"} onClick={closeMenu}>Decks</NavLink>
              <NavLink to="/add" className={({ isActive }) => isActive ? "mobile-nav-item active" : "mobile-nav-item"} onClick={closeMenu}>Add</NavLink>
              <NavLink to="/browse" className={({ isActive }) => isActive ? "mobile-nav-item active" : "mobile-nav-item"} onClick={closeMenu}>Browse</NavLink>
              <NavLink to="/account" className={({ isActive }) => isActive ? "mobile-nav-item active" : "mobile-nav-item"} onClick={closeMenu}>Account</NavLink>
              <span className="mobile-nav-item" onClick={handleLogout}>Log Out</span>
            </>
          ) : (
            <>
              <NavLink to="/login" className={({ isActive }) => isActive ? "mobile-nav-item active" : "mobile-nav-item"} onClick={closeMenu}>Log In</NavLink>
              <NavLink to="/register" className={({ isActive }) => isActive ? "mobile-nav-item active" : "mobile-nav-item"} onClick={closeMenu}>Sign Up</NavLink>
            </>
          )}
        </div>
      )}
    </nav>
  );
};

export default Navbar;
