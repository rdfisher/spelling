// Module-resolution hook for the test runner. The app's imports carry a
// `?v=NN` cache-busting query (e.g. "../words.js?v=16") that browsers accept in
// import specifiers but Node's file resolver does not. This strips the query so
// the same source runs unmodified under `node --test`.
export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.replace(/\?v=\d+$/, ""), context);
}
