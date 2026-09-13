/**
 * Study sound effects using Web Audio API.
 * No external audio files needed — all sounds are synthesized.
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  // Resume if suspended (browsers require user interaction first)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playTone(
  frequency: number,
  duration: number,
  type: OscillatorType = 'sine',
  volume: number = 0.15
) {
  const ctx = getAudioContext();
  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);

  // Envelope: quick attack, smooth decay
  gainNode.gain.setValueAtTime(0, ctx.currentTime);
  gainNode.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.02);
  gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);

  oscillator.start(ctx.currentTime);
  oscillator.stop(ctx.currentTime + duration);
}

/** Soft click when flipping card to show answer */
export function playFlipSound() {
  const ctx = getAudioContext();
  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(800, ctx.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.08);

  gainNode.gain.setValueAtTime(0, ctx.currentTime);
  gainNode.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);
  oscillator.start(ctx.currentTime);
  oscillator.stop(ctx.currentTime + 0.1);
}

/** Low tone for "Again" (incorrect) */
export function playAgainSound() {
  playTone(250, 0.3, 'sine', 0.12);
  setTimeout(() => playTone(200, 0.3, 'sine', 0.1), 100);
}

/** Neutral tone for "Hard" */
export function playHardSound() {
  playTone(400, 0.2, 'triangle', 0.1);
}

/** Pleasant ascending tone for "Good" */
export function playGoodSound() {
  playTone(523, 0.15, 'sine', 0.12); // C5
  setTimeout(() => playTone(659, 0.2, 'sine', 0.1), 100); // E5
}

/** Bright ascending tone for "Easy" */
export function playEasySound() {
  playTone(523, 0.12, 'sine', 0.12); // C5
  setTimeout(() => playTone(659, 0.12, 'sine', 0.1), 80);  // E5
  setTimeout(() => playTone(784, 0.25, 'sine', 0.12), 160); // G5
}

/** Celebration melody when study session is complete */
export function playCompleteSound() {
  const notes = [523, 587, 659, 784, 880]; // C5 D5 E5 G5 A5
  notes.forEach((freq, i) => {
    setTimeout(() => playTone(freq, 0.25, 'sine', 0.12), i * 120);
  });
}

/** Play sound based on rating (1=Again, 2=Hard, 3=Good, 4=Easy) */
export function playRatingSound(rating: number) {
  switch (rating) {
    case 1: playAgainSound(); break;
    case 2: playHardSound(); break;
    case 3: playGoodSound(); break;
    case 4: playEasySound(); break;
  }
}

