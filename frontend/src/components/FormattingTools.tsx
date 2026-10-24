export default function FormattingTools({ targetId, disabled, onChange }: { targetId: string; disabled: boolean; onChange: (value: string) => void }) {
  const wrap = (before: string, after: string) => {
    const input = document.getElementById(targetId) as HTMLTextAreaElement | null;
    if (!input || disabled) return;
    const start = input.selectionStart, end = input.selectionEnd;
    onChange(input.value.slice(0, start) + before + input.value.slice(start, end) + after + input.value.slice(end));
    requestAnimationFrame(() => { if (input.isConnected) { input.focus(); input.setSelectionRange(start + before.length, end + before.length); } });
  };
  return <div className="formatting-tools" role="toolbar" aria-label="Field formatting" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBlock: 6 }}>
    {[
      ['Bold', '<b>', '</b>'], ['Italic', '<i>', '</i>'], ['Underline', '<u>', '</u>'],
      ['Subscript', '<sub>', '</sub>'], ['Superscript', '<sup>', '</sup>'],
      ['List', '<ul><li>', '</li></ul>'], ['Math', '\\(', '\\)'],
    ].map(([name, before, after]) => <button key={name} type="button" disabled={disabled} onClick={() => wrap(before, after)}>{name}</button>)}
  </div>;
}
