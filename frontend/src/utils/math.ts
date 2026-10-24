import renderMathInElement from 'katex/contrib/auto-render';
import 'katex/contrib/mhchem';
import mathCss from 'katex/dist/katex.min.css?inline';

export { mathCss };
export function renderMath(element: HTMLElement) {
  renderMathInElement(element, {
    delimiters: [
      { left: '\\(', right: '\\)', display: false },
      { left: '\\[', right: '\\]', display: true },
      { left: '$$', right: '$$', display: true },
      { left: '[$]', right: '[/$]', display: false },
      { left: '[$$]', right: '[/$$]', display: true },
    ],
    throwOnError: false, trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20,
    macros: {},
  });
}
