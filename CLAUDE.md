# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

A small, dependency-free educational web game for a young child (Miles). Plain
static files — no build step, no framework, no package manager. Open
`index.html` in a browser to play.

The app has four modes, all sharing one HTML page and one script:

- **Spell** — type the word for a picture.
- **Read** — match a spoken word to one of four pictures.
- **Count** — type how many pictures are shown.
- **Maths** — type the answer to an addition sum.

## Files

- `index.html` — one page; each mode has its own `<main>` (`#spell-main`,
  `#read-main`, `#count-main`, `#maths-main`), toggled by `setMode()`.
- `app.js` — all game logic. Shared helpers (audio, faces, tiers, scoring,
  numeric keypad) are reused across modes; per-mode code is grouped in labelled
  sections near the bottom.
- `style.css` — all styles.
- `words.js` — the word list (data only; a word's tier is derived from its
  length by `tierForWord()`, not stored per word).
- `assets/images/` — Twemoji SVGs (CC-BY 4.0, see `ATTRIBUTIONS.md`).

## Conventions

- Bump the `?v=NN` cache-bust query on the `style.css` / `words.js` / `app.js`
  references in `index.html` whenever you change those files, so browsers don't
  serve a stale mix.
- No dependencies — keep it that way unless asked. It must run by opening the
  file directly.

## Verifying a change

Drive it in a real browser rather than trusting the code by eye — Chromium +
Playwright are available (see prior sessions for the pattern: serve the folder,
click into the mode, exercise the flow, screenshot). There are no unit tests.

## Git: check you're up to date before starting

`main` is the trunk where all merged work lands. Feature branches
(`claude/...`) can fall well behind it between sessions, and starting work on a
stale branch has caused duplicated/conflicting changes.

**At the start of a session, before making changes**, check the working branch
against `origin/main`:

```sh
git fetch origin
git log --oneline HEAD..origin/main   # commits on main you don't have
git log --oneline origin/main..HEAD   # your branch's unique commits
```

- If the branch is behind and has **no unique unmerged work**, reset onto main:
  `git checkout -B <branch> origin/main`.
- If it has **unique commits**, rebase them onto main instead of discarding
  them: `git rebase origin/main`.
- If already up to date, carry on.

Do this rather than assuming the freshly-cloned branch reflects the latest code.
