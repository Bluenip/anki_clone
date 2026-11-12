import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import { usePrefs } from '../context/usePrefs';

const Navbar = () => {
  const { user, logout } = useAuth();
  const { t, theme, toggleTheme, lang, setLang } = usePrefs();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
    setMobileMenuOpen(false);
  };

  const closeMenu = () => setMobileMenuOpen(false);
  const desktop = ({ isActive }: { isActive: boolean }) => isActive ? 'menu-item active' : 'menu-item';
  const mobile = ({ isActive }: { isActive: boolean }) => isActive ? 'mobile-nav-item active' : 'mobile-nav-item';

  const prefButtons = (
    <div className="pref-toggles">
      <button
        type="button"
        className="pref-toggle"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? t('nav.themeLight') : t('nav.themeDark')}
        title={theme === 'dark' ? t('nav.themeLight') : t('nav.themeDark')}
      >
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>
      <button
        type="button"
        className="pref-toggle"
        onClick={() => setLang(lang === 'vi' ? 'en' : 'vi')}
        aria-label={t('nav.language')}
        title={t('nav.language')}
      >
        <span className={lang === 'vi' ? 'pref-active' : undefined}>VI</span>
        {' | '}
        <span className={lang === 'en' ? 'pref-active' : undefined}>EN</span>
      </button>
    </div>
  );

  return (
    <nav className="desktop-navbar">
      <div className="top-menu-bar">
        <div className="top-menu-left">
          <Link to="/" className="navbar-brand" onClick={closeMenu}>
            AnkiWeb <span className="brand-icon">🌟</span>
          </Link>
          <div className="nav-links">
            <NavLink to="/intro" className={desktop}>{t('nav.guide')}</NavLink>
          {user && (
            <>
              <NavLink to="/decks" className={desktop}>{t('nav.decks')}</NavLink>
              <NavLink to="/add" className={desktop}>{t('nav.add')}</NavLink>
              <NavLink to="/browse" className={desktop}>{t('nav.browse')}</NavLink>
              <NavLink to="/stats" className={desktop}>{t('nav.stats')}</NavLink>
              <NavLink to="/custom-study" className={desktop}>{t('nav.customStudy')}</NavLink>
            </>
          )}
          </div>
        </div>
        <div className="top-menu-right">
          {prefButtons}
          {user ? (
            <>
              <NavLink to="/account" className={desktop}>{t('nav.account')}</NavLink>
              <button className="menu-item" onClick={handleLogout} style={{ cursor: 'pointer', background: 'none', border: 'none', color: 'inherit', font: 'inherit', padding: 0 }}>{t('nav.logout')}</button>
            </>
          ) : (
            <>
              <NavLink to="/login" className={desktop}>{t('nav.login')}</NavLink>
              <NavLink to="/register" className={desktop}>{t('nav.signup')}</NavLink>
            </>
          )}
        </div>
        <button
          className="hamburger-btn"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label={t('nav.toggleMenu')}
        >
          {mobileMenuOpen ? '✕' : '☰'}
        </button>
      </div>
      {mobileMenuOpen && (
        <div className="mobile-nav-menu">
          {prefButtons}
          <NavLink to="/intro" className={mobile} onClick={closeMenu}>{t('nav.guide')}</NavLink>
          {user ? (
            <>
              <NavLink to="/decks" className={mobile} onClick={closeMenu}>{t('nav.decks')}</NavLink>
              <NavLink to="/add" className={mobile} onClick={closeMenu}>{t('nav.add')}</NavLink>
              <NavLink to="/browse" className={mobile} onClick={closeMenu}>{t('nav.browse')}</NavLink>
              <NavLink to="/stats" className={mobile} onClick={closeMenu}>{t('nav.stats')}</NavLink>
              <NavLink to="/custom-study" className={mobile} onClick={closeMenu}>{t('nav.customStudy')}</NavLink>
              <NavLink to="/account" className={mobile} onClick={closeMenu}>{t('nav.account')}</NavLink>
              <span className="mobile-nav-item" onClick={handleLogout}>{t('nav.logout')}</span>
            </>
          ) : (
            <>
              <NavLink to="/login" className={mobile} onClick={closeMenu}>{t('nav.login')}</NavLink>
              <NavLink to="/register" className={mobile} onClick={closeMenu}>{t('nav.signup')}</NavLink>
            </>
          )}
        </div>
      )}
    </nav>
  );
};

export default Navbar;
