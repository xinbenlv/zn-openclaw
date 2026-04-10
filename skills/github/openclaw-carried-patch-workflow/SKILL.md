---
name: openclaw-carried-patch-workflow
description: Maintain the downstream CPQ queue in xinbenlv/openclaw, keep metadata in a live YAML ledger, and force cpq-capstone-2 rebuilds after any queue mutation.
version: 1.0.0
author: OpenClaw
license: MIT
metadata:
  openclaw:
    tags: [github, carried-patches, downstream, fork, rebase, worktree, cpq]
    related_skills: [github]
---

# OpenClaw carried patch workflow

Use this skill when working in `xinbenlv/openclaw` as a downstream fork of `openclaw/openclaw`.

## Core model

- `upstream/main` = clean upstream source of truth.
- local carried branch = `upstream/main` + the carried patch queue.
- `origin/main` = remote mirror of the carried queue.
- `cpq-capstone-2` is the canonical metadata snapshot for the current queue.
- `cpq-head` must point to `cpq-capstone-2`.
- Any mutation in `cpq-base..cpq-head` invalidates the old `cpq-capstone-2`.

## Patch naming rules

Use human-meaningful patch IDs in carried commit subjects.

- `cpq-cornerstone-<N>` for downstream foundation carries.
- `patch-fix-test-pr<PR_NUMBER>` for upstream-bound test fixes.
- `patch-fix-func-pr<PR_NUMBER>` for upstream-bound functional bugfixes.
- `patch-feat-pr<PR_NUMBER>` for upstream-bound feature carries.
- `cpq-capstone-<N>` for top-of-stack downstream branding and metadata carries.

## Sources of truth

- `docs/carried-patches.md` = policy and invariants only.
- `docs/carried-patch-ledger.yaml` = live patch metadata ledger.
- carried commit message body = full patch rationale, written in Markdown like a PR description.

Do not turn `docs/carried-patches.md` into a patch encyclopedia.

## Queue insertion rule

Inside `cpq-body`, ordering is mandatory:

1. `patch-fix-test-pr*`
2. `patch-fix-func-pr*`
3. `patch-feat-pr*`

When adding a new carried patch, insert it into its bucket.
Do not append it at the top just because that is convenient.
Always rebuild `cpq-capstone-2` last.

## Required commit body format

Every carried patch commit must have a Markdown body with these sections:

```md
## Why carried
- ...

## Upstream
- PR: https://github.com/openclaw/openclaw/pull/1234
- Status: open

## Summary
- ...

## Drop condition
- ...

## Files
- `path/to/file`
```

For local-only carries, use:

```md
## Upstream
- PR: null
- Status: local-only
```

## Ledger format

`docs/carried-patch-ledger.yaml` must stay minimal:

```yaml
patches:
  - id: patch-feat-pr6456
    current_commit: 9963501c
    upstream_pr: https://github.com/openclaw/openclaw/pull/6456
```

Special case:
- `cpq-capstone-2` uses `current_commit: cpq-head` in the ledger.
- Reason: embedding the commit's own final hash inside itself is a stupid fixed-point problem.

## Mandatory rebuild triggers

You MUST rebuild `cpq-capstone-2` after any of these:

- changing `cpq-base`
- adding a carried commit
- dropping a carried commit
- reordering carried commits
- amending, rebasing, squashing, or rewording any carried commit
- changing a patch ID
- changing upstream PR mapping / URL
- changing ledger contents
- changing any file in the queue in a way that alters any carried commit hash

Short version: if anything in `cpq-base..cpq-head` changed, rebuild `cpq-capstone-2` last.

## Hooks

This repo uses CPQ guard hooks under `git-hooks/`.

Expected hooks:
- `commit-msg` validates Markdown commit bodies for carried patches.
- `pre-commit` warns when staged changes mutate CPQ state and therefore require a final capstone rebuild.
- `pre-push` blocks pushes if the ledger is stale, `cpq-capstone-2` is not last, or `cpq-head` is not aligned.
- `node scripts/cpq-checks.mjs rebuild-ledger` regenerates the YAML ledger from the current carried queue.
- `node scripts/cpq-checks.mjs rebuild-capstone` regenerates the ledger, creates or amends `cpq-capstone-2`, and refreshes `refs/cpq/base` + `refs/cpq/head`.

## Daily workflow

### 1. Inspect state first

```bash
git fetch upstream --prune
git fetch origin --prune
git status --short --branch
git log --reverse --oneline upstream/main..HEAD
```

### 2. Start new own fix/feat work from `cpq-base`, in a clean worktree

For new downstream patch candidates, branch from the current `cpq-base`, not from `cpq-head`.

```bash
BASE=$(git merge-base upstream/main HEAD)
mkdir -p .worktrees
git worktree add .worktrees/feat-some-change "$BASE" -b feat/some-change
```

### 3. Keep carried metadata explicit

Whenever you create or mutate a carried patch:
- update the commit body
- update the upstream PR body backlink if applicable
- run `node scripts/cpq-checks.mjs rebuild-ledger` if you only need to refresh the ledger during work
- run `node scripts/cpq-checks.mjs rebuild-capstone` as the final step after any queue mutation

### 4. Maintain CPQ refs after rebuild

After the queue is finalized, update local refs:

```bash
git update-ref refs/cpq/base $(git merge-base upstream/main HEAD)
git update-ref refs/cpq/head HEAD
```

### 5. Push only after verification

```bash
node scripts/cpq-checks.mjs rebuild-capstone
node scripts/cpq-checks.mjs verify
git push --force-with-lease origin HEAD:main
```

## Done criteria

You are done only when all are true:
- the carried branch is based on current `upstream/main`
- every carried patch commit has the required Markdown body
- `docs/carried-patch-ledger.yaml` matches the current queue
- `cpq-capstone-2` is the final carried commit
- `cpq-head` points to `cpq-capstone-2`
- each upstream-bound patch links to its upstream PR
- each upstream PR body links back with `Carried patch: <patch-id>`
- `origin/main` mirrors the carried queue
