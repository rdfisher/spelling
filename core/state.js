// The shape of the game state. Game fields plus a `view` sub-object holding
// transient display state that a declarative view would render from.
export function createInitialState(progress) {
  return {
    currentWord: null,
    currentIndex: 0,
    wrongGuesses: 0,
    letterMisses: 0,
    lastWord: null,
    locked: false,
    progress,
    view: {
      feedback: "",
      lastScore: null,
      flash: null, // { index, kind: "correct" | "wrong" } - fresh object per trigger
      scoreFace: null, // { score } - one-shot overlay trigger
      tierBanner: false, // one-shot unlock-banner trigger
    },
  };
}
