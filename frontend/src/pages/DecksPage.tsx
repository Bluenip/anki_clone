import PackageImportPanel from '../components/PackageImportPanel';
import './DecksPage.css';
import { visibleDeckRows } from '../utils/deckTree';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listDecks, getTodaySummary, createDeck, deleteDeck, updateDeck, importCards, startPackageImport, discardPackageUpload, listPendingPackageImports, exportApkg, exportText, exportCollection, getImportNoteTypes } from '../api/decks';
import type { Deck as DeckData, TextImportOptions } from '../api/decks';
import { getNoteTypes } from '../api/notes';
import type { NoteType } from '../api/notes';
import { usePrefs } from '../context/usePrefs';
import { tNow } from '../context/prefs-context-base';

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
  const { t } = usePrefs();
  // shortcut: upload progress text comes from api/packageUpload.ts in English only; translate there if it matters.
  const [uploadStatus, setUploadStatus] = useState('');
  const [decks, setDecks] = useState<DeckData[]>([]);
  const [collapsedDecks, setCollapsedDecks] = useState<Set<string>>(new Set());
  const deckRows = useMemo(() => visibleDeckRows(decks, collapsedDecks), [decks, collapsedDecks]);
  const toggleDeck = (name: string) => {
    setActiveDropdown(null);
    setCollapsedDecks(previous => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
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
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const closePackageJob = () => {
    setPackageJobId(null); setImportingApkg(false);
    sessionStorage.removeItem('anki-package-import');
  };

  useEffect(() => {
    let disposed = false;
    // Recover accepted previews after a lost response, reload, or a new tab.
    Promise.resolve(listPendingPackageImports()).then(response => {
      if (disposed || !response?.data?.length) return;
      const saved = sessionStorage.getItem('anki-package-import');
      const active = response.data.find(job => job.id === saved) || response.data[0];
      setPackageJobId(active.id);
      sessionStorage.setItem('anki-package-import', active.id);
      setImportingApkg(true);
    }).catch(() => { /* Normal page actions remain available if discovery fails. */ });
    return () => { disposed = true; };
  }, []);

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
      if (err?.code !== 'ERR_CANCELED' && err?.name !== 'AbortError') setOperationError(err?.response?.data?.detail || err?.message || t('decks.uploadFailed'));
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
      setOperationError(t('decks.useBackups'));
      e.target.value = '';
      return;
    }
    if (collectionRestore && !window.confirm(t('decks.confirmRestore'))) {
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
      reader.onerror = () => setOperationError(t('decks.readFailed'));
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
      setLoadError(tNow('decks.loadFailed'));
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
      setCreateModalError(err?.response?.data?.detail || t('decks.createFailed'));
    } finally {
      setPending(false);
    }
  };

  const handleDelete = async (id: number) => {
    const target=decks.find(deck=>deck.id===id);
    if (confirm(t('decks.confirmDelete', { name: target?.name || t('decks.thisDeck'), count: target?.total_cards ?? 0 }))) {
      setPending(true);
      setOperationError(null);
      try {
        await deleteDeck(id);
        fetchDecks();
      } catch {
        setOperationError(t('decks.deleteFailed'));
      } finally {
        setPending(false);
      }
    }
  };

  const handleRename = async (id: number, oldName: string) => {
    const newName = prompt(t('decks.enterNewName'), oldName);
    if (newName && newName !== oldName) {
      setPending(true);
      setOperationError(null);
      try {
        await updateDeck(id, { name: newName });
        fetchDecks();
      } catch {
        setOperationError(t('decks.renameFailed'));
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
      setOperationError(await exportFailure(error, t('decks.exportFailed')));
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
      setOperationError(await exportFailure(error, t('decks.exportCollectionFailed')));
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
      setImportModalError(err?.response?.data?.detail || t('decks.importFailed'));
    } finally {
      setPending(false);
    }
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div className="page-container decks-page">
      <header className="decks-heading">
        <div><p className="decks-eyebrow">{t('decks.eyebrow')}</p><h1>{t('nav.decks')}</h1><p>{t('decks.subtitle')}</p></div>
        <div className="decks-primary-actions">
          <button className="btn btn-ghost" onClick={e => { openerRef.current = e.currentTarget; setShowFileImport(true); }} disabled={importingApkg || pending}>{importingApkg ? t('decks.importing') : t('decks.importFile')}</button>
          <button className="btn btn-primary" onClick={openCreateModal} disabled={pending}>{t('decks.createDeck')}</button>
        </div>
      </header>
      
      {operationError && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{operationError}</span>
          <button onClick={() => setOperationError(null)} className="btn btn-ghost btn-sm" aria-label={t('study.dismissError')}>✕</button>
        </div>
      )}

      {loadError && decks.length > 0 && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{loadError}</span>
          <button onClick={() => setLoadError(null)} className="btn btn-ghost btn-sm" aria-label={t('study.dismissError')}>✕</button>
        </div>
      )}

      {uploadProgress !== null && <section className="glass-card package-import-progress" aria-label={t('decks.packageUpload')}>
        <p role="status">{uploadStatus || t('decks.uploading')} {uploadProgress}%</p>
        <progress max={100} value={uploadProgress} aria-label={t('decks.uploadProgress')} />
        <button className="btn btn-ghost" onClick={() => uploadController.current?.abort()}>{t('decks.cancelUpload')}</button>
      </section>}
      {uploadFile && uploadProgress === null && !importingApkg && <section className="glass-card package-import-progress" aria-label={t('decks.pausedUpload')}>
        <p>{uploadFile.name} — {t('decks.partsSaved')}</p>
        <button className="btn btn-primary" onClick={() => void uploadPackage(uploadFile, uploadFile.name.toLowerCase().endsWith('.colpkg'))}>{t('decks.resumeUpload')}</button>
        <button className="btn btn-ghost" onClick={() => { setUploadFile(null); setOperationError(null); void discardPackageUpload(); }}>{t('decks.cancelUpload')}</button>
      </section>}
      {packageJobId && <PackageImportPanel key={packageJobId} id={packageJobId} onBusy={setImportingApkg} onComplete={fetchDecks} onClose={closePackageJob} />}

      <div className="desktop-deck-table">
        <div className="deck-list-header">
          <div className="col-name">{t('add.deck')}</div>
          <span>{t('stat.new')}</span>
          <span>{t('decks.learn')}</span>
          <span>{t('stat.due')}</span>
          <span></span>
        </div>
        
        {loadError && decks.length === 0 ? (
          <div role="alert" style={{ padding: '2rem', textAlign: 'center' }}>
            <p style={{ color: '#ef4444', marginBottom: '1rem' }}>{loadError}</p>
            <button className="btn btn-primary" onClick={fetchDecks}>{t('common.retry')}</button>
          </div>
        ) : decks.length === 0 ? (
          <div className="decks-empty">
            <div className="decks-empty-icon" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><rect x="8" y="12" width="29" height="29" rx="5" stroke="currentColor" strokeWidth="2"/><path d="M16 7h21a5 5 0 0 1 5 5v20M17 23h11M17 30h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg></div>
            <h2>{t('decks.emptyTitle')}</h2>
            <p>{t('decks.emptyText')}</p>
            <span>{t('decks.emptySupports')}</span>
          </div>
        ) : (
          deckRows.map(({ name, label, depth, deck, children }) => (
            <div key={name} className="deck-row" style={{ position: 'relative', zIndex: deck && activeDropdown === deck.id ? 20 : 1 }}>
              <div className="col-name deck-tree-name" style={{ paddingInlineStart: `${depth * 24}px` }}>
                {children.size > 0 ? (
                  <button type="button" className="deck-tree-toggle"
                    aria-label={`${collapsedDecks.has(name) ? t('decks.expand') : t('decks.collapse')} ${name}`}
                    aria-expanded={!collapsedDecks.has(name)} onClick={() => toggleDeck(name)}>
                    <span aria-hidden="true">{collapsedDecks.has(name) ? '+' : '−'}</span>
                  </button>
                ) : <span className="deck-tree-spacer" aria-hidden="true" />}
                {deck ? <Link className="deck-tree-label" to={`/decks/${deck.id}`} title={name}>{label}</Link>
                  : <button type="button" className="deck-tree-label deck-tree-group" title={name}
                      aria-label={t('decks.toggleGroup', { name })} onClick={() => toggleDeck(name)}>{label}</button>}
              </div>
              <div className="col-stat stat-new">{deck ? deck.new_cards || 0 : '—'}</div>
              <div className="col-stat stat-learn">{deck ? deck.learn_cards || 0 : '—'}</div>
              <div className="col-stat stat-due">{deck ? deck.due_cards || 0 : '—'}</div>

              <div className="col-actions">
                {deck && <>
                <button 
                  className="gear-btn" 
                  onClick={(e) => { e.stopPropagation(); setActiveDropdown(activeDropdown === deck.id ? null : deck.id); }}
                  aria-label={t('decks.optionsFor', { name: deck.name })}
                  aria-expanded={activeDropdown === deck.id}
                  aria-haspopup="menu"
                >
                  ⚙️
                </button>
                {activeDropdown === deck.id && (
                  <div className="gear-dropdown" role="menu" onClick={(e) => e.stopPropagation()}>
                    <button className="gear-dropdown-item" role="menuitem" disabled={pending} onClick={() => { setActiveDropdown(null); handleRename(deck.id, deck.name); }}>{t('decks.rename')}</button>
                    <button className="gear-dropdown-item" role="menuitem" onClick={() => { setActiveDropdown(null); navigate(`/decks/${deck.id}/options`); }}>{t('decks.options')}</button>
                    <button className="gear-dropdown-item" role="menuitem" onClick={(e) => { setActiveDropdown(null); openExportModal(deck.id, deck.name, e); }}>{t('decks.export')}</button>
                    <button className="gear-dropdown-item" role="menuitem" onClick={(e) => { setActiveDropdown(null); openImportModal(deck.id, e); }}>{t('decks.importCards')}</button>
                    <button className="gear-dropdown-item" role="menuitem" disabled={pending} style={{ color: '#ef4444' }} onClick={() => { setActiveDropdown(null); handleDelete(deck.id); }}>{t('common.delete')}</button>
                  </div>
                )}
                </>}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="studied-today">
        {todaySummary ? t('decks.studiedToday', { reviews: todaySummary.reviews, seconds: todaySummary.seconds, per: todaySummary.seconds_per_card }) : t('decks.activityUnavailable')}
      </div>

      <section className="collection-tools" aria-label={t('decks.tools')}>
        <div className="collection-tools-copy"><h2>{t('decks.tools')}</h2><p>{t('decks.toolsText')}</p></div>
        <div className="collection-tools-actions">
          <a className="btn btn-ghost" href="https://ankiweb.net/shared/decks" target="_blank" rel="noopener noreferrer">{t('decks.getShared')} <span aria-hidden="true">↗</span></a>
          <button className="btn btn-ghost" onClick={handleCollectionExport} disabled={exporting || importingApkg}>{exporting ? t('decks.exporting') : t('decks.exportCollection')}</button>
          <Link className="btn btn-ghost" to="/backups">{t('backups.title')}</Link>
        </div>
      </section>
      <input type="file" accept=".txt,.csv,.tsv,.apkg,.colpkg" hidden ref={fileInputRef} onChange={handleFileUpload} aria-label={t('decks.uploadForImport')} />
      {showFileImport && <div className="modal-overlay" onClick={closeFileImport} role="dialog" aria-modal="true" aria-label={t('decks.importFileAria')}>
        <div className="modal glass-card file-import-modal" ref={fileImportModalRef} onClick={e => e.stopPropagation()}>
          <h2>{t('decks.importYourCards')}</h2>
          <p className="import-intro">{t('decks.importIntro')}</p>
        <div className="form-group"><label htmlFor="package-media">{t('decks.mediaCollisions')}</label><select id="package-media" value={mediaConflicts} disabled={importingApkg} onChange={e => setMediaConflicts(e.target.value as 'error' | 'rename')}><option value="error">{t('decks.mediaStop')}</option><option value="rename">{t('decks.mediaRename')}</option></select></div>
        <div className="form-group"><label htmlFor="package-duplicates">{t('decks.existingPackageNotes')}</label><select id="package-duplicates" value={packageDuplicates} disabled={importingApkg} onChange={e => setPackageDuplicates(e.target.value as typeof packageDuplicates)}><option value="newer">{t('decks.pkgNewer')}</option><option value="skip">{t('decks.pkgSkip')}</option><option value="update">{t('decks.pkgUpdate')}</option><option value="add">{t('decks.pkgAdd')}</option></select></div>
        <label className="package-history"><input type="checkbox" checked={importScheduling} disabled={importingApkg} onChange={e => setImportScheduling(e.target.checked)} /> {t('decks.importHistory')}</label>

          <p className="import-hint">{t('decks.replaceHint')} <Link to="/backups">{t('backups.title')}</Link>.</p>
          <div className="modal-actions"><button className="btn btn-ghost" onClick={closeFileImport}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={importingApkg || pending} onClick={() => fileInputRef.current?.click()}>{t('decks.chooseFile')}</button></div>
        </div>
      </div>}

      {showCreateModal && (
        <div className="modal-overlay" onClick={closeCreateModal} role="dialog" aria-modal="true" aria-label={t('decks.createNewDeckAria')}>
          <div className="modal glass-card" ref={createModalRef} onClick={e => e.stopPropagation()}>
            <h2>{t('decks.createNewDeck')}</h2>
            {createModalError && (
              <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
                {createModalError}
              </div>
            )}
            <form onSubmit={handleCreateDeck}>
              <div className="form-group">
                <label htmlFor="new-deck-name">{t('decks.deckName')}</label>
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
                <button type="button" className="btn btn-ghost" onClick={closeCreateModal} disabled={pending}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" disabled={pending || !newDeckName.trim()}>{pending ? t('auth.creating') : t('decks.create')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showImportModal && (
        <div className="modal-overlay cards-import-overlay" onClick={closeImportModal} role="dialog" aria-modal="true" aria-label={t('decks.importCardsAria')}>
          <div className="modal glass-card cards-import-modal" ref={importModalRef} onClick={e => e.stopPropagation()}>
            <h2>{t('decks.importCards')}</h2>
            {importModalError && (
              <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
                {importModalError}
              </div>
            )}
            <form onSubmit={handleImport}>
              <div className="cards-import-body">
              <div className="form-group">
                <label htmlFor="import-deck-select">{t('decks.targetDeck')}</label>
                <select 
                  id="import-deck-select"
                  value={importDeckId || ''} 
                  onChange={e => { setImportDeckId(Number(e.target.value)); setImportModalError(null); }}
                  disabled={pending}
                  required
                >
                  <option value="" disabled>{t('add.selectDeck')}</option>
                  {decks.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="import-text">{t('decks.basicNotes')}</label>
                <label>{t('decks.dupScope')}<select value={matchScope} disabled={pending} onChange={e => setMatchScope(e.target.value as typeof matchScope)}><option value="deck">{t('decks.scopeDeck')}</option><option value="collection">{t('decks.scopeCollection')}</option></select></label>
                  <label>{t('decks.dupMatch')}<select value={matchFields} disabled={pending} onChange={e => setMatchFields(e.target.value as typeof matchFields)}><option value="first">{t('decks.firstField')}</option><option value="all">{t('decks.allFields')}</option></select></label>
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
                <label htmlFor="import-separator">{t('decks.separator')}</label>
                <select
                  id="import-separator"
                  value={importSeparator}
                  onChange={e => setImportSeparator(e.target.value)}
                  disabled={pending}
                >
                  <option value={'\t'}>{t('decks.sepTab')}</option>
                  <option value=",">{t('decks.sepComma')}</option>
                  <option value=";">{t('decks.sepSemicolon')}</option>
                  <option value="-">{t('decks.sepDash')}</option>
                  <option value="|">{t('decks.sepPipe')}</option>
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="duplicate-policy">{t('decks.existingNotes')}</label>
                <select id="duplicate-policy" value={duplicatePolicy} disabled={pending} onChange={e => setDuplicatePolicy(e.target.value as 'add' | 'skip' | 'update')}>
                  <option value="add">{t('decks.dupAdd')}</option>
                  <option value="skip">{t('decks.dupSkip')}</option>
                  <option value="update">{t('decks.dupUpdate')}</option>
                </select>
              </div>
              <div className="form-group">
                <label className="import-checkbox-label"><input type="checkbox" checked={hasHeader} disabled={pending} onChange={e => setHasHeader(e.target.checked)} /> {t('decks.hasHeader')}</label>
                <label className="import-checkbox-label"><input type="checkbox" checked={allowHtml} disabled={pending} onChange={e => setAllowHtml(e.target.checked)} /> {t('decks.allowHtml')}</label>
                <label className="import-checkbox-label"><input type="checkbox" checked={useFileDecks} disabled={pending} onChange={e => setUseFileDecks(e.target.checked)} /> {t('decks.fileDecks')}</label>
                {!advancedMode && (
                  <label className="import-checkbox-label"><input type="checkbox" checked={swapColumns} disabled={pending} onChange={e => setSwapColumns(e.target.checked)} /> {t('decks.swap')}</label>
                )}
                <label className="import-checkbox-label"><input type="checkbox" checked={advancedMode} disabled={pending} onChange={e => { setAdvancedMode(e.target.checked); setImportModalError(null); }} /> {t('decks.advanced')}</label>
              </div>

              {advancedMode && (
                <div className="advanced-import-options" style={{ background: 'rgba(var(--fg-rgb),0.05)', padding: '1rem', borderRadius: '8px', marginBottom: '1rem' }}>
                  <div className="form-group">
                    <label htmlFor="advanced-kind-select">{t('nt.noteType')}</label>
                    <select
                      id="advanced-kind-select"
                      aria-label={t('nt.noteType')}
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
                    <label>{t('decks.fieldMapping')}</label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginTop: '0.25rem' }}>
                      {currentNoteType.fields.map((field, idx) => (
                        <div key={field}>
                          <label htmlFor={`field-col-${field}`} style={{ fontSize: '0.85rem' }}>{field} column</label>
                          <input
                            id={`field-col-${field}`}
                            aria-label={t('decks.columnFor', { field })}
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
                      <label htmlFor="import-tags-col" style={{ fontSize: '0.85rem' }}>{t('decks.tagsColumn')}</label>
                      <input
                        id="import-tags-col"
                        aria-label={t('decks.tagsColumnAria')}
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
                      <label htmlFor="import-guid-col" style={{ fontSize: '0.85rem' }}>{t('decks.guidColumn')}</label>
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
                    <label htmlFor="import-global-tags" style={{ fontSize: '0.85rem' }}>{t('decks.globalTags')}</label>
                    <input
                      id="import-global-tags"
                      aria-label={t('decks.globalTagsAria')}
                      type="text"
                      placeholder="e.g. tag1 tag2"
                      value={globalTags}
                      onChange={e => { setGlobalTags(e.target.value); setImportModalError(null); }}
                      disabled={pending}
                    />
                  </div>
                </div>
              )}

              <details className="import-format-help"><summary>{t('decks.formatsSummary')}</summary><p>{t('decks.formatsText')}</p></details>
              {previewIsCurrent && <p role="status">{importPreview?.message} No changes made yet. Confirm to apply.</p>}
              </div>
              <div className="modal-actions cards-import-actions">
                <button type="button" className="btn btn-ghost" onClick={closeImportModal} disabled={pending}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" disabled={pending || !importText.trim()}>{pending ? t('auth.processing') : previewIsCurrent ? t('decks.confirmImport') : t('decks.previewImport')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showExportModal && (
        <div className="modal-overlay" onClick={closeExportModal} role="dialog" aria-modal="true" aria-label={t('decks.exportDeck')}>
          <div className="modal glass-card" ref={exportModalRef} onClick={e => e.stopPropagation()}>
            <h2>{t('decks.exportDeck')}</h2>
            <div className="form-group">
              <label htmlFor="export-deck-name">{t('add.deck')}</label>
              <input id="export-deck-name" type="text" value={exportDeckName} readOnly style={{ opacity: 0.7 }} />
            </div>
            <div className="form-group">
              <label htmlFor="export-format">{t('decks.fileFormat')}</label>
              <select id="export-format" value={exportFormat} disabled={exporting} onChange={e => setExportFormat(e.target.value as typeof exportFormat)}>
                <option value="apkg">{t('decks.fmtApkg')}</option>
                <option value="csv">{t('decks.fmtCsv')}</option>
                <option value="txt">{t('decks.fmtTxt')}</option>
                <option value="tsv">{t('decks.fmtTsv')}</option>
              </select>
            </div>
            {exportFormat !== 'apkg' && <p>{t('decks.textExportHint')}</p>}
            {exportFormat === 'apkg' && <label><input type="checkbox" checked={modernPackage} onChange={e => setModernPackage(e.target.checked)} disabled={exporting} /> {t('decks.modernPackage')}</label>}
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input 
                type="checkbox" 
                id="include-scheduling" 
                checked={includeScheduling} 
                onChange={e => setIncludeScheduling(e.target.checked)} 
                style={{ width: 'auto' }}
                disabled={exporting || exportFormat !== 'apkg'}
              />
              <label htmlFor="include-scheduling" style={{ margin: 0 }}>{t('decks.includeScheduling')}</label>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={closeExportModal} disabled={exporting}>{t('common.cancel')}</button>
              <button 
                type="button" 
                className="btn btn-primary" 
                onClick={handleExport} 
                disabled={exporting}
              >
                {exporting ? t('decks.exporting') : t('decks.export')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DecksPage;
