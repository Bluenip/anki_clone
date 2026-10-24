import { Link } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import client from '../api/client';
import CardFace from '../components/CardFace';

type Template = { name: string; qfmt: string; afmt: string };
type Model = { id?: number; revision?: string; name: string; fields: string[]; templates: Template[]; css: string };
const blank = (): Model => ({ name: 'My note type', fields: ['Front', 'Back'], templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id="answer">{{Back}}' }], css: '.card { font-size: 20px; }' });
const message = (e: unknown) => {
  const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
  return typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : 'Request failed. Please try again.';
};

export default function NoteTypesPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [draft, setDraft] = useState<Model>(blank);
  const [samples, setSamples] = useState<Record<string, string>>({ Front: 'Question', Back: 'Answer' });
  const [preview, setPreview] = useState<{ cards: { ordinal: number; front: string; back: string }[]; css: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const pending = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    let active = true;
    client.get<Model[]>('/api/models').then(r => { if (active) setModels(r.data); }).catch(e => { if (active) setError(message(e)); });
    const generation = epoch;
    return () => { active = false; generation.current++; };
  }, []);
  const change = (next: Model) => { epoch.current++; setDraft(next); setPreview(undefined); setStatus(''); };
  const perform = async (action: 'save' | 'preview' | 'reload') => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setStatus('');
    const token = epoch.current;
    try {
      if (action === 'reload') {
        const { data } = await client.get<Model[]>('/api/models');
        if (epoch.current !== token) return;
        setModels(data);
        const latest = data.find(m => m.id === draft.id);
        if (latest) { change(latest); setStatus('Latest saved definition loaded.'); }
      } else if (action === 'preview') {
        const { data } = await client.post('/api/models/preview', { ...draft, values: Object.fromEntries(draft.fields.map(f => [f, samples[f] || ''])) });
        if (epoch.current === token) setPreview(data);
      } else {
        const { data } = draft.id
          ? await client.put<Model>(`/api/models/${draft.id}`, { ...draft, expected_revision: draft.revision })
          : await client.post<Model>('/api/models', draft);
        if (epoch.current !== token) return;
        setDraft(data); setModels(old => [...old.filter(m => m.id !== data.id), data]); setStatus('Saved. Existing cards keep their IDs and study history.');
      }
    } catch (e) { if (epoch.current === token) setError(message(e)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="page-container note-types-page" style={{ maxWidth: 1000 }}>
    <h1>Note types &amp; templates</h1><p><Link to="/media">Check media files</Link></p>
    <p>Edit source fields, card templates and shared styling. Saving applies to every note using this type.</p>
    {error && <p role="alert" className="alert alert-error">{error}</p>}
    {status && <p role="status">{status}</p>}
    <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <label>Note type <select value={draft.id || ''} onChange={e => {
        const model = models.find(m => m.id === Number(e.target.value)); change(model || blank()); setError('');
      }}><option value="">Create new</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <button type="button" onClick={() => change({ ...draft, id: undefined, revision: undefined, name: `${draft.name} copy` })}>Clone</button>
      {draft.id && <button type="button" onClick={() => void perform('reload')}>Reload saved definition (discards edits)</button>}
      <div className="glass-card" style={{ padding: 20, marginTop: 16 }}>
        <label>Name<input value={draft.name} onChange={e => change({ ...draft, name: e.target.value })} /></label>
        <label>Fields (one name per line)<textarea rows={4} value={draft.fields.join('\n')} onChange={e => change({ ...draft, fields: e.target.value.split('\n') })} /></label>
        <p>Fields match by name. A field containing data cannot be removed or renamed. Existing template positions identify their cards.</p>
        {draft.templates.map((t, index) => <section key={index} style={{ marginBlock: 20 }}>
          <h2>Card {index + 1}</h2>
          {(['name', 'qfmt', 'afmt'] as const).map(key => <label key={key}>{key === 'qfmt' ? 'Front template' : key === 'afmt' ? 'Back template' : 'Template name'}
            <textarea rows={key === 'name' ? 1 : 5} value={t[key]} onChange={e => change({ ...draft, templates: draft.templates.map((old, i) => i === index ? { ...old, [key]: e.target.value } : old) })} />
          </label>)}
        </section>)}
        <button type="button" onClick={() => change({ ...draft, templates: [...draft.templates, { name: `Card ${draft.templates.length + 1}`, qfmt: '{{' + draft.fields[0] + '}}', afmt: '{{FrontSide}}' }] })}>Add card template</button>
        <label>Shared CSS<textarea rows={7} value={draft.css} onChange={e => change({ ...draft, css: e.target.value })} /></label>
        <h2>Preview fields</h2>
        {draft.fields.map((f, i) => <label key={i}>{f}<textarea rows={2} value={samples[f] || ''} onChange={e => { setSamples({ ...samples, [f]: e.target.value }); setPreview(undefined); }} /></label>)}
        <button type="button" onClick={() => void perform('preview')}>Preview</button>{' '}
        <button type="button" className="btn btn-primary" onClick={() => void perform('save')}>Save note type</button>
      </div>
    </fieldset>
    {preview?.cards.map(card => <section key={card.ordinal}><h2>Card {card.ordinal + 1} preview</h2>
      <CardFace html={card.front} cardCss={preview.css} title="Front preview" />
      <CardFace html={card.back} cardCss={preview.css} title="Back preview" />
    </section>)}
  </div>;
}
