# Changelog

## Unreleased

- Protect release authority outside the project, bind short-lived approvals to a gate, and execute verified artifact snapshots.
- Restrict secret environment references and project file paths; harden publishing and CI.
- Fix symlinked executable entrypoints and prepare the package for public npm publishing.
- Implement release planning, approval and provider adapters.
- Add cross-platform interactive approval and external executor tests.
- Export side-effect-free tool definitions, configuration metadata, and doctor; report pending release plans in status without exposing approval.
