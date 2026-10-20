// Builds a manager over a sandboxed data folder, with fake child_process installed.
'use strict';
const sb = require('./sandbox');
const fake = require('./fake-child-process');
const path = require('node:path');
const fs = require('node:fs');
const { createManager } = require('../../manager');

const APP_BINARY = '/Applications/Fake Profiles.app/Contents/MacOS/Fake Profiles';
const HELPER = '/Applications/Fake Profiles.app/Contents/Resources/app.asar.unpacked/helper.js';

// `profiles` is the profiles.json profile list; folders and config folders are made on disk.
function makeManager({ profiles = [], extra = {}, labelPrefix } = {}) {
  const configDir = sb.dir('data');
  sb.writeJson(path.join(configDir, 'profiles.json'), { ...extra, profiles });
  const mgr = createManager({ configDir, appBinary: APP_BINARY, helperPath: HELPER, labelPrefix });
  const file = (...p) => path.join(configDir, ...p);
  const logText = () => { try { return fs.readFileSync(file('logs', 'manager.log'), 'utf8'); } catch { return ''; } };
  return { mgr, configDir, file, logText };
}

// One trusted Code profile with one folder, the usual starting point.
function oneServer({ id = 'work', serverId = 'app', account = 'alice@example.com', args, labelPrefix, extra, cfgExtra } = {}) {
  const folder = sb.dir('folder');
  const cfg = sb.claudeConfigDir({ account, trusted: [folder], extra: cfgExtra });
  const server = { id: serverId, folder };
  if (args) server.args = args;
  const m = makeManager({ profiles: [{ id, name: 'Work', account, configDir: cfg, servers: [server] }], extra, labelPrefix });
  return { ...m, folder, cfg, key: `${id}-${serverId}` };
}

const label = (key, prefix = 'io.github.jonkafton.claude-profiles') => `${prefix}.server.${key}`;
const agentsDir = () => path.join(sb.home, 'Library', 'LaunchAgents');

module.exports = { sb, fake, makeManager, oneServer, label, agentsDir, APP_BINARY, HELPER };
