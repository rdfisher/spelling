// Tunable game constants, shared by the pure core. No DOM, no side effects.
export const UNLOCK_THRESHOLD_SCORE = 70;
export const WORDS_TO_UNLOCK = 3;
export const MAX_MISSES_PER_LETTER = 3;
export const SAD_FACE_THRESHOLD = 40;

// Word-pick weighting: each tier below the current top tier gets weight
// (tierDecay ^ tiersBelowTop). At BASE_TIER_DECAY, lower tiers are less
// likely than the top tier (favors newer/harder words). As recentStruggle
// rises toward 1, the effective decay rises toward MAX_TIER_DECAY, flipping
// the bias so easier/lower tiers become more likely (favors review/confidence).
export const BASE_TIER_DECAY = 0.5;
export const MAX_TIER_DECAY = 2.0;
export const STRUGGLE_EMA_ALPHA = 0.25;

// Keyboard layout - used by the engine for adjacent-key forgiveness and by the
// view to build the on-screen keyboard.
export const KEYBOARD_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
