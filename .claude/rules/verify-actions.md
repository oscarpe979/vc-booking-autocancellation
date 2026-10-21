# Verification Requirements

Apply after every workspace change. Supplements the testing requirements in `senior-engineering.md`.

## Required Evidence

- Verify the requested result through an authoritative source; edit-tool success and command exit status alone are insufficient.
- For code changes, inspect the changed code and run the narrowest relevant executable check when one exists.
- For file operations, inspect the relevant path or directory and confirm both the intended new state and removal of any old path when applicable.
- For structured configuration, validate both the changed content and its syntax or format.
- For external systems, verify the result in that system when access is available; otherwise state the unverified boundary.
- For bulk changes, verify every affected item or use a complete query that proves the whole set.

- Do not claim completion if verification fails or is unavailable.
