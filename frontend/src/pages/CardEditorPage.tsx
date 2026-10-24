import FormattingTools from '../components/FormattingTools';
import MediaTools from '../components/MediaTools';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { listCards, createCard, updateCard, deleteCard } from '../api/cards';
import type { Card } from '../api/cards';
import { getCardNote, updateNote } from '../api/notes';
import type { Note, UpdateNotePayload } from '../api/notes';
import { sanitizeHtml } from '../utils/sanitize';

const getErrMsg = (err: unknown, fallback: string) => {
  const e = err as { response?: { data?: { detail?: string; message?: string } }; message?: string };
  const msg = e?.response?.data?.detail || e?.response?.data?.message || e?.message || fallback;
  return typeof msg === 'string' ? msg : JSON.stringify(msg);
};

const CardEditorPageContent = () => {
  const { deckId } = useParams<{ deckId: string }>();
  const [cards, setCards] = useState<Card[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  // Add Card form state
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [addPending, setAddPending] = useState(false);
  const [addError, setAddError] = useState('');

  // Edit Note / Card state
  const [editingCard, setEditingCard] = useState<Card | null>(null);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [mediaBusy, setMediaBusy] = useState(0);
  const [editFields, setEditFields] = useState<Record<string, string>>({});
  const [editTags, setEditTags] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [editLoadError, setEditLoadError] = useState('');
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [isConflict, setIsConflict] = useState(false);

  const loadSeqRef = useRef(0);
  const saveSeqRef = useRef(0);
  const prevDeckIdRef = useRef(deckId);

  const handleCancelEdit = useCallback(() => {
    loadSeqRef.current += 1;
    saveSeqRef.current += 1;
    setEditingCard(null);
    setEditingNote(null);
    setEditFields({});
    setEditTags('');
    setEditLoadError('');
    setSaveError('');
    setIsConflict(false);
    setEditLoading(false);
    setSavePending(false);
  }, []);

  useEffect(() => {
    if (prevDeckIdRef.current !== deckId) {
      prevDeckIdRef.current = deckId;
      handleCancelEdit();
    }
  }, [deckId, handleCancelEdit]);

  useEffect(() => {
    return () => {
      loadSeqRef.current += 1;
      saveSeqRef.current += 1;
    };
  }, []);

  const listSeqRef = useRef(0);
  const listContextRef = useRef<{ deckId: string; search: string } | null>(null);

  // Manual refreshes use the current route/query, including after a slow save.
  const fetchCards = useCallback(async () => {
    const context = listContextRef.current;
    if (!context) return;
    const seq = ++listSeqRef.current;
    try {
      const res = await listCards(+context.deckId, context.search);
      if (listSeqRef.current === seq) setCards(res.data);
    } catch {
      /* Keep the current list on refresh failure. */
    } finally {
      if (listSeqRef.current === seq) setLoading(false);
    }
  }, []);

  useEffect(() => {
    listContextRef.current = deckId ? { deckId, search } : null;
    void fetchCards();
    return () => {
      listContextRef.current = null;
      listSeqRef.current += 1;
    };
  }, [deckId, search, fetchCards]);

  const loadNoteForCard = useCallback(async (card: Card) => {
    const seq = ++loadSeqRef.current;
    setEditLoading(true);
    setEditLoadError('');
    setSaveError('');
    setIsConflict(false);
    try {
      const res = await getCardNote(card.id);
      if (loadSeqRef.current !== seq) return;
      const note = res.data;
      setEditingNote(note);
      const initialFields = note.fields && Object.keys(note.fields).length > 0
        ? { ...note.fields }
        : { Front: card.front, Back: card.back };
      setEditFields(initialFields);
      setEditTags(Array.isArray(note.tags) ? note.tags.join(' ') : '');
    } catch (err: unknown) {
      if (loadSeqRef.current !== seq) return;
      setEditLoadError(getErrMsg(err, 'Failed to load note'));
    } finally {
      if (loadSeqRef.current === seq) {
        setEditLoading(false);
      }
    }
  }, []);

  const handleEdit = (card: Card) => {
    if (savePending) return;
    saveSeqRef.current += 1;
    setEditingCard(card);
    setEditingNote(null);
    setEditFields({});
    setEditTags('');
    setEditLoadError('');
    setSaveError('');
    setIsConflict(false);
    loadNoteForCard(card);
  };

  const handleReloadLatest = () => {
    if (!editingCard) return;
    setSaveError('');
    setIsConflict(false);
    loadNoteForCard(editingCard);
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (addPending || !front.trim() || !back.trim() || !deckId) return;
    setAddPending(true);
    setAddError('');
    try {
      await createCard(+deckId, front, back);
      setFront('');
      setBack('');
      await fetchCards();
    } catch (err: unknown) {
      setAddError(getErrMsg(err, 'Failed to add card'));
    } finally {
      setAddPending(false);
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savePending || mediaBusy > 0 || !editingCard || !editingNote) return;
    const saveSeq = ++saveSeqRef.current;
    setSavePending(true);
    setSaveError('');
    setIsConflict(false);
    try {
      if (editingNote.id !== null) {
        const tagsArray = editTags.split(/\s+/).map((t) => t.trim()).filter(Boolean);
        const payload: UpdateNotePayload = { fields: editFields, tags: tagsArray };
        if (editingNote.revision !== undefined) {
          payload.expected_revision = editingNote.revision;
        }
        await updateNote(editingNote.id, payload);
      } else {
        const frontVal = editFields['Front'] ?? editFields['front'] ?? '';
        const backVal = editFields['Back'] ?? editFields['back'] ?? '';
        const payload: { front: string; back: string; expected_version?: number } = {
          front: frontVal,
          back: backVal,
        };
        if (editingNote.version !== undefined) {
          payload.expected_version = editingNote.version;
        }
        await updateCard(editingCard.id, payload);
      }
      if (saveSeqRef.current !== saveSeq) return;
      handleCancelEdit();
      await fetchCards();
    } catch (err: unknown) {
      if (saveSeqRef.current !== saveSeq) return;
      const status = (err as { response?: { status?: number }; status?: number })?.response?.status ?? (err as { status?: number })?.status;
      if (status === 409) {
        setIsConflict(true);
        const serverData = (err as { response?: { data?: { detail?: string; message?: string } } })?.response?.data;
        const msg = serverData?.detail || serverData?.message || 'Conflict: This note was modified elsewhere. Reload latest note to review changes, or cancel.';
        setSaveError(typeof msg === 'string' ? msg : JSON.stringify(msg));
      } else {
        setSaveError(getErrMsg(err, 'Failed to save note'));
      }
    } finally {
      if (saveSeqRef.current === saveSeq) {
        setSavePending(false);
      }
    }
  };

  const handleDelete = async (id: number) => {
    if (savePending) return;
    if (!confirm('Delete this card?')) return;
    try {
      await deleteCard(id);
      if (editingCard?.id === id) handleCancelEdit();
      await fetchCards();
    } catch {
      /* ignore */
    }
  };

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="breadcrumb">
        <Link to="/decks">Decks</Link> <span>/</span>
        <Link to={`/decks/${deckId}`}>Deck</Link> <span>/</span> <span>Cards</span>
      </div>

      <div className="card-editor-layout">
        {editingCard && editLoading && (
          <div className="card-form glass-card" role="region" aria-label="Edit note">
            <h2>Edit Note</h2>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '160px', gap: '1rem' }}>
              <div className="spinner" role="status" aria-label="Loading note" />
              <span style={{ color: 'var(--text-secondary)' }}>Loading note...</span>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={handleCancelEdit}>Cancel</button>
            </div>
          </div>
        )}

        {editingCard && !editLoading && editLoadError && (
          <div className="card-form glass-card" role="region" aria-label="Edit note">
            <h2>Edit Note</h2>
            <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>{editLoadError}</div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={handleCancelEdit}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={() => loadNoteForCard(editingCard)}>Retry</button>
            </div>
          </div>
        )}

        {editingCard && !editLoading && !editLoadError && editingNote && (
          <div className="card-form glass-card" role="region" aria-label="Edit note">
            <h2>{editingNote.id === null ? 'Edit Legacy Card' : 'Edit Note'}</h2>
            <div className="note-meta-info" style={{ marginBottom: '1rem', display: 'flex', gap: '1rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              <span data-testid="note-type">Note Type: <strong>{editingNote.kind || 'basic'}</strong></span>
              <span data-testid="sibling-count">Cards (siblings): <strong>{editingNote.cards?.length ?? 1}</strong></span>
              {editingNote.id === null && <span className="badge">Legacy</span>}
            </div>

            {saveError && (
              <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
                <div>{saveError}</div>
                {isConflict && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleReloadLatest}
                      disabled={savePending || editLoading}
                    >
                      Reload latest note (discards local edits)
                    </button>
                  </div>
                )}
              </div>
            )}

            <form onSubmit={handleSaveEdit}>
              {Object.entries(editFields).map(([fieldName, value]) => {
                const isOptional = fieldName === 'Extra' || fieldName === 'Add Reverse';
                return (
                  <div className="form-group" key={fieldName}>
                    <label htmlFor={`edit-field-${fieldName}`}>
                      {fieldName} {isOptional && <span style={{ opacity: 0.6 }}>(optional)</span>}
                    </label>
                    <FormattingTools targetId={`edit-field-${fieldName}`} disabled={savePending || mediaBusy > 0} onChange={value => setEditFields(prev => ({ ...prev, [fieldName]: value }))} />
                    <textarea
                      id={`edit-field-${fieldName}`}
                      aria-label={fieldName}
                      value={value}
                      onChange={(e) => setEditFields((prev) => ({ ...prev, [fieldName]: e.target.value }))}
                      rows={fieldName === 'Add Reverse' ? 2 : 4}
                      required={!isOptional}
                      disabled={savePending || mediaBusy > 0}
                      placeholder={`Enter ${fieldName}...`}
                    />
                    <MediaTools key={String(editingCard.id) + fieldName} disabled={savePending} onBusyChange={active => setMediaBusy(n => Math.max(0, n + (active ? 1 : -1)))} onInsert={markup => setEditFields(prev => ({ ...prev, [fieldName]: (prev[fieldName] || '') + markup }))} />
                  </div>
                );
              })}

              <div className="form-group">
                <label htmlFor="edit-tags">Tags</label>
                <input
                  id="edit-tags"
                  aria-label="Tags"
                  type="text"
                  placeholder="e.g. vocab chapter1 (spaces between tags, commas literal)"
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  disabled={savePending || mediaBusy > 0}
                />
              </div>

              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={handleCancelEdit} disabled={savePending || mediaBusy > 0}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={savePending || mediaBusy > 0}>
                  {savePending ? 'Saving...' : 'Update'}
                </button>
              </div>
            </form>
          </div>
        )}

        {!editingCard && (
          <div className="card-form glass-card" role="region" aria-label="Add card">
            <h2>Add New Card</h2>
            {addError && <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>{addError}</div>}
            <form onSubmit={handleAddSubmit}>
              <div className="form-group">
                <label htmlFor="card-front">Front</label>
                <textarea
                  id="card-front"
                  aria-label="Front"
                  value={front}
                  onChange={(e) => setFront(e.target.value)}
                  placeholder="Question or term"
                  rows={4}
                  required
                  disabled={addPending}
                />
              </div>
              <div className="form-group">
                <label htmlFor="card-back">Back</label>
                <textarea
                  id="card-back"
                  aria-label="Back"
                  value={back}
                  onChange={(e) => setBack(e.target.value)}
                  placeholder="Answer or definition"
                  rows={4}
                  required
                  disabled={addPending}
                />
              </div>
              <div className="modal-actions">
                <button type="submit" className="btn btn-primary" disabled={addPending || !front.trim() || !back.trim()}>
                  {addPending ? 'Adding...' : 'Add Card'}
                </button>
              </div>
              <div style={{ marginTop: '1rem', textAlign: 'center', fontSize: '0.85rem' }}>
                <Link to="/add">Add Note (Cloze / Reversed)</Link>
              </div>
            </form>
          </div>
        )}

        <div className="card-list-section">
          <div className="card-list-header">
            <h2>Cards ({cards.length})</h2>
            <input
              type="text"
              className="search-input"
              placeholder="Search cards..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search cards"
            />
          </div>
          {cards.length === 0 ? (
            <div className="empty-state glass-card">
              <p>No cards yet. Add your first card!</p>
            </div>
          ) : (
            <div className="cards-grid">
              {cards.map((card) => (
                <div key={card.id} className="card-item glass-card">
                  <div className="card-item-front">
                    <strong>Q:</strong> <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(card.front) }} />
                  </div>
                  <div className="card-item-back">
                    <strong>A:</strong> <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(card.back) }} />
                  </div>
                  <div className="card-item-actions">
                    <button className="btn btn-sm btn-ghost" onClick={() => handleEdit(card)} disabled={savePending || mediaBusy > 0}>Edit</button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDelete(card.id)} disabled={savePending || mediaBusy > 0}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default function CardEditorPage() {
  const { deckId } = useParams<{ deckId: string }>();
  return <CardEditorPageContent key={deckId} />;
}
