import { test } from "node:test";
import assert from "node:assert/strict";

import { WORDS, MAX_TIER } from "../words.js";
import { createInitialState } from "../core/state.js";
import {
  isAdjacentKey,
  pickNextWord,
  startWord,
  submitLetter,
} from "../core/engine.js";

// ---- helpers ---------------------------------------------------------------

function freshProgress(over = {}) {
  return {
    unlockedTier: 1,
    tierStreak: 0,
    recentStruggle: 0,
    bestScores: {},
    totalWordsCompleted: 0,
    totalScoreSum: 0,
    ...over,
  };
}

const word = (w) => WORDS.find((x) => x.word === w);

// Start a fresh game already showing `w`.
function begin(w, progressOver) {
  const s = createInitialState(freshProgress(progressOver));
  return startWord(s, word(w)).state;
}

// Apply a sequence of physical key presses, threading state and collecting the
// effects from the final press (plus all effects, for ordering assertions).
function playKeys(state, keys, viaOnScreen = false) {
  let allEffects = [];
  let lastEffects = [];
  for (const k of keys) {
    const r = submitLetter(state, k, viaOnScreen, WORDS);
    state = r.state;
    lastEffects = r.effects;
    allEffects = allEffects.concat(r.effects);
  }
  return { state, effects: lastEffects, allEffects };
}

const types = (effects) => effects.map((e) => e.type);

// ---- scoring ---------------------------------------------------------------

test("perfect spelling scores 100 with a happy overlay", () => {
  const { state, allEffects } = playKeys(begin("cat"), ["c", "a", "t"]);
  assert.equal(state.view.lastScore, 100);
  assert.equal(state.view.feedback, "Great job! Score: 100");
  assert.deepEqual(state.view.scoreFace, { score: 100 });
  assert.equal(state.locked, true);
  assert.deepEqual(types(allEffects), [
    "sound", // c
    "sound", // a
    "sound", // t (correct) ...
    "sound", // fanfare
    "save",
    "scheduleNext",
  ]);
});

test("one wrong guess on a 3-letter word scores 67", () => {
  // 'z' is wrong on 'c'; physical presses are always penalised.
  const { state } = playKeys(begin("cat"), ["z", "c", "a", "t"]);
  assert.equal(state.view.lastScore, 67);
});

test("two wrong guesses scores 33 and triggers the sad-face path", () => {
  const { state, effects } = playKeys(begin("cat"), ["z", "c", "z", "a", "t"]);
  assert.equal(state.view.lastScore, 33);
  // Sad face (<40): no feedback, no overlay.
  assert.equal(state.view.feedback, "");
  assert.equal(state.view.scoreFace, null);
  // ...and the next word is capped one tier lower (floored at 1).
  const next = effects.find((e) => e.type === "scheduleNext");
  assert.equal(next.maxTier, 1);
  assert.equal(next.delay, 1300);
});

test("sad-face drops the next word a tier when higher tiers are unlocked", () => {
  const { effects } = playKeys(begin("cat", { unlockedTier: 2 }), [
    "z", "c", "z", "a", "t",
  ]);
  const next = effects.find((e) => e.type === "scheduleNext");
  assert.equal(next.maxTier, 1); // max(1, 2 - 1)
});

// ---- struggle EMA ----------------------------------------------------------

test("recentStruggle stays 0 after a win, rises after a miss", () => {
  const win = playKeys(begin("cat"), ["c", "a", "t"]);
  assert.equal(win.state.progress.recentStruggle, 0);

  const loss = playKeys(begin("cat"), ["z", "c", "z", "a", "t"]); // score 33 < 70
  assert.equal(loss.state.progress.recentStruggle, 0.25); // 0*0.75 + 1*0.25
});

test("recentStruggle decays from a prior value on a win", () => {
  const { state } = playKeys(begin("cat", { recentStruggle: 0.25 }), [
    "c", "a", "t",
  ]);
  assert.equal(state.progress.recentStruggle, 0.1875); // 0.25*0.75 + 0
});

// ---- max-misses auto-advance ----------------------------------------------

test("3 misses on a letter auto-fills it, keeps the misses, and re-speaks", () => {
  const { state, effects } = playKeys(begin("cat"), ["z", "z", "z"]);
  assert.equal(state.currentIndex, 1); // 'c' filled in for the player
  assert.equal(state.wrongGuesses, 3); // misses still count
  assert.equal(state.letterMisses, 0); // reset after advancing
  // The third miss: wrong sound, then the auto-advance's correct sound, then
  // a reminder speak (word isn't finished).
  assert.deepEqual(types(effects), ["sound", "sound", "speak"]);
});

test("max-misses that complete the word do NOT re-speak", () => {
  const { state, effects } = playKeys(begin("cat"), ["c", "a", "z", "z", "z"]);
  assert.equal(state.locked, true);
  assert.equal(state.view.lastScore, 0); // 3 wrong on 3 letters
  assert.ok(!types(effects).includes("speak"));
  assert.deepEqual(types(effects), [
    "sound", // wrong (3rd z)
    "sound", // correct (auto-advance)
    "sound", // fanfare (word complete)
    "save",
    "scheduleNext",
  ]);
});

// ---- tier unlocking --------------------------------------------------------

test("unlocks the next tier after 3 top-tier wins, then resets the streak", () => {
  let s = createInitialState(freshProgress());
  const banners = [];
  for (const w of ["cat", "dog", "sun"]) {
    s = startWord(s, word(w)).state;
    s = playKeys(s, word(w).word.split("")).state;
    banners.push(s.view.tierBanner);
  }
  assert.deepEqual(banners, [false, false, true]);
  assert.equal(s.progress.unlockedTier, 2);
  assert.equal(s.progress.tierStreak, 0);
});

test("a sub-threshold score resets the tier streak", () => {
  const { state } = playKeys(begin("cat", { tierStreak: 2 }), [
    "z", "c", "z", "a", "t",
  ]); // score 33
  assert.equal(state.progress.tierStreak, 0);
  assert.equal(state.progress.unlockedTier, 1);
});

test("wins on lower-than-top tiers do not advance the streak", () => {
  // 'cat' is tier 1, but tier 2 is the current top - it shouldn't count.
  const { state } = playKeys(
    begin("cat", { unlockedTier: 2, tierStreak: 1 }),
    ["c", "a", "t"]
  );
  assert.equal(state.progress.tierStreak, 1); // unchanged
  assert.equal(state.progress.unlockedTier, 2);
});

test("unlocking is capped at the highest tier", () => {
  const topWord = WORDS.find((w) => w.tier === MAX_TIER).word;
  const { state } = playKeys(
    begin(topWord, { unlockedTier: MAX_TIER, tierStreak: 2 }),
    topWord.split("")
  );
  assert.equal(state.progress.unlockedTier, MAX_TIER); // no unlock past the top
  assert.equal(state.view.tierBanner, false);
});

// ---- bestScores ------------------------------------------------------------

test("bestScores keeps the highest score per word", () => {
  let s = begin("cat");
  s = playKeys(s, ["z", "c", "a", "t"]).state; // 67
  assert.equal(s.progress.bestScores.cat, 67);

  s = startWord(s, word("cat")).state;
  s = playKeys(s, ["c", "a", "t"]).state; // 100
  assert.equal(s.progress.bestScores.cat, 100);

  s = startWord(s, word("cat")).state;
  s = playKeys(s, ["z", "c", "a", "t"]).state; // 67 again - shouldn't lower it
  assert.equal(s.progress.bestScores.cat, 100);
});

// ---- adjacent-key forgiveness ---------------------------------------------

test("adjacent on-screen taps are forgiven, physical presses are not", () => {
  // 'x' sits next to 'c' on the bottom row.
  const forgiven = submitLetter(begin("cat"), "x", true, WORDS);
  assert.equal(forgiven.state.wrongGuesses, 0);
  assert.equal(forgiven.state.currentIndex, 0);
  assert.deepEqual(types(forgiven.effects), ["sound"]); // wrong sound only

  const penalised = submitLetter(begin("cat"), "x", false, WORDS);
  assert.equal(penalised.state.wrongGuesses, 1);
});

test("isAdjacentKey knows the layout and doesn't wrap across rows", () => {
  assert.equal(isAdjacentKey("x", "c"), true);
  assert.equal(isAdjacentKey("v", "c"), true);
  assert.equal(isAdjacentKey("a", "c"), false);
  assert.equal(isAdjacentKey("p", "a"), false); // different rows, no wrap
});

// ---- word selection --------------------------------------------------------

test("pickNextWord never repeats the last word", () => {
  const s = createInitialState(freshProgress());
  s.lastWord = word("cat");
  const pick = pickNextWord(s, WORDS, 1, () => 0); // rng 0 => first eligible
  assert.notEqual(pick.word, "cat");
});

test("pickNextWord respects the max tier", () => {
  const s = createInitialState(freshProgress());
  for (const rng of [0, 0.25, 0.5, 0.75, 0.999]) {
    assert.ok(pickNextWord(s, WORDS, 1, () => rng).tier <= 1);
  }
});

test("pickNextWord is deterministic given the same rng", () => {
  const s = createInitialState(freshProgress({ unlockedTier: 2 }));
  const a = pickNextWord(s, WORDS, 2, () => 0.42);
  const b = pickNextWord(s, WORDS, 2, () => 0.42);
  assert.equal(a.word, b.word);
});

// ---- startWord -------------------------------------------------------------

test("startWord resets per-word state and schedules the spoken prompt", () => {
  const dirty = createInitialState(freshProgress());
  dirty.currentIndex = 2;
  dirty.wrongGuesses = 5;
  dirty.locked = true;
  dirty.view.feedback = "stale";
  dirty.view.flash = { index: 1, kind: "wrong" };

  const { state, effects } = startWord(dirty, word("cat"));
  assert.equal(state.currentIndex, 0);
  assert.equal(state.wrongGuesses, 0);
  assert.equal(state.letterMisses, 0);
  assert.equal(state.locked, false);
  assert.equal(state.view.feedback, "");
  assert.equal(state.view.flash, null);
  assert.deepEqual(effects, [{ type: "scheduleSpeak", delay: 1000 }]);
});

// ---- purity ----------------------------------------------------------------

test("submitLetter does not mutate the input state", () => {
  const s = begin("cat");
  const beforeIndex = s.currentIndex;
  const beforeWrong = s.wrongGuesses;
  const beforeFlash = s.view.flash;

  submitLetter(s, "c", false, WORDS); // correct - would advance a copy
  submitLetter(s, "z", false, WORDS); // wrong - would bump wrongGuesses on a copy

  assert.equal(s.currentIndex, beforeIndex);
  assert.equal(s.wrongGuesses, beforeWrong);
  assert.equal(s.view.flash, beforeFlash);
});

test("completing a word does not mutate the caller's progress object", () => {
  const s = begin("cat");
  const before = s.progress.totalWordsCompleted;
  playKeys(s, ["c", "a", "t"]);
  assert.equal(s.progress.totalWordsCompleted, before);
});

// ---- guards ----------------------------------------------------------------

test("input is ignored while locked or before a word starts", () => {
  const noWord = createInitialState(freshProgress());
  const r1 = submitLetter(noWord, "c", false, WORDS);
  assert.equal(r1.state, noWord);
  assert.deepEqual(r1.effects, []);

  const locked = begin("cat");
  locked.locked = true;
  const r2 = submitLetter(locked, "c", false, WORDS);
  assert.deepEqual(r2.effects, []);
});
