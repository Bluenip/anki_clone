import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BrowsePage from '../pages/BrowsePage';
import * as api from '../api/cards';
import * as decksApi from '../api/decks';
vi.mock('../api/decks');
vi.mock('../api/cards');
const card: api.BrowseCard = { id: 1, deck_id: 1, front: 'question', back: 'answer', deck_name: 'Deck',
  created_at: '', updated_at: '', version: 3, is_suspended: false, is_buried: false, card_state: 'new', note_id: null };
const open = () => render(<MemoryRouter><BrowsePage /></MemoryRouter>);
beforeEach(() => { vi.resetAllMocks(); });

describe('Browser safety', () => {
  it('limits select all to 500 and submits exactly those displayed IDs', async () => {
    vi.mocked(api.browseCards).mockResolvedValue({ data: Array.from({length:501},(_,i)=>({...card,id:i+1})) } as never);
    vi.mocked(api.bulkActionCards).mockResolvedValue({ data: {updated:500} } as never);
    open();
    await screen.findByLabelText('Select card 501');
    fireEvent.click(screen.getByLabelText('Select all displayed'));
    expect((screen.getByLabelText('Select card 501') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Select card 501') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'Suspend'}));
    await waitFor(()=>expect(api.bulkActionCards).toHaveBeenCalledTimes(1));
    const payload=vi.mocked(api.bulkActionCards).mock.calls[0][0] as api.BulkActionRequest;
    expect(payload.cards.map(c=>c.card_id)).toEqual(Array.from({length:500},(_,i)=>i+1));
  });

  it('drops selections from previous pages and uses the active query for paging', async () => {
    vi.mocked(api.browseCards).mockResolvedValueOnce({data:Array.from({length:1000},(_,i)=>({...card,id:i+1}))} as never)
      .mockResolvedValue({data:[{...card,id:1001}]} as never);
    vi.mocked(api.bulkActionCards).mockResolvedValue({data:{updated:1}} as never);
    open(); await screen.findByLabelText('Select card 1000');
    fireEvent.click(screen.getByLabelText('Select card 1'));
    fireEvent.change(screen.getByLabelText('Search cards query'),{target:{value:'draft query'}});
    fireEvent.click(screen.getByRole('button',{name:'Next page'}));
    await screen.findByLabelText('Select card 1001');
    expect(api.browseCards).toHaveBeenLastCalledWith('',1000);
    expect(screen.getByTestId('selection-count').textContent).toBe('0 selected');
    expect(screen.queryByLabelText('Select card 1')).toBeNull();
    fireEvent.click(screen.getByLabelText('Select card 1001'));
    fireEvent.click(screen.getByRole('button',{name:'Bury'}));
    await screen.findByRole('status');
    expect(api.bulkActionCards).toHaveBeenCalledWith({action:'bury',cards:[{card_id:1001,expected_version:3}]});
    expect(api.browseCards).toHaveBeenLastCalledWith('',1000);
  });

  it('sends the displayed edit version and reloads the actual backend version', async () => {
    vi.mocked(api.browseCards).mockResolvedValueOnce({data:[card]} as never)
      .mockResolvedValueOnce({data:[{...card,front:'edited',version:9}]} as never);
    vi.mocked(api.updateCard).mockResolvedValue({data:{}} as never);
    vi.mocked(api.bulkActionCards).mockRejectedValue({response:{status:409}});
    open(); await screen.findByLabelText('Front');
    fireEvent.change(screen.getByLabelText('Front'),{target:{value:'edited'}});
    fireEvent.click(screen.getByRole('button',{name:'Save Changes'}));
    await screen.findByText('Saved!');
    expect(api.updateCard).toHaveBeenCalledWith(1,{front:'edited',back:'answer',expected_version:3});
    fireEvent.click(screen.getByLabelText('Select card 1'));
    fireEvent.click(screen.getByRole('button',{name:'Bury'}));
    await waitFor(()=>expect(api.bulkActionCards).toHaveBeenCalledWith({action:'bury',cards:[{card_id:1,expected_version:9}]}));
  });

  it('moves selected cards to an explicitly chosen deck and refreshes the applied query', async () => {
    vi.mocked(api.browseCards).mockResolvedValue({data:[card]} as never);
    vi.mocked(decksApi.listDecks).mockResolvedValue({data:[{id:2,name:'Destination'}]} as never);
    vi.mocked(api.bulkActionCards).mockResolvedValue({data:{updated:1}} as never);
    open(); await screen.findByLabelText('Select card 1');
    fireEvent.click(screen.getByLabelText('Select card 1'));
    fireEvent.click(screen.getByRole('button',{name:'Change Deck'}));
    await screen.findByLabelText('Destination deck');
    expect((screen.getByRole('button',{name:'Move selected cards'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Destination deck'),{target:{value:'2'}});
    fireEvent.change(screen.getByLabelText('Search cards query'),{target:{value:'unsubmitted draft'}});
    fireEvent.click(screen.getByRole('button',{name:'Move selected cards'}));
    await screen.findByRole('status');
    expect(api.bulkActionCards).toHaveBeenCalledWith({action:'move',target_deck_id:2,cards:[{card_id:1,expected_version:3}]});
    expect(api.browseCards).toHaveBeenLastCalledWith('',0);
    expect(screen.queryByLabelText('Destination deck')).toBeNull();
  });

  it('clears the editor after an invalid query and renders structured422 errors safely', async () => {
    vi.mocked(api.browseCards).mockResolvedValueOnce({data:[card]} as never)
      .mockRejectedValueOnce({response:{status:422,data:{detail:[{msg:'invalid'}]}}});
    open(); await screen.findByLabelText('Front');
    fireEvent.change(screen.getByLabelText('Search cards query'),{target:{value:'invalid:'}});
    fireEvent.click(screen.getByRole('button',{name:'Search'}));
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid search');
    expect(screen.queryByLabelText('Front')).toBeNull();
    expect(screen.queryByRole('button',{name:'Save Changes'})).toBeNull();
  });
});
