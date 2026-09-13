import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { listDecks, createDeck, deleteDeck, updateDeck, importCards, importApkg, exportApkg } from '../api/decks';

const DecksPage = () => {
  const [decks, setDecks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Modals state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newDeckName, setNewDeckName] = useState('');
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState('');
  const [importDeckId, setImportDeckId] = useState<number | null>(null);
  const [importSeparator, setImportSeparator] = useState('\t');
  
  // Export modal state
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportDeckId, setExportDeckId] = useState<number | null>(null);
  const [exportDeckName, setExportDeckName] = useState('');
  const [includeScheduling, setIncludeScheduling] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Import .apkg state
  const [importingApkg, setImportingApkg] = useState(false);

  // Dropdown state
  const [activeDropdown, setActiveDropdown] = useState<number | null>(null);
  
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (file.name.endsWith('.apkg')) {
      // Handle .apkg import
      setImportingApkg(true);
      try {
        const res = await importApkg(file);
        const data = res.data;
        let message = `Imported ${data.cards_imported} cards into deck "${data.deck_name}"`;
        if (data.media_imported > 0) {
          message += ` + ${data.media_imported} media files`;
        }
        alert(message);
        fetchDecks();
      } catch {
        alert('Failed to import .apkg file.');
      } finally {
        setImportingApkg(false);
      }
    } else {
      // Handle text file import (existing behavior)
      const reader = new FileReader();
      reader.onload = (ev) => {
        setImportText(ev.target?.result as string);
        setImportDeckId(decks.length > 0 ? decks[0].id : null);
        setShowImportModal(true);
      };
      reader.readAsText(file);
    }
    e.target.value = '';
  };

  const fetchDecks = async () => {
    try {
      const res = await listDecks();
      setDecks(res.data);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { fetchDecks(); }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setActiveDropdown(null);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const handleCreateDeck = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDeckName) return;
    try {
      await createDeck(newDeckName, '');
      setNewDeckName('');
      setShowCreateModal(false);
      fetchDecks();
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: number) => {
    if (confirm('Are you sure you want to delete this deck?')) {
      try {
        await deleteDeck(id);
        fetchDecks();
      } catch { /* ignore */ }
    }
  };

  const handleRename = async (id: number, oldName: string) => {
    const newName = prompt('Enter new name:', oldName);
    if (newName && newName !== oldName) {
      try {
        await updateDeck(id, { name: newName });
        fetchDecks();
      } catch { /* ignore */ }
    }
  };

  const openImportModal = (id: number) => {
    setImportDeckId(id);
    setImportText('');
    setShowImportModal(true);
  };

  const openExportModal = (deckId: number, deckName: string) => {
    setExportDeckId(deckId);
    setExportDeckName(deckName);
    setIncludeScheduling(false);
    setShowExportModal(true);
  };

  const handleExport = async () => {
    if (!exportDeckId) return;
    setExporting(true);
    try {
      const res = await exportApkg(exportDeckId, includeScheduling);
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${exportDeckName}.apkg`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setShowExportModal(false);
    } catch {
      alert('Failed to export deck.');
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importDeckId || !importText) return;
    try {
      const res = await importCards(importDeckId, importText, importSeparator);
      alert(res.data.message);
      setShowImportModal(false);
      fetchDecks();
    } catch {
      alert('Failed to import cards.');
    }
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div className="page-container" style={{ padding: '2rem 1rem' }}>
      
      <div className="desktop-deck-table">
        <div className="deck-list-header">
          <div className="col-name">Deck</div>
          <span>New</span>
          <span>Learn</span>
          <span>Due</span>
          <span></span>
        </div>
        
        {decks.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
            No decks yet. Click "Create Deck" to get started!
          </div>
        ) : (
          decks.map(deck => (
            <div key={deck.id} className="deck-row" style={{ position: 'relative', zIndex: activeDropdown === deck.id ? 20 : 1 }}>
              <div className="col-name" onClick={() => navigate(`/decks/${deck.id}`)}>
                {deck.name}
              </div>
              <div className="col-stat stat-new">{deck.new_cards || 0}</div>
              <div className="col-stat stat-learn">{deck.learn_cards || 0}</div>
              <div className="col-stat stat-due">{deck.due_cards || 0}</div>
              
              <div className="col-actions">
                <button 
                  className="gear-btn" 
                  onClick={(e) => { e.stopPropagation(); setActiveDropdown(activeDropdown === deck.id ? null : deck.id); }}
                >
                  ⚙️
                </button>
                {activeDropdown === deck.id && (
                  <div className="gear-dropdown" onClick={(e) => e.stopPropagation()}>
                    <button className="gear-dropdown-item" onClick={() => { setActiveDropdown(null); handleRename(deck.id, deck.name); }}>Rename</button>
                    <button className="gear-dropdown-item" onClick={() => { setActiveDropdown(null); navigate(`/decks/${deck.id}/options`); }}>Options</button>
                    <button className="gear-dropdown-item" onClick={() => { setActiveDropdown(null); openExportModal(deck.id, deck.name); }}>Export</button>
                    <button className="gear-dropdown-item" onClick={() => { setActiveDropdown(null); openImportModal(deck.id); }}>Import Cards</button>
                    <button className="gear-dropdown-item" style={{ color: '#ef4444' }} onClick={() => { setActiveDropdown(null); handleDelete(deck.id); }}>Delete</button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="studied-today">
        Studied 0 cards in 0 seconds today (0s/card)
      </div>

      <div style={{ textAlign: 'center', marginTop: '3rem', display: 'flex', gap: '1rem', justifyContent: 'center' }}>
        <button className="btn btn-pill" onClick={() => window.open('https://ankiweb.net/shared/decks', '_blank')}>Get Shared</button>
        <button className="btn btn-pill" onClick={() => setShowCreateModal(true)}>Create Deck</button>
        <button className="btn btn-pill" onClick={() => fileInputRef.current?.click()} disabled={importingApkg}>
          {importingApkg ? 'Importing...' : 'Import File'}
        </button>
        <input 
          type="file" 
          accept=".txt,.csv,.apkg" 
          style={{ display: 'none' }} 
          ref={fileInputRef} 
          onChange={handleFileUpload} 
        />
      </div>

      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal glass-card" onClick={e => e.stopPropagation()}>
            <h2>Create New Deck</h2>
            <form onSubmit={handleCreateDeck}>
              <div className="form-group">
                <label>Deck Name</label>
                <input autoFocus type="text" value={newDeckName} onChange={e => setNewDeckName(e.target.value)} required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowCreateModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Create</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showImportModal && (
        <div className="modal-overlay" onClick={() => setShowImportModal(false)}>
          <div className="modal glass-card" style={{ maxWidth: '600px' }} onClick={e => e.stopPropagation()}>
            <h2>Import Cards</h2>
            <form onSubmit={handleImport}>
              <div className="form-group">
                <label>Target Deck</label>
                <select 
                  value={importDeckId || ''} 
                  onChange={e => setImportDeckId(Number(e.target.value))}
                  required
                >
                  <option value="" disabled>Select a deck...</option>
                  {decks.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Format: Front [Separator] Back (One card per line)</label>
                <textarea 
                  rows={8} 
                  value={importText} 
                  onChange={e => setImportText(e.target.value)} 
                  placeholder={"Hello\\tXin chào\\nApple\\tQuả táo"}
                  required 
                />
              </div>
              <div className="form-group">
                <label>Separator</label>
                <select value={importSeparator} onChange={e => setImportSeparator(e.target.value)}>
                  <option value="\t">Tab (Excel paste)</option>
                  <option value=",">Comma (,)</option>
                  <option value="-">Dash (-)</option>
                  <option value="|">Pipe (|)</option>
                </select>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowImportModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Import</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showExportModal && (
        <div className="modal-overlay" onClick={() => setShowExportModal(false)}>
          <div className="modal glass-card" onClick={e => e.stopPropagation()}>
            <h2>Export Deck</h2>
            <div className="form-group">
              <label>Deck</label>
              <input type="text" value={exportDeckName} readOnly style={{ opacity: 0.7 }} />
            </div>
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input 
                type="checkbox" 
                id="include-scheduling" 
                checked={includeScheduling} 
                onChange={e => setIncludeScheduling(e.target.checked)} 
                style={{ width: 'auto' }}
              />
              <label htmlFor="include-scheduling" style={{ margin: 0 }}>Include scheduling information</label>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setShowExportModal(false)}>Cancel</button>
              <button 
                type="button" 
                className="btn btn-primary" 
                onClick={handleExport} 
                disabled={exporting}
              >
                {exporting ? 'Exporting...' : 'Export'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DecksPage;
