import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PackageImportPanel from '../components/PackageImportPanel';
import * as api from '../api/decks';
vi.mock('../api/decks');
const preview: api.PackageImportJob = {
  id: 'a'.repeat(32), status: 'awaiting_confirmation', completed: 1, total: 1,
  result: { cards_imported: 545, cards_updated: 0, cards_skipped: 0, notes_in_package: 545,
    cards_in_package: 545, media_imported: 545, media_bytes: 213391122, deck_name: 'Music', warnings: ['Missing font'] },
};
beforeEach(() => vi.resetAllMocks());
describe('Package import preview and confirmation', () => {
  it('keeps the collection unchanged until confirmation and shows the result', async () => {
    const busy = vi.fn(), complete = vi.fn();
    vi.mocked(api.getPackageImport).mockResolvedValue({ data: preview } as any);
    render(<PackageImportPanel id={preview.id} onBusy={busy} onComplete={complete} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'Import package' });
    expect(screen.getByText(/Your collection has not been changed/)).toBeDefined();
    expect(screen.getByText('Missing font')).toBeDefined();
    expect(api.confirmPackageImport).not.toHaveBeenCalled();
    const done = { ...preview, status: 'completed' };
    vi.mocked(api.confirmPackageImport).mockResolvedValue({ data: done } as any);
    vi.mocked(api.getPackageImport).mockResolvedValue({ data: done } as any);
    fireEvent.click(screen.getByRole('button', { name: 'Import package' }));
    await screen.findByText('Import completed');
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(busy).toHaveBeenLastCalledWith(false);
  });
  it('cancels a preview and never confirms it', async () => {
    vi.mocked(api.getPackageImport).mockResolvedValue({ data: preview } as any);
    render(<PackageImportPanel id={preview.id} onBusy={vi.fn()} onComplete={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'Cancel import' });
    const cancelled = { ...preview, status: 'cancelled' };
    vi.mocked(api.cancelPackageImport).mockResolvedValue({ data: cancelled } as any);
    vi.mocked(api.getPackageImport).mockResolvedValue({ data: cancelled } as any);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }));
    await screen.findByText('Import cancelled');
    expect(api.confirmPackageImport).not.toHaveBeenCalled();
  });
  it('lets the user reconnect after a status request fails', async () => {
    vi.mocked(api.getPackageImport).mockRejectedValueOnce(new Error('offline'));
    render(<PackageImportPanel id={preview.id} onBusy={vi.fn()} onComplete={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('alert');
    vi.mocked(api.getPackageImport).mockResolvedValue({ data: preview } as any);
    fireEvent.click(screen.getByText('Retry status'));
    await screen.findByText('Ready to import');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
