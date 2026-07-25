import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { resolveInstalledRoleName } from '../subagents/tracker.js';
import { spawnPlatformCommand } from '../utils/platform-command.js';

export const UNSUPPORTED_DOCUMENTED_LEADER_PROOF = 'unsupported_documented_leader_proof' as const;
export const CODEX_APP_SERVER_THREAD_TREE_PROOF = 'codex_app_server_thread_tree' as const;

export type DocumentedLeaderProof =
  | { ok: true; proof: typeof CODEX_APP_SERVER_THREAD_TREE_PROOF }
  | { ok: false; reason: typeof UNSUPPORTED_DOCUMENTED_LEADER_PROOF };

export const UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE = Object.freeze({
  hookSpecificOutput: Object.freeze({
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'unsupported_documented_leader_proof: current Codex hooks do not expose documented root identity required for adapted Ralplan.',
  }),
});

export const UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE = Object.freeze({
  hookSpecificOutput: Object.freeze({
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Ralplan role-intent denied: unknown_role.',
  }),
});

type UnsupportedDocumentedLeaderPreToolUse = Readonly<{
  hookSpecificOutput: Readonly<{
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  }>;
}>;

type PreToolUseDenial = UnsupportedDocumentedLeaderPreToolUse
  | typeof UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE;

export interface Codex01445PreToolUseDependencies {
  resolveInstalledRoleName: typeof resolveInstalledRoleName;
  platform: NodeJS.Platform;
}

const defaultDependencies: Codex01445PreToolUseDependencies = {
  resolveInstalledRoleName,
  platform: process.platform,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isDocumentedRootThread(value: unknown, threadId: string): boolean {
  if (!isRecord(value)) return false;
  const source = value.source;
  return value.id === threadId
    && value.sessionId === threadId
    && value.parentThreadId === null
    && !(isRecord(source) && Object.hasOwn(source, 'subAgent'));
}

/**
 * Codex app-server 0.145+ documents `sessionId` as the shared session-tree id
 * and `parentThreadId` as subagent-only. Querying that protocol avoids using
 * tmux, pointers, transcripts, cwd, or version numbers as identity evidence.
 */
export async function verifyCodexDocumentedLeader(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DocumentedLeaderProof> {
  const threadId = String(env.CODEX_THREAD_ID ?? '').trim();
  const unsupported = (): DocumentedLeaderProof => ({
    ok: false,
    reason: UNSUPPORTED_DOCUMENTED_LEADER_PROOF,
  });
  if (!threadId) return unsupported();

  return await new Promise<DocumentedLeaderProof>((resolveProof) => {
    const { child: rawChild } = spawnPlatformCommand('codex', ['app-server', '--stdio'], {
      env,
      stdio: 'pipe',
      windowsHide: true,
    });
    const child = rawChild as ChildProcessWithoutNullStreams;
    let stdout = '';
    let settled = false;

    const finish = (proof: DocumentedLeaderProof): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!child.stdin.destroyed) child.stdin.end();
      const cleanup = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 250);
      cleanup.unref();
      resolveProof(proof);
    };
    const write = (envelope: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(envelope)}\n`, 'utf8', (error) => {
        if (error) finish(unsupported());
      });
    };
    const timeout = setTimeout(() => finish(unsupported()), 3_000);

    child.once('error', () => finish(unsupported()));
    child.once('close', () => finish(unsupported()));
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1_048_576) {
        finish(unsupported());
        return;
      }
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let envelope: unknown;
        try {
          envelope = JSON.parse(line);
        } catch {
          finish(unsupported());
          return;
        }
        if (!isRecord(envelope)) continue;
        if (envelope.id === 1 && Object.hasOwn(envelope, 'result')) {
          write({ method: 'initialized', params: {} });
          write({
            id: 2,
            method: 'thread/read',
            params: { threadId, includeTurns: false },
          });
          continue;
        }
        if (envelope.id !== 2) continue;
        const result = isRecord(envelope.result) ? envelope.result : undefined;
        const thread = result?.thread;
        finish(isDocumentedRootThread(thread, threadId)
          ? { ok: true, proof: CODEX_APP_SERVER_THREAD_TREE_PROOF }
          : unsupported());
        return;
      }
    });
    child.once('spawn', () => {
      write({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'omx-ralplan-preflight',
            title: 'OMX Ralplan preflight',
            version: '1.0.0',
          },
          capabilities: { experimentalApi: true },
        },
      });
    });
  });
}

function readCommand(payload: Record<string, unknown>): string | undefined {
  if (payload.tool_name !== 'Bash') return undefined;
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return undefined;
  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === 'string' ? command : undefined;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readCodexVersion(payload: Record<string, unknown>): string {
  const raw = readString(payload.codex_version)
    || readString(payload.codexVersion)
    || readString(payload.codex_cli_version)
    || readString(payload.codexCliVersion)
    || readString(payload.cli_version)
    || readString(payload.cliVersion)
    || readString((payload.codex as Record<string, unknown> | undefined)?.version)
    || readString((payload.cli as Record<string, unknown> | undefined)?.version);
  const match = raw.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? '';
}

function unsupportedLeaderPreToolUseForPayload(payload: Record<string, unknown>): UnsupportedDocumentedLeaderPreToolUse {
  const version = readCodexVersion(payload);
  if (!version) return UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `unsupported_documented_leader_proof: Codex ${version} hooks do not expose documented root identity required for adapted Ralplan.`,
    },
  };
}

/**
 * Recognize only the canonical standalone adapted role-intent invocation. The
 * environment placeholder is matched lexically and is never expanded or used
 * as authority. Wrappers, assignments, compounds, redirects, duplicate flags,
 * alternate ordering, and malformed commands deliberately fall through to the
 * CLI parser.
 */
export function parseCodex01445AdaptedRoleIntentCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { role: string } | null {
  const parentPlaceholder = platform === 'win32'
    ? '"%CODEX_THREAD_ID%"'
    : '"$CODEX_THREAD_ID"';
  const escapedPlaceholder = parentPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^omx ralplan role-intent write --role ([A-Za-z0-9_-]{1,64}) --parent-thread ${escapedPlaceholder} --json$`,
  );
  const match = command.match(pattern);
  return match?.[1] ? { role: match[1] } : null;
}

export function evaluateCodex01445PreToolUse(
  payload: Record<string, unknown>,
  overrides: Partial<Codex01445PreToolUseDependencies> = {},
): PreToolUseDenial | undefined {
  const command = readCommand(payload);
  if (!command) return undefined;
  const dependencies = { ...defaultDependencies, ...overrides };
  const parsed = parseCodex01445AdaptedRoleIntentCommand(command, dependencies.platform);
  if (!parsed) return undefined;
  return dependencies.resolveInstalledRoleName(parsed.role)
    ? unsupportedLeaderPreToolUseForPayload(payload)
    : UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE;
}
