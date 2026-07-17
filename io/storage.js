// Persistence for game progress. Owns the localStorage key and the shape of
// the saved progress object, so the rest of the app never touches storage.
import { MAX_TIER } from "../words.js?v=16";

const STORAGE_KEY = "spelling-game-progress-v1";

export function defaultProgress() {
  return {
    unlockedTier: 1,
    tierStreak: 0,
    recentStruggle: 0,
    bestScores: {},
    totalWordsCompleted: 0,
    totalScoreSum: 0,
  };
}

export function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
  return defaultProgress();
}

export function saveProgress(progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch (e) {
    // storage unavailable (e.g. private browsing) - progress just won't persist
  }
}
