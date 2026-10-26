import { useEffect, useState } from 'react';
import CardFace from './CardFace';
import type { CachedCard } from '../utils/offline';

// Sandboxed srcdoc frames do not consistently inherit service-worker control.
// Resolve downloaded media before rendering, so offline frames use local blobs.
export default function OfflineCardFace({ card, uid, revealed, onReveal }: {
  card: CachedCard; uid: number; revealed: boolean; onReveal: () => void;
}) {
  const [faces, setFaces] = useState<{ front: string; back: string; css: string }>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const blobs: string[] = [];
    void (async () => {
      let front = card.front, back = card.back, css = card.card_css || '';
      if ('caches' in window) {
        const cache = await caches.open(`anki-media-${uid}`);
        const names = new Set((front + back + css).match(/\/api\/media\/\d+\/[^"'<>\s)]+/g) || []);
        for (const name of names) {
          if (!name.startsWith(`/api/media/${uid}/`)) continue;
          const response = await cache.match(name);
          if (!response) continue;
          const url = URL.createObjectURL(await response.blob()); blobs.push(url);
          front = front.split(name).join(url); back = back.split(name).join(url); css = css.split(name).join(url);
        }
      }
      if (active) setFaces({ front, back, css });
      else blobs.forEach(url => URL.revokeObjectURL(url));
    })().catch(() => { if (active) setError('Could not read downloaded media. Download this deck again when connected.'); });
    return () => { active = false; blobs.forEach(url => URL.revokeObjectURL(url)); };
  }, [card, uid]);
  if (error) return <p role="alert">{error}</p>;
  if (!faces) return <p role="status">Loading downloaded card…</p>;
  return <CardFace html={revealed ? faces.back : faces.front} frontHtml={faces.front} backHtml={faces.back} showAnswer={revealed} cardCss={faces.css} onRevealAnswer={onReveal} />;
}
