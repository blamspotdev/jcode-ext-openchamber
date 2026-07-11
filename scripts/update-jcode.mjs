#!/usr/bin/env node
/**
 * JCode extension update helper.
 *
 * Automates the "update this openchamber" workflow for the jcode fork so a
 * whole upstream sync + bundle rebuild is one command instead of a dozen manual
 * git/bun steps:
 *
 *   1. Fetch `upstream/main` and report how far behind the base branch is.
 *   2. Create an `update/openchamber-<version>` branch off the base branch.
 *   3. Merge `upstream/main`, auto-resolving the expected README.md conflict
 *      (keep ours) and refreshing README.upstream.md from upstream. Any OTHER
 *      conflict aborts the merge and stops — those need a human.
 *   4. Rebuild the static webview bundle (`bun run --cwd packages/vscode
 *      build:webview`) and swap it into packages/jcode/ext/www/webview,
 *      preserving the hand-authored wrapper index.html and jcode-shim.js.
 *   5. Set the jcode manifest version to the upstream version and update the
 *      wrapper extensionVersion to `<version>-jcode`.
 *   6. Commit. With --push/--pr, push the branch and open a GitHub PR; without
 *      them, print the exact push/PR commands to run.
 *
 * Usage:
 *   node scripts/update-jcode.mjs [options]
 *   bun run jcode:update [-- options]   (npm: npm run jcode:update -- options)
 *
 * Options:
 *   --base <branch>   Base branch to update from (default: main)
 *   --branch <name>   Override the new branch name
 *   --no-install      Never run `bun install`, even if deps look missing
 *   --push            Push the branch to origin when done
 *   --pr              Push and open a GitHub PR (implies --push)
 *   --dry-run         Print the plan (target version, behind count) and exit
 *   --help, -h        Show this help
 *
 * The fork's update conventions this encodes:
 *   - jcode manifest version == upstream OpenChamber version (not a 0.2.x track)
 *   - only README.md is expected to conflict; README.upstream.md mirrors upstream
 *   - the committed www/webview bundle must be rebuilt so users get the new UI
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const UPSTREAM_REF = 'upstream/main';
const JCODE = 'packages/jcode/ext';
const WEBVIEW_SRC = 'packages/vscode/dist/webview';
const WEBVIEW_DEST = `${JCODE}/www/webview`;

// ---- tiny logging + process helpers ---------------------------------------

const info = (m) => console.log(`\x1b[36m›\x1b[0m ${m}`);
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.warn(`\x1b[33m!\x1b[0m ${m}`);
const die = (m) => {
  console.error(`\x1b[31m✗ ${m}\x1b[0m`);
  process.exit(1);
};

function quoteArg(s) {
  return /\s/.test(s) ? `"${s}"` : s;
}

/**
 * Run a command. `git` is a real exe (shell:false). `bun`/`gh` are .cmd shims on
 * Windows that Node can't resolve without a shell, so those pass shell:true and
 * run as one quoted line. Returns { status, stdout (raw), stderr }.
 */
function run(cmd, args = [], opts = {}) {
  const useShell = opts.shell ?? false;
  const file = useShell ? [cmd, ...args.map(quoteArg)].join(' ') : cmd;
  const spawnArgs = useShell ? undefined : args;
  const result = spawnSync(file, spawnArgs, {
    cwd: opts.cwd || ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: opts.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: useShell,
  });
  if (result.error) {
    if (opts.allowFail) return { status: 1, stdout: '', stderr: String(result.error) };
    die(`${opts.label || cmd} could not run: ${result.error.message}`);
  }
  if (result.status !== 0 && !opts.allowFail) {
    die(`${opts.label || [cmd, ...args].join(' ')} failed (exit ${result.status})`);
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

const git = (args, opts = {}) => run('git', args, opts);
const gitOut = (args) => git(args, { capture: true }).stdout.trim();
const bun = (args, opts = {}) => run('bun', args, { shell: true, ...opts });

// ---- arg parsing -----------------------------------------------------------

function parseArgs(argv) {
  const opts = { base: 'main', branch: null, install: true, push: false, pr: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') printHelpAndExit();
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--branch') opts.branch = argv[++i];
    else if (a === '--no-install') opts.install = false;
    else if (a === '--push') opts.push = true;
    else if (a === '--pr') { opts.pr = true; opts.push = true; }
    else if (a === '--dry-run') opts.dryRun = true;
    else die(`Unknown option: ${a} (try --help)`);
  }
  if (!opts.base) die('--base requires a branch name');
  return opts;
}

function printHelpAndExit() {
  const header = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const doc = header.slice(header.indexOf('/**'), header.indexOf('*/') + 2);
  console.log(doc.replace(/^\/\*\*?|\*\/$/g, '').replace(/^ ?\* ?/gm, ''));
  process.exit(0);
}

// ---- steps -----------------------------------------------------------------

function ensurePreconditions() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) die('not a git repository');
  for (const f of ['www/index.html', 'www/jcode-shim.js', 'extension.yaml']) {
    if (!fs.existsSync(path.join(ROOT, JCODE, f))) die(`expected fork file missing: ${JCODE}/${f}`);
  }
  const upstream = git(['remote', 'get-url', 'upstream'], { capture: true, allowFail: true });
  if (upstream.status !== 0) die("no `upstream` remote — add it: git remote add upstream https://github.com/openchamber/openchamber.git");
  const dirty = gitOut(['status', '--porcelain']);
  if (dirty) die('working tree is not clean — commit or stash first:\n' + dirty);
}

function readManifestVersion() {
  const text = fs.readFileSync(path.join(ROOT, JCODE, 'extension.yaml'), 'utf8');
  return (text.match(/^version:\s*(.+)$/m)?.[1] || '').trim();
}

function upstreamVersion() {
  const pkg = git(['show', `${UPSTREAM_REF}:package.json`], { capture: true }).stdout;
  const version = JSON.parse(pkg).version;
  if (!version) die(`could not read version from ${UPSTREAM_REF}:package.json`);
  return version;
}

function mergeUpstream() {
  info(`Merging ${UPSTREAM_REF} …`);
  git(['merge', '--no-commit', '--no-ff', UPSTREAM_REF], { allowFail: true });
  const conflicts = gitOut(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
  const unexpected = conflicts.filter((f) => f !== 'README.md');
  if (unexpected.length) {
    git(['merge', '--abort'], { allowFail: true });
    die('unexpected merge conflicts (only README.md is auto-handled):\n  ' + unexpected.join('\n  ') +
      '\nResolve the merge by hand, then re-run with the bundle steps, or fix upstream drift.');
  }
  if (conflicts.includes('README.md')) {
    info('Resolving README.md conflict → keep ours (fork README)');
    git(['checkout', '--ours', 'README.md']);
    git(['add', 'README.md']);
  }
  // Keep README.upstream.md a faithful mirror of upstream's README.
  const upstreamReadme = git(['show', `${UPSTREAM_REF}:README.md`], { capture: true }).stdout;
  fs.writeFileSync(path.join(ROOT, 'README.upstream.md'), upstreamReadme);
  git(['add', 'README.upstream.md']);
  git(['commit', '--no-edit']);
  ok(`Merged ${UPSTREAM_REF} (${gitOut(['rev-parse', '--short', UPSTREAM_REF])})`);
}

function hasVite() {
  return fs.existsSync(path.join(ROOT, 'node_modules', 'vite', 'package.json'));
}

function buildWebview(install) {
  if (!hasVite()) {
    if (!install) die('build deps missing and --no-install set — run `bun install` first');
    info('Installing dependencies (bun install) — this is slow the first time …');
    // bun exits 1 when optional native/mobile packages fail to link on Windows; tolerate
    // that as long as the build toolchain (vite) actually landed.
    bun(['install'], { allowFail: true });
    if (!hasVite()) die('`bun install` did not produce vite — cannot build the webview');
  }
  info('Building the webview bundle …');
  bun(['run', '--cwd', 'packages/vscode', 'build:webview'], { label: 'webview build' });
  if (!fs.existsSync(path.join(ROOT, WEBVIEW_SRC, 'assets', 'index.js'))) {
    die(`build produced no entry at ${WEBVIEW_SRC}/assets/index.js`);
  }
  ok('Webview build complete');
}

function swapBundle() {
  const src = path.join(ROOT, WEBVIEW_SRC);
  const dest = path.join(ROOT, WEBVIEW_DEST);
  info(`Swapping bundle → ${WEBVIEW_DEST}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  if (!fs.existsSync(path.join(dest, 'assets', 'index.js'))) die('bundle swap left no entry index.js');
  // Hand-authored files live above www/webview and must survive untouched.
  for (const f of ['www/index.html', 'www/jcode-shim.js']) {
    if (!fs.existsSync(path.join(ROOT, JCODE, f))) die(`hand-authored ${f} vanished after swap — aborting`);
  }
  ok('Bundle swapped (wrapper + shim preserved)');
}

function bumpVersions(version) {
  const files = [
    [`${JCODE}/extension.yaml`, /^version:\s*.*$/m, `version: ${version}`],
    [`${JCODE}/www/index.html`, /extensionVersion:\s*'[^']*'/, `extensionVersion: '${version}-jcode'`],
  ];
  for (const [rel, pattern, replacement] of files) {
    const full = path.join(ROOT, rel);
    const text = fs.readFileSync(full, 'utf8');
    const next = text.replace(pattern, replacement);
    if (next === text) warn(`no version match updated in ${rel}`);
    else fs.writeFileSync(full, next);
  }
  ok(`Version set to ${version} (wrapper: ${version}-jcode)`);
}

function commitRebuild(version) {
  git(['add', '-A', JCODE]);
  if (!gitOut(['diff', '--cached', '--name-only'])) {
    warn('no bundle/version changes to commit (already up to date?)');
    return;
  }
  git(['commit',
    '-m', `${version}: rebuild static www bundle from upstream OpenChamber ${version}`,
    '-m', `- Regenerate ${WEBVIEW_DEST} from the ${version} vscode webview build\n- Set jcode extension version to ${version} (tracks upstream)\n- Bump wrapper extensionVersion to ${version}-jcode`,
  ]);
  ok('Committed bundle rebuild + version bump');
}

function originRepo() {
  const url = gitOut(['remote', 'get-url', 'origin']);
  const m = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function pushAndPr(opts, branch, version, prevVersion) {
  const repo = originRepo();
  git(['push', '-u', 'origin', branch]);
  ok(`Pushed ${branch}`);
  if (!opts.pr) return;
  if (run('gh', ['--version'], { shell: true, capture: true, allowFail: true }).status !== 0) {
    warn('gh CLI not found — open the PR manually.');
    return;
  }
  const body = [
    `Syncs the fork with upstream OpenChamber **${prevVersion} → ${version}** and rebuilds the shipped JCode static webview bundle so the extension delivers the new UI.`,
    '',
    '## Changes',
    `- Merge \`${UPSTREAM_REF}\` (\`${gitOut(['rev-parse', '--short', UPSTREAM_REF])}\`). Only README.md conflicted → kept the fork README; refreshed README.upstream.md.`,
    `- Rebuilt \`${WEBVIEW_DEST}/\` from the ${version} vscode webview build.`,
    `- Version tracks Origin: manifests → \`${version}\`; wrapper \`extensionVersion\` → \`${version}-jcode\`.`,
    '- Preserved the hand-authored `www/index.html` wrapper and `jcode-shim.js` host shim.',
    '',
    '## Validation',
    '- `bun run --cwd packages/vscode build:webview` → exit 0',
    '- Clean merge (README-only conflict); bundle entry `assets/index.js` present.',
    '',
    '_Generated by `scripts/update-jcode.mjs`._',
  ].join('\n');
  const bodyFile = path.join(os.tmpdir(), `jcode-pr-${version}.md`);
  fs.writeFileSync(bodyFile, body);
  const args = ['pr', 'create', '--base', opts.base, '--head', branch,
    '--title', `Update to OpenChamber ${version}`, '--body-file', bodyFile];
  if (repo) args.splice(2, 0, '--repo', repo);
  const res = run('gh', args, { shell: true, capture: true, allowFail: true });
  fs.rmSync(bodyFile, { force: true });
  if (res.status === 0) ok(`PR opened: ${res.stdout.trim()}`);
  else { warn('gh pr create failed:\n' + (res.stderr || res.stdout)); printManualPr(opts, branch, version); }
}

function printManualPr(opts, branch, version) {
  const repo = originRepo();
  console.log('\nNext steps:');
  console.log(`  git push -u origin ${branch}`);
  console.log(`  gh pr create${repo ? ` --repo ${repo}` : ''} --base ${opts.base} --head ${branch} --title "Update to OpenChamber ${version}"`);
}

// ---- main ------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  ensurePreconditions();

  info(`Fetching ${UPSTREAM_REF} …`);
  git(['fetch', 'upstream', 'main']);
  const version = upstreamVersion();
  const prevVersion = readManifestVersion();
  const behind = Number(gitOut(['rev-list', '--count', `${opts.base}..${UPSTREAM_REF}`]) || '0');
  const branch = opts.branch || `update/openchamber-${version}`;

  console.log('');
  info(`Upstream OpenChamber version : ${version}`);
  info(`Current jcode manifest        : ${prevVersion}`);
  info(`Base branch                   : ${opts.base} (${behind} commit(s) behind upstream)`);
  info(`Update branch                 : ${branch}`);
  console.log('');

  if (behind === 0 && prevVersion === version) {
    ok('Already up to date with upstream — nothing to do.');
    return;
  }
  if (opts.dryRun) { info('Dry run — no changes made.'); return; }

  if (gitOut(['rev-parse', '--verify', '--quiet', branch])) {
    die(`branch ${branch} already exists — delete it (git branch -D ${branch}) or pass --branch <name>`);
  }
  git(['switch', '-c', branch, opts.base]);

  mergeUpstream();
  buildWebview(opts.install);
  swapBundle();
  bumpVersions(version);
  commitRebuild(version);

  console.log('');
  if (opts.push) pushAndPr(opts, branch, version, prevVersion);
  else printManualPr(opts, branch, version);

  console.log('');
  ok(`Update to OpenChamber ${version} ready on ${branch}`);
}

main();
