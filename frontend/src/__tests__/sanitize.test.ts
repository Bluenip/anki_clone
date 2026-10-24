import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from '../utils/sanitize';

describe('sanitizeHtml security regression suite', () => {
  it('strips <script> tags completely', () => {
    const malicious = 'Hello <script>alert("pwned")</script>World';
    const clean = sanitizeHtml(malicious);
    expect(clean).not.toContain('<script>');
    expect(clean).not.toContain('alert');
    expect(clean).toContain('Hello');
    expect(clean).toContain('World');
  });

  it('strips inline event handlers like onerror and onload', () => {
    const malicious = '<img src="x" onerror="alert(1)" /><svg onload="alert(2)">';
    const clean = sanitizeHtml(malicious);
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('onload');
    expect(clean).not.toContain('alert');
  });

  it('strips javascript: and vbscript: URIs from href attributes', () => {
    const malicious = '<a href="javascript:alert(1)">Click me</a><a href="vbscript:msgbox(1)">VBS</a>';
    const clean = sanitizeHtml(malicious);
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('vbscript:');
    expect(clean).toContain('Click me');
  });

  it('strips data:text/html URIs from links', () => {
    const malicious = '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Malicious link</a>';
    const clean = sanitizeHtml(malicious);
    expect(clean).not.toContain('data:text/html');
  });

  it('preserves legitimate safe formatting and styling', () => {
    const safeHtml = '<p>This is <b>bold</b> and <i>italic</i> with <span style="color: red;">styled text</span></p>';
    const clean = sanitizeHtml(safeHtml);
    expect(clean).toContain('<b>bold</b>');
    expect(clean).toContain('<i>italic</i>');
    expect(clean).toContain('<p>');
  });

  it('preserves legitimate media tags (audio, img, video)', () => {
    const mediaHtml = '<img src="/api/media/test.jpg" alt="test image" /><audio src="/api/media/audio.mp3" controls></audio>';
    const clean = sanitizeHtml(mediaHtml);
    expect(clean).toContain('<img src="/api/media/test.jpg"');
    expect(clean).toContain('<audio src="/api/media/audio.mp3"');
  });

  it('ensures target="_blank" links receive rel="noopener noreferrer"', () => {
    const linkHtml = '<a href="https://example.com" target="_blank">External</a>';
    const clean = sanitizeHtml(linkHtml);
    expect(clean).toContain('rel="noopener noreferrer"');
  });
});
