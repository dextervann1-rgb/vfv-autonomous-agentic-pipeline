import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  REPO_ROOT, validateNetwork, rpcUrlForNetwork, validateSafeAddress,
  parseRpcQuantity, formatGwei, parseSafeNonce, makeRpcClient, inspectBaseChain,
  validateGitBranch, githubRepoFromRemote, forgeBuildAndTest, createPullRequest,
} from '../mcp/base-mcp-server.mjs';

const ADDRESS = `0x${'1'.repeat(40)}`;
const OID = 'a'.repeat(40);
const PR = { branchName: 'agent/example', baseBranch: 'main', title: 'Test $(not a shell)', body: 'A useful PR description.\n--literal' };

function mockRunner(overrides = {}) {
  const calls = [];
  let statusCount = 0;
  let headCount = 0;
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    if (overrides.failOn === `${file} ${args[0]}`) throw Object.assign(new Error('private detail'), { code: 1 });
    if (file === 'forge') return { stdout: `forge ${args[0]} ok`, stderr: '' };
    if (file === 'gh' && args[0] === 'api') return { stdout: `${overrides.remoteOid ?? OID}\n` };
    if (file === 'gh' && args[0] === 'pr') return { stdout: 'https://github.com/example/repo/pull/7\n', stderr: '' };
    assert.equal(file, 'git');
    if (args[0] === 'status') return { stdout: (++statusCount === 1 ? overrides.status : overrides.laterStatus) ?? '' };
    if (args[0] === 'ls-files' && args.includes('--others')) return { stdout: overrides.untracked ?? '' };
    if (args[0] === 'ls-files' && args.includes('-v')) return { stdout: overrides.flags ?? 'H tracked.txt\0' };
    if (args[0] === 'ls-files' && args.includes('--stage')) return { stdout: overrides.staged ?? `100644 ${OID} 0\ttracked.txt\0` };
    if (args[0] === 'symbolic-ref') return { stdout: `${overrides.currentBranch ?? PR.branchName}\n` };
    if (args[0] === 'rev-parse') return { stdout: `${++headCount === 1 ? OID : (overrides.laterOid ?? OID)}\n` };
    if (args[0] === 'remote') return { stdout: `${overrides.origin ?? 'https://github.com/example/repo.git'}\n` };
    assert.fail(`Unexpected mock command ${file} ${args.join(' ')}`);
  };
  return { calls, run };
}

test('validates network and RPC overrides without exposing credentials', () => {
  assert.equal(validateNetwork('mainnet').chainId, 8453);
  assert.equal(validateNetwork('sepolia').chainId, 84532);
  for (const name of ['base', 'BASE', '', '__proto__', null, undefined]) assert.throws(() => validateNetwork(name));
  assert.equal(rpcUrlForNetwork('mainnet', {}), 'https://mainnet.base.org/');
  assert.equal(rpcUrlForNetwork('sepolia', { BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:8545/' }), 'http://127.0.0.1:8545/');
  for (const url of ['file:///etc/passwd', 'https://user:secret@example.com', 'https://example.com/#fragment', 'not-a-url']) {
    assert.throws(() => rpcUrlForNetwork('mainnet', { BASE_RPC_URL: url }), (error) => !error.message.includes('secret'));
  }
});

test('validates quantities, addresses, ABI nonce and precise gwei formatting', () => {
  assert.equal(validateSafeAddress(ADDRESS), ADDRESS);
  for (const address of ['', '0x1234', `0x${'0'.repeat(40)}`, `0x${'g'.repeat(40)}`]) assert.throws(() => validateSafeAddress(address));
  assert.equal(parseRpcQuantity('0x2105'), 8453n);
  for (const q of ['0x', '0x00', '1', '-0x1', '0xzz', `0x1${'0'.repeat(64)}`]) assert.throws(() => parseRpcQuantity(q));
  assert.equal(formatGwei(0n), '0');
  assert.equal(formatGwei(1n), '0.000000001');
  assert.equal(formatGwei(1_123_450_000n), '1.12345');
  assert.equal(formatGwei(10n ** 27n), '1000000000000000000');
  assert.throws(() => formatGwei(-1n));
  assert.equal(parseSafeNonce(`0x${'0'.repeat(63)}f`), '15');
  for (const response of ['0xf', '0x', `0x${'0'.repeat(65)}`]) assert.throws(() => parseSafeNonce(response));
});

test('RPC client forms bounded JSON-RPC requests and sanitizes errors', async () => {
  let request;
  const rpc = makeRpcClient('https://example.invalid/key', { fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), { status: 200 });
  } });
  assert.equal(await rpc('eth_chainId'), '0x1');
  assert.deepEqual(JSON.parse(request.options.body), { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
  assert.equal(request.options.method, 'POST');
  assert.ok(request.options.signal instanceof AbortSignal);
  const bad = makeRpcClient('https://example.invalid/secret', { fetchImpl: async () => new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'secret' } }), { status: 200 }) });
  await assert.rejects(bad('eth_chainId'), (e) => !e.message.includes('secret'));
  const huge = makeRpcClient('https://example.invalid/', { fetchImpl: async () => new Response('x'.repeat(1_000_001)) });
  await assert.rejects(huge('eth_chainId'), /too large/);
  const fail = makeRpcClient('https://example.invalid/secret', { fetchImpl: async () => { throw new Error('secret'); } });
  await assert.rejects(fail('eth_chainId'), (e) => !e.message.includes('secret'));
});

test('telemetry checks chain ID before any other call and handles unknown fee', async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === 'eth_chainId') return '0x14a34'; // 84532
    if (method === 'eth_getBlockByNumber') return { number: '0x64', baseFeePerGas: null };
    if (method === 'eth_gasPrice') return '0x3b9aca01';
    assert.fail(`Unexpected method ${method}`);
  };
  const info = await inspectBaseChain({ network: 'sepolia' }, { rpc });
  assert.deepEqual(info, { network: 'sepolia', chainId: 84532, latestBlock: '100', gasPriceGwei: '1.000000001', baseFeeGwei: null });
  assert.equal(calls[0][0], 'eth_chainId');
  assert.deepEqual(calls[1], ['eth_getBlockByNumber', ['latest', false]]);
  const mismatchCalls = [];
  await assert.rejects(inspectBaseChain({ network: 'mainnet' }, { rpc: async (method) => { mismatchCalls.push(method); return '0x14a34'; } }), /chain ID mismatch/);
  assert.deepEqual(mismatchCalls, ['eth_chainId']);
  await assert.rejects(inspectBaseChain({ network: 'invalid' }, { rpc }), /Network must/);
});

test('optional Safe nonce is an eth_call read, with explicit limitations', async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    switch (method) {
      case 'eth_chainId': return '0x2105';
      case 'eth_getBlockByNumber': return { number: '0x1', baseFeePerGas: '0x3b9aca00' };
      case 'eth_gasPrice': return '0x3b9aca00';
      case 'eth_getCode': return '0x6000';
      case 'eth_call': return `0x${'0'.repeat(63)}2`;
      default: assert.fail(`Unexpected method ${method}`);
    }
  };
  const result = await inspectBaseChain({ network: 'mainnet', safeAddress: ADDRESS }, { rpc });
  assert.equal(result.baseFeeGwei, '1');
  assert.equal(result.safeNonce.nonce, '2');
  assert.match(result.safeNonce.note, /does not verify/);
  assert.match(result.safeNonce.note, /No multisig transaction was signed or executed/);
  assert.deepEqual(calls.at(-1), ['eth_call', [{ to: ADDRESS, data: '0xaffed0e0' }, 'latest']]);
  const noCodeRpc = async (method, params) => method === 'eth_getCode' ? '0x' : rpc(method, params);
  await assert.rejects(inspectBaseChain({ safeAddress: ADDRESS }, { rpc: noCodeRpc }), /No valid deployed contract/);
});

test('branch names and GitHub origin URLs use a conservative allowlist', () => {
  for (const branch of ['agent/feature-1', 'main', 'release/1.0', 'a_b']) assert.equal(validateGitBranch(branch), branch);
  for (const branch of ['-force', 'agent/../main', 'a..b', 'a//b', 'a/.hidden', 'a.lock', 'a/b.lock', 'HEAD', 'a@{1}', 'a b', 'a;echo', 'a/', 'a.', '']) {
    assert.throws(() => validateGitBranch(branch), undefined, branch);
  }
  for (const remote of ['https://github.com/example/repo.git', 'git@github.com:example/repo.git', 'ssh://git@github.com/example/repo']) {
    assert.equal(githubRepoFromRemote(remote), 'example/repo');
  }
  for (const remote of ['https://user:secret@github.com/example/repo', 'https://evil.test/example/repo', 'file:///tmp/x', 'git@github.com:example/..', 'https://github.com/example/repo?token=x']) {
    assert.throws(() => githubRepoFromRemote(remote));
  }
});

test('Foundry runs build then test and stops on failed build', async () => {
  const mock = mockRunner();
  const result = await forgeBuildAndTest({ run: mock.run });
  assert.equal(result.success, true);
  assert.deepEqual(mock.calls.map((x) => x.args), [['build'], ['test', '-vvv']]);
  assert.ok(mock.calls.every((x) => x.options.timeout === 120_000));
  assert.match(result.note, /not a security audit/);
  const failed = mockRunner({ failOn: 'forge build' });
  const failure = await forgeBuildAndTest({ run: failed.run });
  assert.equal(failure.success, false);
  assert.equal(failure.phase, 'build');
  assert.equal(failed.calls.length, 1);
  assert.doesNotMatch(failure.message, /private detail/);
});

test('PR tool only opens a PR for an existing matching branch without write commands', async () => {
  const mock = mockRunner();
  const result = await createPullRequest(PR, { run: mock.run });
  assert.deepEqual(result, { url: 'https://github.com/example/repo/pull/7', repository: 'example/repo', head: 'agent/example', base: 'main', commit: OID });
  assert.equal(mock.calls.filter((x) => x.args[0] === 'status').length, 2);
  assert.equal(mock.calls.filter((x) => x.args[0] === 'ls-files').length, 4);
  assert.ok(!mock.calls.some((x) => x.args.includes('--others')));
  assert.ok(mock.calls.every((x) => x.options.timeout > 0 && x.options.cwd === REPO_ROOT));
  assert.ok(mock.calls.every((x) => !['add', 'commit', 'push', 'checkout', 'switch'].includes(x.args[0])));
  const lookup = mock.calls.find((call) => call.file === 'gh' && call.args[0] === 'api');
  assert.deepEqual(lookup.args, ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/example/repo/git/ref/heads/agent/example', '--jq', '.object.sha']);
  const gh = mock.calls.at(-1);
  assert.equal(gh.file, 'gh');
  assert.deepEqual(gh.args, ['pr', 'create', '--repo', 'github.com/example/repo', '--head', 'agent/example', '--base', 'main', '--title', PR.title, '--body', PR.body]);
});

test('PR preconditions fail closed on dirty, changed, and mismatched branches', async () => {
  const scenarios = [
    [{ status: ' M tracked\0' }, /clean tree/],
    [{ status: '?? untracked\0' }, /clean tree/],
    [{ flags: 'h tracked.txt\0' }, /assume-unchanged/],
    [{ flags: 'S tracked.txt\0' }, /skip-worktree/],
    [{ staged: `160000 ${OID} 0\tlib/submodule\0` }, /submodules/],
    [{ currentBranch: 'other' }, /currently checked-out/],
    [{ origin: 'https://evil.test/o/r' }, /github.com/],
    [{ remoteOid: 'b'.repeat(40) }, /exactly match/],
    [{ failOn: 'gh api' }, /GitHub head branch lookup/],
    [{ laterStatus: ' M tracked\0' }, /clean tree/],
    [{ laterOid: 'c'.repeat(40) }, /HEAD changed/],
  ];
  for (const [overrides, error] of scenarios) {
    const mock = mockRunner(overrides);
    await assert.rejects(createPullRequest(PR, { run: mock.run }), error);
    assert.ok(!mock.calls.some((call) => call.file === 'gh' && call.args[0] === 'pr'));
  }
  const mock = mockRunner();
  await assert.rejects(createPullRequest({ ...PR, branchName: '--force' }, { run: mock.run }), /Invalid branch/);
  assert.equal(mock.calls.length, 0);
  await assert.rejects(createPullRequest({ ...PR, baseBranch: PR.branchName }, { run: mock.run }), /must differ/);
});

test('gh failures warn against blind retry after possible remote creation', async () => {
  const mock = mockRunner({ failOn: 'gh pr' });
  await assert.rejects(createPullRequest(PR, { run: mock.run }), /Check GitHub before retrying/);
});

test('local config contains only the MCP server and no environment interpolation', async () => {
  const config = JSON.parse(await readFile(new URL('../mcp/mcp-config.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(config.mcpServers), ['vfv-base-architect']);
  assert.deepEqual(config.mcpServers['vfv-base-architect'], { command: 'node', args: ['/absolute/path/to/vfv-autonomous-agentic-pipeline/mcp/base-mcp-server.mjs'] });
});

test('SDK 1.32 and Zod 4 expose the three tools over stdio without external calls', async () => {
  const client = new Client({ name: 'local-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [`${REPO_ROOT}/mcp/base-mcp-server.mjs`], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['forge_build_and_test', 'gh_autonomous_pr', 'inspect_base_chain']);
    const inspect = tools.find((tool) => tool.name === 'inspect_base_chain');
    assert.equal(inspect.annotations.readOnlyHint, true);
    assert.deepEqual(inspect.inputSchema.properties.network.enum, ['mainnet', 'sepolia']);
    const invalidNetwork = await client.callTool({ name: 'inspect_base_chain', arguments: { network: 'not-base' } });
    assert.equal(invalidNetwork.isError, true);
    const invalidBranch = await client.callTool({ name: 'gh_autonomous_pr', arguments: { ...PR, branchName: '--force' } });
    assert.equal(invalidBranch.isError, true);
    assert.match(invalidBranch.content[0].text, /Invalid branch/);
  } finally {
    await client.close();
  }
});
