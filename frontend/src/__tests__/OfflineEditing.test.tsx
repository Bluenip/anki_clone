import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OfflineNoteEditor from '../components/OfflineNoteEditor';
import { changeLocal, saveOfflineEdit } from '../utils/offline';
import type { LocalAccount, OfflineEdit, OfflineNote } from '../utils/offline';
vi.mock('../utils/offline', () => ({ changeLocal: vi.fn(), saveOfflineEdit: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const note: OfflineNote = { id: 5, guid: 'source-guid', kind: 'basic', schema_hash: 'a'.repeat(64), fields: { Front: 'Question', Back: 'Answer' }, tags: ['old'] };
const perform = async (work: () => Promise<void>) => work();
const account: LocalAccount = { answers: [], decks: [{ deck: { id: 1, name: 'Downloaded' }, cards: [], notes: [note], revision: 'v', versions: {}, saved_at: '' }] };
describe('Offline source edits', () => {
  it('saves fields and tags locally without changing the downloaded base', async () => {
    vi.mocked(saveOfflineEdit).mockResolvedValue();
    render(<OfflineNoteEditor uid={7} account={account} busy={false} perform={perform} />);
    fireEvent.change(screen.getByLabelText('Offline note'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Offline field Front'), { target: { value: 'Offline question' } });
    fireEvent.change(screen.getByLabelText('Offline tags'), { target: { value: 'new second' } });
    fireEvent.click(screen.getByText('Save edit on this device'));
    await waitFor(() => expect(saveOfflineEdit).toHaveBeenCalledWith(7, note, { Front: 'Offline question', Back: 'Answer' }, ['new', 'second']));
    expect(note.fields.Front).toBe('Question');
  });
  it('requires choices for conflicts and rebases untouched fields on server values', async () => {
    const edit: OfflineEdit = { request_id: 'original-request', note_id: 5, guid: note.guid, schema_hash: note.schema_hash, base_fields: note.fields, base_tags: note.tags, fields: { Front: 'Local', Back: 'Answer' }, tags: ['local'], conflict: 'Both edited Front', conflicting_fields: ['Front'], remote: { ...note, fields: { Front: 'Remote', Back: 'Remote back' }, tags: ['old', 'server'] } };
    const saved = { ...account, edits: [edit] };
    vi.mocked(changeLocal).mockImplementation(async (_uid, change) => {
      const result = change(saved).edits![0];
      expect(result.fields).toEqual({ Front: 'Local', Back: 'Remote back' });
      expect(result.base_fields).toEqual(edit.remote!.fields);
      expect(result.tags.sort()).toEqual(['local', 'server']);
      expect(result.request_id).not.toBe(edit.request_id);
      expect(result.conflict).toBeUndefined();
    });
    render(<OfflineNoteEditor uid={7} account={saved} busy={false} perform={perform} />);
    expect((screen.getByText('Queue resolved edit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Resolve Front'), { target: { value: 'local' } });
    fireEvent.click(screen.getByText('Queue resolved edit'));
    await waitFor(() => expect(changeLocal).toHaveBeenCalledOnce());
  });
  it('keeps queued edits unless discard is confirmed', async () => {
    const edit: OfflineEdit = { request_id: 'original-request', note_id: 5, guid: note.guid, schema_hash: note.schema_hash, base_fields: note.fields, base_tags: [], fields: note.fields, tags: [] };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<OfflineNoteEditor uid={7} account={{ ...account, edits: [edit] }} busy={false} perform={perform} />);
    fireEvent.click(screen.getByText('Discard local edit'));
    expect(changeLocal).not.toHaveBeenCalled(); confirm.mockRestore();
  });
});
