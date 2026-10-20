// The seams between files: each screen's preload against the handlers main.js registers, each page
// against its preload, the headless helper's command line, and what packaging ships.
'use strict';
const { sb, fe, loadMain } = require('./helpers/main-fixture');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function loadPreload(file) {
  fe.state.exposed = {};
  fe.state.rendererInvokes.length = 0;
  fe.state.rendererSends.length = 0;
  fe.state.rendererOn.length = 0;
  const p = path.join(ROOT, file);
  delete require.cache[p];
  require(p);
  return fe.state.exposed;
}

const SCREENS = [
  { preload: 'servers-preload.js', page: 'servers.html', global: 'mgr', channel: 'mgr', panel: '__servers', view: 'servers' },
  { preload: 'profiles-preload.js', page: 'profiles.html', global: 'editor', channel: 'editor', panel: '__profiles', view: 'profiles' },
];

describe('preloads and main.js agree', () => {
  for (const s of SCREENS) {
    test(`every ${s.preload} call is an action main.js handles`, async (t) => {
      const h = await loadMain(t, { profiles: [{ id: 'work', name: 'Work', account: 'a@example.com', configDir: '~/.claude-work' }] });
      const w = h.win();
      await h.select(w, s.panel);
      const sender = h.viewFor(w, s.view).webContents;
      const api = loadPreload(s.preload)[s.global];
      assert.ok(api, `${s.preload} exposes window.${s.global}`);
      const methods = Object.keys(api).filter((k) => !/^on[A-Z]/.test(k));
      assert.ok(methods.length > 5);
      for (const m of methods) {
        fe.state.rendererInvokes.length = 0;
        await api[m]('arg1', 'arg2', 'arg3');
        const [[channel, action, ...args]] = fe.state.rendererInvokes;
        assert.equal(channel, s.channel, m);
        assert.equal(action, m, `${m} calls the action of the same name`);
        assert.ok(args.length <= 3);
        try { await h.invoke(channel, sender, action, ...args); } catch (e) {
          assert.doesNotMatch(e.message, /unknown action|not allowed/, `${s.channel}:${action}`);
        }
      }
    });
    test(`${s.page} uses only what ${s.preload} exposes`, () => {
      const api = loadPreload(s.preload)[s.global];
      const used = new Set([...read(s.page).matchAll(new RegExp(`window\\.${s.global}\\.([A-Za-z]+)`, 'g'))].map((m) => m[1]));
      assert.ok(used.size > 0);
      for (const m of used) assert.equal(typeof api[m], 'function', `${s.page} calls window.${s.global}.${m}`);
    });
  }
  test('the Profiles screen hears the new-profile request main.js sends', () => {
    const api = loadPreload('profiles-preload.js').editor;
    let heard = 0;
    api.onNew(() => heard++);
    const [[channel, fn]] = fe.state.rendererOn;
    assert.equal(channel, 'editor-new');
    fn({});
    assert.equal(heard, 1);
    assert.match(read('main.js'), /send\('editor-new'\)/);
  });
  test('the sidebar’s bridge: list, select, and the three notifications main.js sends', async () => {
    const api = loadPreload('sidebar-preload.js').profiles;
    await api.list();
    assert.deepEqual(fe.state.rendererInvokes, [['profiles']]);
    api.select('work');
    assert.deepEqual(fe.state.rendererSends, [['select', 'work']]);
    const got = {};
    api.onActive((id) => { got.active = id; });
    api.onStatus((st) => { got.status = st; });
    api.onChanged(() => { got.changed = true; });
    const handlers = Object.fromEntries(fe.state.rendererOn);
    assert.deepEqual(Object.keys(handlers).sort(), ['active', 'profiles-changed', 'status']);
    handlers.active({}, 'home');
    handlers.status({}, { work: { state: 'running' } });
    handlers.changed?.({});
    handlers['profiles-changed']({});
    assert.deepEqual(got, { active: 'home', status: { work: { state: 'running' } }, changed: true });
    const main = read('main.js');
    for (const ch of ['active', 'status', 'profiles-changed']) assert.match(main, new RegExp(`send\\('${ch}'`), ch);
    assert.match(main, /ipcMain\.handle\('profiles'/);
    assert.match(main, /ipcMain\.on\('select'/);
  });
  test('sidebar.html uses only what its preload exposes', () => {
    const api = loadPreload('sidebar-preload.js').profiles;
    for (const m of new Set([...read('sidebar.html').matchAll(/window\.profiles\.([A-Za-z]+)/g)].map((x) => x[1]))) assert.equal(typeof api[m], 'function', m);
  });
  test('preloads expose a fixed API and never the raw ipcRenderer', () => {
    for (const f of ['sidebar-preload.js', 'servers-preload.js', 'profiles-preload.js']) {
      const exposed = loadPreload(f);
      for (const api of Object.values(exposed)) {
        assert.ok(!Object.values(api).includes(fe.electron.ipcRenderer), f);
        for (const v of Object.values(api)) assert.equal(typeof v, 'function', f);
      }
      assert.doesNotMatch(read(f), /exposeInMainWorld\([^)]*ipcRenderer\s*\)/, f);
    }
  });
});

describe('the headless helper', () => {
  const helper = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'helper.js'), ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { PATH: process.env.PATH, HOME: sb.home, CLAUDE_PROFILES_DIR: sb.dir('helper-data'), CLAUDE_PROFILES_LABEL_PREFIX: 'test.claude-profiles', ...env },
  });
  test('prints usage and exits 64 for a missing or unknown command', () => {
    for (const args of [[], ['serve'], ['continue', 'key'], ['frobnicate']]) {
      const r = helper(args);
      assert.equal(r.status, 64, args.join(' '));
      assert.match(r.stderr, /usage: helper\.js serve <key> \| reap \[--dry-run\]/);
    }
  });
  test('serve exits 78 for a server that is not in profiles.json', () => {
    const r = helper(['serve', 'ghost-key']);
    assert.equal(r.status, 78);
    assert.match(r.stderr, /serve ghost-key: not in profiles\.json/);
  });
  test('reap --dry-run reports as JSON and ends nothing on a first pass', { skip: process.platform !== 'darwin' && 'reads the macOS process table' }, () => {
    const data = sb.dir('helper-data');
    const r = helper(['reap', '--dry-run'], { CLAUDE_PROFILES_DIR: data });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(typeof out.checked, 'number');
    assert.deepEqual(out.ended, []);
    assert.ok(!fs.existsSync(path.join(data, 'state', 'reap.json')), 'a dry run saves nothing');
  });
});

describe('packaging', () => {
  const build = read('build.mjs');
  const localRequires = (file) => [...read(file).matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => m[1].endsWith('.js') ? m[1] : `${m[1]}.js`);
  test('everything the launchd helper loads is unpacked from the archive', () => {
    const graph = new Set();
    const visit = (f) => { if (graph.has(f)) return; graph.add(f); localRequires(f).forEach(visit); };
    visit('helper.js');
    const unpack = build.match(/unpack:\s*'\{([^}]+)\}\.js'/);
    assert.ok(unpack, 'build.mjs unpacks a {a,b}.js set');
    const unpacked = new Set(unpack[1].split(',').map((n) => `${n}.js`));
    for (const f of graph) assert.ok(unpacked.has(f), `${f} is required by the helper but stays inside app.asar`);
    assert.match(read('main.js'), /path\.join\(process\.resourcesPath, 'app\.asar\.unpacked', 'helper\.js'\)/);
  });
  const ignore = (() => {
    const m = build.match(/ignore:\s*(\[[^\n]*\]),\n/);
    assert.ok(m, 'build.mjs has a one-line ignore list');
    return new Function(`return ${m[1]}`)();
  })();
  const ignored = (p) => ignore.some((re) => re.test(p));
  test('ships every file the app loads', () => {
    const main = read('main.js');
    const loaded = new Set(['main.js', 'package.json', ...localRequires('main.js'), ...localRequires('helper.js'), 'helper.js']);
    for (const m of main.matchAll(/'([a-z-]+\.(?:html|js))'/g)) loaded.add(m[1]);
    for (const f of loaded) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
      assert.ok(!ignored(`/${f}`), `${f} is shipped`);
    }
    assert.ok(loaded.has('servers-preload.js') && loaded.has('profiles.html') && loaded.has('sidebar.html'));
  });
  test('leaves out personal data, build output and the tests', () => {
    for (const p of ['/profiles.json', '/profiles.example.json', '/icons/work.png', '/state/settings.json', '/logs/manager.log', '/dist/x', '/build/icon.icns', '/docs/screenshot.png', '/.git/HEAD', '/build.mjs', '/README.md', '/test/profiles.test.js', '/test/helpers/sandbox.js']) {
      assert.ok(ignored(p), `${p} is left out of the app`);
    }
  });
  test('personal data is ignored by git', () => {
    const gi = read('.gitignore').split('\n').map((l) => l.trim());
    for (const entry of ['profiles.json', 'icons/', 'state/', 'logs/', 'marks/', 'node_modules/', 'dist/']) assert.ok(gi.includes(entry), entry);
  });
  test('package.json runs the tests with the built-in runner', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.scripts.test, /^node --test\b/);
    assert.equal(pkg.main, 'main.js');
  });
});
