import { usePrefs } from '../context/usePrefs';
const Footer = () => {
  const { t } = usePrefs();
  return (
  <footer className="footer">
    <div className="footer-inner">
      <div className="footer-links">
        <a href="#">{t('footer.apps')}</a>
        <a href="#">{t('footer.about')}</a>
        <a href="#">{t('footer.support')}</a>
        <a href="#">{t('footer.terms')}</a>
        <a href="#">{t('footer.privacy')}</a>
      </div>
      <p className="footer-copy">&copy; {new Date().getFullYear()} AnkiClone. {t('footer.builtWith')} ⚡</p>
    </div>
  </footer>
  );
};

export default Footer;
