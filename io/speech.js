// Text-to-speech via the Web Speech API, with two browser workarounds baked in.
let speechUnlocked = false;

export function unlockSpeech() {
  // Some browsers (notably iOS Safari) only allow speechSynthesis.speak() to
  // produce sound if a speak() call has happened synchronously inside a user
  // gesture at least once. Our automatic speech fires from a setTimeout, which
  // doesn't count as a gesture, so we "unlock" it here on the first real
  // keypress/tap and let later calls (sync or async) work normally after that.
  if (speechUnlocked || !("speechSynthesis" in window)) return;
  speechUnlocked = true;
  const utter = new SpeechSynthesisUtterance(" ");
  utter.volume = 0;
  window.speechSynthesis.speak(utter);
}

export function speakWord(word) {
  if (!word || !("speechSynthesis" in window)) return;
  const synth = window.speechSynthesis;
  const doSpeak = () => {
    const utter = new SpeechSynthesisUtterance(word);
    utter.rate = 0.8;
    utter.pitch = 1.1;
    synth.cancel();
    synth.speak(utter);
  };
  // Chrome sometimes hasn't loaded its voice list yet on the very first
  // call, and silently drops speak() calls made before it's ready.
  if (synth.getVoices().length === 0) {
    synth.addEventListener("voiceschanged", doSpeak, { once: true });
  } else {
    doSpeak();
  }
}
