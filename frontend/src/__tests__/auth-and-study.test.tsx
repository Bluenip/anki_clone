import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router-dom';
import ForgotPasswordPage from '../pages/ForgotPasswordPage';
import LoginPage from '../pages/LoginPage';
import StudyPage from '../pages/StudyPage';
import * as authApi from '../api/auth';
import * as studyApi from '../api/study';

vi.mock('../api/auth');
vi.mock('../api/study');

describe('Auth and Study UI flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ForgotPasswordPage displays uniform safe message on submission', async () => {
    vi.spyOn(authApi, 'forgotPasswordApi').mockResolvedValue({
      data: {
        message: 'If an account with that email exists, password reset instructions have been recorded.',
      },
    } as any);

    render(
      <BrowserRouter>
        <ForgotPasswordPage />
      </BrowserRouter>
    );

    const emailInput = screen.getByLabelText(/Email/i);
    fireEvent.change(emailInput, { target: { value: 'user@example.com' } });

    const submitBtn = screen.getByRole('button', { name: /Reset Password/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/If an account with that email exists/i)).toBeDefined();
    });
  });

  it('LoginPage renders error message on invalid credentials', async () => {
    vi.spyOn(authApi, 'loginApi').mockRejectedValue({
      response: { data: { detail: 'Invalid email or password' } },
    });

    render(
      <BrowserRouter>
        <LoginPage />
      </BrowserRouter>
    );

    const emailInput = screen.getByLabelText(/Email/i);
    const passwordInput = screen.getByLabelText(/Password/i);

    fireEvent.change(emailInput, { target: { value: 'wrong@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'wrongpass' } });

    const submitBtn = screen.getByRole('button', { name: /Sign In/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Invalid email or password')).toBeDefined();
    });
  });

  it('LoginPage handles successful login and saves credentials', async () => {
    const mockLogin = vi.fn();
    const mockUser = { id: 1, email: 'valid@example.com', username: 'ValidUser' };
    vi.spyOn(authApi, 'loginApi').mockResolvedValueOnce({
      data: { access_token: 'fake-jwt-token-123', user: mockUser },
    } as any);

    const { AuthContext } = await import('../context/auth-context-base');

    render(
      <AuthContext.Provider value={{ user: null, token: null, login: mockLogin, logout: vi.fn(), loading: false }}>
        <BrowserRouter>
          <LoginPage />
        </BrowserRouter>
      </AuthContext.Provider>
    );

    const emailInput = screen.getByLabelText(/Email/i);
    const passwordInput = screen.getByLabelText(/Password/i);

    fireEvent.change(emailInput, { target: { value: 'valid@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'securepassword123' } });

    const submitBtn = screen.getByRole('button', { name: /Sign In/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('fake-jwt-token-123', mockUser);
    });
  });

  it('StudyPage displays finished message when no cards are due', async () => {
    vi.spyOn(studyApi, 'getNextCard').mockResolvedValue({ data: null } as any);
    vi.spyOn(studyApi, 'getStudyStats').mockResolvedValue({
      data: {
        total_cards: 10,
        new_cards: 0,
        learn_cards: 0,
        due_cards: 0,
        learned_cards: 10,
        avg_ease: 2.5,
        streak_days: 1,
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
      expect(screen.getByText(/Congratulations!/i)).toBeDefined();
      expect(screen.getByText(/You've finished studying this deck for now/i)).toBeDefined();
    });
  });

  it('StudyPage renders error alert when reviewCard API submission fails', async () => {
    const cardData = {
      card_id: 42,
      deck_id: 1,
      deck_name: 'Biology 101',
      front: 'What is mitochondria?',
      back: 'Powerhouse of the cell',
      card_state: 'learning',
      intervals: {
        again: { display: '< 1m' },
        hard: { display: '1d' },
        good: { display: '3d' },
        easy: { display: '4d' },
      },
    };

    vi.spyOn(studyApi, 'getNextCard').mockResolvedValue({ data: cardData } as any);
    vi.spyOn(studyApi, 'getStudyStats').mockResolvedValue({
      data: { total_cards: 1, new_cards: 0, learn_cards: 1, due_cards: 1, learned_cards: 0, avg_ease: 2.5, streak_days: 1 },
    } as any);

    const reviewCardMock = vi.spyOn(studyApi, 'reviewCard');
    reviewCardMock.mockRejectedValueOnce({
      response: { data: { detail: 'Server database write error' } },
    });

    render(
      <MemoryRouter initialEntries={['/study/1']}>
        <Routes>
          <Route path="/study/:deckId" element={<StudyPage />} />
        </Routes>
      </MemoryRouter>
    );

    // Card front should appear
    await waitFor(() => {
      expect(screen.getByText('What is mitochondria?')).toBeDefined();
    });

    // Flip card to reveal answer
    const showAnswerBtn = screen.getByRole('button', { name: /Show Answer/i });
    fireEvent.click(showAnswerBtn);

    await waitFor(() => {
      expect(screen.getByText('Powerhouse of the cell')).toBeDefined();
    });

    // Click rating "Good" (rating 3)
    const goodBtn = screen.getByRole('button', { name: /Good/i });
    fireEvent.click(goodBtn);

    // Review failed, should render visible error alert
    await waitFor(() => {
      expect(screen.getByText('Server database write error')).toBeDefined();
    });

    // Card should still be visible, allowing user to retry
    expect(screen.getByText('Powerhouse of the cell')).toBeDefined();
  });
});
