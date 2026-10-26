import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import DecksPage from '../pages/DecksPage';
import * as api from '../api/decks';

vi.mock('../api/decks');
vi.mock('../api/notes', () => ({
  getNoteTypes: vi.fn().mockResolvedValue({
    data: [
      { kind: 'basic', name: 'Basic', fields: ['Front', 'Back'] },
      { kind: 'reversed', name: 'Basic (and reversed card)', fields: ['Front', 'Back'] },
      { kind: 'optional_reversed', name: 'Basic (optional reversed card)', fields: ['Front', 'Back', 'Add Reverse'] },
      { kind: 'cloze', name: 'Cloze', fields: ['Text', 'Extra'] },
    ],
  }),
}));

function mount() {
  vi.mocked(api.listDecks).mockResolvedValue({ data: [{ id: 1, name: 'Test deck', total_cards: 1, new_cards: 1, learn_cards: 0, due_cards: 0 }] } as never);
  return render(<BrowserRouter><DecksPage /></BrowserRouter>);
}

async function openImport() {
  fireEvent.click(await screen.findByLabelText('Options for deck Test deck'));
  fireEvent.click(screen.getByText('Import Cards'));
  return screen.getByLabelText(/Basic notes: Front/);
}

describe('Text transfer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('tracks keyboard viewport changes and restores page scrolling when import closes', async () => {
    const viewport = Object.assign(new EventTarget(), { height: 350, offsetTop: 100 });
    const oldViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    const remove = vi.spyOn(viewport, 'removeEventListener');
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'auto';
    const view = mount();
    try {
      await openImport();
      const overlay = screen.getByRole('dialog', { name: 'Import cards' });
      expect(overlay.style.getPropertyValue('--import-viewport-height')).toBe('350px');
      expect(document.body.style.overflow).toBe('hidden');
      viewport.height = 280;
      viewport.offsetTop = 120;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
      expect(overlay.style.getPropertyValue('--import-viewport-height')).toBe('280px');
      expect(overlay.style.getPropertyValue('--import-viewport-top')).toBe('120px');
      fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
      expect(document.body.style.overflow).toBe('auto');
      expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
      expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
    } finally {
      view.unmount();
      document.body.style.overflow = oldOverflow;
      if (oldViewport) Object.defineProperty(window, 'visualViewport', oldViewport);
      else Reflect.deleteProperty(window, 'visualViewport');
    }
  });

  it('keeps package export errors visible when the download API returns a JSON blob', async () => {
    const blob=new Blob(['{}'],{type:'application/json'});
    Object.defineProperty(blob,'text',{value:async()=>JSON.stringify({detail:'Export decks with matching scheduler settings together'})});
    vi.mocked(api.exportApkg).mockRejectedValue({response:{data:blob}});
    mount();
    fireEvent.click(await screen.findByLabelText('Options for deck Test deck'));
    fireEvent.click(screen.getByRole('menuitem',{name:'Export'}));
    fireEvent.click(screen.getByRole('button',{name:'Export'}));
    await screen.findByText('Export decks with matching scheduler settings together');
    expect(api.exportApkg).toHaveBeenCalledWith(1,false,true);
  });

  it('requires a fresh preview after input changes before confirming writes', async () => {
    vi.mocked(api.importCards).mockResolvedValue({ data: { message: '1 added' } } as never);
    mount();
    const input = await openImport();
    fireEvent.change(input, { target: { value: 'Q\tA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview Import' }));
    await screen.findByRole('button', { name: 'Confirm Import' });
    expect(vi.mocked(api.importCards).mock.calls[0][3]?.preview).toBe(true);
    fireEvent.change(input, { target: { value: 'Q\tB' } });
    expect(screen.queryByRole('button', { name: 'Confirm Import' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Preview Import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Import' }));
    await waitFor(() => expect(api.importCards).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.importCards).mock.calls.map(call => call[3]?.preview)).toEqual([true, true, false]);
  });

  it('keeps uploaded CSV content in the import form and selects comma separator', async () => {
    mount();
    await screen.findByText('Test deck');
    const file = new File(['"Việt, Nam",Answer'], 'notes.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Upload file for import'), { target: { files: [file] } });
    const input = await screen.findByLabelText(/Basic notes: Front/) as HTMLTextAreaElement;
    expect(input.value).toBe('"Việt, Nam",Answer');
    expect((screen.getByLabelText('Separator') as HTMLSelectElement).value).toBe(',');
  });

  it('defaults to basic import without kind or field_columns when advanced mode is off', async () => {
    vi.mocked(api.importCards).mockResolvedValue({ data: { message: '1 added' } } as never);
    mount();
    const input = await openImport();
    fireEvent.change(input, { target: { value: 'Front\tBack' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview Import' }));
    await screen.findByRole('button', { name: 'Confirm Import' });
    expect(vi.mocked(api.importCards)).toHaveBeenCalledWith(
      1,
      'Front\tBack',
      '\t',
      {
        preview: true,
        duplicate_policy: 'add',
        has_header: false,
        allow_html: true,
        front_column: 0,
        back_column: 1,
      }
    );
  });

  it('sends kind, field_columns, optional columns and tags when advanced mode is enabled', async () => {
    vi.mocked(api.importCards).mockResolvedValue({ data: { message: '1 added' } } as never);
    mount();
    const input = await openImport();
    fireEvent.change(input, { target: { value: 'col0\tcol1\tcol2\tcol3\tcol4' } });

    // Enable advanced mode
    fireEvent.click(screen.getByLabelText(/Advanced mapping/i));

    // Select 'optional_reversed'
    const kindSelect = screen.getByLabelText(/Note type/i);
    fireEvent.change(kindSelect, { target: { value: 'optional_reversed' } });

    // Verify field column inputs exist for Front, Back, Add Reverse
    expect(screen.getByLabelText('Column for Front')).toBeDefined();
    expect(screen.getByLabelText('Column for Back')).toBeDefined();
    expect(screen.getByLabelText('Column for Add Reverse')).toBeDefined();

    // Map columns
    fireEvent.change(screen.getByLabelText('Column for Front'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Column for Back'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Column for Add Reverse'), { target: { value: '2' } });

    // Tags column, guid column, global tags
    fireEvent.change(screen.getByLabelText('Tags column'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('GUID column'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Global tags'), { target: { value: 'vocab ch1' } });

    // Preview
    fireEvent.click(screen.getByRole('button', { name: 'Preview Import' }));
    await screen.findByRole('button', { name: 'Confirm Import' });

    expect(vi.mocked(api.importCards)).toHaveBeenCalledWith(
      1,
      'col0\tcol1\tcol2\tcol3\tcol4',
      '\t',
      {
        preview: true,
        duplicate_policy: 'add',
        has_header: false,
        allow_html: true,
        kind: 'optional_reversed',
        field_columns: {
          Front: 1,
          Back: 0,
          'Add Reverse': 2,
        },
        tags_column: 3,
        guid_column: 4,
        tags: ['vocab', 'ch1'],
      }
    );

    // Confirm
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Import' }));
    await waitFor(() => {
      expect(vi.mocked(api.importCards)).toHaveBeenCalledWith(
        1,
        'col0\tcol1\tcol2\tcol3\tcol4',
        '\t',
        {
          preview: false,
          duplicate_policy: 'add',
          has_header: false,
          allow_html: true,
          kind: 'optional_reversed',
          field_columns: {
            Front: 1,
            Back: 0,
            'Add Reverse': 2,
          },
          tags_column: 3,
          guid_column: 4,
          tags: ['vocab', 'ch1'],
        }
      );
    });
  });

  it('switching to cloze updates field mapping inputs to Text and Extra', async () => {
    vi.mocked(api.importCards).mockResolvedValue({ data: { message: '1 added' } } as never);
    mount();
    const input = await openImport();
    fireEvent.change(input, { target: { value: 'Text\tExtra' } });

    fireEvent.click(screen.getByLabelText(/Advanced mapping/i));
    const kindSelect = screen.getByLabelText(/Note type/i);
    fireEvent.change(kindSelect, { target: { value: 'cloze' } });

    expect(screen.getByLabelText('Column for Text')).toBeDefined();
    expect(screen.getByLabelText('Column for Extra')).toBeDefined();
    expect(screen.queryByLabelText('Column for Front')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Preview Import' }));
    await screen.findByRole('button', { name: 'Confirm Import' });

    expect(vi.mocked(api.importCards)).toHaveBeenCalledWith(
      1,
      'Text\tExtra',
      '\t',
      expect.objectContaining({
        kind: 'cloze',
        field_columns: {
          Text: 0,
          Extra: 1,
        },
      })
    );
  });

  it('requires a fresh preview when advanced inputs change', async () => {
    vi.mocked(api.importCards).mockResolvedValue({ data: { message: '1 added' } } as never);
    mount();
    const input = await openImport();
    fireEvent.change(input, { target: { value: 'Hello\tWorld\ttag' } });

    // Enable advanced mode
    fireEvent.click(screen.getByLabelText(/Advanced mapping/i));

    // Preview
    fireEvent.click(screen.getByRole('button', { name: 'Preview Import' }));
    await screen.findByRole('button', { name: 'Confirm Import' });

    // Change global tags -> confirm button must disappear
    fireEvent.change(screen.getByLabelText('Global tags'), { target: { value: 'newtag' } });
    expect(screen.queryByRole('button', { name: 'Confirm Import' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Preview Import' }));
    await screen.findByRole('button', { name: 'Confirm Import' });

    // Change field mapping -> confirm button must disappear again
    fireEvent.change(screen.getByLabelText('Column for Back'), { target: { value: '2' } });
    expect(screen.queryByRole('button', { name: 'Confirm Import' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Preview Import' }));
    await screen.findByRole('button', { name: 'Confirm Import' });

    // Change tags column -> confirm button must disappear
    fireEvent.change(screen.getByLabelText('Tags column'), { target: { value: '2' } });
    expect(screen.queryByRole('button', { name: 'Confirm Import' })).toBeNull();
  });

  it('imports an existing custom note type by ID and keeps a real Tab delimiter', async () => {
    vi.mocked(api.getImportNoteTypes).mockResolvedValue({ data: [{ id: 42, name: 'Vocabulary', fields: ['Word', 'Meaning', 'Example'] }] } as never);
    vi.mocked(api.importCards).mockResolvedValue({ data: { message: '1 added' } } as never);
    mount();
    const input = await openImport();
    fireEvent.click(screen.getByLabelText(/Advanced mapping/i));
    await screen.findByRole('option', { name: 'Vocabulary (existing)' });
    fireEvent.change(screen.getByLabelText('Note type'), { target: { value: 'custom:42' } });
    fireEvent.change(input, { target: { value: 'word\tmeaning\texample' } });
    fireEvent.change(screen.getByLabelText('Separator'), { target: { value: ',' } });
    fireEvent.change(screen.getByLabelText('Separator'), { target: { value: '\t' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview Import' }));
    await screen.findByRole('button', { name: 'Confirm Import' });
    expect(api.importCards).toHaveBeenLastCalledWith(1, 'word\tmeaning\texample', '\t', expect.objectContaining({
      note_type_id: 42, field_columns: { Word: 0, Meaning: 1, Example: 2 }, preview: true,
    }));
    expect(vi.mocked(api.importCards).mock.lastCall?.[3]).not.toHaveProperty('kind');
  });

  it('requires a new preview when file deck creation is enabled', async () => {
    vi.mocked(api.importCards).mockResolvedValue({ data: { message: '2 added, 3 new decks' } } as never);
    mount();
    const input = await openImport();
    fireEvent.change(input, { target: { value: 'Q\tA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview Import' }));
    await screen.findByRole('button', { name: 'Confirm Import' });
    expect(vi.mocked(api.importCards).mock.lastCall?.[3]).not.toHaveProperty('use_file_decks');
    fireEvent.click(screen.getByLabelText('Use deck names from file (may create decks)'));
    expect(screen.queryByRole('button', { name: 'Confirm Import' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Preview Import' }));
    await screen.findByRole('button', { name: 'Confirm Import' });
    expect(vi.mocked(api.importCards).mock.lastCall?.[3]).toEqual(expect.objectContaining({ use_file_decks: true, preview: true }));
  });

  it('renders updated explanatory text about built-in advanced note types and custom types later', async () => {
    mount();
    await openImport();
    expect(screen.getByText(/Basic two-field import and advanced built-in note types/i)).toBeDefined();
    expect(screen.getByText(/Existing custom note types are available above/i)).toBeDefined();
  });
});
