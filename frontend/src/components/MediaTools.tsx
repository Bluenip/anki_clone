import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import client from '../api/client';

export default function MediaTools({ disabled = false, onInsert, onBusyChange }: { disabled?: boolean; onBusyChange?: (busy: boolean) => void; onInsert: (markup: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const busyCallback = useRef(onBusyChange);
  useLayoutEffect(() => { busyCallback.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => {
    if (!busy) return;
    busyCallback.current?.(true);
    return () => busyCallback.current?.(false);
  }, [busy]);
  const recorder = useRef<MediaRecorder | null>(null);
  const mounted = useRef(true);
  const inserting = useRef(onInsert);
  useLayoutEffect(() => { inserting.current = onInsert; }, [onInsert]);
  const pending = useRef(false);
  const requestingMic = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (recorder.current) {
        recorder.current.onstop = null;
        if (recorder.current.state !== 'inactive') recorder.current.stop();
        recorder.current.stream.getTracks().forEach(t => t.stop());
      }
    };
  }, []);
  const upload = async (file: Blob, name: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Media exceeds 20 MB');
      const form = new FormData(); form.append('file', file, name);
      const { data } = await client.post<{ markup: string }>('/api/media-tools/upload', form, { headers: { 'Content-Type': undefined } });
      if (mounted.current) inserting.current(data.markup);
    } catch (e) {
      if (mounted.current) setError((e as { response?: { data?: { detail?: string } } }).response?.data?.detail || (e as Error).message || 'Upload failed');
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const record = async () => {
    if (pending.current || recorder.current || requestingMic.current) return;
    requestingMic.current = true;
    setError(''); setBusy(true);
    let acquired: MediaStream | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) { stream.getTracks().forEach(t => t.stop()); return; }
      acquired = stream;
      const r = new MediaRecorder(stream); recorder.current = r;
      const chunks: Blob[] = [];
      let size = 0;
      r.ondataavailable = e => { if (e.data.size) { chunks.push(e.data); size += e.data.size; if (size > 20 * 1024 * 1024 && r.state !== 'inactive') r.stop(); } };
      r.onstop = () => {
        stream.getTracks().forEach(t => t.stop()); recorder.current = null;
        if (mounted.current) { setRecording(false); void upload(new Blob(chunks, { type: r.mimeType }), 'recording.webm'); }
      };
      r.onerror = () => {
        r.onstop = null;
        if (r.state !== 'inactive') r.stop();
        stream.getTracks().forEach(t => t.stop()); recorder.current = null;
        if (mounted.current) { setBusy(false); setRecording(false); setError('Recording failed. Please try again.'); }
      };
      r.start(1000); setRecording(true);
    } catch (e) { recorder.current = null; acquired?.getTracks().forEach(t => t.stop()); if (mounted.current) { setBusy(false); setError((e as Error).message || 'Microphone unavailable'); } }
    finally { requestingMic.current = false; }
  };
  return <div className="media-tools" style={{ marginBlock: 8 }}>
    <label>Attach image/audio <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,audio/*,video/webm,video/mp4" disabled={disabled || busy} onChange={e => {
      const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file, file.name);
    }} /></label>
    {recording ? <button type="button" onClick={() => recorder.current?.stop()}>Stop recording and attach</button>
      : <button type="button" disabled={disabled || busy || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined'} onClick={() => void record()}>Record audio</button>}
    {busy && <span role="status">{recording ? 'Recording…' : 'Attaching…'}</span>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
