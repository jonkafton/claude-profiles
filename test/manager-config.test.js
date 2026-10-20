'use strict';
const { sb, makeManager, oneServer } = require('./helpers/manager-fixture');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('config()', () => {
  test('lists one server per profile folder, with ~ expanded', () => {
    fs.mkdirSync(path.join(sb.home, 'code', 'web'), { recursive: true });
    const cfg = sb.claudeConfigDir();
    const { mgr } = makeManager({
      profiles: [
        { id: 'acme', name: 'Acme', account: 'a@acme.example', configDir: cfg, servers: [{ id: 'web', folder: '~/code/web', args: ['--capacity', '5'] }, { id: 'api', folder: '/srv/api' }] },
        { id: 'design', kind: 'design', name: 'Design', account: 'a@acme.example' },
      ],
    });
    const { servers } = mgr.config();
    assert.deepEqual(servers, [
      { key: 'acme-web', profileId: 'acme', profileName: 'Acme', expectedAccount: 'a@acme.example', folder: path.join(sb.home, 'code', 'web'), configDir: cfg, args: ['--capacity', '5'], problem: null },
      { key: 'acme-api', profileId: 'acme', profileName: 'Acme', expectedAccount: 'a@acme.example', folder: '/srv/api', configDir: cfg, args: [], problem: null },
    ]);
  });
  test('flags a profile without a config folder', () => {
    const { mgr } = makeManager({ profiles: [{ id: 'x', name: 'X', servers: [{ id: 's', folder: '/tmp' }] }] });
    const [s] = mgr.config().servers;
    assert.equal(s.problem, 'profile has no configDir');
    assert.equal(s.expectedAccount, null);
  });
  test('pairings keep a matching folder on its own Claude config', () => {
    const cfg = path.join(sb.home, '.claude-acme');
    const { mgr } = makeManager({
      extra: { pairings: [{ folderContains: 'client-acme', configDir: '~/.claude-acme' }] },
      profiles: [
        { id: 'right', name: 'Right', configDir: '~/.claude-acme', servers: [{ id: 's', folder: '/code/client-acme-web' }] },
        { id: 'wrong', name: 'Wrong', configDir: '~/.claude-personal', servers: [{ id: 's', folder: '/code/client-acme-api' }, { id: 'other', folder: '/code/side' }] },
      ],
    });
    const byKey = Object.fromEntries(mgr.config().servers.map((s) => [s.key, s.problem]));
    assert.deepEqual(byKey, { 'right-s': null, 'wrong-s': `client-acme folders must use ${cfg}`, 'wrong-other': null });
  });
  test('cleanup settings fill in defaults', () => {
    const { mgr } = makeManager({ extra: { cleanup: { idleHours: 1 } } });
    assert.deepEqual(mgr.config().cleanup, { idleHours: 1, idleCpuPerHour: 30, includeDesktop: false });
    const { mgr: m2 } = makeManager();
    assert.deepEqual(m2.config().cleanup, { idleHours: 3, idleCpuPerHour: 30, includeDesktop: false });
  });
  test('re-reads profiles.json on every call', () => {
    const { mgr, file } = makeManager();
    assert.equal(mgr.config().servers.length, 0);
    sb.writeJson(file('profiles.json'), { profiles: [{ id: 'p', name: 'P', configDir: '/c', servers: [{ id: 's', folder: '/f' }] }] });
    assert.equal(mgr.config().servers.length, 1);
  });
});

describe('claudeConfig()', () => {
  const { mgr } = makeManager();
  test('reports nothing for a config folder the CLI has never used', () => {
    assert.deepEqual(mgr.claudeConfig(sb.dir()), { account: null, trusted: false, remoteAccepted: false });
  });
  test('treats an unreadable .claude.json like a missing one', () => {
    const d = sb.dir();
    fs.writeFileSync(path.join(d, '.claude.json'), '{ broken');
    assert.deepEqual(mgr.claudeConfig(d, '/x'), { account: null, trusted: false, remoteAccepted: false });
  });
  test('reads the signed-in account, consent and per-folder trust', () => {
    const cfg = sb.claudeConfigDir({ account: 'bob@example.com', trusted: ['/code/a'] });
    assert.deepEqual(mgr.claudeConfig(cfg), { account: 'bob@example.com', trusted: true, remoteAccepted: true });
    assert.equal(mgr.claudeConfig(cfg, '/code/a').trusted, true);
    assert.equal(mgr.claudeConfig(cfg, '/code/b').trusted, false);
  });
  test('a signed-out config without consent', () => {
    const cfg = sb.claudeConfigDir({ account: null, remote: false });
    assert.deepEqual(mgr.claudeConfig(cfg, '/x'), { account: null, trusted: false, remoteAccepted: false });
  });
});

describe('mcpTarget()', () => {
  test('returns the configured server', () => {
    const { mgr, key, folder } = oneServer();
    assert.equal(mgr.mcpTarget(key).folder, folder);
  });
  test('throws for an unknown server or one with a problem', () => {
    const { mgr } = makeManager({ profiles: [{ id: 'x', name: 'X', servers: [{ id: 's', folder: '/tmp' }] }] });
    assert.throws(() => mgr.mcpTarget('nope'), /no server nope in profiles.json/);
    assert.throws(() => mgr.mcpTarget('x-s'), /profile has no configDir/);
  });
});

describe('parseMcpList()', () => {
  const { mgr } = makeManager();
  test('reads each server line and classifies its state', () => {
    const text = [
      'Checking MCP server health...',
      '',
      'claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ✔ Connected',
      'github: https://api.githubcopilot.com/mcp/ (HTTP) - ! Needs authentication',
      'local-tool: npx -y some-server --flag - ✘ Failed to connect',
      'org-tools: https://org.example/mcp (HTTP) - ⏸ Pending approval',
      'off: node server.js - Disabled',
      'odd: thing - ??? something new',
    ].join('\n');
    assert.deepEqual(mgr.parseMcpList(text), [
      { name: 'claude.ai Gmail', target: 'https://gmail.mcp.claude.com/mcp', state: 'connected', detail: 'Connected', connector: true, canSignIn: true },
      { name: 'github', target: 'https://api.githubcopilot.com/mcp/ (HTTP)', state: 'needs-auth', detail: 'Needs authentication', connector: false, canSignIn: true },
      { name: 'local-tool', target: 'npx -y some-server --flag', state: 'failed', detail: 'Failed to connect', connector: false, canSignIn: false },
      { name: 'org-tools', target: 'https://org.example/mcp (HTTP)', state: 'pending', detail: 'Pending approval', connector: false, canSignIn: true },
      { name: 'off', target: 'node server.js', state: 'disabled', detail: 'Disabled', connector: false, canSignIn: false },
      { name: 'odd', target: 'thing', state: 'other', detail: 'something new', connector: false, canSignIn: false },
    ]);
  });
  test('strips terminal colours, hyperlinks and carriage returns', () => {
    const text = '\x1b]8;;https://x.example\x07web\x1b]8;;\x07: https://x.example/mcp (HTTP) - \x1b[32m✔\x1b[39m Connected\r\n';
    const [s] = mgr.parseMcpList(text);
    assert.equal(s.name, 'web');
    assert.equal(s.state, 'connected');
    assert.equal(s.detail, 'Connected');
  });
  test('keeps colons in plugin names and dashes in targets', () => {
    const [s] = mgr.parseMcpList('plugin:tools:search: npx a - b - ✔ Connected');
    assert.equal(s.name, 'plugin:tools:search');
    assert.equal(s.target, 'npx a - b');
  });
  test('returns nothing for output with no server lines', () => {
    assert.deepEqual(mgr.parseMcpList('No MCP servers configured. Use `claude mcp add` to add a server.'), []);
    assert.deepEqual(mgr.parseMcpList(''), []);
  });
});

describe('shellWords()', () => {
  const { mgr } = makeManager();
  const cases = [
    ['npx -y @scope/pkg --port 3000', ['npx', '-y', '@scope/pkg', '--port', '3000']],
    ['  spaced \t out  ', ['spaced', 'out']],
    ['node "my server.js" \'single quoted\'', ['node', 'my server.js', 'single quoted']],
    ['echo "a \\"b\\" c"', ['echo', 'a "b" c']],
    ["echo 'a\\b'", ['echo', 'a\\b']],
    ['echo a\\ b', ['echo', 'a b']],
    ['cmd "" x', ['cmd', '', 'x']],
    ['a"b c"d', ['ab cd']],
    ['', []],
  ];
  for (const [line, words] of cases) test(`splits ${JSON.stringify(line)}`, () => assert.deepEqual(mgr.shellWords(line), words));
  test('rejects an unclosed quote', () => {
    assert.throws(() => mgr.shellWords('node "open'), /unclosed quote/);
    assert.throws(() => mgr.shellWords("node 'open"), /unclosed quote/);
  });
});

describe('log() and setKeep()', () => {
  test('log appends timestamped lines to logs/manager.log', () => {
    const { mgr, logText } = makeManager();
    mgr.log('first');
    mgr.log('second');
    const lines = logText().trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} first$/);
    assert.match(lines[1], / second$/);
  });
  test('setKeep adds and removes ids as strings, without duplicates, in state/settings.json', () => {
    const { mgr, file } = makeManager();
    mgr.setKeep('cse_a', true);
    mgr.setKeep(1234, true);
    mgr.setKeep('cse_a', true);
    assert.deepEqual(sb.readJson(file('state', 'settings.json')), { cleanupEnabled: false, keep: ['cse_a', '1234'] });
    mgr.setKeep('cse_a', false);
    assert.deepEqual(sb.readJson(file('state', 'settings.json')).keep, ['1234']);
  });
});
