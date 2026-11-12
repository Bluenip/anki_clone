import { getCardNote, updateNote } from '../api/notes';
import type { Note } from '../api/notes';
import './BrowsePage.css';
import client from '../api/client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { listDecks } from '../api/decks';
import type { DeckSummary } from '../api/decks';
import { browseCards, bulkActionCards, updateCard } from '../api/cards';
import type { BrowseCard, BulkActionType, BulkActionRequest } from '../api/cards';
import { usePrefs } from '../context/usePrefs';
import { tNow } from '../context/prefs-context-base';

const plainPreview = (html: string) => {
  const text = document.createElement('textarea');
  text.innerHTML = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ');
  return text.value.replace(/\s+/g, ' ').trim();
};

const MAX_BULK = 500;
const PAGE_SIZE = 1000;

const parseTags = (input: string): string[] => {
  return Array.from(new Set(input.trim().split(/\s+/).filter(Boolean)));
};

const getErrMsg = (err: unknown, fallback: string) => {
  const e = err as {
    response?: {
      status?: number;
      data?: { detail?: unknown; message?: unknown } | string;
    };
    message?: string;
  };
  const status = e?.response?.status;
  const detail = e?.response?.data;
  let detailMsg = '';
  if (typeof detail === 'string') {
    detailMsg = detail;
  } else if (detail && typeof detail === 'object') {
    detailMsg = typeof detail.detail === 'string' ? detail.detail :
      typeof detail.message === 'string' ? detail.message : '';
  }

  if (status === 409) {
    return detailMsg || 'Cards were modified elsewhere (version conflict 409). Please refresh.';
  }
  if (status === 404) {
    return detailMsg || 'One or more cards were not found (404). Please refresh.';
  }
  if (status === 422) {
    return detailMsg || 'Invalid search query or payload (422).';
  }
  return detailMsg || e?.message || fallback;
};

const BrowsePage = () => {
  const { t } = usePrefs();
  const [cards, setCards] = useState<BrowseCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [pageOffset, setPageOffset] = useState(0);
  const [selectedCard, setSelectedCard] = useState<BrowseCard | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Error & Status
  const [errorMessage, setErrorMessage] = useState('');
  const [actionSuccessMessage, setActionSuccessMessage] = useState('');

  // Editor state
  const [sourceNote, setSourceNote] = useState<Note | null>(null);
  const [noteFields, setNoteFields] = useState<Record<string, string>>({});
  const [sourceReady, setSourceReady] = useState(false);
  const [editFront, setEditFront] = useState('');
  const [editBack, setEditBack] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Bulk action state
  const [dueDays, setDueDays] = useState(1);
  const [actionPending, setActionPending] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveDecks, setMoveDecks] = useState<DeckSummary[]>([]);
  const [moveLoading, setMoveLoading] = useState(false);
  const [targetDeck, setTargetDeck] = useState('');
  const [tagPanelMode, setTagPanelMode] = useState<'add_tags' | 'remove_tags' | null>(null);
  const [tagInput, setTagInput] = useState('');

  // Request sequence ref to prevent older search responses replacing newer results
  const searchSeqRef = useRef(0);
  const selectedCardRef = useRef<BrowseCard | null>(null);
  const activeQueryRef = useRef('');
  const activeOffsetRef = useRef(0);

  const handleSelectCard = useCallback((card: BrowseCard | null) => {
    if (card && selectedCardRef.current === card) return;
    selectedCardRef.current = card;
    setSelectedCard(card);
    setSourceReady(card != null && card.note_id == null);
    setSourceNote(null);
    setSaveSuccess(false);
    setEditFront(card?.front || '');
    setEditBack(card?.back || '');
  }, []);

  useEffect(() => {
    let ignore = false;
    if (!selectedCard) return;
    if (selectedCard.note_id == null) return;
    getCardNote(selectedCard.id).then(({ data }) => {
      if (ignore) return;
      setSourceNote(data);
      setNoteFields(data.fields);
      setSourceReady(true);
    }).catch(err => {
      if (!ignore) setErrorMessage(getErrMsg(err, tNow('browse.loadNoteFailed')));
    });
    return () => { ignore = true; };
  }, [selectedCard]);

  const fetchCards = useCallback(async (query: string = '', offset = 0) => {
    const previousId = selectedCardRef.current?.id;
    const seq = ++searchSeqRef.current;
    activeQueryRef.current = query;
    activeOffsetRef.current = offset;
    setPageOffset(offset);
    handleSelectCard(null);
    setCards([]);
    setLoading(true);
    setErrorMessage('');
    setActionSuccessMessage('');
    // Clear selection on search as requested
    setSelectedIds(new Set());
    setMoveOpen(false);
    setTagPanelMode(null);
    setTagInput('');

    try {
      const res = await browseCards(query, offset);
      if (seq !== searchSeqRef.current) {
        // Newer search request already dispatched; drop older stale response
        return;
      }
      setCards(res.data);

      handleSelectCard(res.data.find((card) => card.id === previousId) || res.data[0] || null);
    } catch (err) {
      if (seq !== searchSeqRef.current) return;
      setErrorMessage(getErrMsg(err, tNow('browse.fetchFailed')));
      setCards([]);
      // Reset selected card on error to prevent stale edits
      handleSelectCard(null);
    } finally {
      if (seq === searchSeqRef.current) {
        setLoading(false);
      }
    }
  }, [handleSelectCard]);

  const invalidateSearch = useCallback(() => { ++searchSeqRef.current; }, []);
  useEffect(() => {
    let active = true;
    // Defer initialization so a StrictMode cleanup can cancel the first setup.
    queueMicrotask(() => { if (active) void fetchCards(''); });
    return () => { active = false; invalidateSearch(); };
  }, [fetchCards, invalidateSearch]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!saving && !actionPending && !moveLoading) void fetchCards(search);
  };

  // Selection helpers: only apply to displayed results, max 500
  const displayedSelectedCards = cards.filter((c) => selectedIds.has(c.id));
  const selectionCount = displayedSelectedCards.length;
  const isAllDisplayedSelected =
    cards.length > 0 &&
    cards.slice(0, MAX_BULK).every((c) => selectedIds.has(c.id));

  const handleToggleSelectAll = () => {
    if (isAllDisplayedSelected) {
      setSelectedIds(new Set());
    } else {
      // Select displayed cards up to MAX_BULK
      const toSelect = cards.slice(0, MAX_BULK).map((c) => c.id);
      setSelectedIds(new Set(toSelect));
    }
  };

  const handleToggleCardSelection = (cardId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        if (next.size >= MAX_BULK) {
          return next;
        }
        next.add(cardId);
      }
      return next;
    });
  };

  const openMove = async () => {
    setTagPanelMode(null);
    setTagInput('');
    setMoveLoading(true);
    setErrorMessage('');
    try {
      const response = await listDecks();
      setMoveDecks(response.data);
      setTargetDeck('');
      setMoveOpen(true);
    } catch (err) {
      setErrorMessage(getErrMsg(err, t('browse.loadDecksFailed')));
    } finally {
      setMoveLoading(false);
    }
  };

  const openTagPanel = (mode: 'add_tags' | 'remove_tags') => {
    setMoveOpen(false);
    setErrorMessage('');
    setTagPanelMode(mode);
    setTagInput('');
  };

  const handleBulkAction = async (action: BulkActionType, tags?: string[], flag?: number) => {
    // Only apply to displayed and selected cards, capped at MAX_BULK
    const targetCards = cards
      .filter((c) => selectedIds.has(c.id))
      .slice(0, MAX_BULK);

    if (targetCards.length === 0 || loading || actionPending || saving) return;

    if (['delete', 'reset', 'reschedule'].includes(action) && !window.confirm(t('browse.confirmBulk', { action, count: targetCards.length }))) return;
    setActionPending(true);
    setErrorMessage('');
    setActionSuccessMessage('');

    if (action === 'move' && !targetDeck) { setActionPending(false); return; }
    if ((action === 'add_tags' || action === 'remove_tags') && (!tags || tags.length === 0)) {
      setActionPending(false);
      return;
    }
    const payload: BulkActionRequest = {
      action,
      ...(action === 'flag' ? { flag } : {}),
      ...(action === 'reschedule' ? { due_days: dueDays } : {}),
      ...(action === 'move' ? { target_deck_id: Number(targetDeck) } : {}),
      ...((action === 'add_tags' || action === 'remove_tags') ? { tags } : {}),
      cards: targetCards.map((c) => ({
        card_id: c.id,
        expected_version: c.version,
      })),
    };

    try {
      const res = await bulkActionCards(payload);
      await fetchCards(activeQueryRef.current, activeOffsetRef.current);
      if (res.data.updated_notes != null) {
        setActionSuccessMessage(
          t('browse.updatedNotes', { notes: res.data.updated_notes, cards: res.data.updated })
        );
      } else {
        setActionSuccessMessage(t('browse.updatedCards', { cards: res.data.updated }));
      }
      setTagPanelMode(null);
      setTagInput('');
    } catch (err) {
      setErrorMessage(getErrMsg(err, t('browse.actionFailed', { action })));
    } finally {
      setActionPending(false);
    }
  };

  const handleSave = async () => {
    if (!selectedCard || !sourceReady || loading || saving || actionPending) return;

    // Check if card is still in current displayed list
    const currentInList = cards.find((c) => c.id === selectedCard.id);
    if (!currentInList) {
      setErrorMessage(
        t('browse.staleCard')
      );
      return;
    }

    setSaving(true);
    setErrorMessage('');
    try {
      if (sourceNote?.id != null) {
        await updateNote(sourceNote.id, { fields: noteFields, tags: sourceNote.tags, expected_revision: sourceNote.revision });
      } else {
        await updateCard(selectedCard.id, { front: editFront, back: editBack, expected_version: selectedCard.version });
      }

      // Reload actual backend versions and note rendering; edits do not invent scheduler versions.
      await fetchCards(activeQueryRef.current, activeOffsetRef.current);
      setSaveSuccess(true);
    } catch (err) {
      setErrorMessage(getErrMsg(err, t('browse.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const formatStateDisplay = (card: BrowseCard) => {
    const tags: string[] = [];
    if (card.is_suspended) tags.push(t('stats.suspended'));
    if (card.is_buried) tags.push(t('stats.buried'));
    const state = card.card_state || 'new';
    const base = (['new', 'learning', 'relearning', 'review'] as const).includes(state as 'new') ? t(`state.${state as 'new' | 'learning' | 'relearning' | 'review'}`) : state;
    if (tags.length > 0) {
      return `${base} (${tags.join(', ')})`;
    }
    return base;
  };

  return (
    <div className="browser-page">
      <header className="browser-page-heading"><div><p className="browser-eyebrow">{t('decks.eyebrow')}</p><h1>{t('browse.title')}</h1><p>{t('browse.subtitle')}</p></div><Link className="btn btn-secondary" to="/add">{t('browse.addCard')}</Link></header>
    <div className="browse-container">
      {/* Left Pane: List and Search */}
      <div className="browse-sidebar glass-card">
        <form onSubmit={handleSearch} className="browse-search">
          <input
            type="text"
            placeholder={t('browse.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t('browse.searchAria')}
          />
          <button type="submit" className="btn btn-primary" disabled={saving || actionPending || moveLoading}>
            {loading ? t('browse.searching') : t('common.search')}
          </button>
        </form>

        {/* Search Help Disclosure */}
        <details
          className="search-help-disclosure"
          style={{
            marginBottom: '15px',
            fontSize: '0.85rem',
            background: 'rgba(var(--fg-rgb),0.03)',
            borderRadius: '6px',
            padding: '8px 12px',
            border: '1px solid rgba(var(--fg-rgb),0.08)',
          }}
        >
          <summary
            style={{
              cursor: 'pointer',
              fontWeight: 600,
              color: 'var(--accent-blue, #38bdf8)',
              userSelect: 'none',
            }}
          >
            {t('browse.helpTitle')}
          </summary>
          <div style={{ marginTop: '8px', lineHeight: '1.4' }}>
            <p style={{ margin: '0 0 6px 0' }}>
              <strong>{t('browse.pageSize')}</strong> {t('browse.pageSizeText')}
              {t('browse.pageHint')}
            </p>
            <p style={{ margin: '0 0 4px 0', fontWeight: 600 }}>
              {t('browse.syntax')}
            </p>
            <ul style={{ margin: '0 0 6px 0', paddingLeft: '18px' }}>
              <li>
                <strong>{t('browse.textWords')}</strong> {t('browse.implicitAnd')} ({t('browse.eg')}{' '}
                <code>dog cat</code>)
              </li>
              <li>
                <strong>{t('browse.quotes')}</strong> {t('browse.exactPhrase')} ({t('browse.eg')}{' '}
                <code>&quot;front phrase&quot;</code>)
              </li>
              <li>
                <strong>OR:</strong> {t('browse.logicalOr')} ({t('browse.eg')}{' '}
                <code>deck:French OR deck:Spanish</code>)
              </li>
              <li>
                <strong>{t('browse.parens')}</strong> {t('browse.grouping')} ({t('browse.eg')}{' '}
                <code>(tag:hard OR tag:leech) is:review</code>)
              </li>
              <li>
                <strong>{t('browse.minus')}</strong> {t('browse.negation')} ({t('browse.eg')}{' '}
                <code>-tag:easy</code>, <code>-is:suspended</code>)
              </li>
              <li>
                <strong>deck:</strong> {t('browse.byDeck')} ({t('browse.eg')}{' '}
                <code>deck:Biology</code>)
              </li>
              <li>
                <strong>tag:</strong> {t('browse.byTag')} ({t('browse.eg')} <code>tag:exam</code>)
              </li>
              <li>
                <strong>note:</strong> {t('browse.byNote')} ({t('browse.eg')}{' '}
                <code>note:Basic</code>)
              </li>
              <li>
                <strong>cid:</strong> {t('browse.byCid')} ({t('browse.eg')} <code>cid:42</code>
                )
              </li>
              <li>
                <strong>nid:</strong> {t('browse.byNid')} ({t('browse.eg')} <code>nid:15</code>
                )
              </li>
              <li>
                <strong>prop:</strong> {t('browse.prop')}
                {' '}<code>prop:ivl&gt;=10</code>, <code>prop:reps&lt;5</code>, <code>prop:lapses&gt;2</code>.
              </li>
              <li>
                <strong>is:</strong> {t('browse.byState')} <code>is:new</code>,{' '}
                <code>is:learn</code>, <code>is:review</code>,{' '}
                <code>is:suspended</code>, <code>is:buried</code>, <code>is:due</code>
                <p>{t('browse.dueHint1')} <code>deck:filtered</code> {t('browse.dueHint2')}</p>
              </li>
            </ul>
            <p
              style={{
                margin: 0,
                fontSize: '0.8rem',
                color: 'var(--text-muted)',
              }}
            >
              {t('browse.noOther')}
            </p>
          </div>
        </details>

        {/* Bulk Action Controls & Selection Stats */}
        <div
          className="bulk-toolbar bulk-selection-toolbar"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            marginBottom: '12px',
            padding: '8px 12px',
            borderRadius: '6px',
            background: 'rgba(var(--fg-rgb),0.05)',
            border: '1px solid rgba(var(--fg-rgb),0.1)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontSize: '0.9rem',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                aria-label={t('browse.selectAll')}
                checked={isAllDisplayedSelected}
                onChange={handleToggleSelectAll}
                disabled={cards.length === 0 || loading || saving || actionPending}
              />
              <span>{t('browse.selectAllMax')}</span>
            </label>
            <span
              data-testid="selection-count"
              style={{
                fontWeight: 600,
                color: 'var(--accent-blue, #38bdf8)',
              }}
            >
              {selectionCount} selected
            </span>
          </div>

          <div className="bulk-organize-actions">
            <button type="button" className="btn btn-secondary" onClick={openMove}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}>
              {moveLoading ? t('browse.loadingDecks') : t('browse.changeDeck')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => openTagPanel('add_tags')}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}
            >
              {t('browse.addTags')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => openTagPanel('remove_tags')}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}
            >
              {t('browse.removeTags')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handleBulkAction('suspend')}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}
            >
              {t('study.suspend')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handleBulkAction('unsuspend')}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}
            >
              {t('browse.unsuspend')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handleBulkAction('bury')}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}
            >
              {t('study.bury')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handleBulkAction('unbury')}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}
            >
              {t('browse.unbury')}
            </button>
          </div>
        </div>

        <div className="bulk-toolbar bulk-schedule-toolbar" aria-label={t('browse.schedulingAria')}>
          <button type="button" className="btn btn-secondary browse-delete" disabled={loading || saving || actionPending || !selectionCount} onClick={() => void handleBulkAction('delete')}>{t('browse.deleteSelected')}</button>
          <button type="button" className="btn btn-secondary" disabled={loading || saving || actionPending || !selectionCount} onClick={() => void handleBulkAction('reset')}>{t('browse.resetSelected')}</button>
          <label className="browse-due-input">{t('browse.dueInDays')}<input type="number" min="0" max="36500" value={dueDays} onChange={e => setDueDays(Number(e.target.value))} /></label>
          <button type="button" className="btn btn-secondary" disabled={loading || saving || actionPending || !selectionCount || !Number.isInteger(dueDays) || dueDays < 0 || dueDays > 36500} onClick={() => void handleBulkAction('reschedule')}>{t('browse.setDue')}</button>
          <button type="button" className="btn btn-secondary" disabled={loading || saving || actionPending} onClick={async () => {
            setActionPending(true); setErrorMessage('');
            try { await client.post('/api/cards/bulk-undo'); await fetchCards(activeQueryRef.current, activeOffsetRef.current); setActionSuccessMessage(t('browse.undone')); }
            catch (e) { setErrorMessage(getErrMsg(e, t('browse.undoFailed'))); }
            finally { setActionPending(false); }
          }}>{t('browse.undoBulk')}</button>
        </div>
        <label className="flag-selector">{t('browse.flagSelected')} <select value="" disabled={selectionCount === 0 || actionPending || loading || saving} onChange={e => { if (e.target.value !== '') void handleBulkAction('flag', undefined, Number(e.target.value)); }}>
          <option value="">{t('browse.chooseFlag')}</option>
          {(['flag.remove', 'flag.red', 'flag.orange', 'flag.green', 'flag.blue', 'flag.pink', 'flag.turquoise', 'flag.purple'] as const).map((name, value) => <option key={value} value={value}>{t(name)}</option>)}
        </select></label>
        {moveOpen && (
          <div role="group" aria-label={t('browse.changeDeckAria')} className="form-group">
            <label htmlFor="move-target-deck">{t('browse.destination')}</label>
            <select id="move-target-deck" value={targetDeck} disabled={actionPending}
              onChange={(event) => setTargetDeck(event.target.value)}>
              <option value="">{t('browse.chooseDeck')}</option>
              {moveDecks.map(deck => <option key={deck.id} value={deck.id}>{deck.name}</option>)}
            </select>
            <p>Move {selectionCount} selected cards. Existing review dates stay unchanged.</p>
            <button type="button" className="btn btn-primary" disabled={!targetDeck || actionPending || selectionCount === 0}
              onClick={() => handleBulkAction('move')}>{t('browse.moveSelected')}</button>
            <button type="button" className="btn btn-secondary" disabled={actionPending}
              onClick={() => setMoveOpen(false)}>{t('common.cancel')}</button>
          </div>
        )}

        {tagPanelMode && (
          <div
            role="group"
            aria-label={t('browse.tagEditor')}
            className="form-group"
          >
            <label htmlFor="bulk-tag-input">
              {tagPanelMode === 'add_tags' ? t('browse.tagsToAdd') : t('browse.tagsToRemove')}
            </label>
            <input
              id="bulk-tag-input"
              type="text"
              placeholder="e.g. tag1 tag2"
              value={tagInput}
              disabled={actionPending}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (!actionPending && parseTags(tagInput).length > 0 && selectionCount > 0) {
                    void handleBulkAction(tagPanelMode, parseTags(tagInput));
                  }
                }
              }}
            />
            <p>{t('browse.tagsHint')}</p>
            {tagPanelMode === 'remove_tags' && (
              <p>{t('browse.parentTagHint')}</p>
            )}
            <p>{t('browse.selectedCount', { count: selectionCount })}</p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={actionPending || parseTags(tagInput).length === 0 || selectionCount === 0}
              onClick={() => handleBulkAction(tagPanelMode, parseTags(tagInput))}
            >
              {t('browse.apply')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={actionPending}
              onClick={() => {
                setTagPanelMode(null);
                setTagInput('');
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}

        {/* Error notification via role alert */}
        {errorMessage && (
          <div
            role="alert"
            className="browse-error"
            style={{
              padding: '10px 14px',
              marginBottom: '12px',
              borderRadius: '6px',
              backgroundColor: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              color: 'var(--danger-text)',
              fontSize: '0.9rem',
            }}
          >
            {errorMessage}
          </div>
        )}

        {/* Success notification */}
        {actionSuccessMessage && (
          <div
            role="status"
            style={{
              padding: '10px 14px',
              marginBottom: '12px',
              borderRadius: '6px',
              backgroundColor: 'rgba(34, 197, 94, 0.15)',
              border: '1px solid rgba(34, 197, 94, 0.4)',
              color: 'var(--success-text)',
              fontSize: '0.9rem',
            }}
          >
            {actionSuccessMessage}
          </div>
        )}

        <nav aria-label={t('browse.pagesAria')} style={{display:'flex', gap:'12px', alignItems:'center', marginBottom:'8px'}}>
          <button type="button" className="btn btn-secondary"
            disabled={pageOffset === 0 || loading || saving || actionPending || moveLoading}
            onClick={() => fetchCards(activeQueryRef.current, Math.max(0, pageOffset - PAGE_SIZE))}>{t('browse.prevPage')}</button>
          <span>Page {Math.floor(pageOffset / PAGE_SIZE) + 1} · {cards.length} cards</span>
          <button type="button" className="btn btn-secondary"
            disabled={cards.length < PAGE_SIZE || loading || saving || actionPending || moveLoading}
            onClick={() => fetchCards(activeQueryRef.current, pageOffset + PAGE_SIZE)}>{t('browse.nextPage')}</button>
        </nav>
        <div className="browse-table-container">
          <table className="browse-table">
            <thead>
              <tr>
                <th style={{ width: '40px', textAlign: 'center' }}>
                  <span className="sr-only">{t('browse.select')}</span>
                </th>
                <th>{t('editor.front')}</th>
                <th>{t('editor.back')}</th>
                <th>{t('add.deck')}</th>
                <th>{t('stat.due')}</th>
                <th>{t('browse.state')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={6}
                    style={{ textAlign: 'center', padding: '20px' }}
                  >
                    {t('common.loading')}
                  </td>
                </tr>
              ) : cards.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    style={{ textAlign: 'center', padding: '20px' }}
                  >
                    {t('browse.noCards')}
                  </td>
                </tr>
              ) : (
                cards.map((card) => {
                  const isChecked = selectedIds.has(card.id);
                  const isCurrent = selectedCard?.id === card.id;
                  return (
                    <tr
                      key={card.id}
                      className={isCurrent ? 'selected' : ''}
                      onClick={() => { if (!saving && !actionPending) handleSelectCard(card); }}
                    >
                      <td
                        style={{ textAlign: 'center' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          aria-label={t('browse.selectCard', { id: card.id })}
                          checked={isChecked}
                          disabled={saving || actionPending || (!isChecked && selectionCount >= MAX_BULK)}
                          onChange={() => handleToggleCardSelection(card.id)}
                        />
                      </td>
                      <td title={plainPreview(card.front)}>{plainPreview(card.front)}</td>
                      <td title={plainPreview(card.back)}>{plainPreview(card.back)}</td>
                      <td>{card.deck_name}</td>
                      <td>
                        {card.card_state === 'new' ? t('stat.new') : card.next_review
                          ? new Date(card.next_review).toLocaleDateString()
                          : '—'}
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            card.is_suspended
                              ? 'badge-suspended'
                              : card.is_buried
                              ? 'badge-buried'
                              : ''
                          }`}
                          style={{
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontSize: '0.8rem',
                            background: card.is_suspended
                              ? 'rgba(239, 68, 68, 0.2)'
                              : card.is_buried
                              ? 'rgba(234, 179, 8, 0.2)'
                              : 'rgba(var(--fg-rgb),0.1)',
                            color: card.is_suspended
                              ? 'var(--danger-text)'
                              : card.is_buried
                              ? 'var(--warning-text)'
                              : 'inherit',
                          }}
                        >
                          {formatStateDisplay(card)}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Right Pane: Editor */}
      <div className="browse-editor glass-card">
        {selectedCard ? (
          <div className="editor-content">
            <div
              className="editor-header"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '15px',
              }}
            >
              <h2>{t('browse.editCard', { id: selectedCard.id })}</h2>
              {selectedCard.deck_id && (
                <Link
                  to={`/decks/${selectedCard.deck_id}/cards`}
                  className="btn btn-secondary"
                  style={{
                    fontSize: '0.8rem',
                    padding: '4px 8px',
                    textDecoration: 'none',
                  }}
                  title={t('browse.openEditorTitle')}
                >
                  {t('browse.openEditor')}
                </Link>
              )}
            </div>

            <div
              className="browse-card-metadata"
              style={{
                marginBottom: '12px',
                fontSize: '0.85rem',
                color: 'var(--text-muted)',
              }}
            >
              <span>{t('browse.stateLabel')} {formatStateDisplay(selectedCard)}</span>
              {selectedCard.note_id != null && (
                <span style={{ marginLeft: '12px' }}>
                  {t('browse.noteId')} {selectedCard.note_id}
                </span>
              )}

            </div>

            {!sourceReady ? <p role="status">{t('browse.loadingNote')}</p> : sourceNote?.id != null ? Object.entries(noteFields).map(([name, value]) => (
              <div className="form-group" key={name}>
                <label htmlFor={`note-edit-${name}`}>{name}</label>
                <textarea id={`note-edit-${name}`} className="editor-textarea" rows={5} value={value}
                  disabled={saving || actionPending} onChange={e => setNoteFields(prev => ({ ...prev, [name]: e.target.value }))} />
              </div>
            )) : <>
            <div className="form-group">
              <label htmlFor="card-edit-front">{t('editor.front')}</label>
              <textarea
                id="card-edit-front"
                disabled={saving || actionPending}
                value={editFront}
                onChange={(e) => setEditFront(e.target.value)}
                rows={5}
                className="editor-textarea"
              />
            </div>
            <div className="form-group">
              <label htmlFor="card-edit-back">{t('editor.back')}</label>
              <textarea
                id="card-edit-back"
                disabled={saving || actionPending}
                value={editBack}
                onChange={(e) => setEditBack(e.target.value)}
                rows={5}
                className="editor-textarea"
              />
            </div>
            </>}
            <div
              className="browse-save-actions"
              style={{
                marginTop: '20px',
                display: 'flex',
                justifyContent: 'flex-end',
                alignItems: 'center',
                gap: '10px',
              }}
            >
              {saveSuccess && (
                <span
                  style={{
                    color: 'var(--accent-green)',
                    fontSize: '0.9rem',
                  }}
                >
                  Saved!
                </span>
              )}
              <button
                id="save-btn"
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving || actionPending || loading || !sourceReady}
              >
                {saving ? t('common.saving') : t('browse.saveChanges')}
              </button>
            </div>
          </div>
        ) : (
          <div className="editor-empty">
            <span style={{ fontSize: '3rem', opacity: 0.5 }}>🔍</span>
            <p>{t('browse.selectPrompt')}</p>
          </div>
        )}
      </div>
    </div>
    </div>
  );
};

export default BrowsePage;
