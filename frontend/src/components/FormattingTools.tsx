import { useState } from 'react';
import type { ReactNode } from 'react';
import VisualField from './VisualField';
import { formatVisual } from '../utils/visualFormat';
import { usePrefs } from '../context/usePrefs';
import type { MessageKey } from '../i18n/en';

type Tool = readonly [MessageKey, string, string, ReactNode];

// Bold/italic/underline are used all the time; the rest stay one click away behind "⋯".
const MAIN: Tool[] = [['fmt.bold', '<b>', '</b>', <b key="b">B</b>], ['fmt.italic', '<i>', '</i>', <i key="i">I</i>],
  ['fmt.underline', '<u>', '</u>', <u key="u">U</u>]];
const MORE: Tool[] = [['fmt.subscript', '<sub>', '</sub>', <>x<sub>2</sub></>], ['fmt.superscript', '<sup>', '</sup>', <>x<sup>2</sup></>],
  ['fmt.list', '<ul><li>', '</li></ul>', '•'], ['fmt.math', '\\(', '\\)', '∑']];

export default function FormattingTools({ targetId, disabled, onChange }: { targetId: string; disabled: boolean; onChange: (value: string) => void }) {
  const { t } = usePrefs();
  const [more, setMore] = useState(false);
  const wrap = (before: string, after: string) => {
    if (disabled || formatVisual(targetId, before, after, onChange)) return;
    const input = document.getElementById(targetId) as HTMLTextAreaElement | null;
    if (!input || disabled) return;
    const start = input.selectionStart, end = input.selectionEnd;
    onChange(input.value.slice(0, start) + before + input.value.slice(start, end) + after + input.value.slice(end));
    requestAnimationFrame(() => { if (input.isConnected) { input.focus(); input.setSelectionRange(start + before.length, end + before.length); } });
  };
  const button = ([name, before, after, icon]: Tool) => (
    <button key={name} type="button" className="tool-button" disabled={disabled} title={t(name)} aria-label={t(name)}
      onMouseDown={e => e.preventDefault()} onClick={() => wrap(before, after)}>{icon}</button>
  );
  return <div className="formatting-tools" role="toolbar" aria-label={t('fmt.toolbar')}>
    {MAIN.map(button)}
    <button type="button" className="tool-button" aria-expanded={more} title={t('fmt.more')} aria-label={t('fmt.more')}
      onClick={() => setMore(open => !open)}>⋯</button>
    {more && MORE.map(button)}
    <VisualField targetId={targetId} disabled={disabled} onChange={onChange} />
  </div>;
}
