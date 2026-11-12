import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { browseSharedDecks, getCategories } from '../api/shared';
import type { SharedDeck } from '../api/shared';
import { usePrefs } from '../context/usePrefs';

const SharedDecksPage = () => {
  const [decks, setDecks] = useState<SharedDeck[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const { t } = usePrefs();

  useEffect(() => {
    void getCategories().then(r => setCategories(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    let ignore = false;
    browseSharedDecks(search, category)
      .then((res) => {
        if (!ignore) {
          setDecks(res.data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [search, category]);

  const fetchDecks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await browseSharedDecks(search, category);
      setDecks(res.data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [search, category]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void fetchDecks();
  };

  const renderStars = (rating: number) => {
    const stars = [];
    for (let i = 1; i <= 5; i++) stars.push(<span key={i} className={i <= rating ? 'star filled' : 'star'}>★</span>);
    return <span className="stars">{stars}</span>;
  };

  return (
    <div className="page-container">
      <div className="shared-header">
        <h1>{t('shared.title')}</h1>
        <p>{t('shared.subtitle')}</p>
        <form onSubmit={handleSearch} className="search-bar">
          <input type="text" placeholder={t('shared.searchPlaceholder')} value={search} onChange={e => setSearch(e.target.value)} className="search-input search-lg" />
          <button type="submit" className="btn btn-primary">{t('common.search')}</button>
        </form>
      </div>

      <div className="shared-layout">
        <aside className="categories-sidebar glass-card">
          <h3>{t('shared.languages')}</h3>
          <ul>{(categories.languages || []).map((c: string) => (
            <li key={c}><button className={`cat-btn ${category === c ? 'active' : ''}`} onClick={() => setCategory(category === c ? '' : c)}>{c}</button></li>
          ))}</ul>
          <h3>{t('shared.sciences')}</h3>
          <ul>{(categories.sciences || []).map((c: string) => (
            <li key={c}><button className={`cat-btn ${category === c ? 'active' : ''}`} onClick={() => setCategory(category === c ? '' : c)}>{c}</button></li>
          ))}</ul>
          {category && <button className="btn btn-ghost btn-sm" onClick={() => setCategory('')}>{t('shared.clearFilter')}</button>}
        </aside>

        <main className="shared-content">
          {loading ? <div className="loading-screen"><div className="spinner" /></div> : decks.length === 0 ? (
            <div className="empty-state glass-card"><span className="empty-icon">🔍</span><h2>{t('shared.noneFound')}</h2><p>{t('shared.tryDifferent')}</p></div>
          ) : (
            <div className="shared-table">
              <div className="shared-table-header">
                <span className="col-title">{t('common.title')}</span><span className="col-rating">{t('shared.rating')}</span>
                <span className="col-notes">{t('shared.notes')}</span><span className="col-dl">{t('shared.downloads')}</span>
                <span className="col-media">{t('shared.media')}</span>
              </div>
              {decks.map(d => (
                <Link key={d.id} to={`/shared/${d.id}`} className="shared-row glass-card">
                  <span className="col-title"><strong>{d.title}</strong><small>{t('shared.byUser', { user: d.username })}</small></span>
                  <span className="col-rating">{renderStars(d.rating)} <small>({d.rating_count})</small></span>
                  <span className="col-notes">{d.notes_count}</span>
                  <span className="col-dl">{d.download_count}</span>
                  <span className="col-media">{d.has_audio && '🔊'} {d.has_images && '🖼️'}</span>
                </Link>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default SharedDecksPage;
