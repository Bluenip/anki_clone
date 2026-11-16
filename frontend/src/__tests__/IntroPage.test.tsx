import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import IntroPage, { INTRO_STEPS } from '../pages/IntroPage';
import * as auth from '../context/useAuth';
import * as prefs from '../context/usePrefs';
import { translator } from '../context/prefs-context-base';

describe('IntroPage', () => {
  it('works logged out and jumps the video to a step', () => {
    vi.spyOn(auth, 'useAuth').mockReturnValue({ user: null } as any);
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    Element.prototype.scrollIntoView = vi.fn();
    const { container } = render(<MemoryRouter><IntroPage /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /Create a free account/ })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Add new cards/ }));
    expect(container.querySelector('video')!.currentTime).toBe(INTRO_STEPS[7].at.en);
    expect(play).toHaveBeenCalled();
    // English UI plays the English narration.
    expect(container.querySelector('video source')!.getAttribute('src')).toBe('/guide-media/guide-en.mp4');
    expect(container.querySelector('video')!.getAttribute('poster')).toBe('/guide-media/poster-en.jpg');
  });

  it('links logged-in users to their decks', () => {
    vi.spyOn(auth, 'useAuth').mockReturnValue({ user: { id: 1 } } as any);
    render(<MemoryRouter><IntroPage /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /Go to your decks/ }).getAttribute('href')).toBe('/decks');
  });

  it('Vietnamese UI plays the Vietnamese narration and uses its own step times', () => {
    vi.spyOn(auth, 'useAuth').mockReturnValue({ user: null } as any);
    vi.spyOn(prefs, 'usePrefs').mockReturnValue({ t: translator('vi'), lang: 'vi' } as any);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    Element.prototype.scrollIntoView = vi.fn();
    const { container } = render(<MemoryRouter><IntroPage /></MemoryRouter>);
    expect(container.querySelector('video source')!.getAttribute('src')).toBe('/guide-media/guide-vi.mp4');
    fireEvent.click(screen.getByRole('button', { name: /Học tùy chỉnh/ }));
    expect(container.querySelector('video')!.currentTime).toBe(112);
    vi.restoreAllMocks();
  });
});
