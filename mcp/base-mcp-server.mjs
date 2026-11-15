import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NETWORKS = Object.freeze({
  mainnet: Object.freeze({ chainId: 8453, env: 'BASE_RPC_URL', url: 'https://mainnet.base.org' }),
  sepolia: Object.freeze({ chainId: 84532, env: 'BASE_SEPOLIA_RPC_URL', url: 'https://sepolia.base.org' }),
});
const MAX_RPC_RESPONSE = 1_000_000;
const MAX_COMMAND_OUTPUT = 2_000_000;

export function validateNetwork(network) {
  if (typeof network !== 'string' || !Object.hasOwn(NETWORKS, network)) {
    throw new Error('Network must be mainnet or sepolia.');
  }
  return NETWORKS[network];
}

export function rpcUrlForNetwork(network, env = process.env) {
  const config = validateNetwork(network);
  const raw = env[config.env] || config.url;
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Invalid ${config.env} URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(`${config.env} must be an HTTP(S) URL without userinfo or a fragment.`);
  }
  return url.href;
}

export function validateSafeAddress(address) {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) {
    throw new Error('Safe address must be a nonzero 20-byte hex address.');
  }
  return address;
}

export function parseRpcQuantity(value, name = 'RPC quantity') {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) {
    throw new Error(`Invalid ${name}.`);
  }
  return BigInt(value);
}

export function formatGwei(wei) {
  if (typeof wei !== 'bigint' || wei < 0n) throw new Error('Wei must be a nonnegative bigint.');
  const whole = wei / 1_000_000_000n;
  const fraction = (wei % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function parseSafeNonce(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('The nonce() call did not return an ABI-encoded uint256.');
  }
  return BigInt(value).toString();
}

async function readRpcBody(response, method) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RPC_RESPONSE) throw new Error(`RPC ${method} response is too large.`);
    return text;
  }
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RPC_RESPONSE) {
        await reader.cancel();
        throw new Error(`RPC ${method} response is too large.`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

// Each request has its own timeout; RPC error bodies and URLs are not echoed.
export function makeRpcClient(url, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  return async (method, params = []) => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error(`RPC ${method} request failed or timed out.`);
    }
    if (!response.ok) throw new Error(`RPC ${method} returned HTTP ${response.status}.`);
    const contentLength = response.headers?.get('content-length');
    if (contentLength && Number(contentLength) > MAX_RPC_RESPONSE) throw new Error(`RPC ${method} response is too large.`);
    let text;
    try { text = await readRpcBody(response, method); }
    catch (error) {
      if (error?.message === `RPC ${method} response is too large.`) throw error;
      throw new Error(`RPC ${method} response could not be read or timed out.`);
    }
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error(`RPC ${method} returned invalid JSON.`); }
    if (!payload || payload.jsonrpc !== '2.0' || payload.id !== 1 || payload.error || !Object.hasOwn(payload, 'result')) {
      throw new Error(`RPC ${method} returned an invalid response or RPC error.`);
    }
    return payload.result;
  };
}

export async function inspectBaseChain({ network = 'mainnet', safeAddress } = {}, options = {}) {
  const config = validateNetwork(network);
  if (safeAddress !== undefined) validateSafeAddress(safeAddress);
  const rpc = options.rpc ?? makeRpcClient(rpcUrlForNetwork(network, options.env));
  // Verify the endpoint before issuing any block or contract read.
  const chainId = parseRpcQuantity(await rpc('eth_chainId'), 'chain ID');
  if (chainId !== BigInt(config.chainId)) {
    throw new Error(`RPC chain ID mismatch for ${network}: expected ${config.chainId}, got ${chainId}.`);
  }
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error('RPC returned no latest block.');
  const blockNumber = parseRpcQuantity(block.number, 'block number').toString();
  const gasPrice = parseRpcQuantity(await rpc('eth_gasPrice'), 'gas price');
  const baseFee = block.baseFeePerGas == null ? null : parseRpcQuantity(block.baseFeePerGas, 'base fee');
  const result = {
    network, chainId: config.chainId, latestBlock: blockNumber,
    gasPriceGwei: formatGwei(gasPrice),
    baseFeeGwei: baseFee === null ? null : formatGwei(baseFee),
  };
  if (safeAddress !== undefined) {
    const code = await rpc('eth_getCode', [safeAddress, 'latest']);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) {
      throw new Error('No valid deployed contract code found at the supplied address.');
    }
    // nonce() -> 0xaffed0e0; this is eth_call only, never signing or execution.
    const nonce = parseSafeNonce(await rpc('eth_call', [{ to: safeAddress, data: '0xaffed0e0' }, 'latest']));
    result.safeNonce = {
      address: safeAddress, nonce,
      note: 'Read-only nonce() call; this does not verify that the contract is a Safe. No multisig transaction was signed or executed.',
    };
  }
  return result;
}

// A deliberately conservative subset of valid Git branch names, suitable for CLI arguments and refs.
export function validateGitBranch(branch) {
  if (typeof branch !== 'string' || branch.length > 200 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch === 'HEAD' ||
      branch.includes('..') || branch.endsWith('.') || branch.endsWith('/') ||
      branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new Error('Invalid branch name. Use a conservative Git branch name without option prefixes or special characters.');
  }
  return branch;
}

export function githubRepoFromRemote(remote) {
  if (typeof remote !== 'string') throw new Error('The origin remote must be a GitHub repository.');
  let path;
  const scp = /^git@github\.com:([^?#]+)$/.exec(remote);
  if (scp) {
    path = scp[1];
  } else {
    let url;
    try { url = new URL(remote); } catch { throw new Error('The origin remote must be a GitHub repository.'); }
    if (url.hostname !== 'github.com' || url.port || url.password || url.search || url.hash ||
        !((url.protocol === 'https:' && !url.username) || (url.protocol === 'ssh:' && url.username === 'git'))) {
      throw new Error('The origin remote must be a github.com HTTPS or Git SSH URL without credentials.');
    }
    path = url.pathname.replace(/^\//, '');
  }
  path = path.replace(/\.git$/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+$/.test(path)) {
    throw new Error('The origin remote has an invalid GitHub owner/repository path.');
  }
  const [owner, name] = path.split('/');
  if (owner.endsWith('-') || name === '.' || name === '..') {
    throw new Error('The origin remote has an invalid GitHub owner/repository path.');
  }
  return path;
}

export async function runCommand(file, args, { cwd = REPO_ROOT, timeout = 15_000 } = {}) {
  // Explicit executable and argument vector: never pass user input through a shell.
  return execFileAsync(file, args, {
    cwd, timeout, maxBuffer: MAX_COMMAND_OUTPUT, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
  });
}

function commandFailure(phase, error) {
  const detail = error?.killed ? 'timed out' : error?.code === 'ENOENT' ? 'executable not found' : 'failed';
  return new Error(`${phase} ${detail}.`);
}

export async function forgeBuildAndTest({ run = runCommand } = {}) {
  const results = [];
  for (const [phase, args] of [['build', ['build']], ['test', ['test', '-vvv']]]) {
    try {
      const { stdout = '', stderr = '' } = await run('forge', args, { cwd: REPO_ROOT, timeout: 120_000 });
      results.push({ phase, stdout, stderr });
    } catch (error) {
      return { success: false, phase, message: commandFailure(`forge ${phase}`, error).message,
        stdout: typeof error?.stdout === 'string' ? error.stdout : '',
        stderr: typeof error?.stderr === 'string' ? error.stderr : '', results };
    }
  }
  return { success: true, results, note: 'Build and tests are not a security audit or deployment verification.' };
}

function validatePrText(title, body) {
  if (typeof title !== 'string' || title.trim().length < 5 || title.length > 200 || /[\r\n\0]/.test(title)) {
    throw new Error('PR title must contain 5–200 characters on one line.');
  }
  if (typeof body !== 'string' || body.trim().length < 10 || body.length > 20_000 || body.includes('\0')) {
    throw new Error('PR body must contain 10–20000 characters.');
  }
}

async function git(run, args, timeout = 15_000) {
  try { return (await run('git', args, { cwd: REPO_ROOT, timeout })).stdout ?? ''; }
  catch (error) { throw commandFailure('Git operation', error); }
}

async function requireCleanTree(run) {
  const status = await git(run, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  if (status) throw new Error('PR creation requires a clean tree, including tracked and untracked changes.');
  // Ignored files such as node_modules are not staged or pushed by this tool.
  const flags = await git(run, ['ls-files', '-v', '-z']);
  if (flags.split('\0').filter(Boolean).some((entry) => !entry.startsWith('H '))) {
    throw new Error('PR creation rejects assume-unchanged, skip-worktree, or other nonstandard index flags.');
  }
  const staged = await git(run, ['ls-files', '--stage', '-z']);
  // Do not silently overlook ignored untracked files inside nested repositories.
  if (staged.split('\0').some((entry) => entry.startsWith('160000 '))) {
    throw new Error('PR creation does not support repositories containing Git submodules.');
  }
}

async function branchSnapshot(run, branch) {
  const current = (await git(run, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  if (current !== branch) throw new Error('The requested head branch must be the currently checked-out branch.');
  const oid = (await git(run, ['rev-parse', '--verify', 'HEAD'])).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) throw new Error('Git returned an invalid HEAD object ID.');
  return oid.toLowerCase();
}

// Opens a PR only; does not create/switch branches, stage, commit, or push.
// Calling this function performs network operations and requires gh authentication.
export async function createPullRequest({ branchName, baseBranch = 'main', title, body }, { run = runCommand } = {}) {
  validateGitBranch(branchName);
  validateGitBranch(baseBranch);
  if (branchName === baseBranch) throw new Error('Head and base branch must differ.');
  validatePrText(title, body);
  await requireCleanTree(run);
  const oid = await branchSnapshot(run, branchName);
  const origin = (await git(run, ['remote', 'get-url', 'origin'])).trim();
  const repo = githubRepoFromRemote(origin);
  let remoteOid;
  try {
    // gh uses its GitHub API credentials, even when origin is an SSH URL. No Git SSH key is used.
    ({ stdout: remoteOid = '' } = await run('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
      `repos/${repo}/git/ref/heads/${branchName}`, '--jq', '.object.sha'], { cwd: REPO_ROOT, timeout: 30_000 }));
  } catch (error) {
    throw commandFailure('GitHub head branch lookup', error);
  }
  if (remoteOid.trim().toLowerCase() !== oid) {
    throw new Error('GitHub head branch must already exist and exactly match the local HEAD; this tool does not push.');
  }
  await requireCleanTree(run);
  if (await branchSnapshot(run, branchName) !== oid) throw new Error('HEAD changed while checking the PR.');
  let stdout;
  try {
    ({ stdout = '' } = await run('gh', ['pr', 'create', '--repo', `github.com/${repo}`,
      '--head', branchName, '--base', baseBranch, '--title', title, '--body', body],
    { cwd: REPO_ROOT, timeout: 60_000 }));
  } catch (error) {
    // A timeout/failure can occur after GitHub created the PR. Do not blindly retry.
    throw new Error(`${commandFailure('GitHub PR creation', error).message} Check GitHub before retrying; a PR may already exist.`);
  }
  const prUrl = stdout.trim();
  const expected = new RegExp(`^https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/[0-9]+$`, 'i');
  if (!expected.test(prUrl)) throw new Error('GitHub returned an unexpected result; check for an existing PR before retrying.');
  return { url: prUrl, repository: repo, head: branchName, base: baseBranch, commit: oid };
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(error) {
  return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Operation failed.' }] };
}

export async function createServer() {
  // Lazy imports keep pure helpers/testability independent of installed SDK dependencies.
  const [{ McpServer }, { z }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'), import('zod'),
  ]);
  const server = new McpServer({ name: 'vfv-base-architect', version: '1.0.0' });
  server.registerTool('inspect_base_chain', {
    description: 'Read Base mainnet or Sepolia block/gas telemetry and optionally a contract nonce(). This is read-only; it neither validates a Safe nor signs or executes transactions.',
    inputSchema: { network: z.enum(['mainnet', 'sepolia']).default('mainnet'), safeAddress: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
    async (args) => { try { return toolResult(await inspectBaseChain(args)); } catch (error) { return toolError(error); } });
  server.registerTool('forge_build_and_test', {
    description: 'Run forge build, then forge test -vvv in the repository. Passing tests do not constitute an audit.', inputSchema: {},
  },
    async () => { try { const result = await forgeBuildAndTest(); return { ...toolResult(result), ...(result.success ? {} : { isError: true }) }; } catch (error) { return toolError(error); } });
  server.registerTool('gh_autonomous_pr', {
    description: 'Open a GitHub PR for the clean, currently checked-out, already-pushed origin branch. Rejects non-ignored untracked files, hidden index changes, and submodules. Requires network access and gh authentication; never creates a branch, stages, commits, or pushes.',
    inputSchema: { branchName: z.string(), baseBranch: z.string().default('main'), title: z.string(), body: z.string() },
  },
    async (args) => { try { return toolResult(await createPullRequest(args)); } catch (error) { return toolError(error); } });
  return server;
}

async function main() {
  const [{ StdioServerTransport }, server] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/stdio.js'), createServer(),
  ]);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Base MCP server failed to start: ${error.message}`);
    process.exitCode = 1;
  });
}
