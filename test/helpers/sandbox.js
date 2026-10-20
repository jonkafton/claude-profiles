// Points HOME at a throwaway folder before any app module loads. profiles.js and manager.js read
// os.homedir() once, at require time, so this must be the first require in every test file: otherwise a
// test could write plists into the real ~/Library/LaunchAgents or profiles into the real data folder.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profiles-test-')));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;
for (const k of ['CLAUDE_PROFILES_DIR', 'CLAUDE_PROFILES_LABEL_PREFIX', 'CLAUDE_PROFILES_USER_DATA', 'CLAUDE_PROFILES_DEBUG', 'CLAUDE_PROFILES_DEBUG_NET']) delete process.env[k];
if (os.homedir() !== home) throw new Error(`sandbox: os.homedir() is ${os.homedir()}, not ${home}; refusing to run`);

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

let n = 0;
// A fresh folder under the sandbox, for one test's config dir, working folder and so on.
function dir(name = 'd') {
  const d = path.join(root, `${name}-${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// A Claude config folder as the CLI leaves it once signed in, with Remote Control accepted and folders trusted.
function claudeConfigDir({ account = 'alice@example.com', trusted = [], remote = true, extra = {} } = {}) {
  const cfg = dir('claude-config');
  writeJson(path.join(cfg, '.claude.json'), {
    oauthAccount: account ? { emailAddress: account } : undefined,
    remoteDialogSeen: remote,
    projects: Object.fromEntries(trusted.map((f) => [f, { hasTrustDialogAccepted: true }])),
    ...extra,
  });
  return cfg;
}

// A fake `claude` executable on disk, so manager.which() finds it on the PATH it is given.
function fakeClaudeBin() {
  const bin = dir('bin');
  const file = path.join(bin, 'claude');
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return { bin, file };
}

const flush = () => new Promise((r) => setImmediate(r));

module.exports = { root, home, dir, writeJson, readJson, claudeConfigDir, fakeClaudeBin, flush };
