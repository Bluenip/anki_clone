import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CustomStudyPage from '../pages/CustomStudyPage';
import * as filteredApi from '../api/filtered';
import * as studyApi from '../api/study';

vi.mock('../api/filtered');
vi.mock('../api/study');

const session: filteredApi.Session = {
  id: 7, name: 'Before the test', search: '', limit: 50, order: 'oldest', reschedule: true, version: 2, remaining: 5,
};

describe('Custom study in student test mode', () => {
  it('shows the exercise instead of rating buttons and sends the answer for server grading', async () => {
    vi.mocked(filteredApi.getFilteredSessions).mockResolvedValue({ data: [session] } as never);
    vi.mocked(filteredApi.getFilteredNextCard).mockResolvedValue({
      data: {
        session, next_available_at: null,
        card: { card_id: 31, deck_name: 'on screen 2', front: 'Collect', back: 'Collect<hr id=answer>Sưu tầm', version: 3,
                rendered: true, intervals: { again: { display: '< 1m' }, good: { display: '1d' } },
                quiz: { type: 'typing', direction: 'meaning_to_word', meaning: 'Sưu tầm', answer_length: 7, audio: null, tts: null } },
      },
    } as never);
    vi.mocked(studyApi.checkQuiz).mockResolvedValue({
      data: { type: 'typing', result: 'correct', correct: true, expected: 'Collect', rating: 3 },
    } as never);
    const answer = vi.mocked(filteredApi.answerFilteredCard).mockResolvedValue({ data: { session: { ...session, version: 3 } } } as never);

    render(
      <MemoryRouter initialEntries={['/custom-study']}>
        <Routes><Route path="/custom-study" element={<CustomStudyPage />} /></Routes>
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Study$/i }));

    const input = await screen.findByPlaceholderText(/type your answer|nhập câu trả lời/i);
    expect(screen.queryByText('Collect')).toBeNull();                       // card hidden before answering
    expect(screen.queryByRole('button', { name: /Easy \(4\)/i })).toBeNull(); // no self-rating
    fireEvent.keyDown(window, { key: '4' });
    expect(answer).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'collect' } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.click(await screen.findByRole('button', { name: /continue|tiếp tục/i }));

    await waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
    const [sid, payload] = answer.mock.calls[0];
    expect(sid).toBe(7);
    expect(payload).toMatchObject({ card_id: 31, expected_version: 3, rating: 3, quiz: { response: 'collect', hint_used: false } });
  });
});
