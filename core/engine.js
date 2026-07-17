// Pure game engine. No DOM, no audio, no storage, no timers - every transition
// takes the current state and returns { state, effects }, where `effects` is a
// list of side effects for the shell (main.js) to perform. Given the same
// inputs (and rng) it is fully deterministic, so it can be unit-tested without
// a browser.
//
// Effect shapes:
//   { type: "sound", name: "correct" | "wrong" | "fanfare" }
//   { type: "speak" }                              - say the current word
//   { type: "scheduleSpeak", delay }               - say it after `delay` ms
//   { type: "save" }                               - persist progress
//   { type: "scheduleNext", delay, maxTier }       - start next word after delay
import { MAX_TIER } from "../words.js?v=16";
import {
  UNLOCK_THRESHOLD_SCORE,
  WORDS_TO_UNLOCK,
  MAX_MISSES_PER_LETTER,
  SAD_FACE_THRESHOLD,
  BASE_TIER_DECAY,
  MAX_TIER_DECAY,
  STRUGGLE_EMA_ALPHA,
  KEYBOARD_ROWS,
} from "./config.js?v=16";

function clone(state) {
  return {
    ...state,
    progress: { ...state.progress, bestScores: { ...state.progress.bestScores } },
    view: { ...state.view },
  };
}

export function isAdjacentKey(pressed, expected) {
  const pressedUpper = pressed.toUpperCase();
  const expectedUpper = expected.toUpperCase();
  for (const row of KEYBOARD_ROWS) {
    const idx = row.indexOf(expectedUpper);
    if (idx === -1) continue;
    return row[idx - 1] === pressedUpper || row[idx + 1] === pressedUpper;
  }
  return false;
}

export function pickNextWord(
  state,
  words,
  maxTier = state.progress.unlockedTier,
  rng = Math.random
) {
  const pool = words.filter(
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

  let r = rng() * totalWeight;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

export function startWord(state, wordObj) {
  const s = clone(state);
  s.currentWord = wordObj;
  s.currentIndex = 0;
  s.wrongGuesses = 0;
  s.letterMisses = 0;
  s.locked = false;
  // Fresh word: clear any transient one-shot view triggers from the last word.
  s.view.feedback = "";
  s.view.flash = null;
  s.view.scoreFace = null;
  s.view.tierBanner = false;
  return { state: s, effects: [{ type: "scheduleSpeak", delay: 1000 }] };
}

export function submitLetter(state, key, viaOnScreenKeyboard, words) {
  if (!state.currentWord || state.locked) return { state, effects: [] };

  const expected = state.currentWord.word[state.currentIndex].toLowerCase();
  const got = key.toLowerCase();

  if (got === expected) {
    return advance(clone(state));
  }

  // A tap on the on-screen keyboard that lands on a key next to the right
  // one is likely a fat-finger slip, not a real mistake - play the same
  // sound so it's clear that wasn't the letter, but don't penalize it.
  // Physical keyboard presses don't get this forgiveness.
  if (viaOnScreenKeyboard && isAdjacentKey(got, expected)) {
    return { state, effects: [{ type: "sound", name: "wrong" }] };
  }

  const s = clone(state);
  s.wrongGuesses++;
  s.letterMisses++;
  s.view.flash = { index: s.currentIndex, kind: "wrong" };

  if (s.letterMisses >= MAX_MISSES_PER_LETTER) {
    // Missed this letter too many times in a row - fill it in so the player
    // doesn't get stuck, and say the word again as a reminder. The misses
    // already counted above still count against the score.
    const r = advance(s);
    const effects = [{ type: "sound", name: "wrong" }, ...r.effects];
    if (!r.state.locked) effects.push({ type: "speak" });
    return { state: r.state, effects };
  }

  return { state: s, effects: [{ type: "sound", name: "wrong" }] };
}

// Advances past the current letter. Mutates the (already-cloned) state it is
// handed, and completes the word if that was the last letter.
function advance(s) {
  s.currentIndex++;
  s.letterMisses = 0;
  s.view.flash = { index: s.currentIndex - 1, kind: "correct" };
  const effects = [{ type: "sound", name: "correct" }];
  if (s.currentIndex === s.currentWord.word.length) {
    const c = complete(s);
    return { state: c.state, effects: [...effects, ...c.effects] };
  }
  return { state: s, effects };
}

function complete(s) {
  s.locked = true;
  const effects = [{ type: "sound", name: "fanfare" }];

  const score = Math.round(
    Math.max(0, 100 - (s.wrongGuesses / s.currentWord.word.length) * 100)
  );
  s.progress.totalWordsCompleted++;
  s.progress.totalScoreSum += score;
  const prevBest = s.progress.bestScores[s.currentWord.word] || 0;
  if (score > prevBest) s.progress.bestScores[s.currentWord.word] = score;

  const failed = score < UNLOCK_THRESHOLD_SCORE ? 1 : 0;
  s.progress.recentStruggle =
    s.progress.recentStruggle * (1 - STRUGGLE_EMA_ALPHA) +
    failed * STRUGGLE_EMA_ALPHA;

  // Only words at the highest currently-unlocked tier count toward unlocking
  // the next one - practicing/reviewing lower tiers shouldn't help or hurt
  // progress toward the next tier.
  if (s.currentWord.tier === s.progress.unlockedTier) {
    if (score >= UNLOCK_THRESHOLD_SCORE) {
      s.progress.tierStreak = (s.progress.tierStreak || 0) + 1;
    } else {
      s.progress.tierStreak = 0;
    }
  }

  let unlockedNewTier = false;
  if (
    s.progress.tierStreak >= WORDS_TO_UNLOCK &&
    s.progress.unlockedTier < MAX_TIER
  ) {
    s.progress.unlockedTier++;
    s.progress.tierStreak = 0;
    unlockedNewTier = true;
  }

  s.view.lastScore = score;
  s.lastWord = s.currentWord;

  // A sad-face score is discouraging to see, so skip the overlay entirely and
  // quietly move on - and make the next word an easier one by keeping it below
  // the highest unlocked tier (unless only tier 1 is unlocked).
  const sadFace = score < SAD_FACE_THRESHOLD;
  if (sadFace) {
    s.view.feedback = "";
    s.view.scoreFace = null;
  } else {
    s.view.feedback = `Great job! Score: ${score}`;
    s.view.scoreFace = { score };
  }
  s.view.tierBanner = unlockedNewTier;

  const nextMaxTier = sadFace
    ? Math.max(1, s.progress.unlockedTier - 1)
    : s.progress.unlockedTier;

  effects.push({ type: "save" });
  effects.push({
    type: "scheduleNext",
    delay: unlockedNewTier ? 2200 : 1300,
    maxTier: nextMaxTier,
  });
  return { state: s, effects };
}
