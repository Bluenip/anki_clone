import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import IntroPage, { INTRO_STEPS } from '../pages/IntroPage';
import * as auth from '../context/useAuth';

describe('IntroPage', () => {
  it('works logged out and jumps the video to a step', () => {
    vi.spyOn(auth, 'useAuth').mockReturnValue({ user: null } as any);
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    Element.prototype.scrollIntoView = vi.fn();
    const { container } = render(<MemoryRouter><IntroPage /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /Tạo tài khoản/ })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Thêm thẻ mới/ }));
    expect(container.querySelector('video')!.currentTime).toBe(INTRO_STEPS[5].at);
    expect(play).toHaveBeenCalled();
  });

  it('links logged-in users to their decks', () => {
    vi.spyOn(auth, 'useAuth').mockReturnValue({ user: { id: 1 } } as any);
    render(<MemoryRouter><IntroPage /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /Vào bộ thẻ/ }).getAttribute('href')).toBe('/decks');
  });
});
