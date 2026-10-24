import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { listDecks } from '../api/decks';
import type { DeckSummary } from '../api/decks';
import { browseCards, bulkActionCards, updateCard } from '../api/cards';
import type { BrowseCard, BulkActionType, BulkActionRequest } from '../api/cards';

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
  const [editFront, setEditFront] = useState('');
  const [editBack, setEditBack] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Bulk action state
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
    selectedCardRef.current = card;
    setSelectedCard(card);
    setSaveSuccess(false);
    setEditFront(card?.front || '');
    setEditBack(card?.back || '');
  }, []);

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
      setErrorMessage(getErrMsg(err, 'Failed to fetch cards'));
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
      setErrorMessage(getErrMsg(err, 'Failed to load destination decks'));
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
          `Successfully updated ${res.data.updated_notes} note(s) (${res.data.updated} card(s)).`
        );
      } else {
        setActionSuccessMessage(`Successfully updated ${res.data.updated} card(s).`);
      }
      setTagPanelMode(null);
      setTagInput('');
    } catch (err) {
      setErrorMessage(getErrMsg(err, `Failed to execute ${action}`));
    } finally {
      setActionPending(false);
    }
  };

  const handleSave = async () => {
    if (!selectedCard || loading || saving || actionPending) return;

    // Check if card is still in current displayed list
    const currentInList = cards.find((c) => c.id === selectedCard.id);
    if (!currentInList) {
      setErrorMessage(
        'The selected card is no longer in the active results. Editing stale cards is prevented.'
      );
      return;
    }

    setSaving(true);
    setErrorMessage('');
    try {
      await updateCard(selectedCard.id, { front: editFront, back: editBack, expected_version: selectedCard.version });

      // Reload actual backend versions and note rendering; edits do not invent scheduler versions.
      await fetchCards(activeQueryRef.current, activeOffsetRef.current);
      setSaveSuccess(true);
    } catch (err) {
      setErrorMessage(getErrMsg(err, 'Failed to save card'));
    } finally {
      setSaving(false);
    }
  };

  const formatStateDisplay = (card: BrowseCard) => {
    const tags: string[] = [];
    if (card.is_suspended) tags.push('Suspended');
    if (card.is_buried) tags.push('Buried');
    const base = card.card_state || 'new';
    if (tags.length > 0) {
      return `${base} (${tags.join(', ')})`;
    }
    return base;
  };

  return (
    <div className="browse-container">
      {/* Left Pane: List and Search */}
      <div className="browse-sidebar glass-card">
        <form onSubmit={handleSearch} className="browse-search">
          <input
            type="text"
            placeholder="Search cards/notes (e.g. deck:French tag:verb is:suspended)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search cards query"
          />
          <button type="submit" className="btn btn-primary" disabled={saving || actionPending || moveLoading}>
            {loading ? 'Searching...' : 'Search'}
          </button>
        </form>

        {/* Search Help Disclosure */}
        <details
          className="search-help-disclosure"
          style={{
            marginBottom: '15px',
            fontSize: '0.85rem',
            background: 'rgba(255, 255, 255, 0.03)',
            borderRadius: '6px',
            padding: '8px 12px',
            border: '1px solid rgba(255, 255, 255, 0.08)',
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
            Search Syntax Help (Supported Filters)
          </summary>
          <div style={{ marginTop: '8px', lineHeight: '1.4' }}>
            <p style={{ margin: '0 0 6px 0' }}>
              <strong>Page size:</strong> Up to <strong>1,000 cards</strong> per page.
              Use Next page to view more results. Selections apply only to the current page.
            </p>
            <p style={{ margin: '0 0 4px 0', fontWeight: 600 }}>
              Supported syntax subset:
            </p>
            <ul style={{ margin: '0 0 6px 0', paddingLeft: '18px' }}>
              <li>
                <strong>Text words:</strong> Implicit AND (e.g.{' '}
                <code>dog cat</code>)
              </li>
              <li>
                <strong>Quotes:</strong> Exact phrase (e.g.{' '}
                <code>&quot;front phrase&quot;</code>)
              </li>
              <li>
                <strong>OR:</strong> Logical OR (e.g.{' '}
                <code>deck:French OR deck:Spanish</code>)
              </li>
              <li>
                <strong>Parentheses:</strong> Grouping (e.g.{' '}
                <code>(tag:hard OR tag:leech) is:review</code>)
              </li>
              <li>
                <strong>Minus negation:</strong> Negation (e.g.{' '}
                <code>-tag:easy</code>, <code>-is:suspended</code>)
              </li>
              <li>
                <strong>deck:</strong> Filter by deck name (e.g.{' '}
                <code>deck:Biology</code>)
              </li>
              <li>
                <strong>tag:</strong> Filter by tag (e.g. <code>tag:exam</code>)
              </li>
              <li>
                <strong>note:</strong> Filter by note model name (e.g.{' '}
                <code>note:Basic</code>)
              </li>
              <li>
                <strong>cid:</strong> Filter by card ID (e.g. <code>cid:42</code>
                )
              </li>
              <li>
                <strong>nid:</strong> Filter by note ID (e.g. <code>nid:15</code>
                )
              </li>
              <li>
                <strong>prop:</strong> Compare interval days, answer count or lapse count:
                {' '}<code>prop:ivl&gt;=10</code>, <code>prop:reps&lt;5</code>, <code>prop:lapses&gt;2</code>.
              </li>
              <li>
                <strong>is:</strong> Filter by card state: <code>is:new</code>,{' '}
                <code>is:learn</code>, <code>is:review</code>,{' '}
                <code>is:suspended</code>, <code>is:buried</code>, <code>is:due</code>
                <p>Due includes the learning-ahead window and ignores daily limits. Use <code>deck:filtered</code> for cards in Custom Study.</p>
              </li>
            </ul>
            <p
              style={{
                margin: 0,
                fontSize: '0.8rem',
                color: 'var(--text-muted, #94a3b8)',
              }}
            >
              No other operators are supported yet.
            </p>
          </div>
        </details>

        {/* Bulk Action Controls & Selection Stats */}
        <div
          className="bulk-toolbar"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            marginBottom: '12px',
            padding: '8px 12px',
            borderRadius: '6px',
            background: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
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
                aria-label="Select all displayed"
                checked={isAllDisplayedSelected}
                onChange={handleToggleSelectAll}
                disabled={cards.length === 0 || loading || saving || actionPending}
              />
              <span>Select all displayed (max 500)</span>
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

          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary" onClick={openMove}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}>
              {moveLoading ? 'Loading decks...' : 'Change Deck'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => openTagPanel('add_tags')}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}
            >
              Add Tags
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => openTagPanel('remove_tags')}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}
            >
              Remove Tags
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handleBulkAction('suspend')}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}
            >
              Suspend
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handleBulkAction('unsuspend')}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}
            >
              Unsuspend
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handleBulkAction('bury')}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}
            >
              Bury
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handleBulkAction('unbury')}
              disabled={selectionCount === 0 || actionPending || loading || saving || moveLoading}
            >
              Unbury
            </button>
          </div>
        </div>

        <label className="flag-selector">Flag selected cards <select value="" disabled={selectionCount === 0 || actionPending || loading || saving} onChange={e => { if (e.target.value !== '') void handleBulkAction('flag', undefined, Number(e.target.value)); }}>
          <option value="">Choose flag</option>
          {['Remove flag', 'Red', 'Orange', 'Green', 'Blue', 'Pink', 'Turquoise', 'Purple'].map((name, value) => <option key={value} value={value}>{name}</option>)}
        </select></label>
        {moveOpen && (
          <div role="group" aria-label="Change selected cards' deck" className="form-group">
            <label htmlFor="move-target-deck">Destination deck</label>
            <select id="move-target-deck" value={targetDeck} disabled={actionPending}
              onChange={(event) => setTargetDeck(event.target.value)}>
              <option value="">Choose a deck</option>
              {moveDecks.map(deck => <option key={deck.id} value={deck.id}>{deck.name}</option>)}
            </select>
            <p>Move {selectionCount} selected cards. Existing review dates stay unchanged.</p>
            <button type="button" className="btn btn-primary" disabled={!targetDeck || actionPending || selectionCount === 0}
              onClick={() => handleBulkAction('move')}>Move selected cards</button>
            <button type="button" className="btn btn-secondary" disabled={actionPending}
              onClick={() => setMoveOpen(false)}>Cancel</button>
          </div>
        )}

        {tagPanelMode && (
          <div
            role="group"
            aria-label="Bulk tag editor"
            className="form-group"
          >
            <label htmlFor="bulk-tag-input">
              {tagPanelMode === 'add_tags' ? 'Tags to add' : 'Tags to remove'}
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
            <p>Tags belong to notes; all cards of each selected note are affected, including cards on other pages/decks.</p>
            {tagPanelMode === 'remove_tags' && (
              <p>Removing a parent tag also removes its subtags.</p>
            )}
            <p>{selectionCount} selected card(s)</p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={actionPending || parseTags(tagInput).length === 0 || selectionCount === 0}
              onClick={() => handleBulkAction(tagPanelMode, parseTags(tagInput))}
            >
              Apply
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
              Cancel
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
              color: '#f87171',
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
              color: '#4ade80',
              fontSize: '0.9rem',
            }}
          >
            {actionSuccessMessage}
          </div>
        )}

        <nav aria-label="Search result pages" style={{display:'flex', gap:'12px', alignItems:'center', marginBottom:'8px'}}>
          <button type="button" className="btn btn-secondary"
            disabled={pageOffset === 0 || loading || saving || actionPending || moveLoading}
            onClick={() => fetchCards(activeQueryRef.current, Math.max(0, pageOffset - PAGE_SIZE))}>Previous page</button>
          <span>Page {Math.floor(pageOffset / PAGE_SIZE) + 1} · {cards.length} cards</span>
          <button type="button" className="btn btn-secondary"
            disabled={cards.length < PAGE_SIZE || loading || saving || actionPending || moveLoading}
            onClick={() => fetchCards(activeQueryRef.current, pageOffset + PAGE_SIZE)}>Next page</button>
        </nav>
        <div className="browse-table-container">
          <table className="browse-table">
            <thead>
              <tr>
                <th style={{ width: '40px', textAlign: 'center' }}>
                  <span className="sr-only">Select</span>
                </th>
                <th>Front</th>
                <th>Back</th>
                <th>Deck</th>
                <th>Due</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={6}
                    style={{ textAlign: 'center', padding: '20px' }}
                  >
                    Loading...
                  </td>
                </tr>
              ) : cards.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    style={{ textAlign: 'center', padding: '20px' }}
                  >
                    No cards found
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
                          aria-label={`Select card ${card.id}`}
                          checked={isChecked}
                          disabled={saving || actionPending || (!isChecked && selectionCount >= MAX_BULK)}
                          onChange={() => handleToggleCardSelection(card.id)}
                        />
                      </td>
                      <td>{card.front}</td>
                      <td>{card.back}</td>
                      <td>{card.deck_name}</td>
                      <td>
                        {card.card_state === 'new' ? 'New' : card.next_review
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
                              : 'rgba(255, 255, 255, 0.1)',
                            color: card.is_suspended
                              ? '#fca5a5'
                              : card.is_buried
                              ? '#fde047'
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
              <h2>Edit Card #{selectedCard.id}</h2>
              {selectedCard.deck_id && (
                <Link
                  to={`/decks/${selectedCard.deck_id}/cards`}
                  className="btn btn-secondary"
                  style={{
                    fontSize: '0.8rem',
                    padding: '4px 8px',
                    textDecoration: 'none',
                  }}
                  title="Open Note Editor in Deck View"
                >
                  Open in Note/Deck Editor
                </Link>
              )}
            </div>

            <div
              style={{
                marginBottom: '12px',
                fontSize: '0.85rem',
                color: 'var(--text-muted, #94a3b8)',
              }}
            >
              <span>State: {formatStateDisplay(selectedCard)}</span>
              {selectedCard.note_id != null && (
                <span style={{ marginLeft: '12px' }}>
                  Note ID: {selectedCard.note_id}
                </span>
              )}

            </div>

            <div className="form-group">
              <label htmlFor="card-edit-front">Front</label>
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
              <label htmlFor="card-edit-back">Back</label>
              <textarea
                id="card-edit-back"
                disabled={saving || actionPending}
                value={editBack}
                onChange={(e) => setEditBack(e.target.value)}
                rows={5}
                className="editor-textarea"
              />
            </div>
            <div
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
                    color: 'var(--accent-green, #4ade80)',
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
                disabled={saving || actionPending || loading}
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        ) : (
          <div className="editor-empty">
            <span style={{ fontSize: '3rem', opacity: 0.5 }}>🔍</span>
            <p>Select a card to view and edit</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default BrowsePage;
