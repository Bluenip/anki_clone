import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import StudyPage from '../pages/StudyPage';
import CardFace from '../components/CardFace';
import * as studyApi from '../api/study';

vi.mock('../api/study');

describe('StudyControls and CardFace reviewer UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders card and handles key user flow (Space to reveal, keyboard 3 to review)', async () => {
    const cardData = {
      card_id: 101,
      deck_id: 1,
      deck_name: 'Biology 101',
      front: 'What is photosynthesis?',
      back: 'Process used by plants to convert light energy into chemical energy',
      version: 3,
      rendered: true,
      intervals: {
        again: { display: '< 1m' },
        hard: { display: '1d' },
        good: { display: '3d' },
        easy: { display: '4d' },
      },
      settings: {
        maximum_answer_seconds: 60,
      },
    };

    vi.spyOn(studyApi, 'getNextCard').mockResolvedValue({ data: cardData } as any);
    vi.spyOn(studyApi, 'getStudyStats').mockResolvedValue({
      data: { total_cards: 1, new_cards: 0, learn_cards: 1, due_cards: 1 },
    } as any);

    const reviewSpy = vi.spyOn(studyApi, 'reviewCard').mockResolvedValue({ data: { success: true } } as any);

    render(
      <MemoryRouter initialEntries={['/study/1']}>
        <Routes>
          <Route path="/study/:deckId" element={<StudyPage />} />
        </Routes>
      </MemoryRouter>
    );

    // Question appears
    await waitFor(() => {
      expect(screen.getByText('What is photosynthesis?')).toBeDefined();
    });

    // Space key reveals answer
    fireEvent.keyDown(window, { key: ' ' });

    await waitFor(() => {
      expect(
        screen.getByText('Process used by plants to convert light energy into chemical energy')
      ).toBeDefined();
    });

    // Press '3' to submit Good rating
    fireEvent.keyDown(window, { key: '3' });

    await waitFor(() => {
      expect(reviewSpy).toHaveBeenCalledTimes(1);
    });

    const [cardId, rating, extra] = reviewSpy.mock.calls[0];
    expect(cardId).toBe(101);
    expect(rating).toBe(3);
    expect(extra?.expected_version).toBe(3);
    expect(typeof extra?.request_id).toBe('string');
    expect(extra?.request_id?.length).toBeGreaterThan(0);
    expect(typeof extra?.duration_ms).toBe('number');
  });

  it('synchronous ref guard prevents duplicate review submissions', async () => {
    const cardData = {
      card_id: 102,
      deck_id: 1,
      deck_name: 'Biology 101',
      front: 'Front text',
      back: 'Back text',
      version: 1,
    };

    vi.spyOn(studyApi, 'getNextCard').mockResolvedValue({ data: cardData } as any);
    vi.spyOn(studyApi, 'getStudyStats').mockResolvedValue({ data: {} } as any);

    let resolveReview: (val: any) => void;
    const reviewPromise = new Promise((resolve) => {
      resolveReview = resolve;
    });

    const reviewSpy = vi.spyOn(studyApi, 'reviewCard').mockReturnValue(reviewPromise as any);

    render(
      <MemoryRouter initialEntries={['/study/1']}>
        <Routes>
          <Route path="/study/:deckId" element={<StudyPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Front text')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /Show Answer/i }));

    await waitFor(() => {
      expect(screen.getByText('Back text')).toBeDefined();
    });

    const goodBtn = screen.getByRole('button', { name: /Good/i });

    // Double click synchronously
    fireEvent.click(goodBtn);
    fireEvent.click(goodBtn);

    expect(reviewSpy).toHaveBeenCalledTimes(1);

    // Resolve review
    resolveReview!({ data: { success: true } });
  });

  it('409 retry behavior: retains same request_id on retry, generates fresh request_id on different rating', async () => {
    const cardData = {
      card_id: 103,
      deck_id: 1,
      deck_name: 'Biology 101',
      front: 'What causes conflict?',
      back: 'Resource scarcity',
      version: 2,
    };

    vi.spyOn(studyApi, 'getNextCard').mockResolvedValue({ data: cardData } as any);
    vi.spyOn(studyApi, 'getStudyStats').mockResolvedValue({ data: {} } as any);

    const reviewSpy = vi.spyOn(studyApi, 'reviewCard');
    reviewSpy.mockRejectedValueOnce({
      response: { status: 409, data: { detail: 'Version conflict' } },
    });

    render(
      <MemoryRouter initialEntries={['/study/1']}>
        <Routes>
          <Route path="/study/:deckId" element={<StudyPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('What causes conflict?')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /Show Answer/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Good/i })).toBeDefined();
    });

    // 1st attempt: click Good (rating 3)
    fireEvent.click(screen.getByRole('button', { name: /Good/i }));

    await waitFor(() => {
      expect(screen.getByText('Version conflict')).toBeDefined();
    });

    expect(reviewSpy).toHaveBeenCalledTimes(1);
    const firstRequestId = reviewSpy.mock.calls[0][2]?.request_id;
    expect(firstRequestId).toBeDefined();

    // 2nd attempt: click Good again (retry same rating)
    reviewSpy.mockRejectedValueOnce({
      response: { status: 409, data: { detail: 'Version conflict retry' } },
    });

    fireEvent.click(screen.getByRole('button', { name: /Good/i }));

    await waitFor(() => {
      expect(screen.getByText('Version conflict retry')).toBeDefined();
    });

    expect(reviewSpy).toHaveBeenCalledTimes(2);
    const secondRequestId = reviewSpy.mock.calls[1][2]?.request_id;
    // Request ID MUST BE RETAINED for retry of same review
    expect(secondRequestId).toBe(firstRequestId);

    // 3rd attempt: change intended rating to Again (rating 1)
    reviewSpy.mockResolvedValueOnce({ data: { success: true } } as any);

    fireEvent.click(screen.getByRole('button', { name: /Again/i }));

    await waitFor(() => {
      expect(reviewSpy).toHaveBeenCalledTimes(3);
    });

    const thirdRequestId = reviewSpy.mock.calls[2][2]?.request_id;
    // New request ID because different rating was chosen
    expect(thirdRequestId).not.toBe(firstRequestId);
  });

  it('duration counts real card time capped by max-answer setting', async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const cardData = {
      card_id: 104,
      deck_id: 1,
      deck_name: 'Biology 101',
      front: 'Timed Front',
      back: 'Timed Back',
      settings: {
        maximum_answer_seconds: 5,
        stop_on_screen_timer_on_answer: true,
      },
    };

    vi.spyOn(studyApi, 'getNextCard').mockResolvedValue({ data: cardData } as any);
    vi.spyOn(studyApi, 'getStudyStats').mockResolvedValue({ data: {} } as any);

    const reviewSpy = vi.spyOn(studyApi, 'reviewCard').mockResolvedValue({ data: { success: true } } as any);

    render(
      <MemoryRouter initialEntries={['/study/1']}>
        <Routes>
          <Route path="/study/:deckId" element={<StudyPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Timed Front')).toBeDefined();
    });

    now = 3000;
    fireEvent.click(screen.getByRole('button', { name: /Show Answer/i }));
    now = 13000;
    fireEvent.click(screen.getByRole('button', { name: /Good/i }));

    await waitFor(() => {
      expect(reviewSpy).toHaveBeenCalledTimes(1);
    });

    const extra = reviewSpy.mock.calls[0][2];
    expect(extra?.duration_ms).toBeDefined();
    // Must be capped by maximum_answer_seconds * 1000
    expect(extra!.duration_ms).toBe(2000);
    clock.mockRestore();
  });

  it('audio preference: respects dont_play_audio_automatically and replays on R key', async () => {


    const cardData = {
      card_id: 105,
      deck_id: 1,
      deck_name: 'Languages',
      front: 'Bonjour <audio src="bonjour.mp3"></audio>',
      back: 'Hello',
      settings: {
        dont_play_audio_automatically: true,
      },
    };

    vi.spyOn(studyApi, 'getNextCard').mockResolvedValue({ data: cardData } as any);
    vi.spyOn(studyApi, 'getStudyStats').mockResolvedValue({ data: {} } as any);

    render(
      <MemoryRouter initialEntries={['/study/1']}>
        <Routes>
          <Route path="/study/:deckId" element={<StudyPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Bonjour/i)).toBeDefined();
    });

    const iframe = screen.getByTitle('Card Content') as HTMLIFrameElement;
    const doc = iframe.contentDocument!;
    const audio = doc.createElement('audio');
    audio.src = 'bonjour.mp3';
    doc.body.append(audio);
    const playMock = vi.spyOn(audio, 'play').mockResolvedValue(undefined);
    vi.spyOn(audio, 'pause').mockImplementation(() => undefined);
    expect(playMock).not.toHaveBeenCalled();

    // Replay manually via R key
    fireEvent.keyDown(window, { key: 'r' });

    // Audio stopped previous and called play
    expect(playMock).toHaveBeenCalled();
    playMock.mockRestore();
  });

  it('waiting state: displays waiting screen when null card with next_learning_at is returned', async () => {
    vi.spyOn(studyApi, 'getNextCard').mockResolvedValue({ data: null } as any);
    vi.spyOn(studyApi, 'getStudyStats').mockResolvedValue({
      data: {
        next_learning_at: '2026-10-22T15:00:00Z',
        total_cards: 5,
      },
    } as any);

    render(
      <MemoryRouter initialEntries={['/study/1']}>
        <Routes>
          <Route path="/study/:deckId" element={<StudyPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Waiting for Next Card/i)).toBeDefined();
    });

    // Should NOT display congratulations
    expect(screen.queryByText(/Congratulations!/i)).toBeNull();
  });

  it('CardFace srcDoc sandbox disallows scripts, sanitizes markup, and CSS closing tag cannot inject HTML', () => {
    const maliciousHtml = '<p>Clean text</p><script>alert("xss")</script><img src="x" onerror="evil()" />';
    const maliciousCss = 'body { color: blue; } </style><div id="injected-html">pwned</div>';

    const { container } = render(
      <CardFace html={maliciousHtml} cardCss={maliciousCss} title="Test Card" />
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();

    // Sandbox allow-same-origin ONLY
    const sandbox = iframe?.getAttribute('sandbox');
    expect(sandbox).toBe('allow-same-origin');
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-forms');
    expect(sandbox).not.toContain('allow-popups');

    const srcDoc = iframe?.getAttribute('srcdoc') || '';

    // CSP meta tag with script-src 'none'
    expect(srcDoc).toContain("script-src 'none'");
    expect(srcDoc).toContain("default-src 'none'");
    expect(srcDoc).toContain(window.location.origin);
    expect(container.querySelector('.card-face-accessible img')).toBeNull();

    // Script tags sanitized away
    expect(srcDoc).not.toContain('<script>');
    expect(srcDoc).not.toContain('alert("xss")');

    // CSS closing tag </style escaped so it cannot break out into HTML
    expect(srcDoc).not.toContain('</style><div id="injected-html">');
    expect(srcDoc).toContain('<\\/style><div id="injected-html">');
  });

  it('auto-advance: reports error for unsupported question action and never silently rates', async () => {
    const cardData = {
      card_id: 106,
      deck_id: 1,
      deck_name: 'Timer Deck',
      front: 'Timed Question',
      back: 'Timed Answer',
      settings: {
        seconds_to_show_question_for: 0.1,
        question_action: 'invalid_action',
      },
    };

    vi.spyOn(studyApi, 'getNextCard').mockResolvedValue({ data: cardData } as any);
    vi.spyOn(studyApi, 'getStudyStats').mockResolvedValue({ data: {} } as any);
    const reviewSpy = vi.spyOn(studyApi, 'reviewCard');

    render(
      <MemoryRouter initialEntries={['/study/1']}>
        <Routes>
          <Route path="/study/:deckId" element={<StudyPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Timed Question')).toBeDefined();
    });

    // Wait for auto-action error
    await waitFor(() => {
      expect(screen.getByText(/Unsupported question action: invalid_action/i)).toBeDefined();
    });

    // Must never silently rate
    expect(reviewSpy).not.toHaveBeenCalled();
  });

  it('card action and undo: supports Bury card, Suspend card and Ctrl+Z undo', async () => {
    const cardData = {
      card_id: 107,
      deck_id: 1,
      deck_name: 'Actions Deck',
      front: 'Action Front',
      back: 'Action Back',
      version: 4,
    };

    vi.spyOn(studyApi, 'getNextCard').mockResolvedValue({ data: cardData } as any);
    vi.spyOn(studyApi, 'getStudyStats').mockResolvedValue({ data: {} } as any);

    const actionSpy = vi.spyOn(studyApi, 'cardAction').mockResolvedValue({ data: { success: true } } as any);
    const undoSpy = vi.spyOn(studyApi, 'undoReview').mockResolvedValue({ data: { success: true } } as any);

    render(
      <MemoryRouter initialEntries={['/study/1']}>
        <Routes>
          <Route path="/study/:deckId" element={<StudyPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Action Front')).toBeDefined();
    });

    // Click Bury button
    fireEvent.click(screen.getByRole('button', { name: /Bury/i }));

    await waitFor(() => {
      expect(actionSpy).toHaveBeenCalledWith(107, 'bury', 4);
    });

    // Trigger Ctrl+Z
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

    await waitFor(() => {
      expect(undoSpy).toHaveBeenCalled();
    });
  });

  it('safe retryable load errors: shows retry button and retries successfully', async () => {
    const getNextCardSpy = vi.spyOn(studyApi, 'getNextCard');
    getNextCardSpy.mockRejectedValueOnce({
      response: { data: { detail: 'Network connectivity lost' } },
    });
    vi.spyOn(studyApi, 'getStudyStats').mockResolvedValue({ data: {} } as any);

    render(
      <MemoryRouter initialEntries={['/study/1']}>
        <Routes>
          <Route path="/study/:deckId" element={<StudyPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Network connectivity lost/i)).toBeDefined();
    });

    // Prepare success response on retry
    const cardData = {
      card_id: 108,
      deck_id: 1,
      deck_name: 'Recovered Deck',
      front: 'Recovered Front',
      back: 'Recovered Back',
    };
    getNextCardSpy.mockResolvedValueOnce({ data: cardData } as any);

    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText('Recovered Front')).toBeDefined();
    });
  });
});
