import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { browseSharedDecks, getCategories } from '../api/shared';

const SharedDecksPage = () => {
  const [decks, setDecks] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState<any>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => { getCategories().then(r => setCategories(r.data)).catch(() => {}); }, []);

  const fetchDecks = async () => {
    setLoading(true);
    try { const res = await browseSharedDecks(search, category); setDecks(res.data); }
    catch { /* */ } finally { setLoading(false); }
  };

  useEffect(() => { fetchDecks(); }, [category]);

  const handleSearch = (e: React.FormEvent) => { e.preventDefault(); fetchDecks(); };

  const renderStars = (rating: number) => {
    const stars = [];
    for (let i = 1; i <= 5; i++) stars.push(<span key={i} className={i <= rating ? 'star filled' : 'star'}>★</span>);
    return <span className="stars">{stars}</span>;
  };

  return (
    <div className="page-container">
      <div className="shared-header">
        <h1>Shared Decks</h1>
        <p>Browse community-created flashcard decks</p>
        <form onSubmit={handleSearch} className="search-bar">
          <input type="text" placeholder="Search decks..." value={search} onChange={e => setSearch(e.target.value)} className="search-input search-lg" />
          <button type="submit" className="btn btn-primary">Search</button>
        </form>
      </div>

      <div className="shared-layout">
        <aside className="categories-sidebar glass-card">
          <h3>Languages</h3>
          <ul>{(categories.languages || []).map((c: string) => (
            <li key={c}><button className={`cat-btn ${category === c ? 'active' : ''}`} onClick={() => setCategory(category === c ? '' : c)}>{c}</button></li>
          ))}</ul>
          <h3>Sciences & Trivia</h3>
          <ul>{(categories.sciences || []).map((c: string) => (
            <li key={c}><button className={`cat-btn ${category === c ? 'active' : ''}`} onClick={() => setCategory(category === c ? '' : c)}>{c}</button></li>
          ))}</ul>
          {category && <button className="btn btn-ghost btn-sm" onClick={() => setCategory('')}>Clear filter</button>}
        </aside>

        <main className="shared-content">
          {loading ? <div className="loading-screen"><div className="spinner" /></div> : decks.length === 0 ? (
            <div className="empty-state glass-card"><span className="empty-icon">🔍</span><h2>No decks found</h2><p>Try a different search or category</p></div>
          ) : (
            <div className="shared-table">
              <div className="shared-table-header">
                <span className="col-title">Title</span><span className="col-rating">Rating</span>
                <span className="col-notes">Notes</span><span className="col-dl">Downloads</span>
                <span className="col-media">Media</span>
              </div>
              {decks.map(d => (
                <Link key={d.id} to={`/shared/${d.id}`} className="shared-row glass-card">
                  <span className="col-title"><strong>{d.title}</strong><small>by {d.username}</small></span>
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
