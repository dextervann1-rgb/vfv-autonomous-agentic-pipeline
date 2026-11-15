# Registry build, test, and deployment

Run the following commands from the repository root. The contracts and tests have **no third-party Solidity dependencies**: no `forge install`, `contracts/lib`, or Git submodules are needed. Solidity is pinned to 0.8.28 in `foundry.toml`; Foundry downloads that compiler on first use if it is not already cached.

Use Foundry 1.7.1 for the tested toolchain. For example, on **Linux x86-64** with Node/npm installed, install the exact platform binary outside the repository:

```bash
npm install --prefix "$HOME/.local/vfv-foundry" --no-save --ignore-scripts --no-audit --no-fund @foundry-rs/forge-linux-amd64@1.7.1
export PATH="$HOME/.local/vfv-foundry/node_modules/@foundry-rs/forge-linux-amd64/bin:$PATH"
forge --version
forge build
forge test -vvv
```

Other platforms require the corresponding Foundry 1.7.1 binary. Builds/tests are local; the default 512 fuzz runs can be increased with `forge test --fuzz-runs 10000`. `contracts/out/`, `contracts/cache/`, and `contracts/broadcast/` are generated output, not dependencies; keep them out of version control. Cache and broadcast files may contain sensitive information.

## Base deployment

The script refuses chain IDs other than Base Sepolia (84532) and Base Mainnet (8453). Supply a trusted RPC URL for the intended chain. It never submits a transaction unless `--broadcast` is explicitly passed to `forge script`.

- `DEPLOYER_PRIVATE_KEY` is required and must be a valid private key, normally `0x`-prefixed. The corresponding account must have enough ETH for gas when broadcasting. Handle this secret in a trusted environment; don't place it in source control, shell history, or logs.
- `VFV_SAFE_OWNER` is optional. Unset **or empty** means the deployer address is owner. A nonempty value must be a nonzero address; the script installs it directly as the initial owner, not as a pending transfer. It does not check that the address is a Safe or that its signers can use it. Independently confirm the address and intended network before broadcasting; a wrong or inaccessible owner can permanently lock control.
- Set `BASE_SEPOLIA_RPC_URL` or `BASE_RPC_URL` yourself; no default public RPC or explorer API key is assumed. Source verification is not automatic and was not performed here.

For example, first **simulate only** on Base Sepolia. Set the RPC URL and optional Safe owner securely beforehand. Enter the private key without echoing it:

```bash
read -r -s -p 'Deployer private key: ' DEPLOYER_PRIVATE_KEY; echo
export DEPLOYER_PRIVATE_KEY
# Set VFV_SAFE_OWNER to a verified address, or leave it unset/empty for deployer ownership.
forge script contracts/script/Deploy.s.sol:DeployAutonomousRegistry \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

After independently reviewing the simulation, chain, owner and gas, the following is a **separate live transaction** and spends real funds:

```bash
forge script contracts/script/Deploy.s.sol:DeployAutonomousRegistry \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
```

For Base Mainnet, substitute `"$BASE_RPC_URL"` in either command and exercise extra care; the same `--broadcast` warning applies. Clear the key from your shell when finished: `unset DEPLOYER_PRIVATE_KEY`.

## Registry behavior and limitations

Artifacts are append-only and IDs start at 1. Check `1 <= id <= totalArtifacts` before relying on `artifacts(id)`: the mapping getter returns default values for absent IDs. The owner supplies the hash, CID, deployment address and `verified` flag; none is validated, and `verified` is an **owner assertion**, not cryptographic or independent verification. Empty metadata and a zero deployment address are permitted. The timestamp is the block timestamp and should not be treated as a precise trusted clock. Treat the bytes32 commit hash encoding consistently off-chain, particularly for Git hashes shorter than 32 bytes.

Ownership transfers are two-step: the current owner calls `transferOwnership(newOwner)`, and the proposed owner must call `acceptOwnership()`. Until acceptance, the current owner retains control. A proposal can be replaced or cancelled with `cancelOwnershipTransfer()`. The current owner and the zero address cannot be proposed, and renunciation is not supported. If the new owner is a Safe, its signers must execute the acceptance transaction from that Safe.

This is a non-upgradeable contract and has not been independently audited. Tests and a simulation are not a security audit or a guarantee of correctness.
