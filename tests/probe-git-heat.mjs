import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { gitHeat } from '../src/git-metadata.mjs';

test('status heat equals numstat for edits, binary, quoted paths, subroots, merges and rename fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-heat-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.com');
  const write = (name, data) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), data); };
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); };
  const compare = (dir = root, fallback = false) => {
    process.env.CODEATLAS_GIT_HEAT_MODE = 'numstat'; const before = gitHeat(dir);
    process.env.CODEATLAS_GIT_HEAT_MODE = 'name-status'; const calls = [];
    const after = gitHeat(dir, (label, invoke) => { calls.push(label); return invoke(); });
    assert.deepEqual(after, before);
    assert.equal(calls.some(label => label.includes('--numstat')), fallback);
  };
  const old = process.env.CODEATLAS_GIT_HEAT_MODE;
  try {
    write('sub/中文 file.js', 'one\n'); write('binary', Buffer.from([0, 1, 2]));
    if (process.platform !== 'win32') write('quote"\t.js', 'quote\n');
    write('123', 'numeric\n'); commit(); compare(); compare(path.join(root, 'sub'));
    write('sub/中文 file.js', 'two\n'); fs.unlinkSync(path.join(root, '123')); commit(); compare();
    git('checkout', '-qb', 'side'); write('side', 'side\n'); commit();
    git('checkout', '-'); write('main', 'main\n'); commit(); git('merge', '--no-ff', 'side', '-qm', 'merge'); compare();
    git('mv', 'side', 'renamed'); commit(); compare(root, true); compare(path.join(root, 'sub'), true);
    const missing = path.join(root, 'not-a-directory');
    process.env.CODEATLAS_GIT_HEAT_MODE = 'name-status'; assert.equal(gitHeat(missing), null);
  } finally {
    if (old === undefined) delete process.env.CODEATLAS_GIT_HEAT_MODE;
    else process.env.CODEATLAS_GIT_HEAT_MODE = old;
  }
});

test('both heat modes retain the last 200 commits, including empty commits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-heat-window-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q');
  let input = '';
  for (let i = 0; i < 202; i++) {
    input += `commit refs/heads/window\ncommitter fixture <fixture@example.com> ${1700000000 + i} +0000\ndata 1\nx\n`;
    if (i === 0) input += 'M 100644 inline old-only\ndata 1\nx\n';
    if (i !== 201) input += `M 100644 inline recent\ndata ${String(i).length}\n${i}\n`;
    input += '\n';
  }
  execFileSync('git', ['-C', root, 'fast-import', '--quiet'], { input, stdio: ['pipe', 'pipe', 'pipe'] });
  git('symbolic-ref', 'HEAD', 'refs/heads/window'); git('reset', '--hard', '--quiet');
  const old = process.env.CODEATLAS_GIT_HEAT_MODE;
  try {
    process.env.CODEATLAS_GIT_HEAT_MODE = 'numstat'; const before = gitHeat(root);
    process.env.CODEATLAS_GIT_HEAT_MODE = 'name-status'; assert.deepEqual(gitHeat(root), before);
    assert.equal(before.commits, 200); assert.equal(before.byPath.has('old-only'), false);
    assert.equal(before.byPath.get('recent').changes, 199);
  } finally {
    if (old === undefined) delete process.env.CODEATLAS_GIT_HEAT_MODE;
    else process.env.CODEATLAS_GIT_HEAT_MODE = old;
  }
});
