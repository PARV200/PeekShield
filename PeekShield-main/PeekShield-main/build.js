// ─────────────────────────────────────────────────────────────
// PEEKSHIELD — Build Launcher
// Ensures ELECTRON_RUN_AS_NODE is stripped during packaging
// ─────────────────────────────────────────────────────────────
const { spawn } = require("child_process");
const path = require("path");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const builderCli = path.join(__dirname, "node_modules", "electron-builder", "out", "cli", "cli.js");

const child = spawn(process.execPath, [builderCli, "--win", "--x64"], {
  env,
  stdio: "inherit",
});

child.on("close", (code) => {
  process.exit(code || 0);
});

child.on("error", (err) => {
  console.error("Build failed to launch:", err);
  process.exit(1);
});
