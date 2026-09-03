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
    // Daily limits
    new_cards_per_day: 20,
    maximum_reviews_per_day: 200,
    new_cards_ignore_review_limit: false,
    limits_start_from_top: false,

    // New cards
    learning_steps: "1m 10m",
    graduating_interval: 1,
    easy_interval: 4,
    insertion_order: "Sequential (oldest cards first)",

    // Lapses
    relearning_steps: "10m",
    minimum_interval: 1,
    leech_threshold: 8,
    leech_action: "Tag Only",

    // Display Order
    new_card_gather_order: "Deck",
    new_card_sort_order: "Card type, then order gathered",
    new_review_order: "Mix with reviews",
    interday_learning_review_order: "Mix with reviews",
    review_sort_order: "Due date, then random",

    // Advanced
    maximum_interval: 36500,
    starting_ease: 2.50,
    easy_bonus: 1.30,
    interval_modifier: 1.00,
    hard_interval: 1.20,
    new_interval: 0.00,

    // Audio
    dont_play_audio_automatically: false,
    skip_question_when_replaying_answer: false,

    // Timers
    maximum_answer_seconds: 60,
    show_on_screen_timer: false,
    stop_on_screen_timer_on_answer: false,

    // Auto Advance
    seconds_to_show_question_for: 0.0,
    seconds_to_show_answer_for: 0.0,
    wait_for_audio: true,
    question_action: "Show Answer",
    answer_action: "Bury Card",

    // Burying
    bury_new_siblings: false,
    bury_review_siblings: false,
    bury_interday_learning_siblings: false,

    // Easy Days
    easy_days: { Mon: 100, Tue: 100, Wed: 100, Thu: 100, Fri: 100, Sat: 100, Sun: 100 } as Record<string, number>,

    // FSRS
    fsrs: false,
    custom_scheduling: false
  });

  useEffect(() => {
    const fetchDeck = async () => {
      try {
        const res = await getDeck(Number(deckId));
        setDeck(res.data);
        if (res.data.settings && res.data.settings !== "{}") {
          try {
            const parsed = JSON.parse(res.data.settings);
            setSettings(prev => ({ ...prev, ...parsed }));
          } catch (e) {
            console.error("Failed to parse settings:", e);
          }
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

  const handleEasyDayChange = (day: string, value: number) => {
    setSettings(prev => ({
      ...prev,
      easy_days: { ...prev.easy_days, [day]: value }
    }));
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

  const ToggleSwitch = ({ field, checked }: { field: string; checked: boolean }) => (
    <div
      className={`toggle-switch ${checked ? 'active' : ''}`}
      onClick={() => handleChange(field, !checked)}
      role="switch"
      aria-checked={checked}
    />
  );

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
              <ToggleSwitch field="new_cards_ignore_review_limit" checked={settings.new_cards_ignore_review_limit} />
            </div>
            <div className="options-row">
              <label>Limits start from top</label>
              <ToggleSwitch field="limits_start_from_top" checked={settings.limits_start_from_top} />
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
                <option>Deck, then random notes</option>
                <option>Ascending position</option>
                <option>Descending position</option>
                <option>Random notes</option>
                <option>Random cards</option>
              </select>
            </div>
            <div className="options-row">
              <label>New card sort order</label>
              <select value={settings.new_card_sort_order} onChange={e => handleChange('new_card_sort_order', e.target.value)}>
                <option>Card type, then order gathered</option>
                <option>Order gathered</option>
                <option>Card type, then random</option>
                <option>Random note, then card type</option>
                <option>Random</option>
              </select>
            </div>
            <div className="options-row">
              <label>New/review order</label>
              <select value={settings.new_review_order} onChange={e => handleChange('new_review_order', e.target.value)}>
                <option>Mix with reviews</option>
                <option>Show before reviews</option>
                <option>Show after reviews</option>
              </select>
            </div>
            <div className="options-row">
              <label>Interday learning/review order</label>
              <select value={settings.interday_learning_review_order} onChange={e => handleChange('interday_learning_review_order', e.target.value)}>
                <option>Mix with reviews</option>
                <option>Show before reviews</option>
                <option>Show after reviews</option>
              </select>
            </div>
            <div className="options-row">
              <label>Review sort order</label>
              <select value={settings.review_sort_order} onChange={e => handleChange('review_sort_order', e.target.value)}>
                <option>Due date, then random</option>
                <option>Due date, then deck</option>
                <option>Deck, then due date</option>
                <option>Ascending intervals</option>
                <option>Descending intervals</option>
                <option>Ascending ease</option>
                <option>Descending ease</option>
                <option>Relative overdueness</option>
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
              <ToggleSwitch field="fsrs" checked={settings.fsrs} />
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
            <div className="options-row">
              <label>Bury new siblings</label>
              <ToggleSwitch field="bury_new_siblings" checked={settings.bury_new_siblings} />
            </div>
            <div className="options-row">
              <label>Bury review siblings</label>
              <ToggleSwitch field="bury_review_siblings" checked={settings.bury_review_siblings} />
            </div>
            <div className="options-row">
              <label>Bury interday learning siblings</label>
              <ToggleSwitch field="bury_interday_learning_siblings" checked={settings.bury_interday_learning_siblings} />
            </div>
          </section>

          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>Audio</h3>
              <span className="help-icon">?</span>
            </div>
            <div className="options-row">
              <label>Don't play audio automatically</label>
              <ToggleSwitch field="dont_play_audio_automatically" checked={settings.dont_play_audio_automatically} />
            </div>
            <div className="options-row">
              <label>Skip question when replaying answer</label>
              <ToggleSwitch field="skip_question_when_replaying_answer" checked={settings.skip_question_when_replaying_answer} />
            </div>
          </section>

          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>Timers</h3>
              <span className="help-icon">?</span>
            </div>
            <div className="options-row">
              <label>Maximum answer seconds</label>
              <input type="number" value={settings.maximum_answer_seconds} onChange={e => handleChange('maximum_answer_seconds', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>Show on-screen timer</label>
              <ToggleSwitch field="show_on_screen_timer" checked={settings.show_on_screen_timer} />
            </div>
            <div className="options-row">
              <label>Stop on-screen timer on answer</label>
              <ToggleSwitch field="stop_on_screen_timer_on_answer" checked={settings.stop_on_screen_timer_on_answer} />
            </div>
          </section>

          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>Auto Advance</h3>
              <span className="help-icon">?</span>
            </div>
            <div className="options-row">
              <label>Seconds to show question for</label>
              <input type="number" step="0.1" value={settings.seconds_to_show_question_for} onChange={e => handleChange('seconds_to_show_question_for', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>Seconds to show answer for</label>
              <input type="number" step="0.1" value={settings.seconds_to_show_answer_for} onChange={e => handleChange('seconds_to_show_answer_for', +e.target.value)} />
            </div>
            <div className="options-row">
              <label>Wait for audio</label>
              <ToggleSwitch field="wait_for_audio" checked={settings.wait_for_audio} />
            </div>
            <div className="options-row">
              <label>Question action</label>
              <select value={settings.question_action} onChange={e => handleChange('question_action', e.target.value)}>
                <option>Show Answer</option>
                <option>Show Reminder</option>
                <option>Answer Again</option>
                <option>Answer Hard</option>
                <option>Answer Good</option>
                <option>Answer Easy</option>
              </select>
            </div>
            <div className="options-row">
              <label>Answer action</label>
              <select value={settings.answer_action} onChange={e => handleChange('answer_action', e.target.value)}>
                <option>Bury Card</option>
                <option>Answer Again</option>
                <option>Answer Hard</option>
                <option>Answer Good</option>
                <option>Answer Easy</option>
              </select>
            </div>
          </section>

          <section className="options-card glass-card">
            <div className="options-card-header">
              <h3>Easy Days</h3>
            </div>
            <div className="easy-days-header">
              <span></span>
              <span className="easy-days-label-min">Maximum</span>
              <span className="easy-days-label-mid">Reduced</span>
              <span className="easy-days-label-max">Normal</span>
            </div>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => (
              <div className="slider-row" key={day}>
                <span className="day-label">{day}</span>
                <input
                  type="range"
                  className="glass-slider"
                  min="0"
                  max="100"
                  value={settings.easy_days?.[day] ?? 100}
                  onChange={e => handleEasyDayChange(day, +e.target.value)}
                />
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
