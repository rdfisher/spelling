const STORAGE_KEY = "spelling-game-progress-v1";
const UNLOCK_THRESHOLD_SCORE = 70;
const WORDS_TO_UNLOCK = 3;
const MAX_MISSES_PER_LETTER = 3;
const MAX_TIER = Math.max(...WORDS.map((w) => w.tier));

let progress = loadProgress();
let currentWord = null;
let currentIndex = 0;
let wrongGuesses = 0;
let letterMisses = 0;
let lastWord = null;
let locked = false;
let audioCtx = null;
let autoSpeakTimer = null;
let speechUnlocked = false;

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    // ignore corrupt/unavailable storage, start fresh
  }
  return {
    unlockedTier: 1,
    tierStreak: 0,
    bestScores: {},
    totalWordsCompleted: 0,
    totalScoreSum: 0,
  };
}

function saveProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch (e) {
    // storage unavailable (e.g. private browsing) - progress just won't persist
  }
}

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

function playCorrectSound() {
  playTone(523.25, 0.12, "sine", 0, 0.2);
  playTone(659.25, 0.12, "sine", 0.09, 0.2);
}

function playWrongSound() {
  playTone(160, 0.25, "sawtooth", 0, 0.12);
}

function playWordCompleteFanfare() {
  playTone(523.25, 0.1, "sine", 0, 0.2);
  playTone(659.25, 0.1, "sine", 0.1, 0.2);
  playTone(783.99, 0.1, "sine", 0.2, 0.2);
  playTone(1046.5, 0.35, "sine", 0.3, 0.22);
}

function unlockSpeech() {
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

function speakWord() {
  if (!currentWord || !("speechSynthesis" in window)) return;
  const synth = window.speechSynthesis;
  const doSpeak = () => {
    const utter = new SpeechSynthesisUtterance(currentWord.word);
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

function pickNextWord() {
  const pool = WORDS.filter(
    (w) => w.tier <= progress.unlockedTier && (!lastWord || w.word !== lastWord.word)
  );
  return pool[Math.floor(Math.random() * pool.length)];
}

function startWord(wordObj) {
  currentWord = wordObj;
  currentIndex = 0;
  wrongGuesses = 0;
  letterMisses = 0;
  locked = false;
  document.getElementById("word-image").src = wordObj.image;
  document.getElementById("word-image").alt = wordObj.word;
  document.getElementById("feedback").textContent = "";
  renderWord();
  updateTierBadge();

  clearTimeout(autoSpeakTimer);
  autoSpeakTimer = setTimeout(speakWord, 1000);
}

function renderWord() {
  const container = document.getElementById("letter-boxes");
  container.innerHTML = "";
  for (let i = 0; i < currentWord.word.length; i++) {
    const box = document.createElement("div");
    box.className = "letter-box";
    if (i < currentIndex) {
      box.textContent = currentWord.word[i].toUpperCase();
      box.classList.add("filled");
    }
    container.appendChild(box);
  }
}

function flashBox(index, kind) {
  const boxes = document.querySelectorAll(".letter-box");
  const box = boxes[index];
  if (!box) return;
  const cls = kind === "correct" ? "pop" : "shake";
  box.classList.add(cls);
  setTimeout(() => box.classList.remove(cls), 400);
}

function handleKeydown(e) {
  if (!/^[a-zA-Z]$/.test(e.key)) return;
  submitLetter(e.key);
}

function submitLetter(key) {
  if (!currentWord || locked) return;

  const expected = currentWord.word[currentIndex].toLowerCase();
  const got = key.toLowerCase();

  if (got === expected) {
    advanceLetter();
    return;
  }

  wrongGuesses++;
  letterMisses++;
  playWrongSound();
  flashBox(currentIndex, "wrong");

  if (letterMisses >= MAX_MISSES_PER_LETTER) {
    // Miles has missed this letter too many times in a row - fill it in for
    // him so he doesn't get stuck, and say the word again as a reminder.
    // The misses already counted above still count against his score.
    advanceLetter();
    if (!locked) speakWord();
  }
}

function advanceLetter() {
  currentIndex++;
  letterMisses = 0;
  playCorrectSound();
  renderWord();
  flashBox(currentIndex - 1, "correct");
  if (currentIndex === currentWord.word.length) {
    completeWord();
  }
}

function completeWord() {
  locked = true;
  playWordCompleteFanfare();

  const score = Math.round(
    Math.max(0, 100 - (wrongGuesses / currentWord.word.length) * 100)
  );
  progress.totalWordsCompleted++;
  progress.totalScoreSum += score;
  const prevBest = progress.bestScores[currentWord.word] || 0;
  if (score > prevBest) progress.bestScores[currentWord.word] = score;

  if (score >= UNLOCK_THRESHOLD_SCORE) {
    progress.tierStreak = (progress.tierStreak || 0) + 1;
  } else {
    progress.tierStreak = 0;
  }

  let unlockedNewTier = false;
  if (progress.tierStreak >= WORDS_TO_UNLOCK && progress.unlockedTier < MAX_TIER) {
    progress.unlockedTier++;
    progress.tierStreak = 0;
    unlockedNewTier = true;
  }

  saveProgress();
  updateScoreboard(score);
  document.getElementById("feedback").textContent = `Great job! Score: ${score}`;
  lastWord = currentWord;

  if (unlockedNewTier) {
    showTierUnlockBanner();
  }

  setTimeout(() => {
    startWord(pickNextWord());
  }, unlockedNewTier ? 2200 : 1300);
}

function updateScoreboard(lastScore) {
  const avg = progress.totalWordsCompleted
    ? Math.round(progress.totalScoreSum / progress.totalWordsCompleted)
    : 0;
  document.getElementById("last-score").textContent =
    lastScore != null ? `Last: ${lastScore}` : "";
  document.getElementById("session-stats").textContent =
    `Words: ${progress.totalWordsCompleted} · Avg: ${avg}`;
}

function updateTierBadge() {
  document.getElementById("tier-badge").textContent = `Tier ${currentWord.tier}`;
}

function showTierUnlockBanner() {
  const banner = document.getElementById("tier-unlock-banner");
  banner.classList.remove("hidden");
  requestAnimationFrame(() => banner.classList.add("show"));
  setTimeout(() => {
    banner.classList.remove("show");
    setTimeout(() => banner.classList.add("hidden"), 400);
  }, 1900);
}

function resetProgress() {
  if (!confirm("Reset all progress? This can't be undone.")) return;
  progress = {
    unlockedTier: 1,
    tierStreak: 0,
    bestScores: {},
    totalWordsCompleted: 0,
    totalScoreSum: 0,
  };
  saveProgress();
  lastWord = null;
  updateScoreboard(null);
  startWord(pickNextWord());
}

const KEYBOARD_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];

function buildOnscreenKeyboard() {
  const container = document.getElementById("onscreen-keyboard");
  KEYBOARD_ROWS.forEach((row) => {
    const rowEl = document.createElement("div");
    rowEl.className = "keyboard-row";
    row.split("").forEach((letter) => {
      const key = document.createElement("button");
      key.type = "button";
      key.className = "key";
      key.textContent = letter;
      key.addEventListener("click", () => submitLetter(letter));
      rowEl.appendChild(key);
    });
    container.appendChild(rowEl);
  });
}

function startGame() {
  document.getElementById("start-overlay").classList.add("hidden");
  // Unlocking speech synchronously inside this click handler (rather than
  // waiting for the first in-game keypress) means even the very first word's
  // auto-speak timer - which fires shortly after this - is able to produce sound.
  unlockSpeech();
  startWord(pickNextWord());
}

function init() {
  document.getElementById("hear-btn").addEventListener("click", speakWord);
  document.getElementById("reset-btn").addEventListener("click", resetProgress);
  document.getElementById("start-btn").addEventListener("click", startGame);
  window.addEventListener("keydown", handleKeydown);
  buildOnscreenKeyboard();
  updateScoreboard(null);
}

init();
