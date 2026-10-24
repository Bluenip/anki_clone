import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import StudyPage from '../pages/StudyPage';
import DeckOptionsPage from '../pages/DeckOptionsPage';
import * as study from '../api/study';
import * as decks from '../api/decks';
import * as options from '../api/options';
vi.mock('../api/study');
vi.mock('../api/decks');
vi.mock('../api/options');
vi.mock('../sounds',()=>({playFlipSound:vi.fn(),playRatingSound:vi.fn(),playCompleteSound:vi.fn()}));
const opts={preset_id:null,preset_name:null,preset_version:null,preset_settings:'{}',settings:'{}',overrides:{},today:{},presets:[{id:9,name:'Shared',settings:'{}',version:0,used_by:[]}]};
function Navigation({path}:{path:string}) { const nav=useNavigate(); return <button onClick={()=>nav(path)}>Switch deck</button>; }
function open(kind:'study'|'options') {
  const path=kind==='study'?'/study/':'/decks/';
  const suffix=kind==='study'?'':'/options';
  render(<MemoryRouter initialEntries={[`${path}1${suffix}`]}><Navigation path={`${path}2${suffix}`} /><Routes>
    <Route path={`${path}:deckId${suffix}`} element={kind==='study'?<StudyPage/>:<DeckOptionsPage/>}/>
  </Routes></MemoryRouter>);
}
beforeEach(()=>{
  vi.resetAllMocks();
  vi.mocked(study.getNextCard).mockImplementation(async id=>({data:{card_id:id,front:`Question ${id}`,back:`Answer ${id}`,version:0,settings:{}}} as never));
  vi.mocked(study.getStudyStats).mockResolvedValue({data:{}} as never);
  vi.mocked(decks.getDeck).mockImplementation(async id=>({data:{id,name:`Deck ${id}`,settings:'{}'}} as never));
  vi.mocked(options.getDeckOptions).mockResolvedValue({data:opts} as never);
});
it('late review from an old deck never reloads that deck into the new reviewer',async()=>{
  let finish!:(value:never)=>void;
  vi.mocked(study.reviewCard).mockImplementation(()=>new Promise<never>(resolve=>{finish=resolve;}));
  open('study');await screen.findByText('Question 1');
  fireEvent.keyDown(window,{key:' '});await screen.findByText('Answer 1');
  fireEvent.keyDown(window,{key:'3'});await waitFor(()=>expect(study.reviewCard).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText('Switch deck'));await screen.findByText('Question 2');
  await act(async()=>finish({data:{}} as never));
  expect(screen.queryByText('Question 1')).toBeNull();
  expect(study.getNextCard).toHaveBeenCalledTimes(2);
});
it('late options save cannot replace the next deck preset revision',async()=>{
  let finish!:(value:never)=>void;
  vi.mocked(options.saveDeckOptions).mockImplementationOnce(()=>new Promise<never>(resolve=>{finish=resolve;}));
  open('options');await screen.findByLabelText('New cards/day');
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  fireEvent.click(screen.getByText('Switch deck'));await screen.findByText('Options for Deck 2');
  await act(async()=>finish({data:{...opts,preset_version:99,preset_id:9,preset_name:'Wrong deck preset'}} as never));
  expect(screen.queryByText(/Wrong deck preset/)).toBeNull();
  vi.mocked(options.saveDeckOptions).mockResolvedValue({data:opts} as never);
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(options.saveDeckOptions).toHaveBeenCalledTimes(2));
  expect(vi.mocked(options.saveDeckOptions).mock.calls[1][0]).toBe(2);
  expect(vi.mocked(options.saveDeckOptions).mock.calls[1][2]).toBeUndefined();
});
it('preset attachment blocks a competing main settings save',async()=>{
  let finish!:(value:never)=>void;
  vi.mocked(options.bindPreset).mockImplementation(()=>new Promise<never>(resolve=>{finish=resolve;}));
  open('options');await screen.findByLabelText('New cards/day');
  fireEvent.click(screen.getByText('Presets and daily limit overrides'));
  fireEvent.change(screen.getByLabelText('Select preset to attach'),{target:{value:'9'}});
  fireEvent.click(screen.getByRole('button',{name:'Attach'}));
  await waitFor(()=>expect(options.bindPreset).toHaveBeenCalledTimes(1));
  expect((screen.getByRole('button',{name:'Save'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  expect(options.saveDeckOptions).not.toHaveBeenCalled();
  await act(async()=>finish({data:{...opts,preset_id:9,preset_version:1}} as never));
  expect((screen.getByRole('button',{name:'Save'}) as HTMLButtonElement).disabled).toBe(false);
});
