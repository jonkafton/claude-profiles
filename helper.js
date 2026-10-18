// Headless entry point that launchd runs, using the app's own binary as plain Node:
//   ELECTRON_RUN_AS_NODE=1 "<Claude Profiles binary>" helper.js serve <key> | reap [--dry-run]
'use strict';
const { createManager } = require('./manager');
const { DEFAULT_CONFIG_DIR } = require('./profiles');

const mgr = createManager({
  configDir: process.env.CLAUDE_PROFILES_DIR || DEFAULT_CONFIG_DIR,
  appBinary: process.execPath,
  helperPath: __filename,
});

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'serve' && arg) {
  mgr.serve(arg);
} else if (cmd === 'reap') {
  mgr.reap({ dryRun: arg === '--dry-run' }).then((r) => { console.log(JSON.stringify(r, null, 2)); });
} else {
  console.error('usage: helper.js serve <key> | reap [--dry-run]');
  process.exit(64);
}
