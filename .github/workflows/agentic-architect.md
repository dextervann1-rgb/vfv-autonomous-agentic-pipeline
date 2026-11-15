# Autonomous codebase architect

This is a human-readable specification, not a compiled `gh-aw` workflow. The runnable standard GitHub Actions workflow is `agentic-architect.lock.yml`.

- Inspect a bounded set of tracked source files as untrusted input; never include local secret files.
- Ask Gemini for one concrete repository improvement and a new Solidity module.
- Restrict output to a new file under `contracts/src/generated/`; validate the generated path and keep existing files untouched.
- Run Foundry build and tests before opening an issue, pushing a uniquely named branch, or opening a pull request.
- Never force-push or automatically merge or deploy. Human review and an independent smart-contract security audit remain necessary.

The automation is triggered manually, every six hours, and when an issue is opened. It will skip if the Gemini API key is missing. The issue event is only a trigger; the issue body is not supplied to the model.
