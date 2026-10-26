import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import VisualField from '../components/VisualField';
import { answerDiff } from '../utils/answerDiff';
afterEach(cleanup);
function Field() { const [value,setValue]=useState('<b>Hello</b>'); return <><VisualField targetId="field" disabled={false} onChange={setValue}/><textarea id="field" value={value} onChange={e=>setValue(e.target.value)}/></>; }

describe('Authoring',()=>{
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
});
