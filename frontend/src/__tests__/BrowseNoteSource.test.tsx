import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BrowsePage from '../pages/BrowsePage';
import * as cards from '../api/cards';
import * as notes from '../api/notes';
vi.mock('../api/cards');
vi.mock('../api/notes');
const card = { id: 1, note_id: 7, deck_id: 1, deck_name: 'English', front: 'Rendered question', back: 'Rendered question<hr>Answer', version: 3 };
const source = { id: 7, fields: { Front: 'Original', Back: 'Answer', Extra: 'Keep me' }, tags: ['existing'], revision: 'revision-7' };
const open = () => render(<MemoryRouter><BrowsePage /></MemoryRouter>);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(cards.browseCards).mockResolvedValue({data: [card]} as never);
  vi.mocked(notes.getCardNote).mockResolvedValue({data: source} as never);
  vi.mocked(notes.updateNote).mockResolvedValue({data: source} as never);
});
describe('Browse original note editing', () => {
  it('saves original fields with revision and preserves other fields and tags', async () => {
    open();
    const front = await screen.findByLabelText('Front');
    expect((front as HTMLTextAreaElement).value).toBe('Original');
    expect((screen.getByLabelText('Back') as HTMLTextAreaElement).value).toBe('Answer');
    fireEvent.click(screen.getByText('Rendered question'));
    expect((screen.getByRole('button', {name: 'Save Changes'}) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(front, {target: {value: 'Edited'}});
    fireEvent.click(screen.getByRole('button', {name: 'Save Changes'}));
    await screen.findByText('Saved!');
    expect(notes.updateNote).toHaveBeenCalledWith(7, {fields: {...source.fields, Front: 'Edited'}, tags: ['existing'], expected_revision: 'revision-7'});
    expect(cards.updateCard).not.toHaveBeenCalled();
  });
  it('keeps saving disabled when fetching source fails', async () => {
    vi.mocked(notes.getCardNote).mockRejectedValue(new Error('Source unavailable'));
    open();
    await screen.findByText('Source unavailable');
    expect((screen.getByRole('button', {name: 'Save Changes'}) as HTMLButtonElement).disabled).toBe(true);
    expect(cards.updateCard).not.toHaveBeenCalled();
  });
  it('ignores a source response from a previously selected card', async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(cards.browseCards).mockResolvedValue({data: [card, {...card,id: 2,note_id: 8,front: 'Second card'}]} as never);
    vi.mocked(notes.getCardNote).mockImplementationOnce(() => new Promise(r => {resolve = r;}) as never)
      .mockResolvedValueOnce({data: {...source,id: 8,fields: {Front: 'Second source'}}} as never);
    open();
    await waitFor(() => expect(notes.getCardNote).toHaveBeenCalledWith(1));
    fireEvent.click(screen.getByText('Second card'));
    await screen.findByDisplayValue('Second source');
    await act(async () => resolve({data: source}));
    expect((screen.getByLabelText('Front') as HTMLTextAreaElement).value).toBe('Second source');
  });
});
