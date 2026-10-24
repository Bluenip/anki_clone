import FormattingTools from '../components/FormattingTools';
import MediaTools from '../components/MediaTools';
import { Link } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { listDecks } from '../api/decks';
import type { DeckSummary as Deck } from '../api/decks';
import { getNoteTypes, createNote } from '../api/notes';
import type { NoteType } from '../api/notes';

const AddPage = () => {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [noteTypes, setNoteTypes] = useState<NoteType[]>([]);
  const [selectedDeckId, setSelectedDeckId] = useState<number | ''>('');
  const [selectedKind, setSelectedKind] = useState<string>('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [tags, setTags] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const [mediaBusy, setMediaBusy] = useState(0);
  const pendingRef = useRef(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let ignore = false;

    Promise.all([listDecks(), getNoteTypes()])
      .then(([decksRes, typesRes]) => {
        if (!ignore) {
          setDecks(decksRes.data);
          setNoteTypes(typesRes.data);
          if (decksRes.data.length > 0) {
            setSelectedDeckId(prev => prev || decksRes.data[0].id);
          }
          if (typesRes.data.length > 0) {
            const defaultType = typesRes.data.find(t => t.kind === 'basic') || typesRes.data[0];
            setSelectedKind(prev => prev || defaultType.kind);
          }
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load initial data');
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [loadAttempt]);

  const handleRetry = () => {
    setLoading(true);
    setLoadError('');
    setLoadAttempt(prev => prev + 1);
  };

  const currentType = noteTypes.find(t => t.kind === selectedKind) || noteTypes[0];
  const currentFields = currentType ? currentType.fields : [];

  const handleInsertCloze = () => {
    const textarea = textRef.current;
    if (!textarea || pendingRef.current) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const currentVal = fields['Text'] || '';
    const selected = currentVal.substring(start, end);
    const indexes = [...currentVal.matchAll(/\{\{c(\d+)::/g)].map(match => Number(match[1]));
    const ordinal = Math.max(0, ...indexes) + 1;
    const replacement = `{{c${ordinal}::${selected}}}`;
    const nextVal = currentVal.slice(0, start) + replacement + currentVal.slice(end);
    setFields(prev => ({ ...prev, Text: nextVal }));
    setTimeout(() => {
      textarea.focus();
      const cursor = selected ? start + replacement.length : start + replacement.indexOf('::') + 2;
      textarea.setSelectionRange(cursor, cursor);
    }, 0);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (
      selectedKind === 'cloze' &&
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      (e.key === 'C' || e.key === 'c')
    ) {
      e.preventDefault();
      handleInsertCloze();
    }
  };

  const handleSubmit = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (pendingRef.current || mediaBusy > 0) return;

    if (!selectedDeckId) {
      setErrorMsg('Please select a deck.');
      return;
    }

    if (
      (selectedKind === 'basic' || selectedKind === 'reversed' || selectedKind === 'optional_reversed') &&
      (!fields['Front']?.trim() || !fields['Back']?.trim())
    ) {
      setErrorMsg('Front and Back fields are required.');
      return;
    }

    if (selectedKind === 'cloze' && !fields['Text']?.trim()) {
      setErrorMsg('Text field is required for Cloze notes.');
      return;
    }

    const noteFields: Record<string, string> = {};
    for (const f of currentFields) {
      noteFields[f] = fields[f] ?? '';
    }

    const tagsArray = tags.split(/\s+/).map(t => t.trim()).filter(Boolean);

    pendingRef.current = true;
    setPending(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const res = await createNote({
        deck_id: Number(selectedDeckId),
        kind: currentType?.id ? 'basic' : selectedKind,
        ...(currentType?.id ? { note_type_id: currentType.id } : {}),
        fields: noteFields,
        tags: tagsArray,
      });

      const cardsCount = res.data.cards?.length ?? 1;
      setSuccessMsg(`Note created successfully (${cardsCount} ${cardsCount === 1 ? 'card' : 'cards'} created)`);
      setFields({});
      setTags('');
    } catch (err: any) {
      const msg = err.response?.data?.detail || err.response?.data?.message || err.message || 'Failed to create note';
      setErrorMsg(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="page-container" style={{ maxWidth: '640px', marginTop: '2rem' }}>
        <div className="glass-card" style={{ padding: '2rem' }}>
          <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
            {loadError}
          </div>
          <button type="button" className="btn btn-primary" onClick={handleRetry}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container" style={{ maxWidth: '640px', marginTop: '2rem' }}>
      <div className="glass-card" style={{ padding: '2rem' }}>
        <h2 style={{ marginBottom: '1.5rem', textAlign: 'center' }}>Add Note</h2>

        {successMsg && <div className="alert alert-success" role="status" style={{ marginBottom: '1rem' }}>{successMsg}</div>}
        {errorMsg && <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>{errorMsg}</div>}

        <p><Link to="/note-types">Manage note types &amp; templates</Link></p>
      <form onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
          <div className="form-group">
            <label htmlFor="deck-select">Deck</label>
            <select
              id="deck-select"
              value={selectedDeckId}
              onChange={e => setSelectedDeckId(Number(e.target.value))}
              required
              disabled={pending || decks.length === 0}
            >
              <option value="" disabled>Select a deck...</option>
              {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="note-type-select">Type</label>
            <select
              id="note-type-select"
              value={selectedKind}
              onChange={e => setSelectedKind(e.target.value)}
              disabled={pending || noteTypes.length === 0}
            >
              {noteTypes.map(t => <option key={t.kind} value={t.kind}>{t.name}</option>)}
            </select>
          </div>

          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.25rem', lineHeight: 1.4 }}>
            <span>HTML and plain text are supported. </span>
            {selectedKind === 'cloze' && (
              <span>Cloze deletions use <code>{'{{c1::answer}}'}</code> syntax. Highlight text and click &quot;Insert Cloze&quot; or press Ctrl+Shift+C. </span>
            )}
            <span>Optional fields (Extra, Add Reverse) may be left empty. Press Ctrl+Enter to submit.</span>
          </div>

          {currentFields.map(fieldName => {
            const isOptional = fieldName === 'Extra' || fieldName === 'Add Reverse';
            return (
              <div className="form-group" key={fieldName}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.375rem' }}>
                  <label htmlFor={`field-${fieldName}`} style={{ margin: 0 }}>
                    {fieldName} {isOptional && <span style={{ opacity: 0.6 }}>(optional)</span>}
                  </label>
                  {selectedKind === 'cloze' && fieldName === 'Text' && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={handleInsertCloze}
                      disabled={pending || mediaBusy > 0}
                      style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                    >
                      Insert Cloze (Ctrl+Shift+C)
                    </button>
                  )}
                </div>
                <FormattingTools targetId={`field-${fieldName}`} disabled={pending || mediaBusy > 0} onChange={value => setFields(prev => ({ ...prev, [fieldName]: value }))} />
                <textarea
                  id={`field-${fieldName}`}
                  ref={fieldName === 'Text' ? textRef : undefined}
                  value={fields[fieldName] || ''}
                  onChange={e => setFields(prev => ({ ...prev, [fieldName]: e.target.value }))}
                  rows={fieldName === 'Add Reverse' ? 2 : 4}
                  required={!isOptional && !selectedKind.startsWith('model:')}
                  disabled={pending || mediaBusy > 0}
                  placeholder={`Enter ${fieldName}...`}
                />
                <MediaTools key={selectedKind + fieldName} disabled={pending} onBusyChange={active => setMediaBusy(n => Math.max(0, n + (active ? 1 : -1)))} onInsert={markup => setFields(prev => ({ ...prev, [fieldName]: (prev[fieldName] || '') + markup }))} />
              </div>
            );
          })}

          <div className="form-group">
            <label htmlFor="note-tags">Tags</label>
            <input
              id="note-tags"
              type="text"
              placeholder="e.g. vocab chapter1 (spaces between tags, commas literal)"
              value={tags}
              onChange={e => setTags(e.target.value)}
              disabled={pending || mediaBusy > 0}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={pending || decks.length === 0 || !selectedDeckId}
          >
            {pending ? 'Adding Note...' : 'Add Note'}
          </button>
          {decks.length === 0 && (
            <p style={{ textAlign: 'center', marginTop: '1rem', color: 'var(--danger)' }}>
              Please create a deck first.
            </p>
          )}
        </form>
      </div>
    </div>
  );
};

export default AddPage;
