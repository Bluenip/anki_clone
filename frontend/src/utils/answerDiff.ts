export type Difference = { kind: 'same' | 'insert' | 'delete'; text: string };
export function answerDiff(entered: string, expected: string): Difference[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const split = (s: string) => Array.from(segmenter.segment(s.normalize('NFC')), x => x.segment);
  const a = split(entered), b = split(expected), output: Difference[] = [];
  const emit = (kind: Difference['kind'], text: string) => { const last = output.at(-1); if (last?.kind === kind) last.text += text; else output.push({ kind, text }); };
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) { emit('same', a[start]); start++; }
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (n * m > 1000000) {
    if (n) emit('delete', a.slice(start, endA).join(''));
    if (m) emit('insert', b.slice(start, endB).join(''));
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[start + i] === b[start + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) { emit('same', a[start + i]); i++; j++; }
      else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) emit('delete', a[start + i++]);
      else emit('insert', b[start + j++]);
    }
  }
  if (endA < a.length) emit('same', a.slice(endA).join(''));
  return output;
}
