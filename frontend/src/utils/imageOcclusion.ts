export type Point = { x: number; y: number };
export type Mask = { id: number; left: number; top: number; width: number; height: number; hideAll: boolean; shape?: 'rect' | 'ellipse' | 'polygon' | 'text'; angle?: number; fill?: string; text?: string; scale?: number; fontSize?: number; points?: Point[] };
const pattern = /\{\{c(0|[1-9]\d*)::image-occlusion:(rect|ellipse|polygon|text):([^{}]+)\}\}/g;
export function polygonBounds(points: Point[]) {
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
}
export function parseMasks(value: string): Mask[] {
  if (!value) return [];
  const invalid = () => new Error('Unsupported or invalid mask. Its source has been preserved.');
  if (value.replace(pattern, '').replace(/<br\s*\/?>|\s/gi, '')) throw invalid();
  const masks = Array.from(value.matchAll(pattern), match => {
    const shape = match[2] as NonNullable<Mask['shape']>;
    const required = ['left', 'top', ...(shape === 'rect' ? ['width', 'height'] : shape === 'ellipse' ? ['rx', 'ry'] : shape === 'polygon' ? ['points'] : ['text', 'scale'])];
    const parts: string[] = []; let part = '', escaped = false;
    for (const char of match[3]) {
      if (escaped) { if (char !== '\\' && char !== ':') throw invalid(); part += char; escaped = false; }
      else if (char === '\\') escaped = true;
      else if (char === ':') { parts.push(part); part = ''; }
      else part += char;
    }
    if (escaped) throw invalid();
    parts.push(part);
    const pairs = parts.map(p => { const at = p.indexOf('='); return at < 0 ? [p] : [p.slice(0, at), p.slice(at + 1)]; });
    const props: Record<string, string> = Object.fromEntries(pairs);
    if (pairs.some(p => p.length !== 2 || ![...required, 'oi', 'angle', 'fill', ...(shape === 'text' ? ['fs'] : [])].includes(p[0])) || new Set(pairs.map(p => p[0])).size !== pairs.length || required.some(k => !props[k]?.trim())) throw invalid();
    const angle = Number(props.angle ?? 0), scale = Number(props.scale ?? 1), fontSize = Number(props.fs ?? .05);
    if (!Number.isFinite(angle) || Math.abs(angle) > 10000 || !Number.isFinite(scale) || scale < .01 || scale > 100 || !Number.isFinite(fontSize) || fontSize < .001 || fontSize > 1 || (Number(match[1]) === 0 && shape !== 'text') || (shape === 'text' && props.text.length > 2000)) throw invalid();
    if (props.fill && !/^(?:#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|black|white|red|green|blue|yellow|orange|purple|gray|grey|transparent|rgba?\([0-9.,% ]+\))$/.test(props.fill)) throw invalid();
    const points = shape === 'polygon' ? props.points.trim().split(/\s+/).map(pair => {
      const parts = pair.split(',');
      if (parts.length !== 2 || parts.some(p => !p.trim() || !Number.isFinite(Number(p)))) throw invalid();
      return { x: Number(parts[0]), y: Number(parts[1]) };
    }) : undefined;
    if (points && (points.length < 3 || points.length > 100 || points.some(p => Math.abs(p.x) > 10 || Math.abs(p.y) > 10) || Math.abs(points.reduce((a, p, i) => { const q = points[(i + 1) % points.length]; return a + p.x * q.y - q.x * p.y; }, 0)) < 1e-10)) throw invalid();
    const bounds = points ? polygonBounds(points) : undefined;
    const mask: Mask = { id: Number(match[1]), left: Number(props.left), top: Number(props.top), width: shape === 'text' ? .001 : bounds?.width ?? (shape === 'ellipse' ? Number(props.rx) * 2 : Number(props.width)), height: shape === 'text' ? .001 : bounds?.height ?? (shape === 'ellipse' ? Number(props.ry) * 2 : Number(props.height)), hideAll: props.oi === '1', ...(shape !== 'rect' ? { shape } : {}), ...(points ? { points } : {}), ...(props.angle ? { angle: angle * .036 } : {}), ...(props.fill ? { fill: props.fill } : {}), ...(shape === 'text' ? { text: props.text, scale, fontSize } : {}) };
    if (![mask.left, mask.top, mask.width, mask.height].every(v => Number.isFinite(v) && v >= 0 && v <= 1) || mask.width <= 0 || mask.height <= 0 || mask.left + mask.width > 1.000001 || mask.top + mask.height > 1.000001 || mask.id > 1000 || !['0', '1'].includes(props.oi ?? '0')) throw invalid();
    return mask;
  });
  if (masks.length > 100) throw invalid();
  return masks;
}
export function serializeMasks(masks: Mask[]) {
  const n = (v: number) => v.toFixed(6);
  return masks.map(m => {
    const escaped = (v: string) => v.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
    const geometry = m.shape === 'text' ? `text=${escaped(m.text || '')}:scale=${n(m.scale ?? 1)}:fs=${n(m.fontSize ?? .05)}` : m.shape === 'ellipse' ? `rx=${n(m.width / 2)}:ry=${n(m.height / 2)}` : m.shape === 'polygon' ? `points=${m.points!.map(p => `${n(p.x)},${n(p.y)}`).join(' ')}` : `width=${n(m.width)}:height=${n(m.height)}`;
    return `{{c${m.id}::image-occlusion:${m.shape || 'rect'}:left=${n(m.left)}:top=${n(m.top)}:${geometry}${m.angle ? `:angle=${Math.round(m.angle / .036)}` : ''}${m.fill ? `:fill=${m.fill}` : ''}${m.hideAll ? ':oi=1' : ''}}}<br>`;
  }).join('');
}
