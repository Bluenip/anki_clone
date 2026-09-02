const Footer = () => (
  <footer className="footer">
    <div className="footer-inner">
      <div className="footer-links">
        <a href="#">Apps</a>
        <a href="#">About</a>
        <a href="#">Support</a>
        <a href="#">Terms</a>
        <a href="#">Privacy</a>
      </div>
      <p className="footer-copy">&copy; {new Date().getFullYear()} AnkiClone. Built with ⚡</p>
    </div>
  </footer>
);

export default Footer;
