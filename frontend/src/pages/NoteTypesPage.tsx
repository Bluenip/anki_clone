import { Link } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import client from '../api/client';
import CardFace from '../components/CardFace';
import { usePrefs } from '../context/usePrefs';
import { tNow } from '../context/prefs-context-base';

type Template = { name: string; qfmt: string; afmt: string };
type Model = { id?: number; revision?: string; name: string; fields: string[]; templates: Template[]; css: string; latex_header?: string; latex_footer?: string };
const blank = (): Model => ({ name: 'My note type', fields: ['Front', 'Back'], templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id="answer">{{Back}}' }], css: '.card { font-size: 20px; }' });
const message = (e: unknown, fallback: string) => {
  const detail = (e as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
  return typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : fallback;
};

export default function NoteTypesPage() {
  const { t } = usePrefs();
  const [models, setModels] = useState<Model[]>([]);
  const [draft, setDraft] = useState<Model>(blank);
  const [samples, setSamples] = useState<Record<string, string>>({ Front: 'Question', Back: 'Answer' });
  const [preview, setPreview] = useState<{ cards: { ordinal: number; front: string; back: string }[]; css: string }>();
  const [renameFrom, setRenameFrom] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const pending = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    let active = true;
    client.get<Model[]>('/api/models').then(r => { if (active) setModels(r.data); }).catch(e => { if (active) setError(message(e, tNow('common.requestFailed'))); });
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
        if (latest) { change(latest); setStatus(t('nt.reloaded')); }
      } else if (action === 'preview') {
        const { data } = await client.post('/api/models/preview', { ...draft, values: Object.fromEntries(draft.fields.map(f => [f, samples[f] || ''])) });
        if (epoch.current === token) setPreview(data);
      } else {
        const { data } = draft.id
          ? await client.put<Model>(`/api/models/${draft.id}`, { ...draft, expected_revision: draft.revision })
          : await client.post<Model>('/api/models', draft);
        if (epoch.current !== token) return;
        setDraft(data); setModels(old => [...old.filter(m => m.id !== data.id), data]); setStatus(t('nt.saved'));
      }
    } catch (e) { if (epoch.current === token) setError(message(e, t('common.requestFailed'))); }
    finally { pending.current = false; setBusy(false); }
  };
  const savedDefinition = models.find(m => m.id === draft.id);
  const dirtyDefinition = Boolean(draft.id && JSON.stringify(draft) !== JSON.stringify(savedDefinition));
  const renameField = async () => {
    if (dirtyDefinition) { setError(t('nt.saveFirst')); return; }
    if (pending.current || !draft.id || !draft.revision) return;
    pending.current = true; setBusy(true); setError('');
    const token = epoch.current;
    try {
      const { data } = await client.post<Model>(`/api/models/${draft.id}/rename-field`, { old_name: renameFrom, new_name: renameTo, expected_revision: draft.revision });
      if (token !== epoch.current) return;
      change(data); setModels(old => old.map(m => m.id === data.id ? data : m));
      setSamples(old => { const next = { ...old, [renameTo]: old[renameFrom] || '' }; delete next[renameFrom]; return next; });
      setRenameFrom(''); setRenameTo(''); setStatus(t('nt.renamed'));
    } catch (e) { if (token === epoch.current) setError(message(e, t('common.requestFailed'))); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="page-container note-types-page" style={{ maxWidth: 1000 }}>
    <h1>{t('nt.title')}</h1><p><Link to="/media">{t('nt.checkMedia')}</Link></p>
    <p>{t('nt.description')}</p>
    {error && <p role="alert" className="alert alert-error">{error}</p>}
    {status && <p role="status">{status}</p>}
    <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <label>{t('nt.noteType')} <select value={draft.id || ''} onChange={e => {
        const model = models.find(m => m.id === Number(e.target.value)); change(model || blank()); setError('');
      }}><option value="">{t('nt.createNew')}</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <button type="button" onClick={() => change({ ...draft, id: undefined, revision: undefined, name: `${draft.name} ${t('nt.copySuffix')}` })}>{t('nt.clone')}</button>
      {draft.id && <button type="button" onClick={() => void perform('reload')}>{t('nt.reload')}</button>}
      <div className="glass-card" style={{ padding: 20, marginTop: 16 }}>
        <label>{t('nt.name')}<input value={draft.name} onChange={e => change({ ...draft, name: e.target.value })} /></label>
        <label>{t('nt.fields')}<textarea rows={4} value={draft.fields.join('\n')} onChange={e => change({ ...draft, fields: e.target.value.split('\n') })} /></label>
        <p>{t('nt.renameHint')}</p>
        {draft.id && <fieldset disabled={busy || dirtyDefinition}><legend>{t('nt.renameLegend')}</legend>
          <label>{t('nt.existingField')}<select value={renameFrom} onChange={e => setRenameFrom(e.target.value)}><option value="">{t('nt.chooseField')}</option>{models.find(m => m.id === draft.id)?.fields.map(f => <option key={f}>{f}</option>)}</select></label>
          <label>{t('nt.newFieldName')}<input value={renameTo} onChange={e => setRenameTo(e.target.value)} /></label>
          <button type="button" disabled={!renameFrom || !renameTo.trim()} onClick={() => void renameField()}>{t('nt.renameButton')}</button>
        </fieldset>}
        {draft.templates.map((tpl, index) => <section key={index} style={{ marginBlock: 20 }}>
          <h2>{t('nt.card', { n: index + 1 })}</h2>
          {(['name', 'qfmt', 'afmt'] as const).map(key => <label key={key}>{key === 'qfmt' ? t('nt.frontTemplate') : key === 'afmt' ? t('nt.backTemplate') : t('nt.templateName')}
            <textarea rows={key === 'name' ? 1 : 5} value={tpl[key]} onChange={e => change({ ...draft, templates: draft.templates.map((old, i) => i === index ? { ...old, [key]: e.target.value } : old) })} />
          </label>)}
        </section>)}
        <button type="button" onClick={() => change({ ...draft, templates: [...draft.templates, { name: `Card ${draft.templates.length + 1}`, qfmt: '{{' + draft.fields[0] + '}}', afmt: '{{FrontSide}}' }] })}>{t('nt.addTemplate')}</button>
        <label>{t('nt.css')}<textarea rows={7} value={draft.css} onChange={e => change({ ...draft, css: e.target.value })} /></label>
        <details><summary>{t('nt.latex')}</summary>
          <p>{t('nt.latexHint')}</p>
          <label>{t('nt.latexHeader')}<textarea rows={7} value={draft.latex_header ?? ''} placeholder={t('nt.serverDefault')} onChange={e => change({ ...draft, latex_header: e.target.value })} /></label>
          <label>{t('nt.latexFooter')}<textarea rows={2} value={draft.latex_footer ?? ''} placeholder={t('nt.serverDefault')} onChange={e => change({ ...draft, latex_footer: e.target.value })} /></label>
        </details>
        <h2>{t('nt.previewFields')}</h2>
        {draft.fields.map((f, i) => <label key={i}>{f}<textarea rows={2} value={samples[f] || ''} onChange={e => { setSamples({ ...samples, [f]: e.target.value }); setPreview(undefined); }} /></label>)}
        <button type="button" onClick={() => void perform('preview')}>{t('common.preview')}</button>{' '}
        <button type="button" className="btn btn-primary" onClick={() => void perform('save')}>{t('nt.save')}</button>
      </div>
    </fieldset>
    {preview?.cards.map(card => <section key={card.ordinal}><h2>{t('nt.cardPreview', { n: card.ordinal + 1 })}</h2>
      <CardFace html={card.front} cardCss={preview.css} title={t('nt.frontPreview')} />
      <CardFace html={card.back} cardCss={preview.css} title={t('nt.backPreview')} />
    </section>)}
  </div>;
}
