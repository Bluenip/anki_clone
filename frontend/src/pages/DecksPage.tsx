import PackageImportPanel from '../components/PackageImportPanel';
import './DecksPage.css';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listDecks, getTodaySummary, createDeck, deleteDeck, updateDeck, importCards, startPackageImport, discardPackageUpload, exportApkg, exportText, exportCollection, getImportNoteTypes } from '../api/decks';
import type { Deck as DeckData, TextImportOptions } from '../api/decks';
import { getNoteTypes } from '../api/notes';
import type { NoteType } from '../api/notes';

const BUILTIN_NOTE_TYPES: NoteType[] = [
  { kind: 'basic', name: 'Basic', fields: ['Front', 'Back'] },
  { kind: 'reversed', name: 'Basic (and reversed card)', fields: ['Front', 'Back'] },
  { kind: 'optional_reversed', name: 'Basic (optional reversed card)', fields: ['Front', 'Back', 'Add Reverse'] },
  { kind: 'cloze', name: 'Cloze', fields: ['Text', 'Extra'] },
];

async function exportFailure(error: unknown, fallback: string): Promise<string> {
  let data = (error as { response?: { data?: unknown } })?.response?.data;
  if (data instanceof Blob) {
    try { data = JSON.parse(await data.text()); } catch { return fallback; }
  }
  const detail = (data as { detail?: unknown } | undefined)?.detail;
  return typeof detail === 'string' ? detail : fallback;
}

const DecksPage = () => {
  const [decks, setDecks] = useState<DeckData[]>([]);
  const [todaySummary, setTodaySummary] = useState<{ reviews: number; seconds: number; seconds_per_card: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  
  // Modals state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createModalError, setCreateModalError] = useState<string | null>(null);
  const [newDeckName, setNewDeckName] = useState('');

  const [showFileImport, setShowFileImport] = useState(false);
  const fileImportModalRef = useRef<HTMLDivElement>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importModalError, setImportModalError] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [importDeckId, setImportDeckId] = useState<number | null>(null);
  const [importSeparator, setImportSeparator] = useState('\t');
  const [matchScope, setMatchScope] = useState<'deck' | 'collection'>('deck');
  const [matchFields, setMatchFields] = useState<'first' | 'all'>('first');
  const [duplicatePolicy, setDuplicatePolicy] = useState<'add' | 'skip' | 'update'>('add');
  const [hasHeader, setHasHeader] = useState(false);
  const [allowHtml, setAllowHtml] = useState(true);
  const [useFileDecks, setUseFileDecks] = useState(false);
  const [swapColumns, setSwapColumns] = useState(false);
  const [noteTypes, setNoteTypes] = useState<(NoteType & { id?: number })[]>(BUILTIN_NOTE_TYPES);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advancedKind, setAdvancedKind] = useState<string>('basic');
  const [fieldColumns, setFieldColumns] = useState<Record<string, number | string>>({ Front: 0, Back: 1 });
  const [tagsColumn, setTagsColumn] = useState<string>('');
  const [guidColumn, setGuidColumn] = useState<string>('');
  const [globalTags, setGlobalTags] = useState<string>('');
  const [importPreview, setImportPreview] = useState<{ fingerprint: string; message: string } | null>(null);

  const currentNoteType: NoteType & { id?: number } = noteTypes.find(nt => nt.kind === advancedKind) || BUILTIN_NOTE_TYPES[0];

  const importFingerprint = JSON.stringify([
    importDeckId,
    importText,
    importSeparator,
    duplicatePolicy, matchScope, matchFields,
    hasHeader,
    allowHtml,
    useFileDecks,
    swapColumns,
    advancedMode,
    advancedKind,
    fieldColumns,
    tagsColumn,
    guidColumn,
    globalTags,
  ]);
  const previewIsCurrent = importPreview?.fingerprint === importFingerprint;
  
  // Export modal state
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportDeckId, setExportDeckId] = useState<number | null>(null);
  const [exportDeckName, setExportDeckName] = useState('');
  const [includeScheduling, setIncludeScheduling] = useState(false);
  const [modernPackage, setModernPackage] = useState(true);
  const [importScheduling, setImportScheduling] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState<'apkg' | 'csv' | 'txt' | 'tsv'>('apkg');

  const [mediaConflicts, setMediaConflicts] = useState<'error' | 'rename'>('error');
  const [packageDuplicates, setPackageDuplicates] = useState<'newer' | 'skip' | 'update' | 'add'>('newer');
  // Import .apkg state
  const [importingApkg, setImportingApkg] = useState(() => !!sessionStorage.getItem('anki-package-import'));
  const [packageJobId, setPackageJobId] = useState<string | null>(() => sessionStorage.getItem('anki-package-import'));
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadStatus, setUploadStatus] = useState('Uploading…');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const closePackageJob = () => {
    setPackageJobId(null); setImportingApkg(false);
    sessionStorage.removeItem('anki-package-import');
  };

  // Dropdown state
  const [activeDropdown, setActiveDropdown] = useState<number | null>(null);
  
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const createModalRef = useRef<HTMLDivElement>(null);
  const importModalRef = useRef<HTMLDivElement>(null);
  const exportModalRef = useRef<HTMLDivElement>(null);
  const closeFileImport = useCallback(() => { setShowFileImport(false); openerRef.current?.focus(); }, []);


  const openCreateModal = (e?: React.MouseEvent) => {
    openerRef.current = (e?.currentTarget as HTMLElement) || (document.activeElement as HTMLElement);
    setCreateModalError(null);
    setShowCreateModal(true);
  };

  const closeCreateModal = useCallback(() => {
    setShowCreateModal(false);
    setCreateModalError(null);
    openerRef.current?.focus();
  }, []);

  const openImportModal = (id: number, e?: React.MouseEvent, text = '') => {
    openerRef.current = (e?.currentTarget as HTMLElement) || (document.activeElement as HTMLElement);
    setImportDeckId(id);
    setImportText(text);
    setImportPreview(null);
    setImportModalError(null);
    setUseFileDecks(false);
    setAdvancedMode(false);
    setAdvancedKind('basic');
    setFieldColumns({ Front: 0, Back: 1 });
    setTagsColumn('');
    setGuidColumn('');
    setGlobalTags('');
    setShowImportModal(true);
  };

  const closeImportModal = useCallback(() => {
    setShowImportModal(false);
    setImportModalError(null);
    openerRef.current?.focus();
  }, []);

  const openExportModal = (deckId: number, deckName: string, e?: React.MouseEvent) => {
    openerRef.current = (e?.currentTarget as HTMLElement) || (document.activeElement as HTMLElement);
    setExportDeckId(deckId);
    setExportDeckName(deckName);
    setIncludeScheduling(false);
    setShowExportModal(true);
  };

  const closeExportModal = useCallback(() => {
    setShowExportModal(false);
    openerRef.current?.focus();
  }, []);

  const uploadPackage = async (file: File, collectionRestore: boolean) => {
    setImportingApkg(true);
    setOperationError(null);
    setUploadFile(file);
    let submitted = false;
    try {
      setUploadProgress(0);
      uploadController.current = new AbortController();
      const res = await startPackageImport(file, importScheduling, collectionRestore, mediaConflicts,
        packageDuplicates, setUploadProgress, uploadController.current.signal, setUploadStatus);
      submitted = true;
      setUploadFile(null);
      setPackageJobId(res.data.id);
      sessionStorage.setItem('anki-package-import', res.data.id);
    } catch (err: any) {
      if (err?.name !== 'PackageUploadPaused') setUploadFile(null);
      if (err?.code !== 'ERR_CANCELED' && err?.name !== 'AbortError') setOperationError(err?.response?.data?.detail || err?.message || 'Failed to upload package.');
    } finally {
      setUploadProgress(null);
      uploadController.current = null;
      if (!submitted) setImportingApkg(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setShowFileImport(false);
    
    const collectionRestore = file.name.toLowerCase().endsWith('.colpkg');
    if (collectionRestore && decks.length > 0) {
      setOperationError('Use Backups & restore to preview and restore into a collection that already contains cards.');
      e.target.value = '';
      return;
    }
    if (collectionRestore && !window.confirm('Restore this collection package, including all decks, media and study history, into your empty collection?')) {
      e.target.value = '';
      return;
    }
    if (file.name.toLowerCase().endsWith('.apkg') || collectionRestore) {
      await uploadPackage(file, collectionRestore);
    } else {
      const reader = new FileReader();
      reader.onload = (ev) => {
        openImportModal(decks.length > 0 ? decks[0].id : 0, undefined, ev.target?.result as string);
        setImportSeparator(file.name.toLowerCase().endsWith('.csv') ? ',' : '\t');
      };
      reader.onerror = () => setOperationError('Could not read the selected file.');
      reader.readAsText(file);
    }
    e.target.value = '';
  };

  const fetchDecks = useCallback(async () => {
    try {
      setLoadError(null);
      const [res, summary] = await Promise.all([listDecks(), Promise.resolve(getTodaySummary()).catch(() => null)]);
      setDecks(res.data);
      setTodaySummary(summary?.data ?? null);
    } catch {
      setLoadError('Failed to load decks. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDecks(); }, [fetchDecks]);

  useEffect(() => {
    let active = true;
    Promise.all([getNoteTypes(), getImportNoteTypes()]).then(([builtins, existing]) => {
      if (!active) return;
      const base = Array.isArray(builtins?.data) && builtins.data.length ? builtins.data : BUILTIN_NOTE_TYPES;
      const saved = Array.isArray(existing?.data) ? existing.data.map(model => ({ ...model, kind: `custom:${model.id}`, name: `${model.name} (existing)` })) : [];
      setNoteTypes([...base, ...saved]);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setActiveDropdown(null);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const getFocusableElements = useCallback((container: HTMLElement): HTMLElement[] => {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter(el => {
      if ((el as any).disabled) return false;
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
      if (el.style.display === 'none' || el.style.visibility === 'hidden') return false;
      return true;
    });
  }, []);

  // Mobile keyboards can shrink the visual viewport without changing 100dvh.
  useEffect(() => {
    if (!showImportModal) return;
    const overlay = importModalRef.current?.parentElement;
    if (!overlay) return;
    const viewport = window.visualViewport;
    const resize = () => {
      overlay.style.setProperty('--import-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
      overlay.style.setProperty('--import-viewport-top', `${viewport?.offsetTop ?? 0}px`);
    };
    resize();
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    window.addEventListener('resize', resize);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
      window.removeEventListener('resize', resize);
      document.body.style.overflow = previousOverflow;
    };
  }, [showImportModal]);

  // Trap focus in modals, ignore disabled/hidden controls, handle Escape & restore focus
  useEffect(() => {
    const activeRef = showFileImport
      ? fileImportModalRef
      : showCreateModal
      ? createModalRef
      : showImportModal
      ? importModalRef
      : showExportModal
      ? exportModalRef
      : null;

    if (!activeRef?.current) return;

    const modalElement = activeRef.current;
    const focusable = getFocusableElements(modalElement);
    if (focusable.length > 0) {
      focusable[0].focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showFileImport) closeFileImport();
        if (showCreateModal) closeCreateModal();
        if (showImportModal) closeImportModal();
        if (showExportModal) closeExportModal();
        return;
      }

      if (e.key === 'Tab') {
        const currentFocusable = getFocusableElements(modalElement);
        if (currentFocusable.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = currentFocusable[0];
        const lastElement = currentFocusable[currentFocusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement || !modalElement.contains(document.activeElement)) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement || !modalElement.contains(document.activeElement)) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showFileImport, closeFileImport, showCreateModal, showImportModal, showExportModal, getFocusableElements, closeCreateModal, closeImportModal, closeExportModal]);


  const handleCreateDeck = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDeckName.trim() || pending) return;
    setPending(true);
    setCreateModalError(null);
    try {
      await createDeck(newDeckName.trim(), '');
      setNewDeckName('');
      closeCreateModal();
      fetchDecks();
    } catch (err: any) {
      setCreateModalError(err?.response?.data?.detail || 'Failed to create deck.');
    } finally {
      setPending(false);
    }
  };

  const handleDelete = async (id: number) => {
    const target=decks.find(deck=>deck.id===id);
    if (confirm(`Delete "${target?.name || 'this deck'}" and its subdecks (${target?.total_cards ?? 0} cards)? This removes their study history.`)) {
      setPending(true);
      setOperationError(null);
      try {
        await deleteDeck(id);
        fetchDecks();
      } catch {
        setOperationError('Failed to delete deck.');
      } finally {
        setPending(false);
      }
    }
  };

  const handleRename = async (id: number, oldName: string) => {
    const newName = prompt('Enter new name:', oldName);
    if (newName && newName !== oldName) {
      setPending(true);
      setOperationError(null);
      try {
        await updateDeck(id, { name: newName });
        fetchDecks();
      } catch {
        setOperationError('Failed to rename deck.');
      } finally {
        setPending(false);
      }
    }
  };

  const handleExport = async () => {
    if (!exportDeckId) return;
    setExporting(true);
    setOperationError(null);
    try {
      const res = exportFormat === 'apkg'
        ? await exportApkg(exportDeckId, includeScheduling, modernPackage)
        : await exportText(exportDeckId, exportFormat);
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${exportDeckName}.${exportFormat}`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      closeExportModal();
    } catch (error: unknown) {
      setOperationError(await exportFailure(error, 'Failed to export deck.'));
    } finally {
      setExporting(false);
    }
  };

  const handleCollectionExport = async () => {
    if (exporting) return;
    setExporting(true);
    setOperationError(null);
    try {
      const response = await exportCollection();
      const url = URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'collection.colpkg';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error: unknown) {
      setOperationError(await exportFailure(error, 'Failed to export collection.'));
    } finally {
      setExporting(false);
    }
  };

  const handleKindChange = (newKind: string) => {
    setAdvancedKind(newKind);
    const nt = noteTypes.find(t => t.kind === newKind);
    if (nt) {
      const mapping: Record<string, number> = {};
      nt.fields.forEach((f, idx) => {
        mapping[f] = idx;
      });
      setFieldColumns(mapping);
    }
    setImportModalError(null);
  };

  const handleFieldColumnChange = (field: string, val: string) => {
    setFieldColumns(prev => ({
      ...prev,
      [field]: val === '' ? '' : (isNaN(parseInt(val, 10)) ? 0 : parseInt(val, 10)),
    }));
    setImportModalError(null);
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importDeckId || !importText.trim() || pending) return;
    setPending(true);
    setImportModalError(null);
    try {
      const options: TextImportOptions = advancedMode
        ? {
            preview: !previewIsCurrent,
            duplicate_policy: duplicatePolicy,
            ...(matchScope !== 'deck' ? { match_scope: matchScope } : {}),
            ...(matchFields !== 'first' ? { match_fields: matchFields } : {}),
            has_header: hasHeader,
            allow_html: allowHtml,
            ...(useFileDecks ? { use_file_decks: true } : {}),
            ...(currentNoteType.id ? { note_type_id: currentNoteType.id } : { kind: advancedKind }),
            field_columns: Object.fromEntries(
              currentNoteType.fields.map((f, idx) => {
                const val = fieldColumns[f];
                const col = typeof val === 'number'
                  ? val
                  : (typeof val === 'string' && val.trim() !== '' && !isNaN(parseInt(val, 10)) ? parseInt(val, 10) : idx);
                return [f, col];
              })
            ),
            ...(tagsColumn.trim() !== '' && !isNaN(parseInt(tagsColumn, 10)) ? { tags_column: parseInt(tagsColumn, 10) } : {}),
            ...(guidColumn.trim() !== '' && !isNaN(parseInt(guidColumn, 10)) ? { guid_column: parseInt(guidColumn, 10) } : {}),
            tags: globalTags.trim() ? globalTags.trim().split(/\s+/) : [],
          }
        : {
            preview: !previewIsCurrent,
            duplicate_policy: duplicatePolicy,
            ...(matchScope !== 'deck' ? { match_scope: matchScope } : {}),
            ...(matchFields !== 'first' ? { match_fields: matchFields } : {}),
            has_header: hasHeader,
            allow_html: allowHtml,
            ...(useFileDecks ? { use_file_decks: true } : {}),
            front_column: swapColumns ? 1 : 0,
            back_column: swapColumns ? 0 : 1,
          };
      const res = await importCards(importDeckId, importText, importSeparator, options);
      if (!previewIsCurrent) setImportPreview({ fingerprint: importFingerprint, message: res.data.message });
      else { closeImportModal(); fetchDecks(); }
    } catch (err: any) {
      setImportModalError(err?.response?.data?.detail || 'Failed to import cards.');
    } finally {
      setPending(false);
    }
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div className="page-container decks-page">
      <header className="decks-heading">
        <div><p className="decks-eyebrow">YOUR COLLECTION</p><h1>Decks</h1><p>Make a little progress, every day.</p></div>
        <div className="decks-primary-actions">
          <button className="btn btn-ghost" onClick={e => { openerRef.current = e.currentTarget; setShowFileImport(true); }} disabled={importingApkg || pending}>{importingApkg ? 'Importing...' : 'Import File'}</button>
          <button className="btn btn-primary" onClick={openCreateModal} disabled={pending}>Create Deck</button>
        </div>
      </header>
      
      {operationError && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{operationError}</span>
          <button onClick={() => setOperationError(null)} className="btn btn-ghost btn-sm" aria-label="Dismiss error">✕</button>
        </div>
      )}

      {loadError && decks.length > 0 && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{loadError}</span>
          <button onClick={() => setLoadError(null)} className="btn btn-ghost btn-sm" aria-label="Dismiss error">✕</button>
        </div>
      )}

      {uploadProgress !== null && <section className="glass-card package-import-progress" aria-label="Package upload">
        <p role="status">{uploadStatus} {uploadProgress}%</p>
        <progress max={100} value={uploadProgress} aria-label="Upload progress" />
        <button className="btn btn-ghost" onClick={() => uploadController.current?.abort()}>Cancel upload</button>
      </section>}
      {uploadFile && uploadProgress === null && !importingApkg && <section className="glass-card package-import-progress" aria-label="Paused upload">
        <p>{uploadFile.name} — received parts are saved. You can continue without starting over.</p>
        <button className="btn btn-primary" onClick={() => void uploadPackage(uploadFile, uploadFile.name.toLowerCase().endsWith('.colpkg'))}>Resume upload</button>
        <button className="btn btn-ghost" onClick={() => { setUploadFile(null); setOperationError(null); void discardPackageUpload(); }}>Cancel upload</button>
      </section>}
      {packageJobId && <PackageImportPanel key={packageJobId} id={packageJobId} onBusy={setImportingApkg} onComplete={fetchDecks} onClose={closePackageJob} />}

      <div className="desktop-deck-table">
        <div className="deck-list-header">
          <div className="col-name">Deck</div>
          <span>New</span>
          <span>Learn</span>
          <span>Due</span>
          <span></span>
        </div>
        
        {loadError && decks.length === 0 ? (
          <div role="alert" style={{ padding: '2rem', textAlign: 'center' }}>
            <p style={{ color: '#ef4444', marginBottom: '1rem' }}>{loadError}</p>
            <button className="btn btn-primary" onClick={fetchDecks}>Retry</button>
          </div>
        ) : decks.length === 0 ? (
          <div className="decks-empty">
            <div className="decks-empty-icon" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><rect x="8" y="12" width="29" height="29" rx="5" stroke="currentColor" strokeWidth="2"/><path d="M16 7h21a5 5 0 0 1 5 5v20M17 23h11M17 30h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg></div>
            <h2>Your next learning journey starts here</h2>
            <p>Create your first deck or import cards you already have.</p>
            <span>Supports Anki packages, CSV and text files</span>
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
                  aria-label={`Options for deck ${deck.name}`}
                  aria-expanded={activeDropdown === deck.id}
                  aria-haspopup="menu"
                >
                  ⚙️
                </button>
                {activeDropdown === deck.id && (
                  <div className="gear-dropdown" role="menu" onClick={(e) => e.stopPropagation()}>
                    <button className="gear-dropdown-item" role="menuitem" disabled={pending} onClick={() => { setActiveDropdown(null); handleRename(deck.id, deck.name); }}>Rename</button>
                    <button className="gear-dropdown-item" role="menuitem" onClick={() => { setActiveDropdown(null); navigate(`/decks/${deck.id}/options`); }}>Options</button>
                    <button className="gear-dropdown-item" role="menuitem" onClick={(e) => { setActiveDropdown(null); openExportModal(deck.id, deck.name, e); }}>Export</button>
                    <button className="gear-dropdown-item" role="menuitem" onClick={(e) => { setActiveDropdown(null); openImportModal(deck.id, e); }}>Import Cards</button>
                    <button className="gear-dropdown-item" role="menuitem" disabled={pending} style={{ color: '#ef4444' }} onClick={() => { setActiveDropdown(null); handleDelete(deck.id); }}>Delete</button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="studied-today">
        {todaySummary ? `Studied ${todaySummary.reviews} cards in ${todaySummary.seconds} seconds today (${todaySummary.seconds_per_card}s/card)` : 'Study activity unavailable'}
      </div>

      <section className="collection-tools" aria-label="Collection tools">
        <div className="collection-tools-copy"><h2>Collection tools</h2><p>Discover cards, export your collection, or manage backups.</p></div>
        <div className="collection-tools-actions">
          <a className="btn btn-ghost" href="https://ankiweb.net/shared/decks" target="_blank" rel="noopener noreferrer">Get Shared <span aria-hidden="true">↗</span></a>
          <button className="btn btn-ghost" onClick={handleCollectionExport} disabled={exporting || importingApkg}>{exporting ? 'Exporting…' : 'Export collection (.colpkg)'}</button>
          <Link className="btn btn-ghost" to="/backups">Backups &amp; restore</Link>
        </div>
      </section>
      <input type="file" accept=".txt,.csv,.tsv,.apkg,.colpkg" hidden ref={fileInputRef} onChange={handleFileUpload} aria-label="Upload file for import" />
      {showFileImport && <div className="modal-overlay" onClick={closeFileImport} role="dialog" aria-modal="true" aria-label="Import file">
        <div className="modal glass-card file-import-modal" ref={fileImportModalRef} onClick={e => e.stopPropagation()}>
          <h2>Import your cards</h2>
          <p className="import-intro">Choose an Anki package, CSV or text file. Package options below apply to .apkg and .colpkg files.</p>
        <div className="form-group"><label htmlFor="package-media">Media name collisions</label><select id="package-media" value={mediaConflicts} disabled={importingApkg} onChange={e => setMediaConflicts(e.target.value as 'error' | 'rename')}><option value="error">Stop and report conflict</option><option value="rename">Keep both files and update incoming references</option></select></div>
        <div className="form-group"><label htmlFor="package-duplicates">Existing package notes</label><select id="package-duplicates" value={packageDuplicates} disabled={importingApkg} onChange={e => setPackageDuplicates(e.target.value as typeof packageDuplicates)}><option value="newer">Update if incoming note is newer</option><option value="skip">Keep existing notes</option><option value="update">Update existing notes</option><option value="add">Import separate copies</option></select></div>
        <label className="package-history"><input type="checkbox" checked={importScheduling} disabled={importingApkg} onChange={e => setImportScheduling(e.target.checked)} /> Import APKG study history</label>

          <p className="import-hint">To replace an existing collection, use <Link to="/backups">Backups &amp; restore</Link>.</p>
          <div className="modal-actions"><button className="btn btn-ghost" onClick={closeFileImport}>Cancel</button><button className="btn btn-primary" disabled={importingApkg || pending} onClick={() => fileInputRef.current?.click()}>Choose file</button></div>
        </div>
      </div>}

      {showCreateModal && (
        <div className="modal-overlay" onClick={closeCreateModal} role="dialog" aria-modal="true" aria-label="Create new deck">
          <div className="modal glass-card" ref={createModalRef} onClick={e => e.stopPropagation()}>
            <h2>Create New Deck</h2>
            {createModalError && (
              <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
                {createModalError}
              </div>
            )}
            <form onSubmit={handleCreateDeck}>
              <div className="form-group">
                <label htmlFor="new-deck-name">Deck Name</label>
                <input
                  id="new-deck-name"
                  autoFocus
                  type="text"
                  value={newDeckName}
                  onChange={e => { setNewDeckName(e.target.value); setCreateModalError(null); }}
                  disabled={pending}
                  required
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={closeCreateModal} disabled={pending}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={pending || !newDeckName.trim()}>{pending ? 'Creating...' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showImportModal && (
        <div className="modal-overlay cards-import-overlay" onClick={closeImportModal} role="dialog" aria-modal="true" aria-label="Import cards">
          <div className="modal glass-card cards-import-modal" ref={importModalRef} onClick={e => e.stopPropagation()}>
            <h2>Import Cards</h2>
            {importModalError && (
              <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
                {importModalError}
              </div>
            )}
            <form onSubmit={handleImport}>
              <div className="cards-import-body">
              <div className="form-group">
                <label htmlFor="import-deck-select">Target Deck</label>
                <select 
                  id="import-deck-select"
                  value={importDeckId || ''} 
                  onChange={e => { setImportDeckId(Number(e.target.value)); setImportModalError(null); }}
                  disabled={pending}
                  required
                >
                  <option value="" disabled>Select a deck...</option>
                  {decks.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="import-text">Basic notes: Front and Back (quoted multiline fields supported)</label>
                <label>Duplicate search scope<select value={matchScope} disabled={pending} onChange={e => setMatchScope(e.target.value as typeof matchScope)}><option value="deck">Selected deck</option><option value="collection">Entire collection (keep existing decks)</option></select></label>
                  <label>Duplicate match<select value={matchFields} disabled={pending} onChange={e => setMatchFields(e.target.value as typeof matchFields)}><option value="first">First field</option><option value="all">All fields</option></select></label>
                  <textarea
                  id="import-text"
                  rows={8} 
                  value={importText} 
                  onChange={e => { setImportText(e.target.value); setImportModalError(null); }}
                  placeholder={"Hello\\tXin chào\\nApple\\tQuả táo"}
                  disabled={pending}
                  required 
                />
              </div>
              <div className="form-group">
                <label htmlFor="import-separator">Separator</label>
                <select
                  id="import-separator"
                  value={importSeparator}
                  onChange={e => setImportSeparator(e.target.value)}
                  disabled={pending}
                >
                  <option value={'\t'}>Tab (Excel paste)</option>
                  <option value=",">Comma (,)</option>
                  <option value=";">Semicolon (;)</option>
                  <option value="-">Dash (-)</option>
                  <option value="|">Pipe (|)</option>
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="duplicate-policy">Existing notes (GUID, otherwise first field in this deck)</label>
                <select id="duplicate-policy" value={duplicatePolicy} disabled={pending} onChange={e => setDuplicatePolicy(e.target.value as 'add' | 'skip' | 'update')}>
                  <option value="add">Add new (existing GUIDs are rejected)</option>
                  <option value="skip">Skip duplicates</option>
                  <option value="update">Update content, keep study progress</option>
                </select>
              </div>
              <div className="form-group">
                <label className="import-checkbox-label"><input type="checkbox" checked={hasHeader} disabled={pending} onChange={e => setHasHeader(e.target.checked)} /> First data row is a column header</label>
                <label className="import-checkbox-label"><input type="checkbox" checked={allowHtml} disabled={pending} onChange={e => setAllowHtml(e.target.checked)} /> Allow HTML in fields</label>
                <label className="import-checkbox-label"><input type="checkbox" checked={useFileDecks} disabled={pending} onChange={e => setUseFileDecks(e.target.checked)} /> Use deck names from file (may create decks)</label>
                {!advancedMode && (
                  <label className="import-checkbox-label"><input type="checkbox" checked={swapColumns} disabled={pending} onChange={e => setSwapColumns(e.target.checked)} /> Swap Front and Back columns</label>
                )}
                <label className="import-checkbox-label"><input type="checkbox" checked={advancedMode} disabled={pending} onChange={e => { setAdvancedMode(e.target.checked); setImportModalError(null); }} /> Advanced mapping (note kind, columns, tags)</label>
              </div>

              {advancedMode && (
                <div className="advanced-import-options" style={{ background: 'rgba(255,255,255,0.05)', padding: '1rem', borderRadius: '8px', marginBottom: '1rem' }}>
                  <div className="form-group">
                    <label htmlFor="advanced-kind-select">Note type</label>
                    <select
                      id="advanced-kind-select"
                      aria-label="Note type"
                      value={advancedKind}
                      onChange={e => handleKindChange(e.target.value)}
                      disabled={pending}
                    >
                      {noteTypes.map(nt => (
                        <option key={nt.kind} value={nt.kind}>
                          {nt.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Field column mapping (0-based)</label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginTop: '0.25rem' }}>
                      {currentNoteType.fields.map((field, idx) => (
                        <div key={field}>
                          <label htmlFor={`field-col-${field}`} style={{ fontSize: '0.85rem' }}>{field} column</label>
                          <input
                            id={`field-col-${field}`}
                            aria-label={`Column for ${field}`}
                            type="number"
                            min="0"
                            max="99"
                            value={fieldColumns[field] !== undefined ? fieldColumns[field] : idx}
                            onChange={e => handleFieldColumnChange(field, e.target.value)}
                            disabled={pending}
                            required
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="form-group" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                    <div>
                      <label htmlFor="import-tags-col" style={{ fontSize: '0.85rem' }}>Tags column (optional, 0-based)</label>
                      <input
                        id="import-tags-col"
                        aria-label="Tags column"
                        type="number"
                        min="0"
                        max="99"
                        placeholder="e.g. 2"
                        value={tagsColumn}
                        onChange={e => { setTagsColumn(e.target.value); setImportModalError(null); }}
                        disabled={pending}
                      />
                    </div>
                    <div>
                      <label htmlFor="import-guid-col" style={{ fontSize: '0.85rem' }}>GUID column (optional, 0-based)</label>
                      <input
                        id="import-guid-col"
                        aria-label="GUID column"
                        type="number"
                        min="0"
                        max="99"
                        placeholder="e.g. 3"
                        value={guidColumn}
                        onChange={e => { setGuidColumn(e.target.value); setImportModalError(null); }}
                        disabled={pending}
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label htmlFor="import-global-tags" style={{ fontSize: '0.85rem' }}>Global tags (optional, space-separated)</label>
                    <input
                      id="import-global-tags"
                      aria-label="Global tags"
                      type="text"
                      placeholder="e.g. tag1 tag2"
                      value={globalTags}
                      onChange={e => { setGlobalTags(e.target.value); setImportModalError(null); }}
                      disabled={pending}
                    />
                  </div>
                </div>
              )}

              <details className="import-format-help"><summary>Supported formats and mapping details</summary><p>Basic two-field import and advanced built-in note types (Basic, Reversed, Optional Reversed, Cloze) with custom column mapping, tags, and GUIDs are supported. Existing custom note types are available above. Mixed note types are now supported; templates/media/history still require APKG, custom note types must already exist. Extra unmapped fields are rejected to prevent data loss. Anki file directives override separator/HTML settings.</p></details>
              {previewIsCurrent && <p role="status">{importPreview?.message} No changes made yet. Confirm to apply.</p>}
              </div>
              <div className="modal-actions cards-import-actions">
                <button type="button" className="btn btn-ghost" onClick={closeImportModal} disabled={pending}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={pending || !importText.trim()}>{pending ? 'Processing...' : previewIsCurrent ? 'Confirm Import' : 'Preview Import'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showExportModal && (
        <div className="modal-overlay" onClick={closeExportModal} role="dialog" aria-modal="true" aria-label="Export deck">
          <div className="modal glass-card" ref={exportModalRef} onClick={e => e.stopPropagation()}>
            <h2>Export Deck</h2>
            <div className="form-group">
              <label htmlFor="export-deck-name">Deck</label>
              <input id="export-deck-name" type="text" value={exportDeckName} readOnly style={{ opacity: 0.7 }} />
            </div>
            <div className="form-group">
              <label htmlFor="export-format">File format</label>
              <select id="export-format" value={exportFormat} disabled={exporting} onChange={e => setExportFormat(e.target.value as typeof exportFormat)}>
                <option value="apkg">Anki deck package (.apkg)</option>
                <option value="csv">Notes CSV (.csv)</option>
                <option value="txt">Notes text (.txt, tab-separated)</option>
                <option value="tsv">Notes TSV (.tsv)</option>
              </select>
            </div>
            {exportFormat !== 'apkg' && <p>Text exports contain source fields, tags and GUIDs. Mixed note types are now supported; templates/media/history still require APKG, custom note types must already exist. Raw HTML is preserved; spreadsheet formula escaping is not applied.</p>}
            {exportFormat === 'apkg' && <label><input type="checkbox" checked={modernPackage} onChange={e => setModernPackage(e.target.checked)} disabled={exporting} /> Modern Anki package (preserves FSRS memory when study history is included)</label>}
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input 
                type="checkbox" 
                id="include-scheduling" 
                checked={includeScheduling} 
                onChange={e => setIncludeScheduling(e.target.checked)} 
                style={{ width: 'auto' }}
                disabled={exporting || exportFormat !== 'apkg'}
              />
              <label htmlFor="include-scheduling" style={{ margin: 0 }}>Include scheduling information</label>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={closeExportModal} disabled={exporting}>Cancel</button>
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
