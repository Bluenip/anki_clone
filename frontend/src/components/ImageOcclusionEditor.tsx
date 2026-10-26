import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import client from '../api/client';
import { useAuth } from '../context/useAuth';

import { parseMasks, serializeMasks, polygonBounds } from '../utils/imageOcclusion';
import type { Mask, Point } from '../utils/imageOcclusion';

export default function ImageOcclusionEditor({ fields, onChange, disabled = false, onBusyChange }: {
  fields: Record<string, string>; onChange: (fields: Record<string, string>) => void;
  disabled?: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<Mask | null>(null);
  const [tool, setTool] = useState<'rect' | 'ellipse' | 'polygon' | 'text'>('rect');
  const [imageAspect, setImageAspect] = useState(1);
  const [vertices, setVertices] = useState<Point[]>([]);
  const [showAnswer, setShowAnswer] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  const lastOrdinal = useRef(0);
  const start = useRef<{ x: number; y: number; pointer: number } | null>(null);
  // Keep async uploads bound to this mounted editor, never the next note/type.
  const latest = useRef({ fields, onChange, onBusyChange });
  useLayoutEffect(() => { latest.current = { fields, onChange, onBusyChange }; }, [fields, onChange, onBusyChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (pending.current) latest.current.onBusyChange(false); }; }, []);
  let masks: Mask[] = [], parseError = '';
  try { masks = parseMasks(fields.Occlusion || ''); } catch (e) { parseError = (e as Error).message; }
  const rawSource = new DOMParser().parseFromString(fields.Image || '', 'text/html').querySelector('img')?.getAttribute('src') || '';
  const localPath = user && rawSource && !/[:/\\]/.test(rawSource) && !rawSource.startsWith('.')
    ? `/api/media/${user.id}/${encodeURIComponent(rawSource)}`
    : user && rawSource.startsWith(`/api/media/${user.id}/`) ? rawSource : '';
  const source = localPath ? (import.meta.env.VITE_API_URL || '') + localPath : '';
  const locked = disabled || busy || !!parseError;
  const selectedIndex = selected !== null && selected < masks.length ? selected : 0;
  const hideAll = masks[0]?.hideAll ?? true;
  const saveMasks = (next: Mask[]) => {
    const source = serializeMasks(next);
    try { parseMasks(source); } catch (e) { setError((e as Error).message); return; }
    setError(''); onChange({ ...fields, Occlusion: source });
  };
  const updateSelected = (changes: Partial<Mask>) => saveMasks(masks.map((m, i) => i === selectedIndex ? { ...m, ...changes } : m));
  const upload = async (file: File) => {
    if (locked || pending.current) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { setError('Choose a PNG, JPEG, WebP or GIF image.'); return; }
    if (file.size > 20 * 1024 * 1024) { setError('Image exceeds 20 MB.'); return; }
    pending.current = true; setBusy(true); onBusyChange(true); setError('');
    try {
      const form = new FormData(); form.append('file', file);
      const { data } = await client.post<{ markup: string }>('/api/media-tools/upload', form, { headers: { 'Content-Type': undefined } });
      if (mounted.current) {
        latest.current.onChange({ ...latest.current.fields, Image: data.markup });
        setLoaded('');
      }
    } catch (e) { if (mounted.current) setError((e as { response?: { data?: { detail?: string } } }).response?.data?.detail || 'Image upload failed.'); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); latest.current.onBusyChange(false); } }
  };
  const point = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) };
  };
  const rectangle = (e: PointerEvent<HTMLDivElement>): Mask | null => {
    if (!start.current || e.pointerId !== start.current.pointer) return null;
    const p = point(e), s = start.current;
    return { id: Math.max(lastOrdinal.current, ...masks.map(m => m.id)) + 1, left: Math.min(s.x, p.x), top: Math.min(s.y, p.y), width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y), hideAll, ...(tool === 'ellipse' ? { shape: tool } : {}) };
  };
  const finishPolygon = () => {
    if (locked || vertices.length < 3 || masks.length >= 100) return;
    const bounds = polygonBounds(vertices);
    const id = Math.max(lastOrdinal.current, ...masks.map(m => m.id)) + 1;
    const next: Mask = { id, shape: 'polygon', left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, points: vertices, hideAll };
    try { parseMasks(serializeMasks([...masks, next])); }
    catch { setError('Choose at least three vertices enclosing an area inside the image.'); return; }
    lastOrdinal.current = id; saveMasks([...masks, next]); setSelected(masks.length); setVertices([]); setError('');
  };
  return <section className="form-group" aria-label="Image Occlusion editor" style={{ marginBlock: 16, scrollMarginTop: 80 }}>
    <p>Draw rectangles, ellipses or polygons over answers in your image. Regions sharing a card number are revealed together. Select a region to preview its answer or adjust its coordinates.</p>
    <label>Occlusion image <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={locked} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} /></label>
    {masks.length > 0 && <p>Replacing the image keeps the existing regions and card identities.</p>}
    {busy && <p role="status">Uploading image…</p>}
    {(error || parseError) && <p role="alert">{error || parseError}</p>}
    <label>Mask mode <select value={hideAll ? 'all' : 'one'} disabled={locked || !masks.length} onChange={e => saveMasks(masks.map(m => ({ ...m, hideAll: e.target.value === 'all' })))}>
      <option value="all">Hide all, guess one</option><option value="one">Hide one, guess one</option>
    </select></label>
    <label>Drawing tool <select aria-label="Drawing tool" disabled={locked} value={tool} onChange={e => { setTool(e.target.value as typeof tool); setVertices([]); setDraft(null); start.current = null; }}><option value="rect">Rectangle</option><option value="ellipse">Ellipse</option><option value="polygon">Polygon</option><option value="text">Text annotation</option></select></label>
    {tool === 'text' && <p>Click the image to place a text annotation. Annotations stay visible on both sides and do not create a card.</p>}
    {tool === 'polygon' && <p>Click each corner, then finish the polygon. {vertices.length}/100 vertices.
      <button type="button" disabled={locked || vertices.length < 3} onClick={finishPolygon}>Finish polygon</button>
      <button type="button" disabled={locked || !vertices.length} onClick={() => setVertices(v => v.slice(0, -1))}>Undo vertex</button>
      <button type="button" disabled={locked || !vertices.length} onClick={() => setVertices([])}>Cancel polygon</button>
    </p>}
    {source && <div aria-label="Draw mask on image" style={{ position: 'relative', overflow: 'hidden', containerType: 'inline-size', touchAction: 'none', userSelect: 'none', marginBlock: 12, lineHeight: 0 }}
      onPointerDown={e => { if (locked || loaded !== source || e.button !== 0 || masks.length >= 100 || Math.max(lastOrdinal.current, ...masks.map(m => m.id)) >= 1000) return; const p = point(e); if (tool === 'text') { saveMasks([...masks, { id: 0, shape: 'text', left: Math.min(p.x, .999), top: Math.min(p.y, .999), width: .001, height: .001, hideAll, text: 'Label', scale: 1, fontSize: .05 }]); setSelected(masks.length); return; } if (tool === 'polygon') { if (vertices.length < 100) setVertices(v => [...v, p]); setShowAnswer(false); return; } start.current = { ...p, pointer: e.pointerId }; e.currentTarget.setPointerCapture?.(e.pointerId); setShowAnswer(false); }}
      onPointerMove={e => { if (!locked) setDraft(rectangle(e)); }}
      onPointerUp={e => { const next = rectangle(e); start.current = null; setDraft(null); if (!locked && next && next.width >= .005 && next.height >= .005) { lastOrdinal.current = next.id; saveMasks([...masks, next]); setSelected(masks.length); } }}
      onPointerCancel={() => { start.current = null; setDraft(null); }}>
      <img src={source} alt="Image to mask" draggable={false} style={{ width: '100%', display: 'block' }} onLoad={e => { setImageAspect(e.currentTarget.naturalHeight / e.currentTarget.naturalWidth || 1); setLoaded(source); setError(''); }} onError={() => { setLoaded(''); setError('Could not load the image. Upload it again.'); }} />
      {vertices.length > 0 && <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Polygon in progress" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}><polyline points={vertices.map(p => `${p.x},${p.y}`).join(' ')} fill="#ffca6480" stroke="#f90" strokeWidth="2" vectorEffect="non-scaling-stroke" />{vertices.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r=".005" fill="#f90" />)}</svg>}
      {[...masks, ...(draft ? [draft] : [])].map((m, i) => {
        const active = m.id === masks[selectedIndex]?.id || i === masks.length;
        const transform = `rotate(${m.angle || 0}deg)`;
        if (m.shape === 'text') return <span key={i} data-io-text={m.id} style={{ position: 'absolute', pointerEvents: 'none', left: `${m.left * 100}%`, top: `${m.top * 100}%`, fontFamily: 'Arial,sans-serif', fontSize: `${(m.fontSize || .05) * imageAspect * 100}cqw`, lineHeight: 1, whiteSpace: 'pre', color: m.fill || 'black', transformOrigin: '0 0', transform: `${transform} scale(${m.scale || 1})` }}>{m.text}</span>;
        const fill = active && showAnswer || !active && !m.hideAll ? 'transparent' : m.fill || (active ? '#ffca64' : '#8893a5');
        if (m.shape === 'polygon' && m.points) {
          const bounds = polygonBounds(m.points);
          return <svg key={i} aria-label={`Polygon region ${i + 1} (card ${m.id})`} viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', pointerEvents: 'none', transformOrigin: '0 0', transform, left: `${m.left * 100}%`, top: `${m.top * 100}%`, width: `${m.width * 100}%`, height: `${m.height * 100}%`, overflow: 'visible' }}><polygon points={m.points.map(p => `${(p.x - bounds.x) / bounds.width * 100},${(p.y - bounds.y) / bounds.height * 100}`).join(' ')} fill={fill} stroke={active ? '#f90' : '#64748b'} strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
        }
        return <span key={i} style={{ position: 'absolute', pointerEvents: 'none', transformOrigin: '0 0', transform, left: `${m.left * 100}%`, top: `${m.top * 100}%`, width: `${m.width * 100}%`, height: `${m.height * 100}%`, boxSizing: 'border-box', borderRadius: m.shape === 'ellipse' ? '50%' : undefined, border: `2px solid ${active ? '#f90' : '#64748b'}`, background: fill, color: '#111', lineHeight: 1.2 }}>{m.id}</span>;
      })}
    </div>}
    <p>{new Set(masks.filter(m => m.id > 0).map(m => m.id)).size} cards · {masks.length}/100 regions</p>
    {masks.length > 0 && <>
      <label>Selected region <select aria-label="Selected region" value={selectedIndex} disabled={locked} onChange={e => { setSelected(Number(e.target.value)); setShowAnswer(false); }}>{masks.map((m, i) => <option key={i} value={i}>Region {i + 1} (card {m.id})</option>)}</select></label>
      <label>Card group <select aria-label="Card group" disabled={locked || masks[selectedIndex]?.shape === 'text'} value={masks[selectedIndex]?.id} onChange={e => {
        const id = e.target.value === 'new' ? Math.max(lastOrdinal.current, ...masks.map(m => m.id)) + 1 : Number(e.target.value);
        if (id > 1000) return;
        lastOrdinal.current = Math.max(lastOrdinal.current, id, ...masks.map(m => m.id));
        saveMasks(masks.map((m, i) => i === selectedIndex ? { ...m, id } : m));
      }}>{[...new Set(masks.filter(m => m.id > 0 || masks[selectedIndex]?.id === 0).map(m => m.id))].map(id => <option key={id} value={id}>Card {id}</option>)}<option value="new" disabled={Math.max(...masks.map(m => m.id)) >= 1000}>New separate card</option></select></label>
      <button className="btn btn-sm btn-ghost" style={{ marginBlock: 8, marginRight: 8 }} type="button" disabled={locked} onClick={() => setShowAnswer(v => !v)}>{showAnswer ? 'Preview question' : 'Preview answer'}</button>
      <button className="btn btn-sm btn-danger" style={{ marginBlock: 8 }} type="button" disabled={locked} onClick={() => { lastOrdinal.current = Math.max(lastOrdinal.current, ...masks.map(m => m.id)); saveMasks(masks.filter((_, i) => i !== selectedIndex)); setSelected(null); }}>Delete selected region</button>
      <label>Rotation (degrees)<input aria-label="Mask rotation" type="number" min="-360" max="360" step="any" disabled={locked} value={masks[selectedIndex]?.angle || 0} onChange={e => { const angle = Number(e.target.value); if (Number.isFinite(angle) && Math.abs(angle) <= 360) updateSelected({ angle }); }} /></label>
      <label>Color<input aria-label="Mask color" type="color" disabled={locked} value={/^#[0-9a-f]{6}$/i.test(masks[selectedIndex]?.fill || '') ? masks[selectedIndex].fill : '#ffca64'} onChange={e => updateSelected({ fill: e.target.value })} /></label>
      <button type="button" disabled={locked} onClick={() => updateSelected({ fill: undefined })}>Reset color</button>
      {masks[selectedIndex]?.shape === 'text' && <>
        <label>Annotation text<input aria-label="Annotation text" maxLength={2000} disabled={locked} value={masks[selectedIndex].text || ''} onChange={e => { if (e.target.value) updateSelected({ text: e.target.value }); }} /></label>
        <label>Text size (% image height)<input aria-label="Annotation size" type="number" min=".1" max="100" step="any" disabled={locked} value={(masks[selectedIndex].fontSize || .05) * 100} onChange={e => { const size = Number(e.target.value) / 100; if (size >= .001 && size <= 1) updateSelected({ fontSize: size }); }} /></label>
        <label>Text scale<input aria-label="Annotation scale" type="number" min=".01" max="100" step="any" disabled={locked} value={masks[selectedIndex].scale || 1} onChange={e => { const scale = Number(e.target.value); if (scale >= .01 && scale <= 100) updateSelected({ scale }); }} /></label>
      </>}
      {(['left', 'top', 'width', 'height'] as const).filter(key => masks[selectedIndex]?.shape !== 'text' || key === 'left' || key === 'top').map(key => <label key={key} style={{ display: 'inline-block', maxWidth: 120, margin: 4 }}>{key} (%)<input aria-label={`Mask ${key} (%)`} type="number" min="0" max="100" step="any" value={Number(((masks[selectedIndex]?.[key] ?? 0) * 100).toFixed(3))} disabled={locked} onChange={e => {
        const value = Number(e.target.value) / 100;
        const next = masks.map((m, i) => {
          if (i !== selectedIndex) return m;
          const resized = { ...m, [key]: value };
          if (m.points && (key === 'width' || key === 'height')) {
            const bounds = polygonBounds(m.points);
            resized.points = m.points.map(p => ({ x: bounds.x + (p.x - bounds.x) * resized.width / m.width, y: bounds.y + (p.y - bounds.y) * resized.height / m.height }));
          }
          return resized;
        });
        if (next.every(m => m.width > 0 && m.height > 0 && m.left >= 0 && m.top >= 0 && m.left + m.width <= 1.000001 && m.top + m.height <= 1.000001)) saveMasks(next);
      }} /></label>)}
      <p>Deleting or regrouping away a card with study history is blocked when saving. Other regions keep their card identities.</p>
    </>}
  </section>;
}
