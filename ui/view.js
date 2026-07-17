// All DOM reads/writes live here. The rest of the app mutates the state object
// and calls render(state); nothing outside this module touches the document.
//
// render() is idempotent for the "steady" display (image, tier badge, letter
// boxes, feedback, scoreboard). The transient view fields - state.view.flash,
// .scoreFace and .tierBanner - are one-shot animation triggers: render fires
// each one on the rising edge (when the field changes to a fresh value) and the
// animation owns its own timers. Modelling them as state fields now means a
// future declarative view (a framework) can render straight from the same
// state; only this module's imperative innards would be replaced.

let el = null;
function els() {
  if (!el) {
    el = {
      wordImage: document.getElementById("word-image"),
      feedback: document.getElementById("feedback"),
      letterBoxes: document.getElementById("letter-boxes"),
      tierBadge: document.getElementById("tier-badge"),
      lastScore: document.getElementById("last-score"),
      sessionStats: document.getElementById("session-stats"),
      scoreFaceOverlay: document.getElementById("score-face-overlay"),
      scoreFaceImage: document.getElementById("score-face-image"),
      tierBanner: document.getElementById("tier-unlock-banner"),
      startOverlay: document.getElementById("start-overlay"),
    };
  }
  return el;
}

// Previously-rendered values, so we only rebuild the letter boxes when the word
// or fill-progress actually changed (avoids wiping an in-flight box animation)
// and only fire each one-shot animation once per trigger.
let prevWord = undefined;
let prevIndex = undefined;
let prevFlash = null;
let prevScoreFace = null;
let prevTierBanner = false;

export function render(state) {
  const e = els();
  const w = state.currentWord;

  if (w) {
    e.wordImage.src = w.image;
    e.wordImage.alt = w.word;
    e.tierBadge.textContent = `Tier ${w.tier}`;
  }

  if (w && (w !== prevWord || state.currentIndex !== prevIndex)) {
    renderLetterBoxes(e, w, state.currentIndex);
  }
  prevWord = w;
  prevIndex = state.currentIndex;

  e.feedback.textContent = state.view.feedback;

  const p = state.progress;
  const avg = p.totalWordsCompleted
    ? Math.round(p.totalScoreSum / p.totalWordsCompleted)
    : 0;
  e.lastScore.textContent =
    state.view.lastScore != null ? `Last: ${state.view.lastScore}` : "";
  e.sessionStats.textContent = `Words: ${p.totalWordsCompleted} · Avg: ${avg}`;

  if (state.view.flash && state.view.flash !== prevFlash) {
    flashBox(e, state.view.flash.index, state.view.flash.kind);
  }
  prevFlash = state.view.flash;

  if (state.view.scoreFace && state.view.scoreFace !== prevScoreFace) {
    showScoreFace(e, state.view.scoreFace.score);
  }
  prevScoreFace = state.view.scoreFace;

  if (state.view.tierBanner && !prevTierBanner) {
    showTierBanner(e);
  }
  prevTierBanner = state.view.tierBanner;
}

function renderLetterBoxes(e, word, currentIndex) {
  const container = e.letterBoxes;
  container.style.setProperty("--letter-count", word.word.length);
  container.innerHTML = "";
  for (let i = 0; i < word.word.length; i++) {
    const box = document.createElement("div");
    box.className = "letter-box";
    if (i < currentIndex) {
      box.textContent = word.word[i].toUpperCase();
      box.classList.add("filled");
    }
    container.appendChild(box);
  }
}

function flashBox(e, index, kind) {
  const boxes = e.letterBoxes.querySelectorAll(".letter-box");
  const box = boxes[index];
  if (!box) return;
  const cls = kind === "correct" ? "pop" : "shake";
  box.classList.add(cls);
  setTimeout(() => box.classList.remove(cls), 400);
}

function getFaceForScore(score) {
  if (score === 100) return "assets/images/face-great.svg";
  if (score >= 70) return "assets/images/face-good.svg";
  if (score >= 40) return "assets/images/face-okay.svg";
  return "assets/images/face-sad.svg";
}

function showScoreFace(e, score) {
  e.scoreFaceImage.src = getFaceForScore(score);
  e.scoreFaceOverlay.classList.remove("hidden");
  setTimeout(() => e.scoreFaceOverlay.classList.add("hidden"), 1000);
}

function showTierBanner(e) {
  const banner = e.tierBanner;
  banner.classList.remove("hidden");
  requestAnimationFrame(() => banner.classList.add("show"));
  setTimeout(() => {
    banner.classList.remove("show");
    setTimeout(() => banner.classList.add("hidden"), 400);
  }, 1900);
}

export function hideStartOverlay() {
  els().startOverlay.classList.add("hidden");
}
