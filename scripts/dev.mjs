// Dev loop without extra dependencies: build once, then run `tsc --watch` and a
// restarting `node --watch` side by side. The sources import `./app.js`-style
// specifiers (NodeNext), which Node cannot resolve against .ts files, so running
// src/ directly with --experimental-strip-types does not work. Run dist/ instead.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const node = process.execPath;

const first = spawnSync(node, [tsc, "-p", "tsconfig.json"], { stdio: "inherit" });
if (first.status !== 0) {
  console.error("[dev] initial build failed; fix the type errors above and re-run `npm run dev`.");
  process.exit(first.status ?? 1);
}

const children = [
  spawn(node, [tsc, "-p", "tsconfig.json", "--watch", "--preserveWatchOutput"], { stdio: "inherit" }),
  // Restarts the server whenever tsc rewrites a file under dist/.
  spawn(node, ["--watch", "--watch-path=dist", "dist/index.js"], { stdio: "inherit" }),
];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exit(code);
}

for (const child of children) child.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
