import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import VisualField from '../components/VisualField';
import { answerDiff } from '../utils/answerDiff';
import { scheduleOffline, nextLocalDay } from '../utils/offlineScheduler';
import type { CachedCard } from '../utils/offline';
afterEach(cleanup);
function Field() { const [value,setValue]=useState('<b>Hello</b>'); return <><VisualField targetId="field" disabled={false} onChange={setValue}/><textarea id="field" value={value} onChange={e=>setValue(e.target.value)}/></>; }

describe('Authoring and offline scheduling',()=>{
  it('preserves HTML while toggling editor and sanitizes visual input',()=>{
    render(<Field/>);fireEvent.click(screen.getByText('Visual editor'));
    const editor=screen.getByRole('textbox',{name:'Visual field'});
    expect(editor.innerHTML).toBe('<b>Hello</b>');
    editor.innerHTML='<i>Edited</i><img src="x" onerror="alert(1)">';fireEvent.input(editor);
    fireEvent.click(screen.getByText('Edit HTML source'));
    const source=document.getElementById('field') as HTMLTextAreaElement;
    expect(source.value).toContain('<i>Edited</i>');expect(source.value).not.toContain('onerror');expect(source.hidden).toBe(false);
  });
  it('diffs Unicode graphemes and bounds long dissimilar answers',()=>{
    expect(answerDiff('cafe\u0301','café')).toEqual([{kind:'same',text:'café'}]);
    const result=answerDiff('a👩‍💻x','a👩‍💻y');
    expect(result).toEqual([{kind:'same',text:'a👩‍💻'},{kind:'delete',text:'x'},{kind:'insert',text:'y'}]);
    expect(answerDiff('a'.repeat(2000),'b'.repeat(2000))).toHaveLength(2);
  });
  it('repeats offline learning, graduates and increments the queued version',()=>{
    const now=new Date('2026-10-26T12:00:00Z');
    const card:CachedCard={card_id:1,deck_name:'Test',front:'Q',back:'A',version:0,settings_hash:'a'.repeat(64),eligible:true,study_deck_id:1,offline_config:{learning_steps:'1m 10m'},offline_state:{card_state:'new',learning_step:0,interval_days:0,ease_factor:2.5,repetitions:0,lapse_count:0,is_suspended:false,next_review:null}};
    const again=scheduleOffline(card,1,now);expect(again.local_due).toBe('2026-10-26T12:01:00.000Z');
    const good=scheduleOffline(again,3,new Date(again.local_due!));expect(good.local_due).toBe('2026-10-26T12:11:00.000Z');
    const graduate=scheduleOffline(good,3,new Date(good.local_due!));expect(graduate.offline_state?.card_state).toBe('review');expect(graduate.version).toBe(3);
    expect(graduate.local_due).toBe('2026-10-27T00:00:00.000Z');
  });
  it('computes study-day rollover across a DST boundary',()=>{
    expect(nextLocalDay(new Date('2026-10-31T16:00:00Z'),'America/New_York',4,1).toISOString()).toBe('2026-11-01T09:00:00.000Z');
  });
});
