import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultProgress } from "../io/storage.js";

test("defaultProgress returns a fresh tier-1 progress object", () => {
  assert.deepEqual(defaultProgress(), {
    unlockedTier: 1,
    tierStreak: 0,
    recentStruggle: 0,
    bestScores: {},
    totalWordsCompleted: 0,
    totalScoreSum: 0,
  });
});

test("defaultProgress returns a new object each call (no shared state)", () => {
  const a = defaultProgress();
  const b = defaultProgress();
  a.bestScores.cat = 100;
  assert.deepEqual(b.bestScores, {}); // b is unaffected
});
