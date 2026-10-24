import { expect, it } from 'vitest';
import { renderMath } from '../utils/math';
import { sanitizeHtml } from '../utils/sanitize';
it('renders Anki inline/display delimiters while preserving literal currency and source', () => {
  const source = String.raw`<p>\(x^2+\frac{1}{2}\)</p><p>\[\ce{H2O}\]</p><p>$5</p>`;
  const doc = new DOMParser().parseFromString(sanitizeHtml(source), 'text/html');
  renderMath(doc.body);
  expect(doc.querySelectorAll('.katex').length).toBe(2);
  expect(doc.body.textContent).toContain('$5');
});
it('does not trust TeX URLs or interpret formulas inside code', () => {
  const doc = new DOMParser().parseFromString(String.raw`<p>\(\href{javascript:alert(1)}{click}\)</p><code>\(x\)</code>`, 'text/html');
  renderMath(doc.body);
  expect(doc.querySelector('a')).toBeNull();
  expect(doc.querySelector('code')?.textContent).toBe(String.raw`\(x\)`);
});
