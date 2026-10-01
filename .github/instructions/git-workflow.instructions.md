
# Git Workflow

Apply this file only when Git branches, commits, pushes, pull requests, or merges are requested.

## Delivery Rules

- Do not commit or push directly to the protected default branch. Use a reviewed pull request.
- Keep each branch and pull request to one logical, reviewable change. Split risky or broad work before delivery.
- Use lowercase, hyphenated branch names with `feature/`, `bugfix/`, `chore/`, `refactor/`, `hotfix/`, or `docs/`; include a ticket ID when relevant.
- Use `TICKET-ID type: description` commit messages when a ticket exists, otherwise `type: description`.
- Delete the remote branch after a merged pull request and remove the local branch only after updating the default branch.
- Do not perform Git delivery actions unless the user asks for them.
