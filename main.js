// Controller / shell. Owns the mutable state reference, dispatches input into
// the pure engine, applies the engine's effects (audio, speech, storage,
// timers), and renders. Contains no game rules and no DOM writes of its own.
import { WORDS } from "./words.js?v=16";
import { loadProgress, saveProgress, defaultProgress } from "./io/storage.js?v=16";
import {
  playCorrectSound,
  playWrongSound,
  playWordCompleteFanfare,
} from "./io/audio.js?v=16";
import { unlockSpeech, speakWord } from "./io/speech.js?v=16";
import { createInitialState } from "./core/state.js?v=16";
import { pickNextWord, startWord, submitLetter } from "./core/engine.js?v=16";
import * as view from "./ui/view.js?v=16";
import { buildKeyboard } from "./ui/keyboard.js?v=16";
import { bindInput } from "./ui/input.js?v=16";

let state = createInitialState(loadProgress());
let autoSpeakTimer = null;

// Apply an engine result: adopt the new state, render it, then run its effects.
function commit(result) {
  state = result.state;
  view.render(state);
  for (const fx of result.effects) applyEffect(fx);
}

function applyEffect(fx) {
  switch (fx.type) {
    case "sound":
      if (fx.name === "correct") playCorrectSound();
      else if (fx.name === "wrong") playWrongSound();
      else if (fx.name === "fanfare") playWordCompleteFanfare();
      break;
    case "speak":
      speakWord(state.currentWord.word);
      break;
    case "scheduleSpeak":
      clearTimeout(autoSpeakTimer);
      autoSpeakTimer = setTimeout(
        () => speakWord(state.currentWord.word),
        fx.delay
      );
      break;
    case "save":
      saveProgress(state.progress);
      break;
    case "scheduleNext":
      setTimeout(() => {
        commit(startWord(state, pickNextWord(state, WORDS, fx.maxTier)));
      }, fx.delay);
      break;
  }
}

function onLetter(key, viaOnScreenKeyboard) {
  commit(submitLetter(state, key, viaOnScreenKeyboard, WORDS));
}

function startGame() {
  view.hideStartOverlay();
  // Unlocking speech synchronously inside this click handler (rather than
  // waiting for the first in-game keypress) means even the very first word's
  // auto-speak timer - which fires shortly after this - is able to produce sound.
  unlockSpeech();
  commit(startWord(state, pickNextWord(state, WORDS)));
}

function resetProgress() {
  if (!confirm("Reset all progress? This can't be undone.")) return;
  state = createInitialState(defaultProgress());
  saveProgress(state.progress);
  commit(startWord(state, pickNextWord(state, WORDS)));
}

function init() {
  bindInput({
    onLetter,
    onHear: () => {
      if (state.currentWord) speakWord(state.currentWord.word);
    },
    onReset: resetProgress,
    onStart: startGame,
  });
  buildKeyboard((letter) => onLetter(letter, true));
  view.render(state);
}

init();
