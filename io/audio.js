// WebAudio sound effects. The AudioContext is created lazily so it only comes
// to life once the game actually plays a sound (inside a user gesture).
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function playTone(freq, duration, type, startTime, gainValue) {
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || "sine";
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + (startTime || 0);
  gain.gain.setValueAtTime(gainValue || 0.2, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

export function playCorrectSound() {
  playTone(523.25, 0.12, "sine", 0, 0.2);
  playTone(659.25, 0.12, "sine", 0.09, 0.2);
}

export function playWrongSound() {
  playTone(160, 0.25, "sawtooth", 0, 0.12);
}

export function playWordCompleteFanfare() {
  playTone(523.25, 0.1, "sine", 0, 0.2);
  playTone(659.25, 0.1, "sine", 0.1, 0.2);
  playTone(783.99, 0.1, "sine", 0.2, 0.2);
  playTone(1046.5, 0.35, "sine", 0.3, 0.22);
}
