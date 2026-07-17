// Controller: owns the single game-state object, runs the game logic, and wires
// input to it. Side effects go through the io/ modules; all DOM writes go
// through ui/view.js. (Extracting the game logic into a pure engine and the
// input handling into their own modules are the next steps - not done yet.)
import { WORDS, MAX_TIER } from "./words.js?v=15";
import { loadProgress, saveProgress, defaultProgress } from "./io/storage.js?v=15";
import {
  playCorrectSound,
  playWrongSound,
  playWordCompleteFanfare,
} from "./io/audio.js?v=15";
import { unlockSpeech, speakWord } from "./io/speech.js?v=15";
import * as view from "./ui/view.js?v=15";

const UNLOCK_THRESHOLD_SCORE = 70;
const WORDS_TO_UNLOCK = 3;
const MAX_MISSES_PER_LETTER = 3;
const SAD_FACE_THRESHOLD = 40;
// Word-pick weighting: each tier below the current top tier gets weight
// (tierDecay ^ tiersBelowTop). At BASE_TIER_DECAY, lower tiers are less
// likely than the top tier (favors newer/harder words). As recentStruggle
// rises toward 1, the effective decay rises toward MAX_TIER_DECAY, flipping
// the bias so easier/lower tiers become more likely (favors review/confidence).
const BASE_TIER_DECAY = 0.5;
const MAX_TIER_DECAY = 2.0;
const STRUGGLE_EMA_ALPHA = 0.25;
const KEYBOARD_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];

// The single source of truth. Game fields plus a `view` sub-object holding
// transient display state - the latter is what a declarative view would render.
const state = {
  currentWord: null,
  currentIndex: 0,
  wrongGuesses: 0,
  letterMisses: 0,
  lastWord: null,
  locked: false,
  progress: loadProgress(),
  view: {
    feedback: "",
    lastScore: null,
    flash: null, // { index, kind: "correct" | "wrong" } - fresh object per trigger
    scoreFace: null, // { score } - one-shot overlay trigger
    tierBanner: false, // one-shot unlock-banner trigger
  },
};

let autoSpeakTimer = null;

function pickNextWord(maxTier = state.progress.unlockedTier) {
  const pool = WORDS.filter(
    (w) =>
      w.tier <= maxTier && (!state.lastWord || w.word !== state.lastWord.word)
  );

  const decay =
    BASE_TIER_DECAY +
    state.progress.recentStruggle * (MAX_TIER_DECAY - BASE_TIER_DECAY);
  const weights = pool.map((w) =>
    Math.pow(decay, state.progress.unlockedTier - w.tier)
  );
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  let r = Math.random() * totalWeight;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function startWord(wordObj) {
  state.currentWord = wordObj;
  state.currentIndex = 0;
  state.wrongGuesses = 0;
  state.letterMisses = 0;
  state.locked = false;
  // Fresh word: clear any transient one-shot view triggers from the last word.
  state.view.feedback = "";
  state.view.flash = null;
  state.view.scoreFace = null;
  state.view.tierBanner = false;
  view.render(state);

  clearTimeout(autoSpeakTimer);
  autoSpeakTimer = setTimeout(() => speakWord(state.currentWord.word), 1000);
}

function handleKeydown(e) {
  if (!/^[a-zA-Z]$/.test(e.key)) return;
  onKeyInput(e.key, false);
}

// Single entry point for a letter guess: mutate state, then render once.
function onKeyInput(key, viaOnScreenKeyboard) {
  submitLetter(key, viaOnScreenKeyboard);
  view.render(state);
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
  if (!state.currentWord || state.locked) return;

  const expected = state.currentWord.word[state.currentIndex].toLowerCase();
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

  state.wrongGuesses++;
  state.letterMisses++;
  playWrongSound();
  state.view.flash = { index: state.currentIndex, kind: "wrong" };

  if (state.letterMisses >= MAX_MISSES_PER_LETTER) {
    // Miles has missed this letter too many times in a row - fill it in for
    // him so he doesn't get stuck, and say the word again as a reminder.
    // The misses already counted above still count against his score.
    advanceLetter();
    if (!state.locked) speakWord(state.currentWord.word);
  }
}

function advanceLetter() {
  state.currentIndex++;
  state.letterMisses = 0;
  playCorrectSound();
  state.view.flash = { index: state.currentIndex - 1, kind: "correct" };
  if (state.currentIndex === state.currentWord.word.length) {
    completeWord();
  }
}

function completeWord() {
  state.locked = true;
  playWordCompleteFanfare();

  const score = Math.round(
    Math.max(0, 100 - (state.wrongGuesses / state.currentWord.word.length) * 100)
  );
  state.progress.totalWordsCompleted++;
  state.progress.totalScoreSum += score;
  const prevBest = state.progress.bestScores[state.currentWord.word] || 0;
  if (score > prevBest) state.progress.bestScores[state.currentWord.word] = score;

  const failed = score < UNLOCK_THRESHOLD_SCORE ? 1 : 0;
  state.progress.recentStruggle =
    state.progress.recentStruggle * (1 - STRUGGLE_EMA_ALPHA) +
    failed * STRUGGLE_EMA_ALPHA;

  // Only words at the highest currently-unlocked tier count toward
  // unlocking the next one - practicing/reviewing lower tiers (which
  // happens more often now that they're weighted in) shouldn't help or
  // hurt progress toward the next tier.
  if (state.currentWord.tier === state.progress.unlockedTier) {
    if (score >= UNLOCK_THRESHOLD_SCORE) {
      state.progress.tierStreak = (state.progress.tierStreak || 0) + 1;
    } else {
      state.progress.tierStreak = 0;
    }
  }

  let unlockedNewTier = false;
  if (
    state.progress.tierStreak >= WORDS_TO_UNLOCK &&
    state.progress.unlockedTier < MAX_TIER
  ) {
    state.progress.unlockedTier++;
    state.progress.tierStreak = 0;
    unlockedNewTier = true;
  }

  saveProgress(state.progress);
  state.view.lastScore = score;
  state.lastWord = state.currentWord;

  // A sad-face score is discouraging to see, so skip the overlay entirely and
  // quietly move on - and make the next word an easier one by keeping it
  // below the highest unlocked tier (unless only tier 1 is unlocked).
  const sadFace = score < SAD_FACE_THRESHOLD;
  if (sadFace) {
    state.view.feedback = "";
    state.view.scoreFace = null;
  } else {
    state.view.feedback = `Great job! Score: ${score}`;
    state.view.scoreFace = { score };
  }

  state.view.tierBanner = unlockedNewTier;

  const nextMaxTier = sadFace
    ? Math.max(1, state.progress.unlockedTier - 1)
    : state.progress.unlockedTier;
  setTimeout(
    () => {
      startWord(pickNextWord(nextMaxTier));
    },
    unlockedNewTier ? 2200 : 1300
  );
}

function resetProgress() {
  if (!confirm("Reset all progress? This can't be undone.")) return;
  state.progress = defaultProgress();
  saveProgress(state.progress);
  state.lastWord = null;
  state.view.lastScore = null;
  startWord(pickNextWord());
}

function startGame() {
  view.hideStartOverlay();
  // Unlocking speech synchronously inside this click handler (rather than
  // waiting for the first in-game keypress) means even the very first word's
  // auto-speak timer - which fires shortly after this - is able to produce sound.
  unlockSpeech();
  startWord(pickNextWord());
}

function init() {
  // Input wiring stays in the controller for now (a dedicated input module is
  // the next step). All display goes through view.js.
  document.getElementById("hear-btn").addEventListener("click", () => {
    if (state.currentWord) speakWord(state.currentWord.word);
  });
  document.getElementById("reset-btn").addEventListener("click", resetProgress);
  document.getElementById("start-btn").addEventListener("click", startGame);
  window.addEventListener("keydown", handleKeydown);
  view.buildKeyboard(KEYBOARD_ROWS, (letter) => onKeyInput(letter, true));
  view.render(state);
}

init();
