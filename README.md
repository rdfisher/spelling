# Miles' Spelling Game

A small browser spelling game for early readers: it shows a picture, speaks the
word, and the child types it letter by letter with audio/visual feedback.
Progress (unlocked tiers, best scores, running stats) persists in
`localStorage`. No build step — it's static files plus native ES modules.

## Running it

Serve the folder over HTTP (ES modules don't load from `file://`) and open
`index.html`, e.g.:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000/
```

## Structure

The code is split into a pure core and an impure shell.

```
words.js          word list + image/tier data
core/
  config.js       tunable constants + keyboard layout
  state.js        the game-state shape
  engine.js       PURE game rules: submitLetter, startWord, pickNextWord.
                  Each returns { state, effects }; no DOM, audio, storage or
                  timers - the shell performs the returned effects.
io/
  storage.js      localStorage persistence
  audio.js        WebAudio sound effects
  speech.js       speech synthesis
ui/
  view.js         all DOM writes; renders from the state object
  keyboard.js     the on-screen keyboard
  input.js        keyboard/button event wiring
main.js           the shell: dispatch input -> engine -> apply effects -> render
```

Because `core/` has no side effects and takes an injectable RNG, the game rules
are deterministic and unit-tested without a browser.

## Tests

No dependencies — the suite uses Node's built-in test runner (Node 20+).

```sh
npm test              # run the suite
npm run test:coverage # run with a coverage report
```

The app's imports carry a `?v=NN` cache-busting query that browsers accept but
Node's resolver does not; `scripts/strip-version-hook.mjs` removes it for the
test run.
