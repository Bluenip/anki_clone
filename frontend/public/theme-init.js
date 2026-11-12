// Runs before React so the page never flashes the wrong theme. Kept in sync with PrefsContext.
(function () {
  var theme;
  try { theme = localStorage.getItem('theme'); } catch { /* storage blocked */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#20252b');
})();
