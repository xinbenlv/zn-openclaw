#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(ROOT, 'docs', 'carried-patch-ledger.yaml');
const CPQ_FILES = new Set([
  'AGENTS.md',
  'docs/carried-patches.md',
  'docs/carried-patch-ledger.yaml',
  'skills/github/openclaw-carried-patch-workflow/SKILL.md',
  'scripts/cpq-checks.mjs',
  'git-hooks/commit-msg',
  'git-hooks/pre-push',
  'git-hooks/pre-commit',
]);
const REQUIRED_HEADERS = [
  '## Why carried',
  '## Upstream',
  '## Summary',
  '## Drop condition',
  '## Files',
];
const CAPSTONE_SUBJECT = 'cpq-capstone-2: rebuild live CPQ metadata ledger';
const CAPSTONE_BODY = `## Why carried
- The queue needs a final metadata snapshot that reflects the actual carried commits after every mutation.
- Without a rebuilt capstone, \`cpq-head\` lies and the ledger rots immediately.

## Upstream
- PR: null
- Status: local-only

## Summary
- Rebuilds \`docs/carried-patch-ledger.yaml\` from the finalized carried queue.
- Reasserts that \`cpq-head\` points to the rebuilt \`cpq-capstone-2\` metadata snapshot.

## Drop condition
- Drop only if this repo abandons the current CPQ ledger model entirely.

## Files
- \`docs/carried-patch-ledger.yaml\`
`;

function git(args, { check = true } = {}) {
  const proc = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (check && proc.status !== 0) {
    const msg = proc.stderr?.trim() || proc.stdout?.trim() || `git ${args.join(' ')} failed`;
    throw new Error(msg);
  }
  return (proc.stdout || '').trim();
}

function currentHeadSubject() {
  return git(['show', '-s', '--format=%s', 'HEAD']);
}

function updateCpqRefs() {
  const base = git(['merge-base', 'upstream/main', 'HEAD']);
  const head = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/cpq/base', base]);
  git(['update-ref', 'refs/cpq/head', head]);
}

function carriedCommits() {
  const base = git(['merge-base', 'upstream/main', 'HEAD']);
  const raw = git(['log', '--reverse', '--format=%H%x1f%s', `${base}..HEAD`], { check: false });
  const commits = raw
    ? raw.split('\n').filter(Boolean).map((line) => {
        const [sha, subject] = line.split('\x1f');
        const id = subject.split(':', 1)[0].trim();
        return { sha, short: sha.slice(0, 8), subject, id };
      })
    : [];
  return { base, commits };
}

function upstreamPrUrl(patchId) {
  const match = /^patch-(?:fix-test|fix-func|feat)-pr(\d+)$/.exec(patchId);
  return match ? `https://github.com/openclaw/openclaw/pull/${match[1]}` : null;
}

function writeLedger(filePath) {
  const { commits } = carriedCommits();
  const lines = ['patches:'];
  for (const commit of commits) {
    const current = commit.id === 'cpq-capstone-2' ? 'cpq-head' : commit.short;
    const upstream = upstreamPrUrl(commit.id) ?? 'null';
    lines.push(`  - id: ${commit.id}`);
    lines.push(`    current_commit: ${current}`);
    lines.push(`    upstream_pr: ${upstream}`);
    lines.push('');
  }
  fs.writeFileSync(filePath, `${lines.join('\n').trimEnd()}\n`, 'utf8');
}

function appendCapstoneEntry(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trimEnd();
  const next = `${text}\n\n  - id: cpq-capstone-2\n    current_commit: cpq-head\n    upstream_pr: null\n`;
  fs.writeFileSync(filePath, next, 'utf8');
}

function rebuildCapstone() {
  writeLedger(LEDGER);
  appendCapstoneEntry(LEDGER);
  git(['add', path.relative(ROOT, LEDGER)]);
  const msgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-cpq-'));
  const msgPath = path.join(msgDir, 'msg.md');
  fs.writeFileSync(msgPath, `${CAPSTONE_SUBJECT}\n\n${CAPSTONE_BODY}`, 'utf8');
  try {
    if (currentHeadSubject().startsWith('cpq-capstone-2:')) {
      git(['commit', '--amend', '-F', msgPath]);
    } else {
      git(['commit', '-F', msgPath]);
    }
  } finally {
    fs.rmSync(msgDir, { recursive: true, force: true });
  }
  updateCpqRefs();
}

function parseLedger(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing ledger: ${filePath}`);
  const entries = [];
  let current = null;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const stripped = rawLine.trim();
    if (!stripped || stripped === 'patches:') continue;
    if (stripped.startsWith('- id:')) {
      if (current) entries.push(current);
      current = { id: stripped.split(':', 2)[1].trim() };
      continue;
    }
    if (!current) continue;
    if (stripped.startsWith('current_commit:')) {
      const value = stripped.split(':', 2)[1].trim();
      current.current_commit = value === 'null' ? null : value;
    } else if (stripped.startsWith('upstream_pr:')) {
      const value = stripped.split(':', 2)[1].trim();
      current.upstream_pr = value === 'null' ? null : value;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function patchBucket(id) {
  if (id.startsWith('cpq-cornerstone-')) return 0;
  if (id.startsWith('patch-fix-test-pr')) return 1;
  if (id.startsWith('patch-fix-func-pr')) return 2;
  if (id.startsWith('patch-feat-pr')) return 3;
  if (id.startsWith('cpq-capstone-')) return 4;
  return 99;
}

function verifyQueueOrder(commits) {
  const buckets = commits.map((commit) => patchBucket(commit.id));
  const sorted = [...buckets].sort((a, b) => a - b);
  if (JSON.stringify(buckets) !== JSON.stringify(sorted)) {
    throw new Error(
      'invalid CPQ queue order; expected cornerstone -> test-fix -> func-fix -> feat -> capstone\n'
      + `actual: ${JSON.stringify(commits.map((commit) => commit.id))}`,
    );
  }
}

function verify() {
  const { base, commits } = carriedCommits();
  if (!commits.length) throw new Error('no carried commits found');
  if (commits.at(-1)?.id !== 'cpq-capstone-2') {
    throw new Error('last carried commit is not cpq-capstone-2; rebuild cpq-capstone-2 last');
  }
  verifyQueueOrder(commits);
  const entries = parseLedger(LEDGER);
  const expectedIds = commits.map((commit) => commit.id);
  const actualIds = entries.map((entry) => entry.id);
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    throw new Error(`ledger patch IDs do not match queue\nexpected: ${JSON.stringify(expectedIds)}\nactual:   ${JSON.stringify(actualIds)}`);
  }
  commits.forEach((commit, index) => {
    const entry = entries[index];
    const expectedUrl = upstreamPrUrl(commit.id);
    if (commit.id === 'cpq-capstone-2') {
      if (entry.current_commit !== 'cpq-head') {
        throw new Error('cpq-capstone-2 ledger entry must use current_commit: cpq-head');
      }
    } else if (entry.current_commit !== commit.short) {
      throw new Error(`ledger hash mismatch for ${commit.id}: expected ${commit.short} got ${entry.current_commit}`);
    }
    if ((entry.upstream_pr ?? null) !== expectedUrl) {
      throw new Error(`ledger upstream PR mismatch for ${commit.id}: expected ${expectedUrl} got ${entry.upstream_pr}`);
    }
  });
  if (!currentHeadSubject().startsWith('cpq-capstone-2:')) {
    throw new Error('HEAD is not cpq-capstone-2');
  }
  const cpqHead = git(['rev-parse', '--verify', 'refs/cpq/head'], { check: false });
  if (cpqHead && cpqHead !== commits.at(-1)?.sha) {
    throw new Error('refs/cpq/head is stale; update cpq-head after rebuilding capstone-2');
  }
  const cpqBase = git(['rev-parse', '--verify', 'refs/cpq/base'], { check: false });
  if (cpqBase && cpqBase !== base) {
    throw new Error('refs/cpq/base is stale; update cpq-base after queue rewrite');
  }
  console.log('CPQ verification OK');
}

function validateCommitMsg(messagePath) {
  const text = fs.readFileSync(messagePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const subject = (lines[0] || '').trim();
  if (!subject.startsWith('cpq-') && !subject.startsWith('patch-')) return;
  const body = lines.slice(1).join('\n').trim();
  if (!body) throw new Error('carried patch commit requires a Markdown body');
  for (const header of REQUIRED_HEADERS) {
    if (!body.includes(header)) {
      throw new Error(`carried patch commit is missing required section: ${header}`);
    }
  }
  if (body.includes('## Upstream') && !body.includes('PR:')) {
    throw new Error('## Upstream section must include a PR line');
  }
  if (body.includes('## Upstream') && !body.includes('Status:')) {
    throw new Error('## Upstream section must include a Status line');
  }
}

function preCommit() {
  const staged = git(['diff', '--cached', '--name-only'], { check: false })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const touched = staged.filter((file) => CPQ_FILES.has(file));
  if (touched.length) {
    process.stderr.write(
      `[cpq] staged CPQ governance changes detected:\n${touched.map((file) => `  - ${file}`).join('\n')}\n`
      + '[cpq] if this mutates the queue, rebuild cpq-capstone-2 last before push.\n',
    );
  }
}

function main(argv) {
  const [cmd, arg] = argv.slice(2);
  try {
    switch (cmd) {
      case 'write-ledger':
      case 'rebuild-ledger':
        writeLedger(LEDGER);
        break;
      case 'rebuild-capstone':
        rebuildCapstone();
        break;
      case 'verify':
        verify();
        break;
      case 'pre-commit':
        preCommit();
        break;
      case 'commit-msg':
        if (!arg) throw new Error('commit-msg requires path to commit message file');
        validateCommitMsg(arg);
        break;
      default:
        throw new Error('usage: cpq-checks.mjs [write-ledger|rebuild-ledger|rebuild-capstone|verify|pre-commit|commit-msg <file>]');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main(process.argv);
