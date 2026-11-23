# Repository instructions

## Main-only branch policy

This is an explicit user preference and overrides default feature-branch workflows.

- Work, commit and push on `main` only.
- Do not create, switch to, or work on another branch or branch-based worktree
  unless the user explicitly requests it. Do not create a pull request by default.
- Check the active branch before making changes. If another branch is active,
  inspect its commits and working-tree changes, then integrate the work safely into
  `main`. Preserve unrelated changes; never discard or reset them to switch branches.
- A branch exception applies only to the user's explicit request, not later tasks.
  Return to `main` afterward unless the user explicitly instructs otherwise.
- Existing automation-created branches do not authorize using additional branches.
  Do not merge or delete unrelated automation branches without user direction.

## Delivery and privacy

- Stage only intended files and preserve unrelated local edits.
- Run the repository's mandatory commit and pre-push checks; do not bypass them.
- Keep private monitoring targets, URLs, rules, credentials, browser profiles and
  evidence in ignored local storage. Never commit or push them.
