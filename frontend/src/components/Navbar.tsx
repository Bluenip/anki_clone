import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const Navbar = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <nav className="desktop-navbar">
      <div className="top-menu-bar">
        <div className="top-menu-left">
          <Link to="/" className="navbar-brand">
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
      </div>
    </nav>
  );
};

export default Navbar;
