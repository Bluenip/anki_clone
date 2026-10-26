import { sanitizeHtml } from './sanitize';

export function formatVisual(targetId: string, before: string, after: string, onChange: (value: string) => void): boolean {
  const editor = Array.from(document.querySelectorAll<HTMLElement>('[data-visual-for]')).find(e => e.dataset.visualFor === targetId);
  if (!editor) return false;
  const selection = window.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return true;
  const range = selection.getRangeAt(0);
  const content = range.cloneContents();
  const holder = document.createElement('div'); holder.append(content);
  const fragment = range.createContextualFragment(sanitizeHtml(before + holder.innerHTML + after));
  range.deleteContents(); range.insertNode(fragment);
  onChange(sanitizeHtml(editor.innerHTML));
  editor.focus();
  return true;
}
