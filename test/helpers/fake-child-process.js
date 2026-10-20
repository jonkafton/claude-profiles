// A scriptable stand-in for node:child_process. manager.js and main.js destructure execFile, execFileSync
// and spawn when they load, so this must be required before them. It patches the shared module object, so
// `require('node:child_process')` anywhere in the process sees the fake.
//
// Built in: a fake launchd (launchctl print/bootstrap/bootout over a set of loaded labels), a fake process
// table answering every `ps` and `lsof` form the app uses, and a login shell that prints a chosen PATH.
// Anything else goes to handlers a test registers with on(); an unhandled command fails like ENOENT.
'use strict';

const cp = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');

// The real functions, for tests that need a real tool (plutil) while the fake is installed.
const real = { execFile: cp.execFile, execFileSync: cp.execFileSync, spawn: cp.spawn };

const state = {
  calls: [], // every execFile/execFileSync: { cmd, args, opts }
  spawned: [], // every spawn: { cmd, args, opts, child }
  handlers: [], // { match(cmd, args), reply(cmd, args, opts) }
  processes: [], // { pid, ppid, rss, time, cmd, cwd, configDir, lstart }
  loaded: new Set(), // launchd labels currently loaded
  lingerPrints: 0, // `launchctl print` keeps reporting a booted-out job as loaded this many more times
  loginPath: '/fake/login/bin:/usr/bin:/bin',
  loginShellFails: false,
  nextPid: 90000,
};

function fail(message, { code = 1, stdout = '', stderr = '' } = {}) {
  const e = new Error(message);
  e.code = code;
  e.stdout = stdout;
  e.stderr = stderr;
  return e;
}

const pad = (v, n) => String(v).padStart(n);
function ps(args) {
  const list = state.processes;
  const fmt = args.join(' ');
  if (fmt === '-axo pid=,ppid=,rss=,time=,command=') return list.map((p) => `${pad(p.pid, 6)} ${pad(p.ppid, 6)} ${pad(p.rss ?? 1024, 8)} ${p.time ?? '0:00.00'} ${p.cmd}`).join('\n') + '\n';
  if (fmt === '-axo pid=,ppid=,command=') return list.map((p) => `${pad(p.pid, 6)} ${pad(p.ppid, 6)} ${p.cmd}`).join('\n') + '\n';
  if (fmt === '-axo command=') return list.map((p) => p.cmd).join('\n') + '\n';
  if (fmt === '-axo pid=,lstart=') return list.map((p) => `${pad(p.pid, 6)} ${p.lstart ?? 'Mon Oct 19 09:00:00 2026'}`).join('\n') + '\n';
  if (args[0] === 'eww') {
    const p = list.find((x) => String(x.pid) === args.at(-1));
    if (!p) throw fail('no such process');
    return `${p.cmd}${p.configDir ? ` TERM=xterm CLAUDE_CONFIG_DIR=${p.configDir} HOME=/x` : ' TERM=xterm'}\n`;
  }
  throw fail(`fake ps: unsupported arguments ${fmt}`);
}

function builtin(cmd, args) {
  if (cmd === 'ps') return ps(args);
  if (cmd === 'lsof') {
    const p = state.processes.find((x) => String(x.pid) === args[args.indexOf('-p') + 1]);
    if (!p || !p.cwd) throw fail('lsof: no process');
    return `p${p.pid}\nfcwd\nn${p.cwd}\n`;
  }
  if (cmd === 'launchctl') {
    const [verb, target] = args;
    if (verb === 'print') {
      const label = target.split('/').pop();
      if (state.loaded.has(label)) return `${label} = { state = running }\n`;
      if (state.lingerPrints > 0) { state.lingerPrints--; return `${label} = { state = exiting }\n`; }
      throw fail(`Could not find service "${label}"`, { code: 113 });
    }
    if (verb === 'bootstrap') { state.loaded.add(path.basename(args[2], '.plist')); return ''; }
    if (verb === 'bootout') { state.loaded.delete(target.split('/').pop()); return ''; }
  }
  if (cmd === '/bin/zsh' && args[0] === '-lic') {
    if (state.loginShellFails) throw fail('zsh: failed');
    return `some motd noise\n${state.loginPath}`;
  }
  return undefined;
}

function respond(cmd, args = [], opts = {}) {
  state.calls.push({ cmd, args, opts });
  for (let i = state.handlers.length - 1; i >= 0; i--) {
    const h = state.handlers[i];
    if (h.match(cmd, args, opts)) {
      const out = h.reply(cmd, args, opts);
      if (out instanceof Error) throw out;
      return typeof out === 'string' ? { stdout: out, stderr: '' } : { stdout: '', stderr: '', ...out };
    }
  }
  const out = builtin(cmd, args);
  if (out === undefined) throw fail(`spawn ${cmd} ENOENT`, { code: 'ENOENT' });
  return { stdout: out, stderr: '' };
}

function execFile(cmd, args, opts, cb) {
  if (typeof args === 'function') { cb = args; args = []; opts = {}; }
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  let result;
  let error = null;
  try { result = respond(cmd, args, opts); } catch (e) { error = e; }
  process.nextTick(() => cb?.(error, error ? error.stdout : result.stdout, error ? error.stderr : result.stderr));
  return new EventEmitter();
}
execFile[promisify.custom] = (cmd, args, opts) => new Promise((resolve, reject) => {
  try { resolve(respond(cmd, args, opts)); } catch (e) { reject(e); }
});

function execFileSync(cmd, args, opts) {
  return respond(cmd, args, opts).stdout;
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = state.nextPid;
    state.nextPid += 100; // room for tests to give each fake child its own descendant pids (pid + 1, + 2, …)
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { ended: false, end() { this.ended = true; } };
    this.killed = [];
  }
  unref() { this.unrefed = true; return this; }
  kill(sig) { this.killed.push(sig); return true; }
}
function spawn(cmd, args = [], opts = {}) {
  const child = new FakeChild();
  state.spawned.push({ cmd, args, opts, child });
  return child;
}

cp.execFile = execFile;
cp.execFileSync = execFileSync;
cp.spawn = spawn;

// Later handlers win, so a test can override a built-in or an earlier handler.
function on(match, reply) {
  const m = typeof match === 'function' ? match : (cmd) => cmd === match || path.basename(cmd) === match;
  state.handlers.push({ match: m, reply: typeof reply === 'function' ? reply : () => reply });
}

function reset() {
  state.calls.length = 0;
  state.spawned.length = 0;
  state.handlers.length = 0;
  state.processes.length = 0;
  state.loaded.clear();
  state.lingerPrints = 0;
  state.loginPath = '/fake/login/bin:/usr/bin:/bin';
  state.loginShellFails = false;
}

const callsTo = (cmd) => state.calls.filter((c) => c.cmd === cmd || path.basename(c.cmd) === cmd);

module.exports = { state, on, reset, fail, callsTo, FakeChild, real };
