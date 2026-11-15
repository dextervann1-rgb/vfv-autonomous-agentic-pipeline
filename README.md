# VFV Autonomous Agentic Pipeline

An AI-assisted GitHub and Base L2 development pipeline for VannFamilyVentures LLC. It proposes a new Solidity module in an issue and pull request, exposes read-only Base telemetry and developer tools through MCP, and supports **manual** contract deployment. Pull requests require human review; nothing here automatically merges or deploys.

> **Security:** Generated contracts and this registry are not independently audited. Passing tests or Slither is not a security audit. Do not use real funds or Base Mainnet until an independent review, the target network, the owner address, and all operational controls have been verified.

## Quick start

Prerequisites: Node.js 20+ (Node.js 22 recommended), Git, authenticated [GitHub CLI](https://cli.github.com/), and Foundry 1.7.1 (`forge`, `cast`). Solidity 0.8.28 is pinned in `foundry.toml` and is downloaded by Foundry on first build. No `forge-std` or Solidity submodules are needed. For a tested Linux installation example see [contract setup](contracts/script/README.md).

```bash
gh repo clone dextervann1-rgb/vfv-autonomous-agentic-pipeline
cd vfv-autonomous-agentic-pipeline
npm ci
npm test
forge build
forge test -vvv
```

A successful local test run covers JavaScript unit tests, a real local MCP handshake, Solidity unit and fuzz tests, and deployment-script logic. A `forge build` lint warning about the timestamp overflow guard is expected: the timestamp is metadata, not an authorization rule or deadline. The Slither workflow narrowly suppresses that particular guard.

## Autonomous improvement

Set `GEMINI_API_KEY` securely in your local environment. `npm run agent:loop` previews a Gemini proposal without changing files or contacting GitHub. It sends a bounded selection of tracked source files to Google Gemini; secret filters are heuristic and cannot guarantee removal of every sensitive value. Inspect tracked files before use.

```bash
npm run agent:loop                 # preview only
npm run agent:loop -- --apply      # build/test, issue, commit, push, PR
```

Apply requires an existing, clean `main` checkout that exactly matches `origin/main`, an authenticated `gh` and Git push access, and Forge with the pinned Solidity compiler already installed (`forge build` first). It accepts only a self-contained **new** file under `contracts/src/generated/`, runs an offline build and every tracked Foundry test before creating an issue, then commits and pushes a uniquely named branch and opens a PR. It never force-pushes. It does not sandbox untrusted existing repository tests or tooling, so use a trusted checkout. On failure, inspect the local worktree, branch, issue and remote before retrying; partial changes are not automatically rolled back. Human security review is required.

The standard Actions workflow at `.github/workflows/agentic-architect.lock.yml` runs every six hours, when an issue is opened, or by manual dispatch. Issue text is not passed to Gemini. It skips without a `GEMINI_API_KEY` Actions secret. The companion `.md` is a human-readable specification, **not** a compiled `gh-aw` workflow.

```bash
gh workflow run agentic-architect.lock.yml --repo dextervann1-rgb/vfv-autonomous-agentic-pipeline
gh run list --repo dextervann1-rgb/vfv-autonomous-agentic-pipeline
```

GitHub's repository setting **Allow GitHub Actions to create and approve pull requests** must be enabled for this workflow to create PRs. That GitHub setting also permits workflows to approve PRs, although the workflow in this repository never does so. Review your branch protection and repository workflows accordingly. Regular local Git commits still need an explicit `git push`; the agent's own commits are pushed by its apply flow.

## Base MCP server

`npm run mcp:base` starts the stdio server. To connect an MCP client, copy `mcp/mcp-config.json` into that client's settings and replace `/absolute/path/to/vfv-autonomous-agentic-pipeline` with the real absolute path to your checkout. The example config does not perform environment-variable expansion. If needed, pass `BASE_RPC_URL` and `BASE_SEPOLIA_RPC_URL` through the client environment; otherwise public Base endpoints are used.

The server exposes `inspect_base_chain` (chain ID, block, gas and optional read-only `nonce()` call), `forge_build_and_test`, and `gh_autonomous_pr`. The nonce read does **not** prove an address is a Safe, and the server never signs or executes multisig transactions. The PR tool only opens a PR for a clean, currently checked-out branch that was already pushed and whose remote HEAD matches; it does not stage, commit or push. It rejects non-ignored untracked files and submodules. RPC providers, `gh`, Git and Foundry must be trusted.

## GitHub secrets and deployment

Configure the following in **Settings → Secrets and variables → Actions**; do not commit keys or paste private keys into issues. The provisioning connection may not have permission to set repository secrets. Network-specific secrets can instead be placed on the corresponding GitHub environment.

| Secret | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Enables automated Gemini proposals. |
| `BASE_SEPOLIA_RPC_URL` | Trusted Base Sepolia RPC for deployment, chain ID 84532. |
| `BASE_RPC_URL` | Trusted Base Mainnet RPC for deployment, chain ID 8453. |
| `DEPLOYER_PRIVATE_KEY` | Funded deployment account; use separate, tightly restricted environment secrets. |
| `BASESCAN_API_KEY` | Etherscan-compatible API key for source verification. |
| `VFV_SAFE_OWNER` | Not required by the GitHub workflow: it selects the owner from the network mapping below. For local deployment, set it to an independently verified, controllable address. |

The deployment workflow is **manual only**, runs build, tests, and Slither before deployment, checks the RPC chain ID and broadcasts only after successful checks. Configure the `base-mainnet` environment with required human reviewers and appropriate secret restrictions before any mainnet run; this configuration is not created automatically. The workflow requires the exact confirmation string `DEPLOY MAINNET` for mainnet. A mainnet or Sepolia broadcast spends gas. Verification can fail **after** a transaction has been sent; inspect the transaction and explorer before retrying.

The workflow maps the owner explicitly: Base Mainnet (`8453`) uses `0x380d3B3f68bBBC49B42Cdb0389A65457FD406f0c` (Vault 1), and Base Sepolia (`84532`) uses `0xFaeB67f71786B28E83d734B05501b9497189922b` (Vault 2). These are user-supplied addresses; the workflow does not prove that either address is a Safe or that its signers control it. Independently verify the address on the selected network before broadcasting.

```bash
# Manual Base Sepolia deployment after credentials and controls are configured:
gh workflow run smart-contract-deploy.yml \
  --repo dextervann1-rgb/vfv-autonomous-agentic-pipeline \
  -f network=base-sepolia -f contract=AutonomousRegistry
```

For local simulation, deployment and owner details see [contract setup](contracts/script/README.md). `VFV_SAFE_OWNER` is installed immediately as the initial owner; the script does not verify it is a Safe or that its signers can control it. The registry is **not upgradeable**, and its `verified` field is only an owner's assertion.
