'use strict';
const { sb, fake, oneServer } = require('./helpers/manager-fixture');
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let claude;
beforeEach(() => {
  fake.reset();
  claude = sb.fakeClaudeBin();
  fake.state.loginPath = `${claude.bin}:/usr/bin:/bin`;
});
const cliCalls = () => fake.state.calls.filter((c) => c.cmd === claude.file);
const replyToClaude = (reply) => fake.on((cmd) => cmd === claude.file, reply);

describe('the environment claude runs in', () => {
  test('uses the login shell PATH and the profile’s config, without the app’s or a parent session’s markers', async (t) => {
    const scrubbed = ['ELECTRON_RUN_AS_NODE', 'CLAUDE_PROFILES_DIR', 'CLAUDE_PROFILES_LABEL_PREFIX', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];
    for (const k of scrubbed) process.env[k] = '1';
    process.env.KEEP_ME = 'yes';
    t.after(() => { for (const k of [...scrubbed, 'KEEP_ME']) delete process.env[k]; });
    const { mgr, key, cfg, folder } = oneServer();
    replyToClaude('');
    await mgr.mcpList(key);
    const [call] = cliCalls();
    assert.deepEqual(call.args, ['mcp', 'list']);
    assert.equal(call.opts.cwd, folder);
    assert.equal(call.opts.env.CLAUDE_CONFIG_DIR, cfg);
    assert.equal(call.opts.env.PATH, fake.state.loginPath);
    assert.equal(call.opts.env.KEEP_ME, 'yes');
    for (const k of scrubbed) assert.ok(!(k in call.opts.env), `${k} should be removed`);
  });
  test('asks the login shell once and reuses its PATH for five minutes', async (t) => {
    const { mgr, key } = oneServer();
    replyToClaude('');
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    await mgr.mcpList(key);
    await mgr.mcpList(key);
    assert.equal(fake.callsTo('/bin/zsh').length, 1);
    t.mock.timers.tick(5 * 60000 + 1);
    await mgr.mcpList(key);
    assert.equal(fake.callsTo('/bin/zsh').length, 2);
  });
  test('keeps using the last known PATH when the login shell later fails', async (t) => {
    const { mgr, key } = oneServer();
    replyToClaude('');
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    await mgr.mcpList(key);
    t.mock.timers.tick(10 * 60000);
    fake.state.loginShellFails = true;
    await mgr.mcpList(key);
    assert.equal(cliCalls()[1].opts.env.PATH, fake.state.loginPath);
  });
  test('falls back to the usual install folders when the login shell never answers', async (t) => {
    // The test runner's own PATH comes first in the fallback and may hold a real claude.
    const before = process.env.PATH;
    process.env.PATH = '';
    t.after(() => { process.env.PATH = before; });
    const { mgr, key } = oneServer();
    fake.state.loginShellFails = true;
    const local = path.join(sb.home, '.local', 'bin');
    fs.mkdirSync(local, { recursive: true });
    fs.copyFileSync(claude.file, path.join(local, 'claude'));
    fs.chmodSync(path.join(local, 'claude'), 0o755);
    fake.on((cmd) => cmd === path.join(local, 'claude'), '');
    await mgr.mcpList(key);
    const call = fake.state.calls.find((c) => c.cmd === path.join(local, 'claude'));
    assert.ok(call, 'claude was found in ~/.local/bin');
    for (const d of [local, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']) assert.ok(call.opts.env.PATH.split(':').includes(d), d);
  });
  test('reports when claude is not on the PATH', async () => {
    const { mgr, key } = oneServer();
    fake.state.loginPath = '/nowhere';
    await assert.rejects(mgr.mcpList(key), /claude not found on PATH/);
    await assert.rejects(mgr.mcpAdd(key, { name: 'x', scope: 'user', transport: 'http', url: 'https://x' }), /claude not found on PATH/);
    await assert.rejects(mgr.mcpLogin(key, 'x'), /claude not found on PATH/);
  });
});

describe('mcpList()', () => {
  test('labels each server with the file that configures it', async () => {
    const { mgr, key, cfg, folder } = oneServer({
      cfgExtra: { mcpServers: { 'user-srv': {}, both: {} } },
    });
    const j = sb.readJson(path.join(cfg, '.claude.json'));
    j.projects[folder].mcpServers = { 'local-srv': {}, both: {} };
    sb.writeJson(path.join(cfg, '.claude.json'), j);
    sb.writeJson(path.join(folder, '.mcp.json'), { mcpServers: { 'project-srv': {} } });
    replyToClaude([
      'claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ✔ Connected',
      'plugin:tools:search: npx tools - ✔ Connected',
      'user-srv: https://u.example/mcp (HTTP) - ✔ Connected',
      'local-srv: node local.js - ✔ Connected',
      'project-srv: node project.js - ✘ Failed to connect',
      'both: node both.js - ✔ Connected',
      'mystery: node m.js - ✔ Connected',
    ].join('\n'));
    const r = await mgr.mcpList(key);
    assert.deepEqual(r.servers.map((s) => [s.name, s.scope]), [
      ['claude.ai Gmail', 'claude.ai'], ['plugin:tools:search', 'plugin'], ['user-srv', 'user'], ['local-srv', 'local'], ['project-srv', 'project'], ['both', 'local'], ['mystery', 'other'],
    ]);
    assert.deepEqual(r.files, { local: path.join(cfg, '.claude.json'), user: path.join(cfg, '.claude.json'), project: path.join(folder, '.mcp.json') });
    assert.ok(!Number.isNaN(Date.parse(r.at)));
  });
  test('never returns server settings, which can hold keys', async () => {
    const { mgr, key, cfg } = oneServer({ cfgExtra: { mcpServers: { secret: { headers: { Authorization: 'Bearer sk-live-123' } } } } });
    replyToClaude('secret: https://s.example/mcp (HTTP) - ✔ Connected');
    const r = await mgr.mcpList(key);
    assert.doesNotMatch(JSON.stringify(r), /sk-live-123/);
    assert.ok(fs.existsSync(path.join(cfg, '.claude.json')));
  });
  test('still reads the list when claude exits non-zero (a server failed its health check)', async () => {
    const { mgr, key } = oneServer();
    replyToClaude(() => fake.fail('exit 1', { stdout: 'a: node a.js - ✘ Failed to connect\n' }));
    const r = await mgr.mcpList(key);
    assert.deepEqual(r.servers.map((s) => s.state), ['failed']);
  });
  test('reports the CLI’s last error line when it prints nothing', async () => {
    const { mgr, key } = oneServer();
    replyToClaude(() => fake.fail('exit 1', { stderr: 'warming up\nError: config is invalid\n' }));
    await assert.rejects(mgr.mcpList(key), /^Error: claude mcp list failed: Error: config is invalid$/);
  });
  test('refuses an unknown server key', async () => {
    const { mgr } = oneServer();
    await assert.rejects(mgr.mcpList('ghost'), /no server ghost/);
  });
});

describe('mcpAdd()', () => {
  const lastAdd = () => cliCalls().at(-1).args;
  test('adds an HTTP server with headers through `claude mcp add-json`', async () => {
    const { mgr, key, folder, logText } = oneServer();
    replyToClaude('Added HTTP MCP server api to user config');
    const out = await mgr.mcpAdd(key, { name: ' api ', scope: 'user', transport: 'http', url: ' https://api.example/mcp ', headers: 'Authorization: Bearer abc\n\n  X-Thing:  a: b  \n' });
    assert.equal(out, 'Added HTTP MCP server api to user config');
    const args = lastAdd();
    assert.deepEqual(args.slice(0, 5), ['mcp', 'add-json', '--scope', 'user', 'api']);
    assert.deepEqual(JSON.parse(args[5]), { type: 'http', url: 'https://api.example/mcp', headers: { Authorization: 'Bearer abc', 'X-Thing': 'a: b' } });
    assert.equal(cliCalls().at(-1).opts.cwd, folder);
    assert.match(logText(), new RegExp(`added MCP server api \\(user\\) for ${key}`));
  });
  test('an SSE server without headers sends no headers key', async () => {
    const { mgr, key } = oneServer();
    replyToClaude('ok');
    await mgr.mcpAdd(key, { name: 'events', scope: 'project', transport: 'sse', url: 'http://localhost:9000/sse' });
    assert.deepEqual(JSON.parse(lastAdd()[5]), { type: 'sse', url: 'http://localhost:9000/sse' });
  });
  test('a stdio server splits its command like a shell and reads NAME=value variables', async () => {
    const { mgr, key } = oneServer();
    replyToClaude('ok');
    await mgr.mcpAdd(key, { name: 'files', scope: 'local', transport: 'stdio', command: ' npx -y "@scope/server files" --root \'/my dir\' ', env: 'API_KEY=abc=def\nEMPTY=' });
    assert.deepEqual(JSON.parse(lastAdd()[5]), { type: 'stdio', command: 'npx', args: ['-y', '@scope/server files', '--root', '/my dir'], env: { API_KEY: 'abc=def', EMPTY: '' } });
  });
  const invalid = [
    [{ name: '' }, /Use letters, numbers/],
    [{ name: '-starts-with-dash' }, /Use letters, numbers/],
    [{ name: 'has space' }, /Use letters, numbers/],
    [{ name: 'a/b' }, /Use letters, numbers/],
    [{ scope: 'claude.ai' }, /Choose where to add it/],
    [{ scope: undefined }, /Choose where to add it/],
    [{ transport: 'websocket' }, /Choose a connection type/],
    [{ url: 'ftp://x' }, /starting with https:\/\//],
    [{ url: 'https://has space' }, /starting with https:\/\//],
    [{ headers: 'NoColonHere' }, /Each header goes on its own line as Name: value: "NoColonHere"/],
    [{ headers: ': empty name' }, /Each header goes on its own line/],
    [{ transport: 'stdio', command: '   ' }, /Enter the command that starts the server/],
    [{ transport: 'stdio', command: 'node "open' }, /unclosed quote/],
    [{ transport: 'stdio', command: 'node x', env: 'NOEQUALS' }, /Each variable goes on its own line as NAME=value: "NOEQUALS"/],
  ];
  for (const [over, error] of invalid) {
    test(`rejects ${JSON.stringify(over)}`, async () => {
      const { mgr, key } = oneServer();
      await assert.rejects(mgr.mcpAdd(key, { name: 'ok', scope: 'user', transport: 'http', url: 'https://x.example/mcp', ...over }), error);
      assert.equal(cliCalls().length, 0, 'nothing reaches the CLI');
    });
  }
  test('passes on the CLI’s error, without colour codes', async () => {
    const { mgr, key } = oneServer();
    replyToClaude(() => fake.fail('exit 1', { stderr: '\x1b[31mMCP server api already exists in user config\x1b[39m\n' }));
    await assert.rejects(mgr.mcpAdd(key, { name: 'api', scope: 'user', transport: 'http', url: 'https://x.example' }), /^Error: MCP server api already exists in user config$/);
  });
});

describe('mcpRemove()', () => {
  test('removes through `claude mcp remove` with the scope', async () => {
    const { mgr, key, logText } = oneServer();
    replyToClaude('Removed MCP server api from user config\n');
    assert.equal(await mgr.mcpRemove(key, 'api', 'user'), 'Removed MCP server api from user config');
    assert.deepEqual(cliCalls().at(-1).args, ['mcp', 'remove', 'api', '--scope', 'user']);
    assert.match(logText(), /removed MCP server api \(user\)/);
  });
  test('refuses connectors, plugins and unknown scopes', async () => {
    const { mgr, key } = oneServer();
    for (const scope of ['claude.ai', 'plugin', 'other', undefined]) await assert.rejects(mgr.mcpRemove(key, 'x', scope), /x is not one this app can remove/);
    assert.equal(cliCalls().length, 0);
  });
  test('falls back to a generic message when the CLI prints nothing', async () => {
    const { mgr, key } = oneServer();
    replyToClaude(() => { const e = fake.fail(''); e.message = ''; return e; });
    await assert.rejects(mgr.mcpRemove(key, 'x', 'user'), /^Error: claude mcp failed$/);
  });
});

describe('mcpLogin()', () => {
  async function start(t, { name = 'github', onUrl, keepAlive = true } = {}) {
    const m = oneServer();
    const kills = [];
    t.mock.method(process, 'kill', (pid, sig) => { kills.push([pid, sig]); return true; });
    const urls = [];
    const login = await m.mgr.mcpLogin(m.key, name, onUrl || ((u) => urls.push(u)));
    const spawned = fake.state.spawned.at(-1);
    // A live CLI under the shell, so the "only tail is left" watcher does not end the login early.
    if (keepAlive) fake.state.processes.push({ pid: spawned.child.pid + 10000, ppid: spawned.child.pid, cmd: '/usr/bin/script -q /dev/null claude mcp login' });
    return { ...m, login, child: spawned.child, spawned, kills, urls };
  }
  test('runs `claude mcp login --no-browser` in a pty, in the folder, in its own process group', async (t) => {
    const { spawned, folder, cfg, file, login } = await start(t);
    assert.equal(spawned.cmd, '/bin/sh');
    const [flag, script, feed, ...argv] = spawned.args;
    assert.equal(flag, '-c');
    assert.equal(script, 'tail -f "$0" | exec /usr/bin/script -q /dev/null "$@"');
    assert.equal(path.dirname(feed), file('state'));
    assert.ok(fs.existsSync(feed));
    assert.deepEqual(argv, [claude.file, 'mcp', 'login', 'github', '--no-browser']);
    assert.equal(spawned.opts.cwd, folder);
    assert.equal(spawned.opts.detached, true);
    assert.equal(spawned.opts.env.CLAUDE_CONFIG_DIR, cfg);
    login.cancel();
  });
  test('hands over the authorization link once, even when it arrives in pieces', async (t) => {
    const { child, login, urls } = await start(t);
    child.stdout.emit('data', 'Opening sign-in…\r\nVisit this URL to');
    child.stdout.emit('data', ' authorize:\r\n  \x1b[4mhttps://auth.example/authorize?client=1&state=2\x1b[24m\r\n');
    child.stderr.emit('data', 'Visit this URL again:\nhttps://other.example\n');
    assert.deepEqual(urls, ['https://auth.example/authorize?client=1&state=2']);
    assert.equal(login.url(), 'https://auth.example/authorize?client=1&state=2');
    login.cancel();
  });
  test('a link handler that throws is logged and does not break the login', async (t) => {
    const { child, login, logText } = await start(t, { onUrl: () => { throw new Error('window failed'); } });
    child.stdout.emit('data', 'Visit this URL:\nhttps://auth.example/x\n');
    assert.equal(login.url(), 'https://auth.example/x');
    assert.match(logText(), /mcp login github: window failed/);
    login.cancel();
  });
  test('cancel stops the whole process group, removes the key feed and resolves with the last lines', async (t) => {
    const { child, login, kills, spawned, logText } = await start(t);
    child.stdout.emit('data', 'one\ntwo\nthree\nfour\nVisit this URL:\nhttps://auth.example/x\n\n');
    login.cancel();
    const r = await login.done;
    assert.deepEqual(kills, [[-child.pid, 'SIGTERM']]);
    assert.ok(!fs.existsSync(spawned.args[2]));
    assert.deepEqual(r, { url: 'https://auth.example/x', output: 'three\nfour\nVisit this URL:\nhttps://auth.example/x' });
    assert.match(logText(), /mcp login github under work-app: cancelled/);
    child.emit('exit', 0);
    assert.equal(logText().match(/github under work-app: (cancelled|finished)/g).length, 1, 'ends only once');
  });
  test('resolves when the CLI exits, with no link if it printed none', async (t) => {
    const { child, login, logText } = await start(t);
    child.stdout.emit('data', 'Error: server github not found\n');
    child.emit('exit', 1);
    assert.deepEqual(await login.done, { url: null, output: 'Error: server github not found' });
    assert.match(logText(), /: finished/);
  });
  test('resolves once only the never-ending tail is left under the shell', async (t) => {
    const { child, login } = await start(t, { keepAlive: false });
    fake.state.processes.push({ pid: child.pid + 1, ppid: child.pid, cmd: 'tail -f /x/keys' });
    const r = await login.done;
    assert.equal(r.url, null);
  });
  test('gives up after ten minutes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { login, logText } = await start(t);
    t.mock.timers.tick(10 * 60000);
    await login.done;
    assert.match(logText(), /: timed out/);
  });
});

describe('Claude Design access', () => {
  test('designStatus asks the CLI under the profile’s config, without a parent session’s markers', async (t) => {
    const { mgr, cfg } = oneServer();
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    t.after(() => { delete process.env.CLAUDECODE; delete process.env.CLAUDE_CODE_CHILD_SESSION; });
    replyToClaude('{"available":true,"signed_in":true,"can_sign_in_here":true}\n');
    assert.deepEqual(await mgr.designStatus(cfg), { available: true, signed_in: true, can_sign_in_here: true });
    const call = cliCalls().at(-1);
    assert.deepEqual(call.args, ['design-login', '--json', '--status']);
    assert.equal(call.opts.env.CLAUDE_CONFIG_DIR, cfg);
    assert.equal(call.opts.env.CLAUDECODE, undefined, 'the CLI refuses to run under a Claude Code session');
    assert.equal(call.opts.env.CLAUDE_CODE_CHILD_SESSION, undefined);
  });
  test('designStatus and designLogin fail plainly without claude or a usable answer', async () => {
    const { mgr, cfg } = oneServer();
    replyToClaude('');
    await assert.rejects(mgr.designStatus(cfg), /claude design-login printed no status/);
    // The login shell's PATH is kept for a few minutes, so a fresh manager sees the change.
    fake.state.loginPath = '/nowhere';
    const other = oneServer();
    await assert.rejects(other.mgr.designStatus(other.cfg), /claude not found on PATH/);
    await assert.rejects(other.mgr.designLogin(other.cfg), /claude not found on PATH/);
  });
  async function start(onUrl) {
    const m = oneServer();
    const urls = [];
    const login = await m.mgr.designLogin(m.cfg, onUrl || ((u) => urls.push(u)));
    return { ...m, login, urls, spawned: fake.state.spawned.at(-1) };
  }
  test('designLogin runs the JSON sign-in and hands over the approval link, even when it arrives in pieces', async () => {
    const { spawned, cfg, login, urls, logText } = await start();
    assert.equal(spawned.cmd, claude.file);
    assert.deepEqual(spawned.args, ['design-login', '--json']);
    assert.deepEqual(spawned.opts.stdio, ['pipe', 'pipe', 'pipe'], 'a pipe on stdin: the CLI refuses a terminal, and closing it cancels');
    assert.equal(spawned.opts.env.CLAUDE_CONFIG_DIR, cfg);
    const { child } = spawned;
    child.stdout.emit('data', '{"event":"pages","url":"https://claude.com/cai/oauth/authorize?x=1","manual_url":"https://m.example","manual');
    child.stdout.emit('data', '_first":false}\nnot json\n');
    assert.deepEqual(urls, ['https://claude.com/cai/oauth/authorize?x=1']);
    child.stdout.emit('data', '{"event":"done","ok":true}\n');
    child.emit('close', 0);
    assert.deepEqual(await login.done, { ok: true, message: '' });
    assert.match(logText(), /design login for .*: started/);
    assert.match(logText(), /design login for .*: authorized/);
    child.emit('close', 0);
    assert.equal(logText().match(/: authorized/g).length, 1, 'ends only once');
  });
  test('cancel closes the CLI’s input, which cancels the sign-in', async () => {
    const { spawned: { child }, login } = await start();
    login.cancel();
    assert.equal(child.stdin.ended, true);
    child.stdout.emit('data', '{"event":"done","ok":false,"message":"The sign-in was cancelled."}\n');
    child.emit('close', 1);
    assert.deepEqual(await login.done, { ok: false, message: 'The sign-in was cancelled.' });
  });
  test('a CLI that exits without a result reports its last error line, or its exit code', async () => {
    let { spawned: { child }, login } = await start();
    child.stderr.emit('data', 'warming up\nerror: unknown command \'design-login\'\n');
    child.emit('close', 1);
    assert.deepEqual(await login.done, { ok: false, message: 'error: unknown command \'design-login\'' });
    ({ spawned: { child }, login } = await start());
    child.emit('close', 2);
    assert.deepEqual(await login.done, { ok: false, message: 'claude design-login exited with 2' });
  });
  test('a link handler that throws is logged and does not break the sign-in', async () => {
    const { spawned: { child }, login, logText } = await start(() => { throw new Error('window failed'); });
    child.stdout.emit('data', '{"event":"pages","url":"https://claude.com/x"}\n{"event":"done","ok":true}\n');
    child.emit('close', 0);
    assert.equal((await login.done).ok, true);
    assert.match(logText(), /design login for .*: window failed/);
  });
  test('gives up on a CLI that never exits', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { spawned: { child }, login } = await start();
    t.mock.timers.tick(6 * 60000);
    assert.deepEqual(await login.done, { ok: false, message: 'The sign-in did not finish.' });
    assert.deepEqual(child.killed, ['SIGTERM']);
  });
});
