// Packages the app and installs it as ~/Applications/Claude Profiles.app.
// A previous install is moved into dist/ rather than deleted; clear dist/ by hand when you no longer need it.
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(here, 'dist', stamp);
const target = path.join(os.homedir(), 'Applications', 'Claude Profiles.app');

const [built] = await packager({
  dir: here,
  out,
  name: 'Claude Profiles',
  platform: 'darwin',
  arch: process.arch,
  icon: path.join(here, 'build', 'icon.icns'),
  appBundleId: 'io.github.jonkafton.claude-profiles',
  appCategoryType: 'public.app-category.developer-tools',
  // launchd runs helper.js with the app's binary as plain Node, so it and its module live outside the archive.
  asar: { unpack: '{helper,manager,profiles}.js' },
  // User data lives in ~/Library/Application Support/Claude Profiles, never in the bundle.
  ignore: [/^\/(dist|build|icons|state|logs|docs|test|\.git)($|\/)/, /^\/(profiles|profiles\.example)\.json$/, /^\/build\.mjs$/, /^\/(README\.md|LICENSE|\.gitignore)$/],
});
const app = path.join(built, 'Claude Profiles.app');

// Re-sign ad hoc: packaging edits Electron's Info.plist, which breaks its original signature.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', app], { stdio: 'inherit' });

// ~/Applications does not exist on every Mac until something creates it.
fs.mkdirSync(path.dirname(target), { recursive: true });
if (fs.existsSync(target)) {
  // Swap the Contents inside the existing bundle rather than replacing the bundle: a Dock pin tracks the
  // bundle folder itself and would otherwise follow the old copy into dist/.
  const previous = path.join(out, 'previous-Claude Profiles.app');
  fs.mkdirSync(previous);
  fs.renameSync(path.join(target, 'Contents'), path.join(previous, 'Contents'));
  fs.renameSync(path.join(app, 'Contents'), path.join(target, 'Contents'));
  execFileSync('codesign', ['--verify', '--deep', target], { stdio: 'inherit' });
} else {
  fs.renameSync(app, target);
}
execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', target]);
console.log(`installed ${target}`);
