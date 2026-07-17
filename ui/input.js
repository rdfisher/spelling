// Translates raw DOM input events into game actions. Owns the keydown filter
// and the control-button wiring; knows nothing about game rules.
export function bindInput({ onLetter, onHear, onReset, onStart }) {
  document.getElementById("hear-btn").addEventListener("click", onHear);
  document.getElementById("reset-btn").addEventListener("click", onReset);
  document.getElementById("start-btn").addEventListener("click", onStart);
  window.addEventListener("keydown", (e) => {
    if (!/^[a-zA-Z]$/.test(e.key)) return;
    onLetter(e.key, false);
  });
}
