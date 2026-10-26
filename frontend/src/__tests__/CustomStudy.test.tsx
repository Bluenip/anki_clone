import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CustomStudyPage from '../pages/CustomStudyPage';
import * as filteredApi from '../api/filtered';

vi.mock('../api/filtered');

const mockSessionPreview: filteredApi.Session = {
  id: 1,
  name: 'Anatomy Cram',
  search: 'is:due',
  limit: 50,
  order: 'oldest',
  reschedule: false,
  version: 3,
  remaining: 10,
  preview_again_seconds: 60,
  preview_hard_seconds: 600,
  preview_good_seconds: 0,
};

const mockSessionReschedule: filteredApi.Session = {
  id: 2,
  name: 'Physics Heavy',
  search: 'tag:physics',
  limit: 30,
  order: 'lapses',
  reschedule: true,
  version: 5,
  remaining: 8,
};

const mockCard: filteredApi.StudyCard = {
  card_id: 201,
  deck_name: 'Medical Deck',
  front: 'What is the largest bone in the human body?',
  back: 'Femur',
  version: 4,
  rendered: false,
  intervals: {
    again: { display: '< 1m' },
    hard: { display: '1d' },
    good: { display: '3d' },
    easy: { display: '7d' },
  },
};

const renderCustomStudy = (initialRoute = '/custom-study') => {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <Routes>
        <Route path="/custom-study" element={<CustomStudyPage />} />
        <Route path="/custom-study/:sessionId" element={<CustomStudyPage />} />
      </Routes>
    </MemoryRouter>
  );
};

describe('CustomStudyPage and Filtered Session UI', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // 1. CREATE TEST: create session with form inputs, default 'is:due', configurable 3 delays
  it('create: creates a new filtered session and builds it with specified payload and delays', async () => {
    vi.mocked(filteredApi.getFilteredSessions).mockResolvedValue({ data: [] } as never);
    const createdSession: filteredApi.Session = {
      id: 10,
      name: 'Pathology Review',
      filters: [],
      search: 'tag:pathology',
      limit: 150,
      order: 'random',
      reschedule: false,
      preview_again_seconds: 120,
      preview_hard_seconds: 1200,
      preview_good_seconds: 60,
      version: 1,
      remaining: 12,
    };
    const createSpy = vi.mocked(filteredApi.createFilteredSession).mockResolvedValue({
      data: createdSession,
    } as never);
    vi.mocked(filteredApi.getFilteredNextCard).mockResolvedValue({
      data: { session: createdSession, card: null, next_available_at: null },
    } as never);

    renderCustomStudy();

    const openBtn = await screen.findByRole('button', { name: /Create Filtered Session/i });
    fireEvent.click(openBtn);

    expect(screen.getByRole('dialog')).toBeDefined();
    const searchInput = screen.getByLabelText(/Search Query/i) as HTMLInputElement;
    expect(searchInput.value).toBe('is:due');

    // Fill in form
    const nameInput = screen.getByLabelText(/Session Name/i);
    fireEvent.change(nameInput, { target: { value: 'Pathology Review' } });
    fireEvent.change(searchInput, { target: { value: 'tag:pathology' } });

    const limitInput = screen.getByLabelText(/Card Limit/i);
    fireEvent.change(limitInput, { target: { value: '150' } });

    const orderSelect = screen.getByLabelText(/Order/i);
    fireEvent.change(orderSelect, { target: { value: 'random' } });

    // Configurable 3 delays panel is visible in preview mode
    expect(screen.getByTestId('preview-delays-panel')).toBeDefined();
    const againInput = screen.getByLabelText(/Again Delay/i);
    const hardInput = screen.getByLabelText(/Hard Delay/i);
    const goodInput = screen.getByLabelText(/Good Delay/i);

    fireEvent.change(againInput, { target: { value: '120' } });
    fireEvent.change(hardInput, { target: { value: '1200' } });
    fireEvent.change(goodInput, { target: { value: '60' } });

    // Submit form
    const submitBtn = screen.getByRole('button', { name: /Create & Build Session/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    expect(createSpy).toHaveBeenCalledWith({
      name: 'Pathology Review',
      filters: [],
      search: 'tag:pathology',
      limit: 150,
      order: 'random',
      reschedule: false,
      preview_again_seconds: 120,
      preview_hard_seconds: 1200,
      preview_good_seconds: 60,
    });
  });

  // 2. FOUR PREVIEW RATINGS & PREVIEWPAYLOAD: all 4 ratings available in preview mode, sends correct payload
  it('four preview ratings: renders all 4 rating buttons in preview mode and submits valid answer payload', async () => {
    vi.mocked(filteredApi.getFilteredSessions).mockResolvedValue({
      data: [mockSessionPreview],
    } as never);
    vi.mocked(filteredApi.getFilteredNextCard).mockResolvedValue({
      data: { session: mockSessionPreview, card: mockCard, next_available_at: null },
    } as never);

    const answerSpy = vi.mocked(filteredApi.answerFilteredCard).mockResolvedValue({
      data: { session: { ...mockSessionPreview, version: 4, remaining: 9 } },
    } as never);

    renderCustomStudy();

    const studyBtn = await screen.findByRole('button', { name: /^Study$/i });
    fireEvent.click(studyBtn);

    await screen.findByText('What is the largest bone in the human body?');

    // Reveal answer via Space
    fireEvent.keyDown(window, { key: ' ' });

    await screen.findByText('Femur');

    // Verify all 4 rating buttons exist with preview intervals
    const previewContainer = screen.getByTestId('preview-rating-buttons');
    expect(previewContainer).toBeDefined();
    expect(screen.getByRole('button', { name: /Again \(1\)/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Hard \(2\)/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Good \(3\)/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Easy \(4\)/i })).toBeDefined();

    // Click Hard (2)
    fireEvent.click(screen.getByRole('button', { name: /Hard \(2\)/i }));

    await waitFor(() => {
      expect(answerSpy).toHaveBeenCalledTimes(1);
    });

    const [sessionId, payload] = answerSpy.mock.calls[0];
    expect(sessionId).toBe(mockSessionPreview.id);
    expect(payload.expected_session_version).toBe(mockSessionPreview.version);
    expect(payload.card_id).toBe(mockCard.card_id);
    expect(payload.expected_version).toBe(mockCard.version);
    expect(payload.rating).toBe(2);
    expect(typeof payload.duration_ms).toBe('number');
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
    expect(payload.duration_ms).toBeLessThanOrEqual(3600000);

    expect(filteredApi.getFilteredNextCard).toHaveBeenCalledWith(mockSessionPreview.id);
  });

  // 3. MODEWARNING TEST: explicit schedule impact wording
  it('modewarning: displays explicit schedule impact warnings for both preview and reschedule modes', async () => {
    vi.mocked(filteredApi.getFilteredSessions).mockResolvedValue({
      data: [mockSessionPreview, mockSessionReschedule],
    } as never);

    vi.mocked(filteredApi.getFilteredNextCard).mockImplementation(async (id: number) => {
      const sess = id === 1 ? mockSessionPreview : mockSessionReschedule;
      return {
        data: { session: sess, card: mockCard, next_available_at: null },
      } as never;
    });

    const { unmount } = renderCustomStudy('/custom-study/1');

    await screen.findByTestId('mode-warning');
    const previewWarning = screen.getByTestId('mode-warning').textContent;
    expect(previewWarning).toContain('Preview Mode');
    expect(previewWarning).toMatch(/NOT affect original card schedules/i);

    unmount();

    renderCustomStudy('/custom-study/2');

    await screen.findByTestId('mode-warning');
    const rescheduleWarning = screen.getByTestId('mode-warning').textContent;
    expect(rescheduleWarning).toContain('Reschedule Mode');
    expect(rescheduleWarning).toMatch(/modify scheduling and intervals in the card's original home deck/i);
  });

  // 4. STALE NEXT TEST: request guards ignore stale responses when switching sessions
  it('stale next: ignores out-of-order or delayed next card responses from previous session', async () => {
    vi.mocked(filteredApi.getFilteredSessions).mockResolvedValue({
      data: [mockSessionPreview, mockSessionReschedule],
    } as never);

    let resolveSession1Card: (value: any) => void;
    const session1Promise = new Promise((resolve) => {
      resolveSession1Card = resolve;
    });

    const cardForSession2: filteredApi.StudyCard = {
      ...mockCard,
      card_id: 302,
      front: 'Front of Session 2 Card',
      back: 'Back of Session 2 Card',
    };

    vi.mocked(filteredApi.getFilteredNextCard).mockImplementation(async (id: number) => {
      if (id === 1) {
        return session1Promise as any;
      }
      return {
        data: { session: mockSessionReschedule, card: cardForSession2, next_available_at: null },
      } as any;
    });

    renderCustomStudy();

    await screen.findByText('Anatomy Cram');
    const studyButtons = screen.getAllByRole('button', { name: /^Study$/i });
    fireEvent.click(studyButtons[0]);

    const backBtn = await screen.findByRole('button', { name: /Back to sessions list/i });
    fireEvent.click(backBtn);

    const studyButtonsAfterBack = await screen.findAllByRole('button', { name: /^Study$/i });
    fireEvent.click(studyButtonsAfterBack[1]);

    await screen.findByText('Front of Session 2 Card');

    // Late session 1 response resolves
    await act(async () => {
      resolveSession1Card!({
        data: {
          session: mockSessionPreview,
          card: { ...mockCard, front: 'STALE SESSION 1 CARD' },
          next_available_at: null,
        },
      });
    });

    expect(screen.queryByText('STALE SESSION 1 CARD')).toBeNull();
    expect(screen.getByText('Front of Session 2 Card')).toBeDefined();
  });

  // 5. SWITCHING DURING PENDING ANSWER/REBUILD TEST
  it('switching during pending answer/rebuild: does not overwrite state or switch back when in-flight request finishes', async () => {
    vi.mocked(filteredApi.getFilteredSessions).mockResolvedValue({
      data: [mockSessionPreview, mockSessionReschedule],
    } as never);

    vi.mocked(filteredApi.getFilteredNextCard).mockImplementation(async (id: number) => {
      const sess = id === 1 ? mockSessionPreview : mockSessionReschedule;
      return {
        data: { session: sess, card: mockCard, next_available_at: null },
      } as never;
    });

    let resolveAnswer: (value: any) => void;
    const answerPromise = new Promise((resolve) => {
      resolveAnswer = resolve;
    });
    vi.mocked(filteredApi.answerFilteredCard).mockImplementation(() => answerPromise as any);

    renderCustomStudy('/custom-study/1');

    await screen.findByText('What is the largest bone in the human body?');

    // Reveal answer and rate
    fireEvent.keyDown(window, { key: ' ' });
    await screen.findByText('Femur');

    // Submit answer in session 1 (remains in-flight)
    fireEvent.click(screen.getByRole('button', { name: /Good \(3\)/i }));

    // User navigates back to sessions list while answer is in-flight
    const backBtn = screen.getByRole('button', { name: /Back to sessions list/i });
    fireEvent.click(backBtn);

    // Verify user is back on sessions list
    expect(await screen.findByText('+ New Custom Study Session')).toBeDefined();

    // Now resolve the in-flight answer for session 1
    await act(async () => {
      resolveAnswer!({
        data: { session: { ...mockSessionPreview, version: 10, remaining: 0 } },
      });
    });

    // Verify UI did NOT switch back to studying session 1
    expect(screen.getByText('+ New Custom Study Session')).toBeDefined();
    expect(screen.queryByText('Femur')).toBeNull();
  });

  // 6. ERRORPRESERVES TEST: review failure preserves current card and offers 409 reload guidance
  it('errorpreserves: keeps current card on error and displays 409 reload guidance', async () => {
    vi.mocked(filteredApi.getFilteredSessions).mockResolvedValue({
      data: [mockSessionReschedule],
    } as never);
    vi.mocked(filteredApi.getFilteredNextCard).mockResolvedValue({
      data: { session: mockSessionReschedule, card: mockCard, next_available_at: null },
    } as never);

    const answerSpy = vi.mocked(filteredApi.answerFilteredCard).mockRejectedValueOnce({
      response: {
        status: 409,
        data: { detail: 'This session changed; reload before continuing' },
      },
    });

    renderCustomStudy('/custom-study/2');

    await screen.findByText('What is the largest bone in the human body?');

    fireEvent.keyDown(window, { key: ' ' });
    await screen.findByText('Femur');

    fireEvent.click(screen.getByRole('button', { name: /Good \(3\)/i }));

    await waitFor(() => {
      expect(answerSpy).toHaveBeenCalledTimes(1);
    });

    // Card preserved
    expect(screen.getByText('What is the largest bone in the human body?')).toBeDefined();
    expect(screen.getByText('Femur')).toBeDefined();

    // 409 Conflict guidance
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/409 Conflict/i);
    expect(alert.textContent).toMatch(/Guidance: A version mismatch occurred. Please reload/i);

    const reloadBtn = screen.getByRole('button', { name: /Reload Session/i });
    expect(reloadBtn).toBeDefined();

    fireEvent.click(reloadBtn);
    await waitFor(() => {
      expect(filteredApi.getFilteredSessions).toHaveBeenCalled();
      expect(filteredApi.getFilteredNextCard).toHaveBeenCalled();
    });
  });

  // 7. UNDO TEST: button and Ctrl+Z trigger undo, update session, and reload card
  it('Undo: supports Undo button and Ctrl+Z shortcut, reloading the session', async () => {
    vi.mocked(filteredApi.getFilteredSessions).mockResolvedValue({
      data: [mockSessionPreview],
    } as never);
    vi.mocked(filteredApi.getFilteredNextCard).mockResolvedValue({
      data: { session: mockSessionPreview, card: mockCard, next_available_at: null },
    } as never);

    const undoSpy = vi.mocked(filteredApi.undoFilteredSession).mockResolvedValue({
      data: { session: { ...mockSessionPreview, version: 6, remaining: 11 } },
    } as never);

    renderCustomStudy('/custom-study/1');

    await screen.findByText('What is the largest bone in the human body?');

    // Click Undo button
    const undoBtn = screen.getByRole('button', { name: /⤺ Undo/i });
    fireEvent.click(undoBtn);

    await waitFor(() => {
      expect(undoSpy).toHaveBeenCalledWith(mockSessionPreview.id);
    });

    // Ensure session/card finished reloading
    await screen.findByText('What is the largest bone in the human body?');

    // Trigger Ctrl+Z shortcut
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

    await waitFor(() => {
      expect(undoSpy).toHaveBeenCalledTimes(2);
    });
  });

  // 8. INPUTKEYBOARD TEST: keyboard shortcuts (Space, 1-4) ignored in inputs and unrevealed state
  it('inputkeyboard: does not trigger reveal or rating when typing in inputs or unrevealed', async () => {
    vi.mocked(filteredApi.getFilteredSessions).mockResolvedValue({
      data: [mockSessionPreview],
    } as never);
    vi.mocked(filteredApi.getFilteredNextCard).mockResolvedValue({
      data: { session: mockSessionPreview, card: mockCard, next_available_at: null },
    } as never);
    const answerSpy = vi.mocked(filteredApi.answerFilteredCard);

    renderCustomStudy('/custom-study/1');

    await screen.findByText('What is the largest bone in the human body?');

    // 1. Unrevealed state ignores 1, 2, 3, 4
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyDown(window, { key: '2' });
    fireEvent.keyDown(window, { key: '3' });
    fireEvent.keyDown(window, { key: '4' });
    expect(answerSpy).not.toHaveBeenCalled();

    // 2. Focused input element ignores Space and 1-4
    const testInput = document.createElement('input');
    document.body.appendChild(testInput);
    testInput.focus();

    fireEvent.keyDown(testInput, { key: ' ' });
    expect(screen.queryByText('Femur')).toBeNull();

    fireEvent.keyDown(testInput, { key: '1' });
    fireEvent.keyDown(testInput, { key: '3' });
    expect(answerSpy).not.toHaveBeenCalled();

    testInput.blur();
    document.body.removeChild(testInput);

    // 3. Outside inputs, Space reveals answer
    fireEvent.keyDown(window, { key: ' ' });
    await screen.findByText('Femur');

    // 4. Revealed card rates on 3 (Good)
    answerSpy.mockResolvedValueOnce({
      data: { session: { ...mockSessionPreview, version: 4 } },
    } as never);
    fireEvent.keyDown(window, { key: '3' });

    await waitFor(() => {
      expect(answerSpy).toHaveBeenCalledTimes(1);
    });
    expect(answerSpy.mock.calls[0][1].rating).toBe(3);
  });
});

it('preserves an empty search when the user chooses to gather all cards', async () => {
  vi.resetAllMocks();
  vi.mocked(filteredApi.getFilteredSessions).mockResolvedValue({data:[]} as never);
  const created={...mockSessionPreview,name:'All cards',search:'',remaining:0};
  vi.mocked(filteredApi.createFilteredSession).mockResolvedValue({data:created} as never);
  vi.mocked(filteredApi.getFilteredNextCard).mockResolvedValue({data:{session:created,card:null,next_available_at:null}} as never);
  renderCustomStudy();
  fireEvent.click(await screen.findByRole('button',{name:/Create Filtered Session/i}));
  fireEvent.change(screen.getByLabelText(/Session Name/i),{target:{value:'All cards'}});
  fireEvent.change(screen.getByLabelText(/Search Query/i),{target:{value:''}});
  fireEvent.click(screen.getByRole('button',{name:/Create & Build Session/i}));
  await screen.findByRole('heading',{name:'All cards'});
  expect(vi.mocked(filteredApi.createFilteredSession).mock.calls[0][0].search).toBe('');
});

it('edits the selected session using its revision and retains inputs on conflict', async () => {
  vi.resetAllMocks();
  vi.mocked(filteredApi.getFilteredSessions).mockResolvedValue({ data: [mockSessionPreview] } as never);
  vi.mocked(filteredApi.getFilteredNextCard).mockResolvedValue({ data: { session: mockSessionPreview, card: mockCard, next_available_at: null } } as never);
  vi.mocked(filteredApi.editFilteredSession).mockRejectedValue({ response: { status: 409, data: { detail: 'Session changed' } } });
  renderCustomStudy('/custom-study/1');
  const edit = await screen.findByRole('button', { name: 'Edit session settings' });
  await waitFor(() => expect((edit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(edit);
  fireEvent.change(screen.getByLabelText(/Session Name/), { target: { value: 'My revised session' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save & Rebuild Session' }));
  await waitFor(() => expect(filteredApi.editFilteredSession).toHaveBeenCalledWith(1, 3, expect.objectContaining({ name: 'My revised session', search: 'is:due' })));
  await screen.findByText('Session changed');
  expect((screen.getByLabelText(/Session Name/) as HTMLInputElement).value).toBe('My revised session');
});
