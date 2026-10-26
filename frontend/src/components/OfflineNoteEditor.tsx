import { useState } from 'react';
import { changeLocal, saveOfflineEdit } from '../utils/offline';
import type { LocalAccount, OfflineEdit, OfflineNote } from '../utils/offline';

export default function OfflineNoteEditor({ uid, account, busy, perform }: { uid: number; account: LocalAccount; busy: boolean; perform: (work: () => Promise<void>) => Promise<void> }) {
  const [selected, setSelected] = useState<OfflineNote | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [tags, setTags] = useState('');
  const notes = [...new Map(account.decks.flatMap(d => d.notes || []).map(n => [n.id, n])).values()];
  return <section style={{ marginBlock: 24 }}><h2>Edit downloaded notes</h2>
    <p>Edits are saved on this device, then merged when connected. Different fields merge automatically; conflicting fields require your choice. Study resumes after edited notes are synced. Fields contain their original HTML/cloze source.</p>
    <select aria-label="Offline note" disabled={busy} value={selected?.id || ''} onChange={e => { const note = notes.find(n => n.id === Number(e.target.value)) || null; setSelected(note); setFields(note?.fields || {}); setTags(note?.tags.join(' ') || ''); }}><option value="">Choose a downloaded note</option>{notes.map(note => <option key={note.id} value={note.id}>#{note.id} — {Object.values(note.fields)[0]?.slice(0, 80)}</option>)}</select>
    {selected && <form onSubmit={e => { e.preventDefault(); void perform(async () => { await saveOfflineEdit(uid, selected, fields, tags.split(/\s+/).filter(Boolean)); setSelected(null); }); }}>
      {Object.entries(fields).map(([key, value]) => <label key={key} style={{ display: 'block' }}>{key}<textarea aria-label={`Offline field ${key}`} maxLength={50000} value={value} disabled={busy} onChange={e => setFields(current => ({ ...current, [key]: e.target.value }))} /></label>)}
      <label>Tags (space separated)<input aria-label="Offline tags" value={tags} disabled={busy} onChange={e => setTags(e.target.value)} /></label>
      <button disabled={busy || !!account.edits?.some(e => e.note_id === selected.id)}>Save edit on this device</button>
    </form>}
    {(account.edits || []).map(edit => <PendingEdit key={edit.request_id} uid={uid} edit={edit} busy={busy} perform={perform} />)}
  </section>;
}
function PendingEdit({ uid, edit, busy, perform }: { uid: number; edit: OfflineEdit; busy: boolean; perform: (work: () => Promise<void>) => Promise<void> }) {
  const [choices, setChoices] = useState<Record<string, 'local' | 'server'>>({});
  const remote = edit.remote;
  const canResolve = remote && remote.guid === edit.guid && remote.schema_hash === edit.schema_hash && Object.keys(edit.fields).every(k => k in remote.fields);
  return <article className="glass-card" style={{ padding: 16, marginTop: 12 }}><h3>Pending note #{edit.note_id}</h3><p>{edit.conflict || 'Saved locally. Waiting to sync.'}</p>
    <details><summary>Local edit</summary>{Object.entries(edit.fields).map(([name, value]) => <div key={name}><strong>{name}</strong><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value}</pre></div>)}</details>
    {canResolve && edit.conflicting_fields?.map(name => <fieldset key={name}><legend>{name}</legend><p>Server: {remote.fields[name]}</p><p>This device: {edit.fields[name]}</p><select aria-label={`Resolve ${name}`} value={choices[name] || ''} onChange={e => setChoices(c => ({ ...c, [name]: e.target.value as 'local' | 'server' }))}><option value="">Choose a version</option><option value="local">Use this device</option><option value="server">Use server</option></select></fieldset>)}
    {canResolve && <button disabled={busy || !edit.conflicting_fields?.length || edit.conflicting_fields.some(k => !choices[k])} onClick={() => void perform(async () => {
      const merged = Object.fromEntries(Object.keys(edit.fields).map(name => [name, choices[name] === 'server' || (!choices[name] && edit.fields[name] === edit.base_fields[name]) ? remote.fields[name] : edit.fields[name]]));
      const baseTags = new Set(edit.base_tags), localTags = new Set(edit.tags);
      const mergedTags = [...new Set([...remote.tags.filter(t => !(baseTags.has(t) && !localTags.has(t))), ...edit.tags.filter(t => !baseTags.has(t))])];
      await changeLocal(uid, account => ({ ...account, edits: (account.edits || []).map(item => item.request_id === edit.request_id ? { request_id: crypto.randomUUID(), note_id: remote.id, guid: remote.guid, schema_hash: remote.schema_hash, base_fields: remote.fields, base_tags: remote.tags, fields: merged, tags: mergedTags } : item) }));
    })}>Queue resolved edit</button>}
    <button disabled={busy} onClick={() => { if (window.confirm('Discard this local edit? The server note will be kept.')) void perform(async () => { await changeLocal(uid, account => ({ ...account, edits: (account.edits || []).filter(item => item.request_id !== edit.request_id) })); }); }}>Discard local edit</button>
  </article>;
}
