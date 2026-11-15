import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import StudyPage from '../pages/StudyPage';
import * as studyApi from '../api/study';

vi.mock('../api/study');

const baseCard = {
  card_id: 7,
  deck_id: 1,
  deck_name: 'English',
  front: '<div>apple</div>',
  back: '<div>apple</div><hr id=answer><div>quả táo</div>',
  version: 2,
  rendered: true,
  intervals: { again: { display: '< 1m' }, hard: { display: '1d' }, good: { display: '3d' }, easy: { display: '4d' } },
  settings: { maximum_answer_seconds: 60 },
};

const renderStudy = () =>
  render(
    <MemoryRouter initialEntries={['/study/1']}>
      <Routes>
        <Route path="/study/:deckId" element={<StudyPage />} />
      </Routes>
    </MemoryRouter>
  );

describe('Student quiz mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(studyApi, 'getStudyStats').mockResolvedValue({ data: { new_cards: 0, learn_cards: 0, due_cards: 1 } } as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it('hides the card and rating buttons, and a wrong answer must be retyped before it counts as Again', async () => {
    vi.spyOn(studyApi, 'getNextCard').mockResolvedValue({
      data: { ...baseCard, quiz: { type: 'typing', direction: 'meaning_to_word', meaning: 'quả táo', answer_length: 5,
        hint: 'a _ _ _ _', audio: null, tts: null } },
    } as any);
    const check = vi.spyOn(studyApi, 'checkQuiz').mockResolvedValue({
      data: { type: 'typing', result: 'wrong', correct: false, expected: 'apple', rating: 1 },
    } as any);
    const review = vi.spyOn(studyApi, 'reviewCard').mockResolvedValue({ data: {} } as any);

    renderStudy();
    const input = await screen.findByPlaceholderText(/type your answer|nhập câu trả lời/i);
    expect(screen.queryByText(/^(Good|Tốt)/)).toBeNull();
    expect(screen.queryByRole('button', { name: /show answer|hiện đáp án/i })).toBeNull();
    // Number keys must not rate the card in quiz mode.
    fireEvent.keyDown(window, { key: '4' });
    expect(review).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'pear' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(check).toHaveBeenCalledWith(7, { response: 'pear', hint_used: false }));

    const continueButton = await screen.findByRole('button', { name: /continue|tiếp tục/i });
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/type the correct answer|gõ lại đáp án/i), { target: { value: 'Apple' } });
    expect((continueButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(continueButton);

    await waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    expect(review.mock.calls[0][0]).toBe(7);
    expect(review.mock.calls[0][1]).toBe(1);
    expect(review.mock.calls[0][2]).toMatchObject({ quiz: { response: 'pear', hint_used: false } });
  });

  it('multiple choice answers with number keys', async () => {
    vi.spyOn(studyApi, 'getNextCard').mockResolvedValue({
      data: { ...baseCard, quiz: { type: 'multiple_choice', direction: 'meaning_to_word', meaning: 'quả táo', answer_length: 5,
        options: ['pear', 'apple', 'plum', 'fig'], audio: null, tts: null } },
    } as any);
    const check = vi.spyOn(studyApi, 'checkQuiz').mockResolvedValue({
      data: { type: 'multiple_choice', result: 'correct', correct: true, expected: 'apple', rating: 3 },
    } as any);
    const review = vi.spyOn(studyApi, 'reviewCard').mockResolvedValue({ data: {} } as any);

    renderStudy();
    await screen.findByText('pear');
    fireEvent.keyDown(window, { key: '2' });
    await waitFor(() => expect(check).toHaveBeenCalledWith(7, { response: 'apple', hint_used: false }));
    fireEvent.click(await screen.findByRole('button', { name: /continue|tiếp tục/i }));
    await waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    expect(review.mock.calls[0][1]).toBe(3);
  });
});

describe('Quiz audio', () => {
  afterEach(() => vi.restoreAllMocks());
  it('plays exercise audio from a same-origin path so the page CSP allows it', async () => {
    vi.spyOn(studyApi, 'getStudyStats').mockResolvedValue({ data: { new_cards: 0, learn_cards: 0, due_cards: 1 } } as any);
    vi.spyOn(studyApi, 'getNextCard').mockResolvedValue({
      data: { ...baseCard, quiz: { type: 'listening', direction: 'meaning_to_word', meaning: '', answer_length: 5,
        audio: '/api/media/1/apple.mp3', tts: null } },
    } as any);
    const sources: string[] = [];
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      sources.push(this.getAttribute('src') || '');
      return Promise.resolve();
    });
    renderStudy();
    fireEvent.click(await screen.findByRole('button', { name: /play again|nghe lại/i }));
    await waitFor(() => expect(sources.length).toBeGreaterThan(0));
    expect(sources.every(src => src === '/api/media/1/apple.mp3')).toBe(true);
  });
});
