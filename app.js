// Each game mode keeps its own independent progress (unlocked tiers, streaks,
// difficulty struggle, stats) under its own storage key.
const SPELL_STORAGE_KEY = "spelling-game-progress-v1";
const READ_STORAGE_KEY = "reading-game-progress-v1";
const COUNT_STORAGE_KEY = "counting-game-progress-v1";
const MATHS_STORAGE_KEY = "maths-game-progress-v1";
const UNLOCK_THRESHOLD_SCORE = 70;
const WORDS_TO_UNLOCK = 6;
// A missed top-tier word chips this much off the unlock streak instead of
// zeroing it, so one unlucky slip at the (rare, hard) frontier doesn't wipe out
// several games' worth of accumulated progress.
const STREAK_MISS_PENALTY = 2;
const MAX_MISSES_PER_LETTER = 3;
const SAD_FACE_THRESHOLD = 40;
// A game runs for this many turns and then ends with a summary screen. The
// counter resets to 0 whenever a tier unlocks, so a hot streak earns a fresh
// batch of turns; plateauing lets the game wind down. Bounded either way,
// since unlocks stop at MAX_TIER.
const TURNS_PER_GAME = 10;

// A word's difficulty tier is purely a function of its length. This is the
// single place the tier rules live - change these thresholds and every word
// re-tiers automatically (words.js is just data, no per-word tier field).
function tierForWord(word) {
  const n = word.length;
  if (n <= 3) return 1;
  if (n === 4) return 2;
  if (n === 5) return 3;
  if (n <= 7) return 4;
  return 5;
}

const MAX_TIER = Math.max(...WORDS.map((w) => tierForWord(w.word)));
// Word-pick weighting: each tier below the current top tier gets weight
// (tierDecay ^ tiersBelowTop). At BASE_TIER_DECAY, lower tiers are less
// likely than the top tier (favors newer/harder words). As recentStruggle
// rises toward 1, the effective decay rises toward MAX_TIER_DECAY, flipping
// the bias so easier/lower tiers become more likely (favors review/confidence).
const BASE_TIER_DECAY = 0.5;
const MAX_TIER_DECAY = 2.0;
const STRUGGLE_EMA_ALPHA = 0.25;
// Fraction of normal picks reserved for the current top tier. Without this, the
// growing stack of unlocked lower tiers crowds out the single top tier, so a
// player at a high tier rarely sees enough top-tier words in a 10-turn game to
// build the unlock streak. Pinning the top tier to a fixed share keeps top-tier
// exposure at ~WORDS_TO_UNLOCK per game at every tier. The share slides from MAX
// (confident) down to MIN as recentStruggle rises, bringing back easier review.
const TOP_TIER_SHARE_MAX = 0.65;
const TOP_TIER_SHARE_MIN = 0.4;

// "spell" | "read" - chosen from the start overlay. The active mode's progress
// object is aliased as `progress` so the shared bookkeeping helpers work
// unchanged, and `storageKey` tracks where to persist it.
let mode = "spell";
let spellProgress = loadProgress(SPELL_STORAGE_KEY);
let readProgress = loadProgress(READ_STORAGE_KEY);
let countProgress = loadProgress(COUNT_STORAGE_KEY);
let mathsProgress = loadProgress(MATHS_STORAGE_KEY);
let progress = spellProgress;
let storageKey = SPELL_STORAGE_KEY;
let currentWord = null;
let currentIndex = 0;
let wrongGuesses = 0;
let letterMisses = 0;
let lastWord = null;
let locked = false;
let audioCtx = null;
let autoSpeakTimer = null;
let speechUnlocked = false;

// Read mode: number of image choices per round and the score penalty per
// wrong tap (first-tap correct = 100; three wrong taps drops it to 0).
const READ_CHOICES = 4;
const READ_WRONG_PENALTY = 34;
let readTarget = null;
let readWrongTaps = 0;
// The round's choices in tile order, so number keys 1-4 can select them on a
// non-touch device (where tapping isn't practical).
let readChoices = [];

// Count mode: show N identical pictures and type how many on the keypad.
// Difficulty tiers are count ranges: tier 1 is small counts, tier 2 larger.
// Tier 2 unlocks from tier 1 via the usual streak. COUNT_TOP_SHARE is how often
// the current top tier is drawn once more than one is unlocked (the rest review
// a lower tier), mirroring the word modes.
const COUNT_TIERS = [
  [1, 5],
  [6, 10],
  [11, 15],
];
const COUNT_MAX_TIER = COUNT_TIERS.length;
const COUNT_TOP_SHARE = 0.7;
const COUNT_WRONG_PENALTY = 34;
let countTarget = 0;
let countWrong = 0;

function countTierForN(n) {
  for (let i = 0; i < COUNT_TIERS.length; i++) {
    if (n >= COUNT_TIERS[i][0] && n <= COUNT_TIERS[i][1]) return i + 1;
  }
  return 1;
}

// Maths mode: tier 1 adds two numbers, each MATHS_MIN..MATHS_MAX. Keyboard
// entry only (no multiple-choice level). Later tiers TBD after playtesting.
const MATHS_MIN = 1;
const MATHS_MAX = 5;
const MATHS_WRONG_PENALTY = 34;
let mathsA = 0;
let mathsB = 0;
let mathsWrong = 0;

// After this many wrong answers on a maths round, show the sum a second way:
// each addend drawn as a stack of coloured squares, so it can be counted out.
const MATHS_HINT_AFTER = 2;
// Numberblocks (BBC show) colours, used for those hint squares: 1 is red, 2 is
// orange, and so on, so a block's colour matches the character on screen. Only
// 1-5 are mapped because Maths mode adds numbers in that range; anything without
// a mapping falls back to grey until its show colour is added here.
const NUMBERBLOCK_COLORS = {
  1: "#e02a2a", // One - red
  2: "#ef7d1a", // Two - orange
  3: "#f4c91f", // Three - yellow
  4: "#54b948", // Four - green
  5: "#3fb3e6", // Five - blue
};
const BLOCK_FALLBACK_COLOR = "#b0b0c0";
function blockColor(n) {
  return NUMBERBLOCK_COLORS[n] || BLOCK_FALLBACK_COLOR;
}

// Shared numeric-keypad entry, used by Count level 2 and Maths. Only one mode
// is ever active, so a single typed buffer suffices.
let entryValue = "";

// Per-game counters (reset when a new game starts, not persisted). turnsThisLeg
// drives the game-end check and resets on tier unlock; the other three feed the
// summary screen and count across the whole game.
let turnsThisLeg = 0;
let gameWordsTotal = 0;
let gameScoreSum = 0;
let gameTiersUnlocked = 0;

function loadProgress(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const loaded = JSON.parse(raw);
      // Clamp in case a tier restructure since this was saved left
      // unlockedTier pointing past the current highest tier.
      loaded.unlockedTier = Math.min(loaded.unlockedTier, MAX_TIER);
      loaded.recentStruggle = loaded.recentStruggle ?? 0;
      return loaded;
    }
  } catch (e) {
    // ignore corrupt/unavailable storage, start fresh
  }
  return {
    unlockedTier: 1,
    tierStreak: 0,
    recentStruggle: 0,
    bestScores: {},
    totalWordsCompleted: 0,
    totalScoreSum: 0,
  };
}

function saveProgress() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(progress));
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

function speakWord(onDone) {
  if (!currentWord || !("speechSynthesis" in window)) {
    if (onDone) onDone();
    return;
  }
  const synth = window.speechSynthesis;
  const doSpeak = () => {
    const utter = new SpeechSynthesisUtterance(currentWord.word);
    utter.rate = 0.8;
    utter.pitch = 1.1;
    if (onDone) {
      utter.onend = onDone;
      utter.onerror = onDone;
    }
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

// Speak the current word, then run `after` once speech finishes. A fallback
// timer guarantees `after` still runs if speech is unavailable or a browser
// silently drops it (never firing onend), so the game never hangs waiting.
function speakThen(after) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    after();
  };
  const fallback = setTimeout(run, 2500);
  speakWord(() => {
    clearTimeout(fallback);
    run();
  });
}

function weightedChoice(items, weights) {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let r = Math.random() * totalWeight;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function pickFromTier(tier) {
  let pool = WORDS.filter(
    (w) => tierForWord(w.word) === tier && (!lastWord || w.word !== lastWord.word)
  );
  // Every tier has plenty of words, but guard against a tier of one that's also
  // the last word, so we never index into an empty pool.
  if (pool.length === 0) pool = WORDS.filter((w) => tierForWord(w.word) === tier);
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickNextWord(maxTier = progress.unlockedTier) {
  const topTier = progress.unlockedTier;
  const decay = BASE_TIER_DECAY + progress.recentStruggle * (MAX_TIER_DECAY - BASE_TIER_DECAY);

  // Normal pick at the frontier: give the top tier a fixed share of picks so it
  // isn't swamped by the accumulated lower tiers, then spread the rest across
  // the lower tiers by the usual decay weighting. (When maxTier is below the
  // frontier - the easier "confidence" pick after a low score - there are no
  // top-tier words to favour, so fall through to the plain weighted pick.)
  if (topTier > 1 && maxTier >= topTier) {
    const share =
      TOP_TIER_SHARE_MAX - progress.recentStruggle * (TOP_TIER_SHARE_MAX - TOP_TIER_SHARE_MIN);
    if (Math.random() < share) return pickFromTier(topTier);

    const lowerTiers = [];
    for (let t = 1; t < topTier; t++) lowerTiers.push(t);
    const tierWeights = lowerTiers.map((t) => Math.pow(decay, topTier - t));
    return pickFromTier(weightedChoice(lowerTiers, tierWeights));
  }

  const pool = WORDS.filter(
    (w) => tierForWord(w.word) <= maxTier && (!lastWord || w.word !== lastWord.word)
  );
  const weights = pool.map((w) => Math.pow(decay, topTier - tierForWord(w.word)));
  return weightedChoice(pool, weights);
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
  container.style.setProperty("--letter-count", currentWord.word.length);
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
  if (mode === "count") {
    handleNumpadKeydown(e);
    return;
  }
  if (mode === "maths") {
    handleNumpadKeydown(e);
    return;
  }
  if (mode === "read") {
    handleReadKeydown(e);
    return;
  }
  if (!/^[a-zA-Z]$/.test(e.key)) return;
  submitLetter(e.key, false);
}

function isAdjacentKey(pressed, expected) {
  const pressedUpper = pressed.toUpperCase();
  const expectedUpper = expected.toUpperCase();
  for (const row of KEYBOARD_ROWS) {
    const idx = row.indexOf(expectedUpper);
    if (idx === -1) continue;
    return row[idx - 1] === pressedUpper || row[idx + 1] === pressedUpper;
  }
  return false;
}

function submitLetter(key, viaOnScreenKeyboard) {
  if (!currentWord || locked) return;

  const expected = currentWord.word[currentIndex].toLowerCase();
  const got = key.toLowerCase();

  if (got === expected) {
    advanceLetter();
    return;
  }

  // A tap on the on-screen keyboard that lands on a key next to the right
  // one is likely a fat-finger slip, not a real mistake - play the same
  // sound so it's clear that wasn't the letter, but don't penalize it.
  // Physical keyboard presses don't get this forgiveness.
  if (viaOnScreenKeyboard && isAdjacentKey(got, expected)) {
    playWrongSound();
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
    // Lock input and let the finished word sit on screen for a beat before
    // the fanfare/score face takes over, so it doesn't vanish the instant
    // the last letter lands.
    locked = true;
    setTimeout(completeWord, 500);
  }
}

function completeWord() {
  locked = true;
  playWordCompleteFanfare();

  const score = Math.round(
    Math.max(0, 100 - (wrongGuesses / currentWord.word.length) * 100)
  );
  const { nextMaxTier, unlockedNewTier, gameOver } = recordCompletion(score);
  const delay = unlockedNewTier ? 2200 : 1300;
  setTimeout(() => {
    if (gameOver) showSummary();
    else startWord(pickNextWord(nextMaxTier));
  }, delay);
}

// Generic per-round bookkeeping shared by every mode: records the score into
// the active mode's stats, advances the per-game counters (a tier/level unlock
// resets the leg so a hot streak earns fresh turns), persists, and shows the
// scoreboard, score face/feedback, and unlock banner. Returns whether the game
// has now ended.
function finishRound(score, unlockedNewTier) {
  progress.totalWordsCompleted++;
  progress.totalScoreSum += score;

  gameWordsTotal++;
  gameScoreSum += score;
  turnsThisLeg++;
  if (unlockedNewTier) {
    gameTiersUnlocked++;
    turnsThisLeg = 0;
  }
  renderTurnProgress();
  const gameOver = turnsThisLeg >= TURNS_PER_GAME;

  saveProgress();
  updateScoreboard(score);

  // A sad-face score is discouraging to see, so skip the overlay entirely and
  // quietly move on.
  if (score < SAD_FACE_THRESHOLD) {
    activeFeedbackEl().textContent = "";
  } else {
    activeFeedbackEl().textContent = `Great job! Score: ${score}`;
    showScoreFace(score);
  }
  if (unlockedNewTier) showTierUnlockBanner();

  return gameOver;
}

// Word-mode (spell/read) end-of-round bookkeeping: updates the best score and
// difficulty struggle EMA, advances the word-tier unlock streak, then defers to
// finishRound for the shared parts. Returns the tier cap for the next word,
// whether a new tier unlocked, and whether the game has ended.
function recordCompletion(score) {
  const prevBest = progress.bestScores[currentWord.word] || 0;
  if (score > prevBest) progress.bestScores[currentWord.word] = score;

  const failed = score < UNLOCK_THRESHOLD_SCORE ? 1 : 0;
  progress.recentStruggle =
    progress.recentStruggle * (1 - STRUGGLE_EMA_ALPHA) + failed * STRUGGLE_EMA_ALPHA;

  // Only words at the highest currently-unlocked tier count toward
  // unlocking the next one - practicing/reviewing lower tiers (which
  // happens more often now that they're weighted in) shouldn't help or
  // hurt progress toward the next tier.
  if (tierForWord(currentWord.word) === progress.unlockedTier) {
    if (score >= UNLOCK_THRESHOLD_SCORE) {
      progress.tierStreak = (progress.tierStreak || 0) + 1;
    } else {
      progress.tierStreak = Math.max(0, (progress.tierStreak || 0) - STREAK_MISS_PENALTY);
    }
  }

  let unlockedNewTier = false;
  if (progress.tierStreak >= WORDS_TO_UNLOCK && progress.unlockedTier < MAX_TIER) {
    progress.unlockedTier++;
    progress.tierStreak = 0;
    unlockedNewTier = true;
  }

  lastWord = currentWord;
  const gameOver = finishRound(score, unlockedNewTier);

  const sadFace = score < SAD_FACE_THRESHOLD;
  const nextMaxTier = sadFace
    ? Math.max(1, progress.unlockedTier - 1)
    : progress.unlockedTier;
  return { nextMaxTier, unlockedNewTier, gameOver };
}

function activeFeedbackEl() {
  if (mode === "read") return document.getElementById("read-feedback");
  if (mode === "count") return document.getElementById("count-feedback");
  if (mode === "maths") return document.getElementById("maths-feedback");
  return document.getElementById("feedback");
}

function renderTurnProgress() {
  const el = document.getElementById("turn-progress");
  if (!el) return;
  el.innerHTML = "";
  for (let i = 0; i < TURNS_PER_GAME; i++) {
    const dot = document.createElement("span");
    dot.className = "turn-dot" + (i < turnsThisLeg ? " done" : "");
    el.appendChild(dot);
  }
}

function resetGameCounters() {
  turnsThisLeg = 0;
  gameWordsTotal = 0;
  gameScoreSum = 0;
  gameTiersUnlocked = 0;
  renderTurnProgress();
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
  document.getElementById("tier-badge").textContent = `Tier ${tierForWord(currentWord.word)}`;
}

function getFaceForScore(score) {
  if (score === 100) return "assets/images/face-great.svg";
  if (score >= 70) return "assets/images/face-good.svg";
  if (score >= SAD_FACE_THRESHOLD) return "assets/images/face-okay.svg";
  return "assets/images/face-sad.svg";
}

function showScoreFace(score) {
  const overlay = document.getElementById("score-face-overlay");
  document.getElementById("score-face-image").src = getFaceForScore(score);
  overlay.classList.remove("hidden");
  setTimeout(() => overlay.classList.add("hidden"), 1000);
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

function summaryTitle(avg) {
  if (avg >= 90) return "Amazing game! 🌟";
  if (avg >= 70) return "Great game! 🎉";
  if (avg >= SAD_FACE_THRESHOLD) return "Good effort! 👍";
  return "Keep practising! 💪";
}

function showSummary() {
  const avg = gameWordsTotal ? Math.round(gameScoreSum / gameWordsTotal) : 0;
  document.getElementById("summary-face").src = getFaceForScore(avg);
  document.getElementById("summary-title").textContent = summaryTitle(avg);
  document.getElementById("summary-words").textContent = gameWordsTotal;
  document.getElementById("summary-avg").textContent = avg;

  const tierLine = document.getElementById("summary-tiers");
  if (gameTiersUnlocked > 0) {
    tierLine.textContent =
      `You unlocked ${gameTiersUnlocked} new tier${gameTiersUnlocked > 1 ? "s" : ""}! 🎉`;
    tierLine.classList.remove("hidden");
  } else {
    tierLine.classList.add("hidden");
  }

  document.getElementById("summary-overlay").classList.remove("hidden");
}

function playAgain() {
  document.getElementById("summary-overlay").classList.add("hidden");
  resetGameCounters();
  restartActiveMode();
}

// Kick off a fresh round in whatever mode is active.
function restartActiveMode() {
  if (mode === "read") startReadRound();
  else if (mode === "count") startCountRound();
  else if (mode === "maths") startMathsRound();
  else startWord(pickNextWord());
}

function goToMenu() {
  document.getElementById("summary-overlay").classList.add("hidden");
  document.getElementById("start-overlay").classList.remove("hidden");
}

function resetProgress() {
  if (!confirm("Reset all progress? This can't be undone.")) return;
  const fresh = {
    unlockedTier: 1,
    tierStreak: 0,
    recentStruggle: 0,
    bestScores: {},
    totalWordsCompleted: 0,
    totalScoreSum: 0,
  };
  // Reset only the mode currently being played; the other mode's progress
  // is stored separately and left untouched.
  progress = fresh;
  if (mode === "read") readProgress = fresh;
  else if (mode === "count") countProgress = fresh;
  else if (mode === "maths") mathsProgress = fresh;
  else spellProgress = fresh;
  saveProgress();
  lastWord = null;
  updateScoreboard(null);
  resetGameCounters();
  restartActiveMode();
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
      key.addEventListener("click", () => submitLetter(letter, true));
      rowEl.appendChild(key);
    });
    container.appendChild(rowEl);
  });
}

// Point `progress`/`storageKey` at the chosen mode, swap which <main> is
// shown, and refresh the shared header/scoreboard. Called once from the start
// overlay - there's no way back to it, so the two modes never run at once.
const MODE_PROGRESS = () => ({
  spell: spellProgress,
  read: readProgress,
  count: countProgress,
  maths: mathsProgress,
});
const MODE_STORAGE_KEY = {
  spell: SPELL_STORAGE_KEY,
  read: READ_STORAGE_KEY,
  count: COUNT_STORAGE_KEY,
  maths: MATHS_STORAGE_KEY,
};
const MODE_TITLE = {
  spell: "Miles' Spelling Game",
  read: "Miles' Reading Game",
  count: "Miles' Counting Game",
  maths: "Miles' Maths Game",
};

function setMode(m) {
  mode = m;
  progress = MODE_PROGRESS()[m];
  storageKey = MODE_STORAGE_KEY[m];
  lastWord = null;
  document.getElementById("spell-main").classList.toggle("hidden", m !== "spell");
  document.getElementById("read-main").classList.toggle("hidden", m !== "read");
  document.getElementById("count-main").classList.toggle("hidden", m !== "count");
  document.getElementById("maths-main").classList.toggle("hidden", m !== "maths");
  document.getElementById("game-title").textContent = MODE_TITLE[m];
  updateScoreboard(null);
  resetGameCounters();
}

function startSpell() {
  setMode("spell");
  document.getElementById("start-overlay").classList.add("hidden");
  // Unlocking speech synchronously inside this click handler (rather than
  // waiting for the first in-game keypress) means even the very first word's
  // auto-speak timer - which fires shortly after this - is able to produce sound.
  unlockSpeech();
  startWord(pickNextWord());
}

function startRead() {
  setMode("read");
  document.getElementById("start-overlay").classList.add("hidden");
  // Prime speech inside this tap so the word can be spoken on a correct answer
  // (iOS only allows speech after a speak() call within a real user gesture).
  unlockSpeech();
  startReadRound();
}

function startCount() {
  setMode("count");
  document.getElementById("start-overlay").classList.add("hidden");
  startCountRound();
}

function startMaths() {
  setMode("maths");
  document.getElementById("start-overlay").classList.add("hidden");
  startMathsRound();
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Build the four image choices for a round: the target plus three random
// distractors drawn from the same unlocked-tier pool, all shuffled.
function buildReadChoices(target) {
  const pool = WORDS.filter(
    (w) => tierForWord(w.word) <= progress.unlockedTier && w.word !== target.word
  );
  const distractors = shuffle(pool).slice(0, READ_CHOICES - 1);
  return shuffle([target, ...distractors]);
}

function startReadRound(maxTier = progress.unlockedTier) {
  readTarget = pickNextWord(maxTier);
  // Alias as currentWord so the shared tier badge / recordCompletion helpers,
  // which read currentWord, work for read rounds too.
  currentWord = readTarget;
  readWrongTaps = 0;
  locked = false;
  updateTierBadge();
  activeFeedbackEl().textContent = "";
  document.getElementById("read-word").textContent = readTarget.word;
  flashReadWord();

  const container = document.getElementById("read-choices");
  container.innerHTML = "";
  readChoices = buildReadChoices(readTarget);
  readChoices.forEach((w, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "read-choice";
    const img = document.createElement("img");
    img.src = w.image;
    img.alt = "";
    btn.appendChild(img);
    // Corner number for keyboard selection; hidden on touch devices via CSS.
    const num = document.createElement("span");
    num.className = "choice-num";
    num.textContent = i + 1;
    btn.appendChild(num);
    btn.addEventListener("click", () => handleReadChoice(w, btn));
    container.appendChild(btn);
  });
}

// Number keys 1-4 pick the matching tile (for non-touch play).
function handleReadKeydown(e) {
  const idx = "1234".indexOf(e.key);
  if (idx === -1) return;
  const btn = document.querySelectorAll("#read-choices .read-choice")[idx];
  if (!btn || btn.disabled) return;
  handleReadChoice(readChoices[idx], btn);
}

function handleReadChoice(word, btn) {
  if (locked) return;

  if (word.word === readTarget.word) {
    locked = true;
    btn.classList.add("correct");
    // Say the word aloud first (reading reinforcement), then the celebration
    // sound, then let the correct tile's highlight land before moving on.
    speakThen(() => {
      playWordCompleteFanfare();
      setTimeout(completeReadRound, 500);
    });
    return;
  }

  // Wrong pick: penalize, grey it out so it can't be tapped again, and let
  // the child keep trying the remaining tiles until they find the right one.
  // Re-flash the word too, to pull attention back to reading it.
  readWrongTaps++;
  playWrongSound();
  btn.classList.add("wrong");
  btn.disabled = true;
  setTimeout(() => btn.classList.remove("wrong"), 400);
  flashReadWord();
}

// Restart the word's attention pulse. Removing the class and forcing a reflow
// before re-adding it lets the CSS animation replay on demand (mid-round).
function flashReadWord() {
  const el = document.getElementById("read-word");
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

function completeReadRound() {
  const score = Math.max(0, 100 - readWrongTaps * READ_WRONG_PENALTY);
  const { nextMaxTier, unlockedNewTier, gameOver } = recordCompletion(score);
  const delay = unlockedNewTier ? 2200 : 1300;
  setTimeout(() => {
    if (gameOver) showSummary();
    else startReadRound(nextMaxTier);
  }, delay);
}

// -- Count mode ------------------------------------------------------------
// Keypad entry only. Difficulty is the count range (COUNT_TIERS), gated by
// progress.unlockedTier.

function startCountRound() {
  // Favour the top unlocked tier; occasionally review a lower one.
  let tier = progress.unlockedTier;
  if (tier > 1 && Math.random() > COUNT_TOP_SHARE) {
    tier = 1 + Math.floor(Math.random() * (tier - 1));
  }
  const [lo, hi] = COUNT_TIERS[tier - 1];
  countTarget = lo + Math.floor(Math.random() * (hi - lo + 1));
  countWrong = 0;
  entryValue = "";
  locked = false;

  document.getElementById("tier-badge").textContent = `Tier ${countTierForN(countTarget)}`;
  activeFeedbackEl().textContent = "";
  renderCountObjects(countTarget);
  renderEntry();
}

// Render `n` copies of one random picture to be counted.
function renderCountObjects(n) {
  const container = document.getElementById("count-objects");
  container.innerHTML = "";
  const pic = WORDS[Math.floor(Math.random() * WORDS.length)].image;
  for (let i = 0; i < n; i++) {
    const img = document.createElement("img");
    img.src = pic;
    img.alt = "";
    container.appendChild(img);
  }
}

// Shared numeric-keypad entry (Count + Maths). The typed value shows in
// the active mode's display; "check" submits to the active mode's handler.
function entryDisplayEl() {
  return document.getElementById(mode === "maths" ? "maths-typed" : "count-typed");
}

function renderEntry() {
  entryDisplayEl().textContent = entryValue === "" ? "?" : entryValue;
}

function handleEntryKey(key) {
  if (locked) return;
  if (key === "check") {
    if (entryValue !== "") submitEntry();
    return;
  }
  if (key === "back") {
    entryValue = entryValue.slice(0, -1);
    renderEntry();
    return;
  }
  // digit - cap at two characters (largest answer is 18)
  if (entryValue.length >= 2) return;
  entryValue = (entryValue + key).replace(/^0+(?=\d)/, "");
  renderEntry();
}

function submitEntry() {
  if (mode === "maths") submitMaths();
  else submitCount();
}

// Buzz, shake the display, and clear it so they can try again.
function rejectEntry(counterInc) {
  playWrongSound();
  const el = entryDisplayEl();
  el.classList.add("shake");
  setTimeout(() => el.classList.remove("shake"), 400);
  entryValue = "";
  renderEntry();
  return counterInc;
}

function submitCount() {
  if (parseInt(entryValue, 10) === countTarget) {
    locked = true;
    playWordCompleteFanfare();
    setTimeout(completeCountRound, 500);
    return;
  }
  countWrong++;
  rejectEntry();
}

function completeCountRound() {
  const score = Math.max(0, 100 - countWrong * COUNT_WRONG_PENALTY);

  // Only rounds at the current top tier count toward unlocking the next one -
  // reviewing an easier tier shouldn't help or hurt progress.
  if (countTierForN(countTarget) === progress.unlockedTier) {
    if (score >= UNLOCK_THRESHOLD_SCORE) {
      progress.tierStreak = (progress.tierStreak || 0) + 1;
    } else {
      progress.tierStreak = Math.max(0, (progress.tierStreak || 0) - STREAK_MISS_PENALTY);
    }
  }
  let unlockedNewTier = false;
  if (progress.tierStreak >= WORDS_TO_UNLOCK && progress.unlockedTier < COUNT_MAX_TIER) {
    progress.unlockedTier++;
    progress.tierStreak = 0;
    unlockedNewTier = true;
  }

  const gameOver = finishRound(score, unlockedNewTier);
  const delay = unlockedNewTier ? 2200 : 1300;
  setTimeout(() => {
    if (gameOver) showSummary();
    else startCountRound();
  }, delay);
}

const NUMPAD_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["back", "0", "check"],
];
const NUMPAD_LABEL = { back: "⌫", check: "✓" };

function buildNumpad(containerId) {
  const container = document.getElementById(containerId);
  NUMPAD_ROWS.forEach((row) => {
    const rowEl = document.createElement("div");
    rowEl.className = "keyboard-row";
    row.forEach((key) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "key" + (NUMPAD_LABEL[key] ? " key-action" : "");
      btn.textContent = NUMPAD_LABEL[key] || key;
      btn.addEventListener("click", () => handleEntryKey(key));
      rowEl.appendChild(btn);
    });
    container.appendChild(rowEl);
  });
}

function handleNumpadKeydown(e) {
  if (/^[0-9]$/.test(e.key)) handleEntryKey(e.key);
  else if (e.key === "Backspace") handleEntryKey("back");
  else if (e.key === "Enter") handleEntryKey("check");
}

// -- Maths mode ------------------------------------------------------------
// Tier 1: add two single-digit numbers, keyboard entry only.

function startMathsRound() {
  mathsA = MATHS_MIN + Math.floor(Math.random() * (MATHS_MAX - MATHS_MIN + 1));
  mathsB = MATHS_MIN + Math.floor(Math.random() * (MATHS_MAX - MATHS_MIN + 1));
  mathsWrong = 0;
  entryValue = "";
  locked = false;
  document.getElementById("tier-badge").textContent = "➕ Add";
  activeFeedbackEl().textContent = "";
  document.getElementById("maths-sum").textContent = `${mathsA} + ${mathsB} =`;
  hideMathsBlocks();
  renderEntry();
}

function submitMaths() {
  if (parseInt(entryValue, 10) === mathsA + mathsB) {
    locked = true;
    playWordCompleteFanfare();
    setTimeout(completeMathsRound, 500);
    return;
  }
  mathsWrong++;
  // Two wrong tries in and still stuck: show the sum as coloured blocks so it
  // can be counted out. Once shown it stays up for the rest of the round.
  if (mathsWrong >= MATHS_HINT_AFTER) showMathsBlocks();
  rejectEntry();
}

// One addend as a stack of squares, all in that number's Numberblocks colour.
function buildBlockStack(n) {
  const stack = document.createElement("div");
  stack.className = "block-stack";
  const color = blockColor(n);
  for (let i = 0; i < n; i++) {
    const sq = document.createElement("span");
    sq.className = "block-square";
    sq.style.background = color;
    stack.appendChild(sq);
  }
  return stack;
}

function hideMathsBlocks() {
  const container = document.getElementById("maths-blocks");
  container.classList.add("hidden");
  container.innerHTML = "";
}

// Draw the sum a second way - e.g. 1 + 2 as one red block plus two orange
// blocks = ? - to help count the answer out.
function showMathsBlocks() {
  const container = document.getElementById("maths-blocks");
  if (!container.classList.contains("hidden")) return; // already up
  container.innerHTML = "";
  const addOp = (text, extraClass) => {
    const op = document.createElement("span");
    op.className = "block-op" + (extraClass ? " " + extraClass : "");
    op.textContent = text;
    container.appendChild(op);
  };
  container.appendChild(buildBlockStack(mathsA));
  addOp("+");
  container.appendChild(buildBlockStack(mathsB));
  addOp("=");
  addOp("?", "block-q");
  container.classList.remove("hidden");
}

function completeMathsRound() {
  const score = Math.max(0, 100 - mathsWrong * MATHS_WRONG_PENALTY);
  const gameOver = finishRound(score, false);
  setTimeout(() => {
    if (gameOver) showSummary();
    else startMathsRound();
  }, 1300);
}

// Face reaction images aren't in WORDS but are needed during play, so preload
// them too - a network drop mid-game shouldn't leave a blank score face.
const FACE_IMAGES = [
  "assets/images/face-great.svg",
  "assets/images/face-good.svg",
  "assets/images/face-okay.svg",
  "assets/images/face-sad.svg",
];

// Fetch every picture up front (into the browser cache) behind a progress bar,
// so once loading finishes the game plays with no further network needed - the
// point being to load everything while there's signal (e.g. before a train)
// and keep working when it drops. Images pull from cache during play because
// the game uses the same URLs. Failed loads retry a few times, then give up so
// the bar can't stall on one bad picture.
function preloadImages(onComplete) {
  const urls = [...new Set([...WORDS.map((w) => w.image), ...FACE_IMAGES])];
  const total = urls.length;
  let settled = 0;
  const fill = document.getElementById("preload-fill");
  const count = document.getElementById("preload-count");

  const update = () => {
    fill.style.width = Math.round((settled / total) * 100) + "%";
    count.textContent = `${settled} / ${total}`;
  };
  const settle = () => {
    settled++;
    update();
    if (settled === total) onComplete();
  };
  update();

  urls.forEach((url) => {
    let tries = 0;
    const attempt = () => {
      const img = new Image();
      img.onload = settle;
      img.onerror = () => {
        if (++tries < 3) setTimeout(attempt, 600);
        else settle();
      };
      img.src = url;
    };
    attempt();
  });
}

function onPreloadDone() {
  document.getElementById("preload").classList.add("hidden");
  document.getElementById("start-buttons").classList.remove("hidden");
}

function init() {
  // Wrapped so the click event isn't passed as speakWord's onDone callback.
  document.getElementById("hear-btn").addEventListener("click", () => speakWord());
  document.getElementById("reset-btn").addEventListener("click", resetProgress);
  document.getElementById("spell-btn").addEventListener("click", startSpell);
  document.getElementById("read-btn").addEventListener("click", startRead);
  document.getElementById("count-btn").addEventListener("click", startCount);
  document.getElementById("maths-btn").addEventListener("click", startMaths);
  document.getElementById("play-again-btn").addEventListener("click", playAgain);
  document.getElementById("menu-btn").addEventListener("click", goToMenu);
  window.addEventListener("keydown", handleKeydown);
  buildOnscreenKeyboard();
  buildNumpad("count-keypad");
  buildNumpad("maths-keypad");
  updateScoreboard(null);
  preloadImages(onPreloadDone);
}

init();
