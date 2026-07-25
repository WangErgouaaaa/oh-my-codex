import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ralplanCommand, type RalplanCommandDependencies } from '../ralplan.js';

async function invoke(args: string[], deps: RalplanCommandDependencies = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, { ...deps, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previous;
  }
}

describe('#3194 ralplan CLI documented leader-proof surface', () => {
  it('describes current documented leader-proof support without naming a stale Codex version', async () => {
    const result = await invoke(['--help']);
    assert.match(result.stdout.join('\n'), /Codex app-server documents the current thread as the session-tree root/);
    assert.doesNotMatch(result.stdout.join('\n'), /Codex 0\.144\.5/);
  });

  it('fails the explicit adapted-surface preflight and neutralizes routing-only Ralplan state', async () => {
    let resolved = false;
    let cancelled = false;
    const result = await invoke(['preflight', '--json'], {
      resolveInstalledRoleName: () => { resolved = true; return 'architect'; },
      cancelRalplan: async () => { cancelled = true; },
      verifyDocumentedLeader: async () => ({
        ok: false,
        reason: 'unsupported_documented_leader_proof',
      }),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(resolved, false);
    assert.equal(cancelled, true);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' });
  });

  it('accepts a current root proven by the documented Codex app-server thread tree', async () => {
    let cancelled = false;
    const result = await invoke(['preflight', '--json'], {
      verifyDocumentedLeader: async () => ({
        ok: true,
        proof: 'codex_app_server_thread_tree',
      }),
      cancelRalplan: async () => { cancelled = true; },
    });
    assert.equal(result.exitCode, undefined);
    assert.equal(cancelled, false);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), {
      ok: true,
      proof: 'codex_app_server_thread_tree',
    });
  });

  it('validates malformed arguments before resolving a role', async () => {
    let resolved = false;
    await assert.rejects(() => invoke(['role-intent', 'write', '--role', 'architect', '--json'], {
      resolveInstalledRoleName: () => { resolved = true; return 'architect'; },
    }), /Missing --parent-thread/);
    assert.equal(resolved, false);
  });

  it('returns unknown_role for a syntactically valid uninstalled role', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'synthetic-unknown', '--parent-thread', 'synthetic-parent', '--json'], {
      resolveInstalledRoleName: () => null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unknown_role' });
  });

  it('denies installed roles before any runtime state dependency is consulted', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'architect', '--parent-thread', 'synthetic-parent', '--session', 'synthetic-session', '--ttl-ms', '1', '--json'], {
      resolveInstalledRoleName: (role) => role.toLowerCase() === 'architect' ? 'architect' : null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' });
  });
});
