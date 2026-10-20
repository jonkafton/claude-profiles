'use strict';
const sb = require('./helpers/sandbox');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../profiles');

const HOME = sb.home;
const input = (over = {}) => ({ name: 'Personal', account: 'alice@example.com', folders: [], ...over });

describe('expand and tilde', () => {
  test('expand turns a leading ~ into the home folder', () => {
    assert.equal(P.expand('~'), HOME);
    assert.equal(P.expand('~/code/app'), path.join(HOME, 'code/app'));
  });
  test('expand leaves other paths and empty values alone', () => {
    assert.equal(P.expand('/opt/x'), '/opt/x');
    assert.equal(P.expand('relative/x'), 'relative/x');
    assert.equal(P.expand(''), '');
    assert.equal(P.expand(undefined), undefined);
    assert.equal(P.expand(null), null);
  });
  test('tilde shortens paths inside the home folder only', () => {
    assert.equal(P.tilde(path.join(HOME, 'code', 'app')), '~/code/app');
    assert.equal(P.tilde('/opt/x'), '/opt/x');
    assert.equal(P.tilde(HOME), HOME, 'the home folder itself is not a path inside it');
    assert.equal(P.tilde(`${HOME}-other/x`), `${HOME}-other/x`, 'a sibling that shares the prefix is not inside home');
    assert.equal(P.tilde(undefined), undefined);
  });
  test('expand and tilde round-trip', () => {
    for (const p of ['~/a', '~/a/b c/d']) assert.equal(P.tilde(P.expand(p)), p);
  });
});

describe('slug', () => {
  test('lowercases and joins words with dashes', () => {
    assert.equal(P.slug('My Work Profile'), 'my-work-profile');
    assert.equal(P.slug('  --Acme__Corp!!  '), 'acme-corp');
  });
  test('folds accents at the end of a word', () => {
    assert.equal(P.slug('Café'), 'cafe');
  });
  test('folds accents inside a word without splitting it', () => {
    assert.equal(P.slug('Crème Brûlée'), 'creme-brulee');
  });
  test('caps the length at 32 characters', () => {
    const s = P.slug('a'.repeat(50));
    assert.equal(s.length, 32);
  });
  test('falls back to "profile" when nothing usable is left', () => {
    assert.equal(P.slug(''), 'profile');
    assert.equal(P.slug('!!!'), 'profile');
    assert.equal(P.slug('日本語'), 'profile');
  });
  test('numbers a slug that is already taken', () => {
    assert.equal(P.slug('Work', new Set(['work'])), 'work-2');
    assert.equal(P.slug('Work', new Set(['work', 'work-2', 'work-3'])), 'work-4');
  });
  test('stringifies non-string input', () => {
    assert.equal(P.slug(42), '42');
  });
});

describe('readRaw and writeRaw', () => {
  test('readRaw creates the folder and a default profiles.json when none exists', () => {
    const dir = path.join(sb.dir(), 'nested', 'config');
    const raw = P.readRaw(dir);
    assert.deepEqual(raw.profiles, []);
    assert.equal(raw.dockIconFollowsProfile, true);
    assert.deepEqual(raw.cleanup, { idleHours: 3, idleCpuPerHour: 30, includeDesktop: false });
    assert.match(raw.comment, /Managed by Claude Profiles/);
    const onDisk = sb.readJson(path.join(dir, 'profiles.json'));
    assert.deepEqual(onDisk, raw);
  });
  test('readRaw adds an empty profile list to a file without one', () => {
    const dir = sb.dir();
    sb.writeJson(path.join(dir, 'profiles.json'), { custom: 1 });
    assert.deepEqual(P.readRaw(dir), { custom: 1, profiles: [] });
  });
  test('readRaw throws on a file that is not JSON', () => {
    const dir = sb.dir();
    fs.writeFileSync(path.join(dir, 'profiles.json'), '{ not json');
    assert.throws(() => P.readRaw(dir), SyntaxError);
  });
  test('writeRaw writes pretty JSON with a trailing newline and leaves no temp file', () => {
    const dir = sb.dir();
    P.writeRaw(dir, { profiles: [{ id: 'a' }] });
    const text = fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8');
    assert.equal(text, JSON.stringify({ profiles: [{ id: 'a' }] }, null, 2) + '\n');
    assert.deepEqual(fs.readdirSync(dir), ['profiles.json']);
  });
});

describe('upsertProfile: validation', () => {
  const dir = () => sb.dir('cfg');
  test('requires a name', () => {
    assert.throws(() => P.upsertProfile(dir(), input({ name: '   ' })), /Give the profile a name/);
  });
  test('requires an email address for the account', () => {
    for (const account of ['', 'alice', 'alice@', 'alice@example', 'a b@example.com']) {
      assert.throws(() => P.upsertProfile(dir(), input({ account })), /email address/, account);
    }
  });
  test('rejects a folder that does not exist or is a file', () => {
    assert.throws(() => P.upsertProfile(dir(), input({ folders: ['/no/such/folder'] })), /Folder not found: \/no\/such\/folder/);
    const file = path.join(sb.dir(), 'file.txt');
    fs.writeFileSync(file, 'x');
    assert.throws(() => P.upsertProfile(dir(), input({ folders: [file] })), /Folder not found/);
  });
  test('rejects an unknown profile id and an unknown kind', () => {
    const d = dir();
    assert.throws(() => P.upsertProfile(d, input({ id: 'ghost' })), /No profile "ghost"/);
    assert.throws(() => P.upsertProfile(d, input({ kind: 'chat' })), /Unknown profile type "chat"/);
  });
  test('rejects sharing a sign-in with a missing profile, itself, or a profile that shares in turn', () => {
    const d = dir();
    const a = P.upsertProfile(d, input({ name: 'A' }));
    const b = P.upsertProfile(d, input({ name: 'B', kind: 'design', shareSignIn: a.id }));
    assert.throws(() => P.upsertProfile(d, input({ name: 'C', shareSignIn: 'ghost' })), /Choose another existing profile/);
    assert.throws(() => P.upsertProfile(d, input({ id: a.id, name: 'A', shareSignIn: a.id })), /Choose another existing profile/);
    assert.throws(() => P.upsertProfile(d, input({ name: 'C', shareSignIn: b.id })), /itself shares another profile’s sign-in/);
  });
  test('a failed save leaves profiles.json unchanged', () => {
    const d = dir();
    P.upsertProfile(d, input());
    const before = fs.readFileSync(path.join(d, 'profiles.json'), 'utf8');
    assert.throws(() => P.upsertProfile(d, input({ name: 'Other', folders: ['/missing'] })));
    assert.equal(fs.readFileSync(path.join(d, 'profiles.json'), 'utf8'), before);
  });
});

describe('upsertProfile: creating', () => {
  test('a new Claude Code profile gets an id, defaults and a config folder on disk', () => {
    const d = sb.dir('cfg');
    const p = P.upsertProfile(d, input({ name: '  Work Stuff ', account: ' bob@example.com ' }));
    assert.equal(p.id, 'work-stuff');
    assert.equal(p.kind, 'code');
    assert.equal(p.name, 'Work Stuff');
    assert.equal(p.account, 'bob@example.com');
    assert.equal(p.url, P.DEFAULT_URL);
    assert.equal(p.configDir, '~/.claude-work-stuff');
    assert.ok(fs.statSync(path.join(HOME, '.claude-work-stuff')).isDirectory());
    assert.deepEqual(p.servers, []);
    assert.deepEqual(P.readRaw(d).profiles, [JSON.parse(JSON.stringify(p))]);
  });
  test('ids never collide with existing profiles', () => {
    const d = sb.dir('cfg');
    const a = P.upsertProfile(d, input({ name: 'Work' }));
    const b = P.upsertProfile(d, input({ name: 'Work' }));
    assert.equal(a.id, 'work');
    assert.equal(b.id, 'work-2');
  });
  test('folders become servers, de-duplicated, stored with ~ and given unique ids', () => {
    const d = sb.dir('cfg');
    const one = path.join(HOME, 'code', 'app');
    const two = path.join(HOME, 'other', 'app');
    for (const f of [one, two]) fs.mkdirSync(f, { recursive: true });
    const p = P.upsertProfile(d, input({ folders: [one, '~/code/app', ` ${two} `, '', two] }));
    assert.deepEqual(p.servers, [{ id: 'app', folder: '~/code/app' }, { id: 'app-2', folder: '~/other/app' }]);
  });
  test('a folder outside the home folder keeps its absolute path', () => {
    const d = sb.dir('cfg');
    const outside = sb.dir('outside');
    const p = P.upsertProfile(d, input({ folders: [outside] }));
    assert.equal(p.servers[0].folder, outside);
  });
  test('a custom config folder is kept, and shortened with ~ when inside home', () => {
    const d = sb.dir('cfg');
    const p = P.upsertProfile(d, input({ configDir: path.join(HOME, 'custom-claude') }));
    assert.equal(p.configDir, '~/custom-claude');
    assert.ok(fs.existsSync(path.join(HOME, 'custom-claude')));
    const q = P.upsertProfile(d, input({ name: 'Q', configDir: ' ~/.claude-q2 ' }));
    assert.equal(q.configDir, '~/.claude-q2');
  });
  test('a Claude Design profile is web-only: no config folder, no servers, design start page', () => {
    const d = sb.dir('cfg');
    const folder = sb.dir('f');
    const p = P.upsertProfile(d, input({ name: 'Designs', kind: 'design', folders: [folder] }));
    assert.equal(p.kind, 'design');
    assert.equal(p.url, P.KINDS.design.url);
    assert.equal(p.configDir, undefined);
    assert.equal(p.servers, undefined);
    assert.ok(!fs.existsSync(path.join(HOME, '.claude-designs')));
  });
  test('a custom start page is kept', () => {
    const d = sb.dir('cfg');
    const p = P.upsertProfile(d, input({ url: ' https://claude.ai/code/some-page ' }));
    assert.equal(p.url, 'https://claude.ai/code/some-page');
  });
});

describe('upsertProfile: editing', () => {
  function setup() {
    const d = sb.dir('cfg');
    const a = path.join(HOME, 'proj', `a-${Math.random().toString(36).slice(2)}`);
    const b = path.join(HOME, 'proj', `b-${Math.random().toString(36).slice(2)}`);
    for (const f of [a, b]) fs.mkdirSync(f, { recursive: true });
    const p = P.upsertProfile(d, input({ folders: [a] }));
    return { d, a, b, p };
  }
  test('keeps an existing folder’s server id and extra settings, adds and drops others', () => {
    const { d, a, b, p } = setup();
    const raw = P.readRaw(d);
    raw.profiles[0].servers[0].args = ['--capacity', '50'];
    raw.profiles[0].servers[0].id = 'renamed-by-hand';
    P.writeRaw(d, raw);
    const edited = P.upsertProfile(d, input({ id: p.id, folders: [b, a] }));
    assert.deepEqual(edited.servers[1], { id: 'renamed-by-hand', folder: P.tilde(a), args: ['--capacity', '50'] });
    assert.equal(edited.servers[0].folder, P.tilde(b));
    const dropped = P.upsertProfile(d, input({ id: p.id, folders: [b] }));
    assert.deepEqual(dropped.servers.map((s) => s.folder), [P.tilde(b)]);
  });
  test('a new folder’s id does not reuse an id an existing server holds', () => {
    const d = sb.dir('cfg');
    const one = path.join(HOME, 'x', 'site');
    const two = path.join(HOME, 'y', 'site');
    for (const f of [one, two]) fs.mkdirSync(f, { recursive: true });
    const p = P.upsertProfile(d, input({ folders: [one] }));
    const edited = P.upsertProfile(d, input({ id: p.id, folders: [one, two] }));
    assert.deepEqual(edited.servers.map((s) => s.id), ['site', 'site-2']);
  });
  test('keeps the id, config folder and unknown keys when the name changes', () => {
    const { d, p } = setup();
    const raw = P.readRaw(d);
    raw.profiles[0].handEdited = { keep: true };
    raw.topLevelKey = 'stays';
    P.writeRaw(d, raw);
    const edited = P.upsertProfile(d, input({ id: p.id, name: 'Renamed' }));
    assert.equal(edited.id, p.id);
    assert.equal(edited.configDir, p.configDir);
    assert.deepEqual(edited.handEdited, { keep: true });
    assert.equal(P.readRaw(d).topLevelKey, 'stays');
  });
  test('switching Code to Design drops servers and config folder, and the default start page follows', () => {
    const { d, p } = setup();
    const design = P.upsertProfile(d, input({ id: p.id, kind: 'design' }));
    assert.equal(design.url, P.KINDS.design.url);
    assert.equal(design.servers, undefined);
    assert.equal(design.configDir, undefined);
    const back = P.upsertProfile(d, input({ id: p.id, kind: 'code' }));
    assert.equal(back.url, P.KINDS.code.url);
    assert.equal(back.configDir, `~/.claude-${p.id}`);
  });
  test('switching kind keeps a start page that was not the old default', () => {
    const d = sb.dir('cfg');
    const p = P.upsertProfile(d, input({ url: 'https://claude.ai/code/pinned' }));
    const design = P.upsertProfile(d, input({ id: p.id, kind: 'design' }));
    assert.equal(design.url, 'https://claude.ai/code/pinned');
  });
  test('kind is kept when the editor does not send it', () => {
    const d = sb.dir('cfg');
    const p = P.upsertProfile(d, input({ kind: 'design' }));
    assert.equal(P.upsertProfile(d, input({ id: p.id, name: 'Again' })).kind, 'design');
  });
  test('icon: undefined keeps it, empty string removes it, a value sets it', () => {
    const d = sb.dir('cfg');
    const p = P.upsertProfile(d, input({ icon: 'icons/a.png' }));
    assert.equal(p.icon, 'icons/a.png');
    assert.equal(P.upsertProfile(d, input({ id: p.id })).icon, 'icons/a.png');
    assert.equal(P.upsertProfile(d, input({ id: p.id, icon: '' })).icon, undefined);
    assert.ok(!('icon' in P.readRaw(d).profiles[0]), 'undefined is dropped from the JSON');
  });
  test('shareSignIn: undefined keeps it, null or empty clears it', () => {
    const d = sb.dir('cfg');
    const a = P.upsertProfile(d, input({ name: 'A' }));
    const b = P.upsertProfile(d, input({ name: 'B', shareSignIn: a.id }));
    assert.equal(b.shareSignIn, a.id);
    assert.equal(P.upsertProfile(d, input({ id: b.id, name: 'B' })).shareSignIn, a.id);
    assert.equal(P.upsertProfile(d, input({ id: b.id, name: 'B', shareSignIn: null })).shareSignIn, undefined);
    P.upsertProfile(d, input({ id: b.id, name: 'B', shareSignIn: a.id }));
    assert.equal(P.upsertProfile(d, input({ id: b.id, name: 'B', shareSignIn: '' })).shareSignIn, undefined);
  });
});

describe('removeProfile', () => {
  test('removes the profile and keeps the rest', () => {
    const d = sb.dir('cfg');
    const a = P.upsertProfile(d, input({ name: 'A' }));
    const b = P.upsertProfile(d, input({ name: 'B' }));
    P.removeProfile(d, a.id);
    assert.deepEqual(P.readRaw(d).profiles.map((p) => p.id), [b.id]);
  });
  test('throws for an unknown id without writing', () => {
    const d = sb.dir('cfg');
    P.upsertProfile(d, input());
    assert.throws(() => P.removeProfile(d, 'ghost'), /No profile "ghost"/);
    assert.equal(P.readRaw(d).profiles.length, 1);
  });
  test('refuses while another profile shares its sign-in, naming it', () => {
    const d = sb.dir('cfg');
    const a = P.upsertProfile(d, input({ name: 'Main' }));
    P.upsertProfile(d, input({ name: 'Design One', kind: 'design', shareSignIn: a.id }));
    assert.throws(() => P.removeProfile(d, a.id), /^Error: Design One shares this profile’s sign-in\. Change or delete it first\.$/);
    P.upsertProfile(d, input({ name: 'Design Two', kind: 'design', shareSignIn: a.id }));
    assert.throws(() => P.removeProfile(d, a.id), /Design One, Design Two share this profile’s sign-in\. Change or delete them first\./);
  });
});

describe('the example profiles file', () => {
  test('profiles.example.json is valid and uses only synthetic data', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profiles.example.json'), 'utf8'));
    assert.ok(Array.isArray(raw.profiles) && raw.profiles.length > 0);
    const ids = raw.profiles.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const p of raw.profiles) {
      assert.match(p.id, /^[a-z0-9-]+$/);
      assert.match(p.account, /@(example\.com|[a-z]+\.example)$/, 'example accounts must be on reserved example domains');
      if (p.shareSignIn) assert.ok(ids.includes(p.shareSignIn));
      assert.ok(P.KINDS[p.kind || 'code']);
    }
  });
});
