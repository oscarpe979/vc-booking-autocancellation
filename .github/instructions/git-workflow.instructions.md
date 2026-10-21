
# Git Workflow

Apply this file only when Git branches, commits, pushes, pull requests, or merges are requested.

## Delivery Rules

- For now, commit directly to `main` (2026-10-21). Do not create branches until deployment rules are set; they will replace this line. Push only when asked.
- Never open pull requests; the user opens them manually.
- When branches return: keep one branch per body of work, never stack a new branch on another, and use lowercase, hyphenated names with `feature/`, `bugfix/`, `chore/`, `refactor/`, `hotfix/`, or `docs/` (with a ticket ID when relevant).
- Use `TICKET-ID type: description` commit messages when a ticket exists, otherwise `type: description`.
- Delete the remote branch after a merged pull request and remove the local branch only after updating the default branch.
- Do not perform Git delivery actions unless the user asks for them.
