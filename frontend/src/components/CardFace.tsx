import { answerDiff } from '../utils/answerDiff';
import { renderMath, mathCss } from '../utils/math';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { sanitizeHtml } from '../utils/sanitize';

export interface CardFaceRef {
  playAudio: (options?: { skipFront?: boolean }) => Promise<void>;
  stopAudio: () => void;
  isPlaying: () => boolean;
  getIframe: () => HTMLIFrameElement | null;
}

export interface CardFaceProps {
  html: string;
  cardCss?: string;
  className?: string;
  title?: string;
  frontHtml?: string;
  backHtml?: string;
  showAnswer?: boolean;
  onAudioEnded?: () => void;
  onRevealAnswer?: () => void;
}

const CardFace = forwardRef<CardFaceRef, CardFaceProps>(
  (
    {
      html,
      cardCss = '',
      className = '',
      title = 'Card Content',
      frontHtml,
      backHtml,
      showAnswer = false,
      onAudioEnded,
      onRevealAnswer,
    },
    ref
  ) => {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const isPlayingRef = useRef(false);
    const playbackGeneration = useRef(0);
    const playbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const activeAudio = useRef<HTMLAudioElement[]>([]);

    const [typed, setTyped] = useState<Record<string, string>>({});
    const typedFields = useMemo(() => {
      const doc = new DOMParser().parseFromString(sanitizeHtml(frontHtml || html), 'text/html');
      return [...new Set(Array.from(doc.querySelectorAll('[data-type-field]')).map(n => n.getAttribute('data-type-field') || ''))];
    }, [frontHtml, html]);
    const answers = useMemo(() => {
      const doc = new DOMParser().parseFromString(sanitizeHtml(backHtml || html), 'text/html');
      return Object.fromEntries(Array.from(doc.querySelectorAll('[data-type-answer]')).map(n => [n.getAttribute('data-type-field') || '', n.getAttribute('data-type-answer') || '']));
    }, [backHtml, html]);
    const typeOptions = useMemo(() => {
      const doc = new DOMParser().parseFromString(sanitizeHtml(frontHtml || html), 'text/html');
      return Object.fromEntries(Array.from(doc.querySelectorAll('[data-type-field]')).map(n => [n.getAttribute('data-type-field') || '', n.getAttribute('data-type-options') || '']));
    }, [frontHtml, html]);
    const matches = (field: string) => {
      const normalize = (value: string) => {
        let text = value.normalize('NFC').trim();
        if (typeOptions[field]?.includes('nc')) text = text.normalize('NFD').replace(/\p{M}/gu, '');
        if (typeOptions[field]?.includes('ci')) text = text.toLocaleLowerCase();
        return text;
      };
      return normalize(typed[field] || '') === normalize(answers[field] || '');
    };
    const cleanHtml = useMemo(() => {
      const doc = new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');
      doc.querySelectorAll('[data-type-field]').forEach(n => n.remove());
      doc.querySelectorAll('audio, video').forEach(media => { media.removeAttribute('autoplay'); media.removeAttribute('loop'); });
      doc.querySelectorAll('[data-tts-voices-list]').forEach(node => {
        const voices = window.speechSynthesis?.getVoices() || [];
        node.textContent = voices.length ? voices.map(v => `${v.name} (${v.lang})`).join(' · ') : 'No speech voices loaded. Reload after your device installs a voice.';
      });
      renderMath(doc.body);
      return doc.body.innerHTML;
    }, [html]);
    const safeCss = useMemo(() => cardCss.replace(/<\/style/gi, '<\\/style'), [cardCss]);

    const srcDoc = useMemo(() => {
      // Firefox resolves 'self' differently for sandboxed about:srcdoc media.
      // Name this application's origin explicitly; never derive it from notes.
      const assetOrigin = window.location.origin;
      return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' ${assetOrigin} data: blob: https:; media-src 'self' ${assetOrigin} blob: https:; font-src 'self' ${assetOrigin} data:; base-uri 'none'; form-action 'none';" />
  <style>${mathCss}</style>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #e5e7eb;
      background: transparent;
      word-break: break-word;
      overflow-wrap: break-word;
    }
    img, video { max-width: 100%; height: auto; }
    audio { display: block; margin: 0.5rem 0; }
    hr#answer {
      border: 0;
      border-top: 1px dashed rgba(255, 255, 255, 0.2);
      margin: 1.5rem 0;
    }
    ${safeCss}
  </style>
</head>
<body class="card">
  ${cleanHtml}
</body>
</html>`;
    }, [cleanHtml, safeCss]);

    const updateHeight = useCallback(() => {
      const iframe = iframeRef.current;
      if (!iframe) return;
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) {
          const height = Math.max(
            doc.body?.scrollHeight || 0,
            doc.documentElement?.scrollHeight || 0,
            40
          );
          iframe.style.height = `${height}px`;
        }
      } catch {
        // Cross-origin fallback
      }
    }, []);

    const stopAudio = useCallback(() => {
      ++playbackGeneration.current;
      window.speechSynthesis?.cancel();
      if (playbackTimer.current) clearTimeout(playbackTimer.current);
      playbackTimer.current = null;
      for (const audio of activeAudio.current) {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
      }
      activeAudio.current = [];
      const iframe = iframeRef.current;
      if (!iframe) return;
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) {
          const audios = Array.from(doc.querySelectorAll('audio'));
          audios.forEach((a) => {
            try {
              a.pause();
              a.currentTime = 0;
              a.onended = null;
              a.onerror = null;
            } catch {
              // ignore
            }
          });
        }
      } catch {
        // ignore
      }
      isPlayingRef.current = false;
    }, []);

    const playAudio = useCallback(
      async (options?: { skipFront?: boolean }) => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!doc) return;
          const allAudios = Array.from(doc.querySelectorAll<HTMLElement>('audio, [data-tts]'));
          let targetAudios = allAudios;
          if (options?.skipFront) {
            const hr = doc.getElementById('answer');
            targetAudios = allAudios.filter((a) => {
              if (a.closest('.card-front')) return false;
              if (hr && (a.compareDocumentPosition(hr) & Node.DOCUMENT_POSITION_PRECEDING) === 0) {
                return false;
              }
              return true;
            });
          }

          if (targetAudios.length === 0) {
            isPlayingRef.current = false;
            onAudioEnded?.();
            return;
          }

          stopAudio();
          const generation = playbackGeneration.current;
          activeAudio.current = targetAudios.filter((el): el is HTMLAudioElement => el.tagName === 'AUDIO');
          isPlayingRef.current = true;

          let idx = 0;
          const playNext = () => {
            if (!isPlayingRef.current || generation !== playbackGeneration.current) return;
            if (idx >= targetAudios.length) {
              isPlayingRef.current = false;
              onAudioEnded?.();
              return;
            }
            const target = targetAudios[idx++];
            if (target.hasAttribute('data-tts')) {
              if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') { playNext(); return; }
              const utterance = new SpeechSynthesisUtterance(target.dataset.tts || '');
              utterance.lang = target.dataset.ttsLang || 'en-US';
              utterance.rate = Math.max(.1, Math.min(10, Number(target.dataset.ttsRate) || 1));
              const wanted = (target.dataset.ttsVoices || '').split(',');
              const voices = window.speechSynthesis.getVoices();
              utterance.voice = voices.find(v => wanted.includes(v.name.replaceAll(' ', '_')) || wanted.includes(v.name)) || voices.find(v => v.lang.toLowerCase() === utterance.lang.toLowerCase()) || null;
              let done = false;
              const advanceSpeech = () => { if (done || generation !== playbackGeneration.current) return; done = true; if (playbackTimer.current) clearTimeout(playbackTimer.current); playbackTimer.current = null; playNext(); };
              utterance.onend = advanceSpeech; utterance.onerror = advanceSpeech;
              playbackTimer.current = setTimeout(() => { window.speechSynthesis.cancel(); advanceSpeech(); }, Math.max(60000, Math.min(600000, utterance.text.length * 150)));
              window.speechSynthesis.speak(utterance);
              return;
            }
            const audio = target as HTMLAudioElement;
            audio.currentTime = 0;
            let finished = false;
            const advance = () => {
              if (finished || generation !== playbackGeneration.current) return;
              finished = true;
              if (playbackTimer.current) clearTimeout(playbackTimer.current);
              playbackTimer.current = null;
              audio.onended = null;
              audio.onerror = null;
              audio.pause();
              playNext();
            };
            audio.onended = advance;
            audio.onerror = advance;
            // Broken URLs and stalled media must not hold auto-advance forever.
            let position = audio.currentTime;
            let lastMovement = Date.now();
            const checkProgress = () => {
              if (finished || generation !== playbackGeneration.current) return;
              if (audio.currentTime !== position) {
                position = audio.currentTime;
                lastMovement = Date.now();
              }
              if (Date.now() - lastMovement >= 60000) advance();
              else playbackTimer.current = setTimeout(checkProgress, 10000);
            };
            playbackTimer.current = setTimeout(checkProgress, 10000);
            try {
              const p = audio.play();
              if (p && typeof p.catch === 'function') {
                p.catch(advance);
              }
            } catch {
              advance();
            }
          };
          playNext();
        } catch {
          isPlayingRef.current = false;
          onAudioEnded?.();
        }
      },
      [stopAudio, onAudioEnded]
    );

    useImperativeHandle(
      ref,
      () => ({
        playAudio,
        stopAudio,
        isPlaying: () => isPlayingRef.current,
        getIframe: () => iframeRef.current,
      }),
      [playAudio, stopAudio]
    );

    // Stop audio on unmount or content change
    useEffect(() => {
      return () => {
        stopAudio();
      };
    }, [cleanHtml, stopAudio]);

    // Handle height updates and ResizeObserver cleanup
    useEffect(() => {
      const iframe = iframeRef.current;
      if (!iframe) return;

      let observer: ResizeObserver | null = null;

      const handleLoad = () => {
        updateHeight();
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          if (doc?.body && typeof ResizeObserver !== 'undefined') {
            if (observer) observer.disconnect();
            observer = new ResizeObserver(() => updateHeight());
            observer.observe(doc.body);
          }
        } catch {
          // ignore
        }
      };

      iframe.addEventListener('load', handleLoad);
      handleLoad();

      return () => {
        iframe.removeEventListener('load', handleLoad);
        if (observer) {
          observer.disconnect();
        }
      };
    }, [srcDoc, updateHeight]);

    const sanitizedFront = useMemo(() => new DOMParser().parseFromString(sanitizeHtml(frontHtml || html), 'text/html').body.textContent || '', [frontHtml, html]);
    const sanitizedBack = useMemo(() => new DOMParser().parseFromString(sanitizeHtml(backHtml || ''), 'text/html').body.textContent || '', [backHtml]);

    return (
      <div className={`card-face-container ${className}`} style={{ width: '100%', position: 'relative' }}>
        <iframe
          ref={iframeRef}
          srcDoc={srcDoc}
          sandbox="allow-same-origin"
          title={title}
          style={{
            width: '100%',
            border: 'none',
            display: 'block',
            overflow: 'hidden',
            backgroundColor: 'transparent',
          }}
        />
        {cleanHtml.includes('data-tts=') && <div><button type="button" onClick={() => void playAudio()}>Read aloud</button>{(!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') && <p role="status">Speech synthesis is unavailable in this browser.</p>}</div>}
        {typedFields.map(field => <div key={field} style={{ marginBlock: 12 }}>
          {!showAnswer ? <label>Type answer ({field})<input autoComplete="off" spellCheck={false} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); onRevealAnswer?.(); } }} value={typed[field] || ''} onChange={e => setTyped(old => ({ ...old, [field]: e.target.value }))} /></label>
            : <div role="status"><div>Your answer: {typed[field] || '(empty)'}</div><div>Correct answer: {answers[field] ?? '(not included in back template)'}</div>
              {answers[field] !== undefined && !matches(field) && <div aria-label="Character comparison" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{answerDiff(typed[field] || '', answers[field]).map((part, i) => part.kind === 'delete' ? <del key={i} style={{ background: '#7f1d1d', color: '#fff' }}>{part.text}</del> : part.kind === 'insert' ? <ins key={i} style={{ background: '#14532d', color: '#fff' }}>{part.text}</ins> : <span key={i}>{part.text}</span>)}</div>}
              {answers[field] !== undefined && <strong>{matches(field) ? 'Match' : 'Different — compare your answer before rating'}</strong>}
            </div>}
        </div>)}
        {/* Accessible fallback markup */}
        <div
          className="card-face-accessible"
          style={{
            position: 'absolute',
            width: '1px',
            height: '1px',
            padding: 0,
            margin: '-1px',
            overflow: 'hidden',
            clip: 'rect(0, 0, 0, 0)',
            whiteSpace: 'normal',
            border: 0,
          }}
        >
          <div className="card-front">{sanitizedFront}</div>
          {showAnswer && backHtml && (
            <div className="card-back">{sanitizedBack}</div>
          )}
        </div>
      </div>
    );
  }
);

CardFace.displayName = 'CardFace';

export default CardFace;
