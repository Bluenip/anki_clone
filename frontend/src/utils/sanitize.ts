import DOMPurify from 'dompurify';

/**
 * Centralized HTML sanitization for card content.
 * Allows rich formatting and media from .apkg imports while blocking XSS.
 */
const ALLOWED_TAGS = [
  // Text formatting
  'b', 'i', 'u', 'em', 'strong', 'sub', 'sup', 'mark', 's', 'del', 'ins',
  'small', 'big', 'abbr', 'cite', 'code', 'kbd', 'pre', 'samp', 'var',
  // Structure
  'details', 'summary', 'p', 'br', 'hr', 'div', 'span', 'blockquote',
  // Lists
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // Tables
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // Headings
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // Media
  'img', 'audio', 'source', 'video', 'figure', 'figcaption',
  // Ruby (for Japanese/Chinese)
  'ruby', 'rt', 'rp',
  // Links
  'a',
];

const ALLOWED_ATTR = [
  'class', 'id', 'style', 'title', 'lang', 'dir',
  // Media
  'src', 'alt', 'width', 'height', 'controls', 'autoplay', 'loop', 'muted',
  'preload', 'type', 'poster',
  // Links
  'href', 'target', 'rel',
  // Tables
  'colspan', 'rowspan', 'scope', 'headers',
  // General
  'data-*',
];

// Configure DOMPurify hooks
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  // Block dangerous URLs in href, src, and action
  if ((data.attrName === 'href' || data.attrName === 'src' || data.attrName === 'action') && data.attrValue) {
    const cleanVal = data.attrValue.replace(/\s+/g, '').toLowerCase();
    if (
      cleanVal.startsWith('javascript:') ||
      cleanVal.startsWith('vbscript:') ||
      cleanVal.startsWith('data:text/html') ||
      cleanVal.startsWith('data:application/xhtml+xml')
    ) {
      data.attrValue = '';
      data.keepAttr = false;
    }
  }
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function sanitizeHtml(dirty?: string | null): string {
  if (!dirty) return '';
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: true,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}
