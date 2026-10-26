import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImageOcclusionEditor from '../components/ImageOcclusionEditor';
import { parseMasks, serializeMasks } from '../utils/imageOcclusion';
import client from '../api/client';
vi.mock('../api/client', () => ({ default: { post: vi.fn() } }));
vi.mock('../context/useAuth', () => ({ useAuth: () => ({ user: { id: 7 } }) }));
const source = '{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1:oi=1}}<br>{{c3::image-occlusion:rect:left=.5:top=.6:width=.2:height=.1:oi=1}}<br>';
const initial = { Image: '<img src="diagram.png">', Occlusion: source, Header: 'Question' };
const busy = vi.fn();
function Editor() {
  const [fields, setFields] = useState<Record<string, string>>(initial);
  return <><ImageOcclusionEditor fields={fields} onChange={setFields} onBusyChange={busy} /><output data-testid="source">{JSON.stringify(fields)}</output></>;
}
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Image Occlusion', () => {
  it('resolves owned portable media and previews answer/mode changes', () => {
    const view = render(<Editor />);
    expect(screen.getByAltText('Image to mask').getAttribute('src')).toBe('/api/media/7/diagram.png');
    const region = () => view.container.querySelector('[aria-label="Draw mask on image"] span') as HTMLElement;
    expect(region().style.background).toBe('rgb(255, 202, 100)');
    fireEvent.click(screen.getByText('Preview answer'));
    expect(region().style.background).toBe('transparent');
    fireEvent.change(screen.getByLabelText('Mask mode'), { target: { value: 'one' } });
    expect(screen.getByTestId('source').textContent).not.toContain(':oi=1');
  });
  it('changes geometry and deletes without renumbering remaining cards', () => {
    render(<Editor />);
    fireEvent.change(screen.getByLabelText('Mask left (%)'), { target: { value: '15' } });
    expect(screen.getByTestId('source').textContent).toContain('left=0.150000');
    fireEvent.change(screen.getByLabelText('Mask left (%)'), { target: { value: '15.123' } });
    expect((screen.getByLabelText('Mask left (%)') as HTMLInputElement).checkValidity()).toBe(true);
    fireEvent.click(screen.getByText('Delete selected region'));
    expect(screen.getByTestId('source').textContent).toContain('c3::');
    expect(screen.getByTestId('source').textContent).not.toContain('c1::');
  });
  it('draws normalized rectangles, including reverse dragging', () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    render(<Editor />);
    const canvas = screen.getByLabelText('Draw mask on image');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 500, height: 400 } as DOMRect);
    fireEvent.load(screen.getByAltText('Image to mask'));
    fireEvent.pointerDown(canvas, { button: 0, clientX: 400, clientY: 320 });
    fireEvent.pointerMove(canvas, { clientX: 300, clientY: 240 });
    fireEvent.pointerUp(canvas, { clientX: 300, clientY: 240 });
    expect(screen.getByTestId('source').textContent).toContain('c4::image-occlusion:rect:left=0.600000:top=0.600000:width=0.200000:height=0.200000');
  });
  it('preserves unsupported source and blocks editing it', () => {
    const change = vi.fn();
    render(<ImageOcclusionEditor fields={{ ...initial, Occlusion: source.replace('rect:', 'ellipse:') }} onChange={change} onBusyChange={busy} />);
    expect(screen.getByRole('alert').textContent).toContain('preserved');
    expect((screen.getByLabelText('Occlusion image') as HTMLInputElement).disabled).toBe(true);
    expect(change).not.toHaveBeenCalled();
  });
  it('ignores an upload completed after unmount', async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(client.post).mockReturnValue(new Promise(r => { resolve = r; }) as never);
    const change = vi.fn();
    const view = render(<ImageOcclusionEditor fields={initial} onChange={change} onBusyChange={busy} />);
    fireEvent.change(screen.getByLabelText('Occlusion image'), { target: { files: [new File(['png'], 'image.png', { type: 'image/png' })] } });
    expect(busy).toHaveBeenCalledWith(true);
    view.unmount();
    await act(async () => resolve({ data: { markup: '<img src="new.png">' } }));
    expect(change).not.toHaveBeenCalled();
    expect(busy).toHaveBeenLastCalledWith(false);
  });
  it('replaces the image while preserving mask data', async () => {
    vi.mocked(client.post).mockResolvedValue({ data: { markup: '<img src="new.png">' } });
    render(<Editor />);
    fireEvent.change(screen.getByLabelText('Occlusion image'), { target: { files: [new File(['png'], 'image.png', { type: 'image/png' })] } });
    await waitFor(() => expect(screen.getByAltText('Image to mask').getAttribute('src')).toBe('/api/media/7/new.png'));
    expect(screen.getByTestId('source').textContent).toContain('c3::');
  });
  it('roundtrips grouped/sparse ordinals and rejects unsupported data', () => {
    expect(parseMasks(serializeMasks(parseMasks(source)))).toEqual(parseMasks(source));
    expect(parseMasks(source.replace('c3::', 'c1::')).map(m => m.id)).toEqual([1, 1]);
    for (const bad of ['junk', source.replace('left=.1', 'left=NaN'), source.replace('height=.1', 'height=.1:angle=NaN')]) expect(() => parseMasks(bad)).toThrow();
  });
});


it('draws ellipse and polygon, groups and separates cards, resizes polygon', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  render(<Editor />);
  const canvas = screen.getByLabelText('Draw mask on image');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 500, height: 400 } as DOMRect);
  fireEvent.load(screen.getByAltText('Image to mask'));
  fireEvent.change(screen.getByLabelText('Drawing tool'), { target: { value: 'ellipse' } });
  fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 80 });
  fireEvent.pointerUp(canvas, { clientX: 200, clientY: 160 });
  const masks = () => parseMasks(JSON.parse(screen.getByTestId('source').textContent!).Occlusion);
  expect(masks()[2]).toMatchObject({ id: 4, shape: 'ellipse', width: .2, height: .2 });
  fireEvent.change(screen.getByLabelText('Drawing tool'), { target: { value: 'polygon' } });
  for (const [x, y] of [[100, 80], [200, 80], [150, 160]]) fireEvent.pointerDown(canvas, { button: 0, clientX: x, clientY: y });
  fireEvent.click(screen.getByText('Finish polygon'));
  expect(masks()[3]).toMatchObject({ id: 5, shape: 'polygon', width: .2, height: .2 });
  fireEvent.change(screen.getByLabelText('Card group'), { target: { value: '4' } });
  expect(masks().map(m => m.id)).toEqual([1, 3, 4, 4]);
  fireEvent.click(screen.getByText('Preview answer'));
  expect(screen.getByLabelText('Polygon region 4 (card 4)').querySelector('polygon')?.getAttribute('fill')).toBe('transparent');
  fireEvent.change(screen.getByLabelText('Mask width (%)'), { target: { value: '40' } });
  expect(masks()[3].width).toBeCloseTo(.4);
  fireEvent.change(screen.getByLabelText('Card group'), { target: { value: 'new' } });
  expect(masks().map(m => m.id)).toEqual([1, 3, 4, 6]);
});

it('rejects degenerate polygons and preserves native point offsets', () => {
  const source = '{{c7::image-occlusion:polygon:left=.1:top=.2:points=.3,.4 .5,.4 .4,.6:oi=1}}';
  expect(parseMasks(serializeMasks(parseMasks(source)))).toEqual(parseMasks(source));
  for (const points of ['0,0 .1,.1', '0,0 .1,.1 .2,.2', '0,0 NaN,.1 .1,0']) {
    expect(() => parseMasks(`{{c1::image-occlusion:polygon:left=.1:top=.1:points=${points}}}`)).toThrow();
  }
});


it('edits rotation/color and adds a portable text annotation without creating a card', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  render(<Editor />);
  fireEvent.change(screen.getByLabelText('Mask rotation'), { target: { value: '90' } });
  fireEvent.change(screen.getByLabelText('Mask color'), { target: { value: '#aabbcc' } });
  expect(screen.getByTestId('source').textContent).toContain('angle=2500:fill=#aabbcc');
  const canvas = screen.getByLabelText('Draw mask on image');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 500, height: 400 } as DOMRect);
  fireEvent.load(screen.getByAltText('Image to mask'));
  fireEvent.change(screen.getByLabelText('Drawing tool'), { target: { value: 'text' } });
  fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.change(screen.getByLabelText('Annotation text'), { target: { value: 'Label: x=y' } });
  const masks = parseMasks(JSON.parse(screen.getByTestId('source').textContent!).Occlusion);
  expect(masks[2]).toMatchObject({ id: 0, shape: 'text', text: 'Label: x=y' });
  expect(screen.getByText('2 cards · 3/100 regions')).toBeDefined();
  expect(parseMasks(serializeMasks(masks))).toEqual(masks);
});
