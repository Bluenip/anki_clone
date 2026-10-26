import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import StudyAutomation from '../components/StudyAutomation';
import CardFace from '../components/CardFace';
import type { CardFaceRef } from '../components/CardFace';
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});

it('waits for audio before auto reveal and performs a phase action only once',()=>{
  vi.useFakeTimers();let playing=true;
  const face={current:{playAudio:vi.fn().mockResolvedValue(undefined),stopAudio:vi.fn(),isPlaying:()=>playing,getIframe:()=>({contentDocument:{readyState:'complete'}} as HTMLIFrameElement)}};
  const reveal=vi.fn(),rate=vi.fn(),bury=vi.fn();
  const card={card_id:1,deck_name:'D',front:'Q',back:'A',settings:{seconds_to_show_question_for:1,wait_for_audio:true}};
  render(<StudyAutomation card={card} face={face} showAnswer={false} busy={false} onReveal={reveal} onRate={rate} onBury={bury}/>);
  act(()=>vi.advanceTimersByTime(2000));expect(reveal).not.toHaveBeenCalled();expect(face.current.playAudio).toHaveBeenCalledTimes(1);
  playing=false;act(()=>vi.advanceTimersByTime(100));expect(reveal).toHaveBeenCalledTimes(1);
  act(()=>vi.advanceTimersByTime(2000));expect(reveal).toHaveBeenCalledTimes(1);
});

it('does not auto-rate while a request is pending and cancels audio on unmount',()=>{
  vi.useFakeTimers();const face={current:{playAudio:vi.fn().mockResolvedValue(undefined),stopAudio:vi.fn(),isPlaying:()=>false,getIframe:()=>({contentDocument:{readyState:'complete'}} as HTMLIFrameElement)}};
  const card={card_id:1,deck_name:'D',front:'Q',back:'A',settings:{seconds_to_show_answer_for:1,answer_action:'Good'}};
  const rate=vi.fn(),noop=vi.fn();
  const view=render(<StudyAutomation card={card} face={face} showAnswer busy onReveal={noop} onRate={rate} onBury={noop}/>);
  act(()=>vi.advanceTimersByTime(2000));expect(rate).not.toHaveBeenCalled();
  view.rerender(<StudyAutomation card={card} face={face} showAnswer busy={false} onReveal={noop} onRate={rate} onBury={noop}/>);
  act(()=>vi.advanceTimersByTime(100));expect(rate).toHaveBeenCalledWith(3);
  view.unmount();expect(face.current.stopAudio).toHaveBeenCalled();
});

it('plays TTS descriptors in order with voice, speed and cancellation',async()=>{
  const spoken: {text:string;lang:string;rate:number;voice:unknown;onend?:()=>void}[]=[];
  class Utterance {lang='';rate=1;voice=null;onend?:()=>void; text:string; constructor(text:string){this.text=text;} }
  const voice={name:'Voice One',lang:'en-US'};
  const speech={cancel:vi.fn(),getVoices:()=>[voice],speak:vi.fn((u:Utterance)=>spoken.push(u))};
  vi.stubGlobal('SpeechSynthesisUtterance',Utterance);vi.stubGlobal('speechSynthesis',speech);
  const ref=createRef<CardFaceRef>();
  const html='<span data-tts="First" data-tts-lang="en-US" data-tts-rate="0.8" data-tts-voices="Voice_One"></span><span data-tts="Second"></span>';
  render(<CardFace ref={ref} html={html}/>);
  const iframe=document.querySelector('iframe')!;iframe.contentDocument!.body.innerHTML=html;
  await act(async()=>{await ref.current!.playAudio();});
  expect(spoken[0].text).toBe('First');expect(spoken[0].voice).toBe(voice);expect(spoken[0].rate).toBe(.8);
  act(()=>spoken[0].onend?.());expect(spoken[1].text).toBe('Second');
  act(()=>ref.current!.stopAudio());expect(ref.current!.isPlaying()).toBe(false);expect(speech.cancel).toHaveBeenCalled();
});
