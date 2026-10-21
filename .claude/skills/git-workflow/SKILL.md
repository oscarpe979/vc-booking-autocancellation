---
name: git-workflow
description: This repo's Git delivery rules (branch names, commit message format, PR scope, branch cleanup). Use when the user asks to create a branch, commit, push, open a pull request, or merge.
---

# Git Workflow

Perform Git delivery actions only when the user asks for them.

## Delivery Rules

- **For now, commit directly to `main`** (user, 2026-10-21). Do not create branches until the user sets deployment rules; they will replace this line. Push only when asked.
- Never open pull requests; the user opens them manually.
- When branches return: keep one branch per body of work, never stack a new branch on another, and use lowercase, hyphenated names with `feature/`, `bugfix/`, `chore/`, `refactor/`, `hotfix/`, or `docs/` (with a ticket ID when relevant).
- Use `TICKET-ID type: description` commit messages when a ticket exists, otherwise `type: description`.
- Delete the remote branch after a merged pull request and remove the local branch only after updating the default branch.
- Never commit `.claude/settings.local.json` (personal Claude Code permissions; gitignored). Everything else under `.claude/` is shared project config and is committed.
