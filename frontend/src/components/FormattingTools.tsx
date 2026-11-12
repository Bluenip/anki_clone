import VisualField from './VisualField';
import { formatVisual } from '../utils/visualFormat';
import { usePrefs } from '../context/usePrefs';
export default function FormattingTools({ targetId, disabled, onChange }: { targetId: string; disabled: boolean; onChange: (value: string) => void }) {
  const { t } = usePrefs();
  const wrap = (before: string, after: string) => {
    if (disabled || formatVisual(targetId, before, after, onChange)) return;
    const input = document.getElementById(targetId) as HTMLTextAreaElement | null;
    if (!input || disabled) return;
    const start = input.selectionStart, end = input.selectionEnd;
    onChange(input.value.slice(0, start) + before + input.value.slice(start, end) + after + input.value.slice(end));
    requestAnimationFrame(() => { if (input.isConnected) { input.focus(); input.setSelectionRange(start + before.length, end + before.length); } });
  };
  return <div className="formatting-tools" role="toolbar" aria-label={t('fmt.toolbar')} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBlock: 6 }}>
    {([
      ['fmt.bold', '<b>', '</b>'], ['fmt.italic', '<i>', '</i>'], ['fmt.underline', '<u>', '</u>'],
      ['fmt.subscript', '<sub>', '</sub>'], ['fmt.superscript', '<sup>', '</sup>'],
      ['fmt.list', '<ul><li>', '</li></ul>'], ['fmt.math', '\\(', '\\)'],
    ] as const).map(([name, before, after]) => <button key={name} type="button" disabled={disabled} onMouseDown={e => e.preventDefault()} onClick={() => wrap(before, after)}>{t(name)}</button>)}
    <VisualField targetId={targetId} disabled={disabled} onChange={onChange} />
  </div>;
}
