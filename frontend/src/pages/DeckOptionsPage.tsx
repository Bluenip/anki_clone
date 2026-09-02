import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getDeck, updateDeck } from '../api/decks';
import '../DeckOptions.css'; // We'll create this to keep styles clean

const DeckOptionsPage = () => {
  const { deckId } = useParams<{ deckId: string }>();
  const navigate = useNavigate();
  const [deck, setDeck] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  
  const [settings, setSettings] = useState({
    new_cards_per_day: 20,
    maximum_reviews_per_day: 200,
    learning_steps: "1m 10m",
    graduating_interval: 1,
    easy_interval: 4,
    insertion_order: "Sequential (oldest cards first)",
    relearning_steps: "10m",
    minimum_interval: 1,
    leech_threshold: 8,
    leech_action: "Tag Only",
    new_card_gather_order: "Deck",
    new_card_sort_order: "Card type, then order gathered",
    new_review_order: "Mix with reviews",
    interday_learning_review_order: "Mix with reviews",
    review_sort_order: "Due date, then random",
    maximum_interval: 36500,
    starting_ease: 2.50,
    easy_bonus: 1.30,
    interval_modifier: 1.00,
    hard_interval: 1.20,
    new_interval: 0.00,
    wait_for_audio: true,
    question_action: "Show Answer",
    answer_action: "Bury Card",
    fsrs: false,
    custom_scheduling: false
  });

  useEffect(() => {
    const fetchDeck = async () => {
      try {
        const res = await getDeck(Number(deckId));
        setDeck(res.data);
        if (res.data.settings && res.data.settings !== "{}") {
          setSettings({ ...settings, ...JSON.parse(res.data.settings) });
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchDeck();
  }, [deckId]);

  const handleChange = (field: string, value: any) => {
    setSettings(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    try {
      await updateDeck(Number(deckId), { settings: JSON.stringify(settings) });
      alert('Settings saved successfully!');
      navigate('/decks');
    } catch (err) {
      alert('Failed to save settings.');
    }
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!deck) return <div className="page-container">Deck not found</div>;

  return (
    <div className="options-container">
      <div className="options-header">
        <div className="options-breadcrumb">
          <Link to="/decks" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>Decks</Link> 
          <span style={{ color: 'var(--text-muted)', margin: '0 0.5rem' }}>/</span> 
          <span>Options for {deck.name}</span>
        </div>
        <div className="options-header-actions">
          <select className="options-select-sm" defaultValue="default">
            <option value="default">Default (used by 1 deck)</option>
            <option value="add">Add Preset...</option>
          </select>
          <button className="btn btn-primary btn-sm" onClick={handleSave}>Save</button>
        </div>
      </div>

      <div className="options-grid">
        {/* Left Column */}
        <div className="options-col">
          
          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>Daily Limits</h3>
              <span className="help-icon">?</span>
            </div>
            <div className="options-row">
              <label>New cards/day</label>
              <input type="number" value={settings.new_cards_per_day} onChange={e => handleChange('new_cards_per_day', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>Maximum reviews/day</label>
              <input type="number" value={settings.maximum_reviews_per_day} onChange={e => handleChange('maximum_reviews_per_day', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>New cards ignore review limit</label>
              <div className="toggle-switch"></div>
            </div>
            <div className="options-row">
              <label>Limits start from top</label>
              <div className="toggle-switch"></div>
            </div>
          </section>

          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>New Cards</h3>
              <span className="help-icon">?</span>
            </div>
            <div className="options-row">
              <label>Learning steps</label>
              <input type="text" value={settings.learning_steps} onChange={e => handleChange('learning_steps', e.target.value)} />
            </div>
            <div className="options-row">
              <label>Graduating interval</label>
              <input type="number" value={settings.graduating_interval} onChange={e => handleChange('graduating_interval', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>Easy interval</label>
              <input type="number" value={settings.easy_interval} onChange={e => handleChange('easy_interval', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>Insertion order</label>
              <select value={settings.insertion_order} onChange={e => handleChange('insertion_order', e.target.value)}>
                <option>Sequential (oldest cards first)</option>
                <option>Random</option>
              </select>
            </div>
          </section>

          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>Lapses</h3>
              <span className="help-icon">?</span>
            </div>
            <div className="options-row">
              <label>Relearning steps</label>
              <input type="text" value={settings.relearning_steps} onChange={e => handleChange('relearning_steps', e.target.value)} />
            </div>
            <div className="options-row">
              <label>Minimum interval</label>
              <input type="number" value={settings.minimum_interval} onChange={e => handleChange('minimum_interval', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>Leech threshold</label>
              <input type="number" value={settings.leech_threshold} onChange={e => handleChange('leech_threshold', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>Leech action</label>
              <select value={settings.leech_action} onChange={e => handleChange('leech_action', e.target.value)}>
                <option>Tag Only</option>
                <option>Suspend Card</option>
              </select>
            </div>
          </section>

          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>Display Order</h3>
              <span className="help-icon">?</span>
            </div>
            <div className="options-row">
              <label>New card gather order</label>
              <select value={settings.new_card_gather_order} onChange={e => handleChange('new_card_gather_order', e.target.value)}>
                <option>Deck</option>
              </select>
            </div>
            <div className="options-row">
              <label>New card sort order</label>
              <select value={settings.new_card_sort_order} onChange={e => handleChange('new_card_sort_order', e.target.value)}>
                <option>Card type, then order gathered</option>
              </select>
            </div>
            <div className="options-row">
              <label>New/review order</label>
              <select value={settings.new_review_order} onChange={e => handleChange('new_review_order', e.target.value)}>
                <option>Mix with reviews</option>
              </select>
            </div>
            <div className="options-row">
              <label>Interday learning/review order</label>
              <select value={settings.interday_learning_review_order} onChange={e => handleChange('interday_learning_review_order', e.target.value)}>
                <option>Mix with reviews</option>
              </select>
            </div>
            <div className="options-row">
              <label>Review sort order</label>
              <select value={settings.review_sort_order} onChange={e => handleChange('review_sort_order', e.target.value)}>
                <option>Due date, then random</option>
              </select>
            </div>
          </section>

          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>FSRS</h3>
              <span className="help-icon">?</span>
            </div>
            <div className="options-row">
              <label>FSRS</label>
              <div className={`toggle-switch ${settings.fsrs ? 'active' : ''}`} onClick={() => handleChange('fsrs', !settings.fsrs)}></div>
            </div>
          </section>

        </div>

        {/* Right Column */}
        <div className="options-col">
          
          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>Burying</h3>
              <span className="help-icon">?</span>
            </div>
            <div className="options-row"><label>Bury new siblings</label><div className="toggle-switch"></div></div>
            <div className="options-row"><label>Bury review siblings</label><div className="toggle-switch"></div></div>
            <div className="options-row"><label>Bury interday learning siblings</label><div className="toggle-switch"></div></div>
          </section>

          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>Audio</h3>
              <span className="help-icon">?</span>
            </div>
            <div className="options-row"><label>Don't play audio automatically</label><div className="toggle-switch"></div></div>
            <div className="options-row"><label>Skip question when replaying answer</label><div className="toggle-switch"></div></div>
          </section>

          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>Timers</h3>
              <span className="help-icon">?</span>
            </div>
            <div className="options-row">
              <label>Maximum answer seconds</label>
              <input type="number" defaultValue="60" />
            </div>
            <div className="options-row"><label>Show on-screen timer</label><div className="toggle-switch"></div></div>
            <div className="options-row"><label>Stop on-screen timer on answer</label><div className="toggle-switch"></div></div>
          </section>

          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>Auto Advance</h3>
              <span className="help-icon">?</span>
            </div>
            <div className="options-row">
              <label>Seconds to show question for</label>
              <input type="number" defaultValue="0.0" step="0.1" />
            </div>
            <div className="options-row">
              <label>Seconds to show answer for</label>
              <input type="number" defaultValue="0.0" step="0.1" />
            </div>
            <div className="options-row">
              <label>Wait for audio</label>
              <div className={`toggle-switch ${settings.wait_for_audio ? 'active' : ''}`} onClick={() => handleChange('wait_for_audio', !settings.wait_for_audio)}></div>
            </div>
            <div className="options-row">
              <label>Question action</label>
              <select value={settings.question_action} onChange={e => handleChange('question_action', e.target.value)}>
                <option>Show Answer</option>
              </select>
            </div>
            <div className="options-row">
              <label>Answer action</label>
              <select value={settings.answer_action} onChange={e => handleChange('answer_action', e.target.value)}>
                <option>Bury Card</option>
              </select>
            </div>
          </section>

          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>Easy Days</h3>
            </div>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => (
              <div className="slider-row" key={day}>
                <span className="day-label">{day}</span>
                <input type="range" className="glass-slider" min="0" max="100" defaultValue="100" />
              </div>
            ))}
          </section>

          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>Advanced</h3>
              <span className="help-icon">?</span>
            </div>
            <div className="options-row">
              <label>Maximum interval</label>
              <input type="number" value={settings.maximum_interval} onChange={e => handleChange('maximum_interval', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>Starting ease</label>
              <input type="number" step="0.01" value={settings.starting_ease} onChange={e => handleChange('starting_ease', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>Easy bonus</label>
              <input type="number" step="0.01" value={settings.easy_bonus} onChange={e => handleChange('easy_bonus', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>Interval modifier</label>
              <input type="number" step="0.01" value={settings.interval_modifier} onChange={e => handleChange('interval_modifier', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>Hard interval</label>
              <input type="number" step="0.01" value={settings.hard_interval} onChange={e => handleChange('hard_interval', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>New interval</label>
              <input type="number" step="0.01" value={settings.new_interval} onChange={e => handleChange('new_interval', +e.target.value)} />
            </div>
            <div className="options-row" style={{ marginTop: '1rem', cursor: 'pointer' }} onClick={() => handleChange('custom_scheduling', !settings.custom_scheduling)}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ transform: settings.custom_scheduling ? 'rotate(90deg)' : 'none', transition: '0.2s' }}>▶</span> 
                Custom scheduling
              </label>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
};

export default DeckOptionsPage;
