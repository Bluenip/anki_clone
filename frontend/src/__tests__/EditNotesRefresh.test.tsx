import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import CardEditorPage from '../pages/CardEditorPage';
import * as cards from '../api/cards';
import * as notes from '../api/notes';
vi.mock('../api/cards');
vi.mock('../api/notes');
const oldCard={id:1,deck_id:1,front:'Old deck card',back:'answer',created_at:'',updated_at:''};
const newCard={...oldCard,id:2,deck_id:2,front:'New deck card'};
const note={id:10,guid:'g',kind:'basic',fields:{Front:'Old deck card',Back:'answer'},tags:['topic,one','keep'],cards:[{...oldCard,template_ord:0}]};
function Page() {
  const navigate=useNavigate();
  return <><button onClick={()=>navigate('/decks/2/cards')}>Go deck two</button><CardEditorPage /></>;
}
function open() {
  render(<MemoryRouter initialEntries={['/decks/1/cards']}><Routes><Route path="/decks/:deckId/cards" element={<Page />} /></Routes></MemoryRouter>);
}
beforeEach(()=>{
  vi.resetAllMocks();
  vi.mocked(cards.listCards).mockResolvedValue({data:[oldCard]} as never);
  vi.mocked(notes.getCardNote).mockResolvedValue({data:note} as never);
  vi.mocked(notes.updateNote).mockResolvedValue({data:note} as never);
});

it('preserves literal commas in tags when saving an existing note', async()=>{
  open();fireEvent.click(await screen.findByRole('button',{name:'Edit'}));
  await screen.findByLabelText('Tags');
  fireEvent.click(screen.getByRole('button',{name:'Update'}));
  await waitFor(()=>expect(notes.updateNote).toHaveBeenCalledWith(10,{fields:note.fields,tags:['topic,one','keep']}));
});

it('drops a late post-save list refresh after navigating to another deck', async()=>{
  let resolveOld!: (value: never)=>void;
  const pending=new Promise<never>(resolve=>{resolveOld=resolve;});
  let oldCalls=0;
  vi.mocked(cards.listCards).mockImplementation((did)=>{
    if(did===2)return Promise.resolve({data:[newCard]} as never);
    return ++oldCalls===1 ? Promise.resolve({data:[oldCard]} as never) : pending;
  });
  open();fireEvent.click(await screen.findByRole('button',{name:'Edit'}));
  await screen.findByLabelText('Tags');
  fireEvent.click(screen.getByRole('button',{name:'Update'}));
  await waitFor(()=>expect(oldCalls).toBe(2));
  fireEvent.click(screen.getByRole('button',{name:'Go deck two'}));
  await screen.findByText('New deck card');
  await act(async()=>resolveOld({data:[oldCard]} as never));
  expect(screen.queryByText('Old deck card')).toBeNull();
  expect(screen.getByText('New deck card')).toBeDefined();
});

it('keeps newer search results when an older-context save completes', async()=>{
  let resolveSave!: (value: never)=>void;
  vi.mocked(notes.updateNote).mockImplementation(()=>new Promise<never>(resolve=>{resolveSave=resolve;}));
  vi.mocked(cards.listCards).mockImplementation((_did,query)=>Promise.resolve({data:query==='missing' ? [] : [oldCard]} as never));
  open();fireEvent.click(await screen.findByRole('button',{name:'Edit'}));
  await screen.findByLabelText('Tags');
  fireEvent.click(screen.getByRole('button',{name:'Update'}));
  fireEvent.change(screen.getByRole('textbox',{name:'Search cards'}),{target:{value:'missing'}});
  await screen.findByText('No cards yet. Add your first card!');
  await act(async()=>resolveSave({data:note} as never));
  expect(screen.queryByText('Old deck card')).toBeNull();
  expect(screen.getByText('No cards yet. Add your first card!')).toBeDefined();
});
