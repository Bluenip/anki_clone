import { useLayoutEffect, useRef, useState } from 'react';
import { sanitizeHtml } from '../utils/sanitize';

export default function VisualField({ targetId, disabled, onChange }: { targetId: string; disabled: boolean; onChange: (value: string) => void }) {
  const [visual, setVisual] = useState(false);
  const [invalidMessage, setInvalidMessage] = useState('');
  const editor = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const source = document.getElementById(targetId) as HTMLTextAreaElement | null;
    if (!source) return;
    source.hidden = visual;
    const invalid = (event: Event) => { if (visual) { event.preventDefault(); setInvalidMessage(source.validationMessage); editor.current?.focus(); } };
    source.addEventListener('invalid', invalid);
    if (editor.current && document.activeElement !== editor.current) editor.current.innerHTML = sanitizeHtml(source.value);
    return () => { source.hidden = false; source.removeEventListener('invalid', invalid); };
  });
  const insert = (html: string) => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.current?.contains(selection.anchorNode)) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const fragment = range.createContextualFragment(sanitizeHtml(html));
    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last) { range.setStartAfter(last); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); }
    onChange(sanitizeHtml(editor.current.innerHTML));
  };
  return <>
    <button type="button" aria-pressed={visual} disabled={disabled} onClick={() => setVisual(v => !v)}>{visual ? 'Edit HTML source' : 'Visual editor'}</button>
    {visual && <div ref={editor} data-visual-for={targetId} role="textbox" aria-label={`Visual ${targetId}`} aria-multiline="true" aria-invalid={Boolean(invalidMessage)} contentEditable={!disabled} suppressContentEditableWarning
      style={{ width: '100%', minHeight: 120, border: '1px solid var(--glass-border)', borderRadius: 8, padding: 12, overflowWrap: 'anywhere' }}
      onInput={e => { setInvalidMessage(''); onChange(sanitizeHtml(e.currentTarget.innerHTML)); }}
      onPaste={e => { e.preventDefault(); const html = e.clipboardData.getData('text/html'); const text = e.clipboardData.getData('text/plain'); const span = document.createElement('span'); span.textContent = text; insert(html || span.innerHTML.replace(/\n/g, '<br>')); }}
      onDrop={e => e.preventDefault()} />}
    {visual && invalidMessage && <p role="alert">{invalidMessage}</p>}
  </>;
}
