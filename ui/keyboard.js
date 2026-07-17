// Builds the on-screen keyboard and reports taps via the onKey callback.
import { KEYBOARD_ROWS } from "../core/config.js?v=16";

export function buildKeyboard(onKey) {
  const container = document.getElementById("onscreen-keyboard");
  KEYBOARD_ROWS.forEach((row) => {
    const rowEl = document.createElement("div");
    rowEl.className = "keyboard-row";
    row.split("").forEach((letter) => {
      const key = document.createElement("button");
      key.type = "button";
      key.className = "key";
      key.textContent = letter;
      key.addEventListener("click", () => onKey(letter));
      rowEl.appendChild(key);
    });
    container.appendChild(rowEl);
  });
}
