// Preloaded via `node --import` so the resolve hook is active before any test
// file imports the app's modules.
import { register } from "node:module";
register("./strip-version-hook.mjs", import.meta.url);
