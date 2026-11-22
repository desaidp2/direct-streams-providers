const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "node_modules", "patchright", "cli.js");
const bin = path.join(root, "node_modules", ".bin", "patchright");

// Install the full Chromium binary. The Render build command invokes
// "npx patchright install chromium" afterwards; wrap that invocation so it
// also retains the full browser instead of only the headless shell.
execFileSync(process.execPath, [cli, "install", "chromium", "--no-shell"], { stdio: "inherit" });

try { fs.unlinkSync(bin); } catch (_) {}
fs.writeFileSync(bin, '#!/bin/sh\nexec node "' + cli + '" "$@" --no-shell\n');
fs.chmodSync(bin, 0o755);
