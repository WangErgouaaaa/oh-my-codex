/**
 * Dynamic worker scaling for team mode — Phase 1: Manual Scaling.
 *
 * Provides scale_up (add workers mid-session) and scale_down (drain + remove idle workers).
 * Gated behind the OMX_TEAM_SCALING_ENABLED environment variable.
 *
 * Key design decisions:
 * - Monotonic worker index counter (next_worker_index in config) ensures unique names
 * - File-based scaling lock prevents concurrent scale operations
 * - 'draining' worker status for graceful transitions during scale_down
 */

import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { mkdir, rm } from 'fs/promises';
import {
  sanitizeTeamName,
  isTmuxAvailable,
  waitForWorkerReady,
  dismissTrustPromptIfPresent,
  sendToWorker,
  isWorkerAlive,
  teardownWorkerPanes,
  buildWorkerStartupCommand,
  trustWorkerMiseConfigIfAvailable,
  writeWorkerStartupScriptCommand,
  resolveTeamWorkerCliForResolvedLaunchArgs,
  assertTeamWorkerCliPolicyCompatibility,
  tagPaneTeamOwner,
  isNativeWindows,
  type TeamWorkerCli,
} from './tmux-session.js';
import { spawnSync } from 'child_process';
import {
  teamReadConfig as readTeamConfig,
  teamSaveConfig as saveTeamConfig,
  teamWriteWorkerIdentity as writeWorkerIdentity,
  teamReadManifest as readTeamManifestV2,
  teamNormalizePolicy as normalizeTeamPolicy,
  teamReadWorkerStatus as readWorkerStatus,
  teamWriteWorkerStatus as writeWorkerStatus,
  teamWithScalingLock as withScalingLock,
  teamAppendEvent as appendTeamEvent,
  teamCreateTask as createStateTask,
  teamListTasks as listTasks,
  teamMarkDispatchRequestNotified as markDispatchRequestNotified,
  teamReadDispatchRequest as readDispatchRequest,
  teamTransitionDispatchRequest as transitionDispatchRequest,
  type TeamConfig,
  type TeamTask,
  type WorkerInfo,
  type WorkerStatus,
} from './team-ops.js';
import {
  queueInboxInstruction,
  waitForDispatchReceipt,
  type DispatchOutcome,
} from './mcp-comm.js';
import {
  generateInitialInbox,
  buildTriggerDirective,
  writeWorkerRoleInstructionsFile,
  writeWorkerWorktreeRootAgentsFile,
  removeWorkerWorktreeRootAgentsFile,
} from './worker-bootstrap.js';
import { buildTeamWorkerGoalInstruction } from './goal-workflow.js';
import { loadRolePrompt } from './role-router.js';
import { composeRoleInstructionsForRole } from '../agents/native-config.js';
import { codexPromptsDir } from '../utils/paths.js';
import { resolveCodexHomeForLaunch } from '../cli/codex-home.js';
import {
  parseTeamWorkerLaunchArgs,
  resolveTeamWorkerLaunchArgs,
  resolveAgentDefaultModel,
  resolveAgentReasoningEffort,
  shouldHonorAgentExactModel,
  TEAM_WORKER_INHERITED_MODEL_ENV,
  type TeamReasoningEffort,
} from './model-contract.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';
import {
  ensureWorktree,
  planWorktreeTarget,
  rollbackProvisionedWorktrees,
  type EnsureWorktreeResult,
  type WorktreeMode,
} from './worktree.js';
import {
  buildApprovedTeamHandoffSection,
  resolvePersistedApprovedTeamExecutionContinuityState,
  type PersistedApprovedTeamExecutionContinuityState,
} from './approved-execution.js';
import {
  readPersistedTeamUltragoalContext,
  renderLeaderOwnedUltragoalContextSection,
} from './ultragoal-context.js';
import {
  parseCanonicalTmuxPaneId,
  parseExactTmuxAuthorityLines,
  parseExactTmuxAuthorityScalar,
} from '../hud/tmux.js';

// ── Environment gate ──────────────────────────────────────────────────────────

const OMX_TEAM_SCALING_ENABLED_ENV = 'OMX_TEAM_SCALING_ENABLED';
const WORKTREE_TRIGGER_STATE_ROOT = '$OMX_TEAM_STATE_ROOT';

export function isScalingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OMX_TEAM_SCALING_ENABLED_ENV];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
}

function assertScalingEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!isScalingEnabled(env)) {
    throw new Error(
      `Dynamic scaling is disabled. Set ${OMX_TEAM_SCALING_ENABLED_ENV}=1 to enable.`,
    );
  }
}

function joinContextSections(...sections: Array<string | undefined>): string | undefined {
  const present = sections.filter((section): section is string => Boolean(section?.trim()));
  return present.length > 0 ? present.join('\n\n') : undefined;
}

interface PersistedTeamPaneIds {
  leaderPaneId: string | null;
  hudPaneId: string | null;
  paneIds: Set<string>;
  workerPaneIds: Map<WorkerInfo, string>;
}

function parsePersistedTmuxPaneId(rawPaneId: unknown): string | null | undefined {
  if (rawPaneId === null || rawPaneId === undefined) return null;
  if (typeof rawPaneId !== 'string') return undefined;
  if (rawPaneId.trim() === '') return null;
  return parseCanonicalTmuxPaneId(rawPaneId) ?? undefined;
}

function canonicalizePersistedTeamPaneIds(config: TeamConfig): PersistedTeamPaneIds | null {
  const leaderPaneId = parsePersistedTmuxPaneId(config.leader_pane_id);
  const hudPaneId = parsePersistedTmuxPaneId(config.hud_pane_id);
  if (leaderPaneId === undefined || hudPaneId === undefined) return null;

  const paneIds = new Set<string>();
  const addPaneId = (paneId: string | null): boolean => {
    if (!paneId) return true;
    if (paneIds.has(paneId)) return false;
    paneIds.add(paneId);
    return true;
  };
  if (!addPaneId(leaderPaneId) || !addPaneId(hudPaneId)) return null;

  const workerPaneIds = new Map<WorkerInfo, string>();
  for (const worker of config.workers) {
    const paneId = parsePersistedTmuxPaneId(worker.pane_id);
    if (paneId === undefined || !addPaneId(paneId)) return null;
    if (paneId) workerPaneIds.set(worker, paneId);
  }

  return { leaderPaneId, hudPaneId, paneIds, workerPaneIds };
}

function parseFreshTmuxPaneId(rawOutput: string | null | undefined): string | null {
  const paneId = typeof rawOutput === 'string' ? parseExactTmuxAuthorityScalar(rawOutput) : null;
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  return canonicalPaneId === paneId ? canonicalPaneId : null;
}

function deriveSingleScaleSplitPaneId(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): string | null {
  if (after.size !== before.size + 1 || ![...before].every((paneId) => after.has(paneId))) return null;
  const created = [...after].filter((paneId) => !before.has(paneId));
  return created.length === 1 ? created[0] ?? null : null;
}


function readGlobalTmuxPaneIdSnapshot(): Set<string> | null {
  const result = spawnSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_dead} #{pane_pid}'], { encoding: 'utf-8' });
  if (result.status !== 0 || result.error) return null;

  const lines = parseExactTmuxAuthorityLines(result.stdout || '');
  if (!lines) return null;
  const paneIds = new Set<string>();
  const seenPaneIds = new Set<string>();
  for (const line of lines) {
    const match = /^(\S+) ([01]) ([0-9]+)$/.exec(line);
    const paneId = parseCanonicalTmuxPaneId(match?.[1]);
    if (!match || !paneId || paneId !== match[1] || !Number.isSafeInteger(Number(match[3])) || seenPaneIds.has(paneId)) return null;
    seenPaneIds.add(paneId);
    // remain-on-exit panes are not live authority. Their PID may legitimately be 0.
    if (match[2] === '1') continue;
    if (!/^[1-9][0-9]*$/.test(match[3]!)) return null;
    paneIds.add(paneId);
  }
  return paneIds;
}

function readScaleSessionId(paneId: string): string | null {
  const result = spawnSync('tmux', ['display-message', '-p', '-t', paneId, '#{session_id}'], { encoding: 'utf-8' });
  if (result.status !== 0 || result.error) return null;
  const sessionId = parseExactTmuxAuthorityScalar(result.stdout || '');
  return sessionId && /^\$[0-9]+$/.test(sessionId) ? sessionId : null;
}

type TeamPaneOwnerSnapshot = Map<string, string>;

function readTeamPaneOwnerSnapshot(sessionName: string): TeamPaneOwnerSnapshot | null {
  const targetSessionName = sessionName.trim();
  if (!targetSessionName) return null;
  const livePaneIds = readGlobalTmuxPaneIdSnapshot();
  if (!livePaneIds) return null;

  const result = spawnSync(
    'tmux',
    ['list-panes', '-t', targetSessionName, '-F', '#{pane_id}\t#{@omx_team_pane_owner_id}'],
    { encoding: 'utf-8' },
  );
  if (result.status !== 0 || result.error) return null;

  const lines = parseExactTmuxAuthorityLines(result.stdout || '');
  if (!lines) return null;
  const paneOwners: TeamPaneOwnerSnapshot = new Map();
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length !== 2) return null;
    const paneId = parseCanonicalTmuxPaneId(fields[0]);
    if (!paneId || paneId !== fields[0]) return null;
    // The session view can retain canonical remain-on-exit rows. They are not authority.
    if (!livePaneIds.has(paneId)) continue;
    if (paneOwners.has(paneId)) return null;
    paneOwners.set(paneId, fields[1]!);
  }
  return paneOwners;
}

function isConsistentTeamPaneSnapshot(
  globalPaneIds: ReadonlySet<string> | null,
  sessionPaneOwners: TeamPaneOwnerSnapshot | null,
): boolean {
  if (!globalPaneIds || !sessionPaneOwners) return false;
  for (const paneId of sessionPaneOwners.keys()) {
    if (!globalPaneIds.has(paneId)) return false;
  }
  return true;
}

function validatePersistedTeamPaneAuthority(
  config: TeamConfig,
  persistedPaneIds: PersistedTeamPaneIds,
  globalPaneIds: ReadonlySet<string>,
): string | null {
  if (persistedPaneIds.paneIds.size === 0) return '';

  const expectedOwnerId = `team:${config.name}`;
  if (config.tmux_pane_owner_id?.trim() !== expectedOwnerId) return null;

  const sessionPaneOwners = readTeamPaneOwnerSnapshot(config.tmux_session);
  if (!sessionPaneOwners || !isConsistentTeamPaneSnapshot(globalPaneIds, sessionPaneOwners)) return null;
  for (const paneId of persistedPaneIds.paneIds) {
    if (!globalPaneIds.has(paneId) || sessionPaneOwners.get(paneId) !== expectedOwnerId) {
      return null;
    }
  }
  return expectedOwnerId;
}

function isFreshOwnedTeamPane(
  paneId: string,
  sessionName: string,
  expectedOwnerId: string,
): boolean {
  const globalPaneIds = readGlobalTmuxPaneIdSnapshot();
  const sessionPaneOwners = readTeamPaneOwnerSnapshot(sessionName);
  if (!globalPaneIds || !sessionPaneOwners) return false;
  if (!isConsistentTeamPaneSnapshot(globalPaneIds, sessionPaneOwners)) return false;
  return globalPaneIds.has(paneId)
    && sessionPaneOwners.has(paneId)
    && sessionPaneOwners.get(paneId) === expectedOwnerId;
}

type VerifiedScaleSplitPane = {
  paneId: string;
  panePid: string;
  sessionId: string;
  sessionName: string;
  sessionId: string;
  ownerId: string;
  ownerOption: string;
  ownerProof: string;
  ownerTagged: boolean;
  operationMarker: string;
};

const OMX_TMUX_SPLIT_OPERATION_MARKER_ENV = 'OMX_TMUX_SPLIT_OPERATION_MARKER';

function writeScaleSplitOperationMarkedCommand(command: string, marker: string): string {
  if (isNativeWindows()) return `$env:${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV} = '${marker}'; ${command}`;
  return `${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV}='${marker}'; export ${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV}; ${command}`;
}

function hasScaleSplitOperationMarker(command: string, marker: string): boolean {
  const posixMarker = `${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV}='${marker}'`;
  const powerShellMarker = `$env:${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV} = '${marker}'`;
  return command === posixMarker
    || command.startsWith(`${posixMarker};`)
    || command === powerShellMarker
    || command.startsWith(`${powerShellMarker};`);
}

function findScaleSplitOperationMarkerPaneId(marker: string): string | null {
  const livePaneIds = readGlobalTmuxPaneIdSnapshot();
  if (!livePaneIds) return null;
  const result = spawnSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_start_command}'], { encoding: 'utf-8' });
  if (result.status !== 0 || result.error) return null;
  const lines = parseExactTmuxAuthorityLines(result.stdout || '');
  if (!lines) return null;
  let candidate: string | null = null;
  const seenLive = new Set<string>();
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length !== 2) return null;
    const paneId = parseCanonicalTmuxPaneId(fields[0]);
    if (!paneId || paneId !== fields[0]) return null;
    if (!livePaneIds.has(paneId)) continue;
    if (seenLive.has(paneId)) return null;
    seenLive.add(paneId);
    if (!hasScaleSplitOperationMarker(fields[1] ?? '', marker)) continue;
    if (candidate) return null;
    candidate = paneId;
  }
  return candidate;
}
function readTmuxOptionExactly(option: string): string | null {
  const result = spawnSync('tmux', ['show-options', '-g', '-v', option], { encoding: 'utf-8' });
  if (result.status !== 0 || result.error) return null;
  return parseExactTmuxAuthorityScalar(result.stdout || '');
}

function readScaleSessionId(paneId: string): string | null {
  const result = spawnSync('tmux', ['display-message', '-p', '-t', paneId, '#{session_id}'], { encoding: 'utf-8' });
  if (result.status !== 0 || result.error) return null;
  const sessionId = parseExactTmuxAuthorityScalar(result.stdout || '');
  return sessionId && /^\$[0-9]+$/.test(sessionId) ? sessionId : null;
}
function readScalePaneIncarnation(paneId: string): { paneDead: boolean; panePid: string; sessionId: string } | null {
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  if (!canonicalPaneId || canonicalPaneId !== paneId) return null;
  const result = spawnSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_dead} #{pane_pid}'], { encoding: 'utf-8' });
  if (result.status !== 0 || result.error) return null;
  const lines = parseExactTmuxAuthorityLines(result.stdout || '');
  if (!lines) return null;
  const seenPaneIds = new Set<string>();
  let incarnation: { paneDead: boolean; panePid: string; sessionId: string } | null = null;
  for (const line of lines) {
    const match = /^(\S+) ([01]) ([0-9]+)$/.exec(line);
    const observedPaneId = parseCanonicalTmuxPaneId(match?.[1]);
    if (!match || !observedPaneId || observedPaneId !== match[1] || !Number.isSafeInteger(Number(match[3])) || seenPaneIds.has(observedPaneId)) return null;
    seenPaneIds.add(observedPaneId);
    if (match[2] === '1') continue;
    if (!/^[1-9][0-9]*$/.test(match[3]!)) return null;
    if (observedPaneId === canonicalPaneId) {
      const sessionId = readScaleSessionId(canonicalPaneId);
      if (!sessionId) return null;
      incarnation = { paneDead: false, panePid: match[3]!, sessionId };
    }
  }
  return incarnation;
}

function isScalePaneLiveInStrictGlobalProbe(paneId: string, expectedPid?: string): boolean {
  const incarnation = readScalePaneIncarnation(paneId);
  return Boolean(incarnation && !incarnation.paneDead && (!expectedPid || incarnation.panePid === expectedPid));
}

function isScalePaneStablyLive(paneId: string, expectedPid: string): boolean {
  for (let probe = 0; probe < 3; probe += 1) {
    if (!isScalePaneLiveInStrictGlobalProbe(paneId, expectedPid)) return false;
    if (probe < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return true;
}

function hasScaleSplitRollbackAuthority(authority: VerifiedScaleSplitPane): boolean {
  const paneId = parseCanonicalTmuxPaneId(authority.paneId);
  const globalPaneIds = readGlobalTmuxPaneIdSnapshot();
  const sessionPaneOwners = readTeamPaneOwnerSnapshot(authority.sessionName);
  const incarnation = paneId ? readScalePaneIncarnation(paneId) : null;
  return Boolean(
    paneId
      && paneId === authority.paneId
      && findScaleSplitOperationMarkerPaneId(authority.operationMarker) === paneId
      && globalPaneIds?.has(paneId)
      && sessionPaneOwners?.has(paneId)
      && isConsistentTeamPaneSnapshot(globalPaneIds, sessionPaneOwners)
      && incarnation?.panePid === authority.panePid
      && incarnation.sessionId === authority.sessionId
      && readTmuxOptionExactly(authority.ownerOption) === authority.ownerProof,
  );
}

function revalidateScaleSplitAuthority(authority: VerifiedScaleSplitPane): boolean {
  if (!hasScaleSplitRollbackAuthority(authority) || !isScalePaneLiveInStrictGlobalProbe(authority.paneId, authority.panePid)) return false;
  const owners = readTeamPaneOwnerSnapshot(authority.sessionName);
  return Boolean(!authority.ownerTagged || owners?.get(authority.paneId) === authority.ownerId);
}

function buildScaleSplitRollbackCondition(authority: VerifiedScaleSplitPane): string | null {
  if (
    parseCanonicalTmuxPaneId(authority.paneId) !== authority.paneId
    || !/^[1-9][0-9]*$/.test(authority.panePid)
    || !/^\$[0-9]+$/.test(authority.sessionId)
    || !/^team:[A-Za-z0-9_-]+$/.test(authority.ownerId)
    || !/^@omx_scale_split_owner_nonce_[a-f0-9]{32}$/.test(authority.ownerOption)
    || !/^(?:pending:)?(?:%[1-9][0-9]*:)?scale-split:[0-9a-f-]{36}$/.test(authority.ownerProof)
    || !/^[0-9a-f-]{36}$/.test(authority.operationMarker)
  ) return null;
  const ownerCondition = authority.ownerTagged
    ? `#{==:#{@omx_team_pane_owner_id},${authority.ownerId}}`
    : '1';
  return `#{&&:#{==:#{pane_id},${authority.paneId}},#{&&:#{==:#{pane_dead},0},#{&&:#{==:#{pane_pid},${authority.panePid}},#{&&:#{==:#{session_id},${authority.sessionId}},#{&&:${ownerCondition},#{&&:#{==:#{${authority.ownerOption}},${authority.ownerProof}},#{m:*${authority.operationMarker}*,#{pane_start_command}}}}}}}}`;
}

function killScaleSplitPaneAtomically(authority: VerifiedScaleSplitPane): boolean {
  const condition = buildScaleSplitRollbackCondition(authority);
  if (!condition) return false;
  const receipt = `__OMX_PANE_MUTATION_${randomUUID().replaceAll('-', '')}__`;
  const result = spawnSync('tmux', [
    'if-shell', '-F', '-t', authority.paneId,
    condition,
    `kill-pane -t ${authority.paneId} \\; display-message -p ${receipt}`,
    `display-message -p __omx_scale_split_rollback_rejected_${receipt}`,
  ], { encoding: 'utf-8', windowsHide: true });
  return result.status === 0 && !result.error && parseExactTmuxAuthorityScalar(result.stdout || '') === receipt;
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface ScaleUpResult {
  ok: true;
  addedWorkers: WorkerInfo[];
  newWorkerCount: number;
  nextWorkerIndex: number;
}

export interface ScaleDownResult {
  ok: true;
  removedWorkers: string[];
  newWorkerCount: number;
}

export interface ScaleError {
  ok: false;
  error: string;
}

type ScaleUpTaskInput = {
  subject: string;
  description: string;
  owner?: string;
  blocked_by?: string[];
  role?: string;
};

interface ScaleUpWorkerLaunchPlan {
  readonly workerIndex: number;
  readonly workerName: string;
  readonly runtimeRole: string;
  readonly workerLaunchArgs: string[];
  readonly workerCli: TeamWorkerCli;
  readonly mixedTaskRoles: readonly string[];
}

function buildScaleUpWorkerLaunchPlans(params: {
  count: number;
  nextWorkerIndex: number;
  agentType: string;
  existingTasks: readonly Pick<TeamTask, 'owner' | 'role'>[];
  incomingTasks: readonly ScaleUpTaskInput[];
  launchEnv: NodeJS.ProcessEnv;
  codexHomeOverride?: string;
}): readonly ScaleUpWorkerLaunchPlan[] {
  const taskAssignments = [...params.existingTasks, ...params.incomingTasks];
  const plans: ScaleUpWorkerLaunchPlan[] = [];

  for (let offset = 0; offset < params.count; offset += 1) {
    const workerIndex = params.nextWorkerIndex + offset;
    const workerName = `worker-${workerIndex}`;
    const workerTaskRoles = taskAssignments
      .filter((task) => task.owner === workerName)
      .map((task) => task.role)
      .filter((role): role is string => Boolean(role));
    const uniqueTaskRoles = new Set(workerTaskRoles);
    const runtimeRole = workerTaskRoles.length > 0 && uniqueTaskRoles.size === 1
      ? workerTaskRoles[0]!
      : params.agentType;
    const preferredReasoning = resolveAgentReasoningEffort(runtimeRole, params.codexHomeOverride)
      ?? resolveAgentReasoningEffort(params.agentType, params.codexHomeOverride);
    const workerLaunchArgs = resolveWorkerLaunchArgsForScaling(
      params.launchEnv,
      runtimeRole,
      preferredReasoning,
      params.codexHomeOverride,
    );
    const workerCli = resolveTeamWorkerCliForResolvedLaunchArgs(
      offset + 1,
      params.count,
      workerLaunchArgs,
      params.launchEnv,
    );
    assertTeamWorkerCliPolicyCompatibility(workerCli, workerLaunchArgs);
    const immutableWorkerLaunchArgs = [...workerLaunchArgs];
    Object.freeze(immutableWorkerLaunchArgs);
    plans.push(Object.freeze({
      workerIndex,
      workerName,
      runtimeRole,
      workerLaunchArgs: immutableWorkerLaunchArgs,
      workerCli,
      mixedTaskRoles: Object.freeze([...uniqueTaskRoles]),
    }));
  }

  return Object.freeze(plans);
}

function resolveInstructionStateRoot(worktreePath?: string | null): string | undefined {
  return worktreePath ? WORKTREE_TRIGGER_STATE_ROOT : undefined;
}

interface ScaleUpApprovedExecutionGate {
  ok: true;
  approvedContextSection?: string;
}

function assertUnreachableApprovedExecutionState(state: never): never {
  throw new Error(`unreachable_scale_up_approved_execution_state:${JSON.stringify(state)}`);
}

function resolveScaleUpApprovedExecutionGate(
  teamName: string,
  approvedExecutionState: PersistedApprovedTeamExecutionContinuityState,
): ScaleUpApprovedExecutionGate | ScaleError {
  switch (approvedExecutionState.status) {
    case 'missing':
      return { ok: true };
    case 'malformed':
      return { ok: false, error: `approved_execution_binding_malformed:${teamName}` };
    case 'ambiguous':
      return {
        ok: false,
        error: `approved_execution_binding_ambiguous:${approvedExecutionState.binding.prd_path}:${approvedExecutionState.binding.task}`,
      };
    case 'stale':
      return {
        ok: false,
        error: `approved_execution_binding_stale:${approvedExecutionState.binding.prd_path}:${approvedExecutionState.binding.task}`,
      };
    case 'valid':
      return {
        ok: true,
        approvedContextSection: buildApprovedTeamHandoffSection(approvedExecutionState.approvedHint),
      };
    default:
      return assertUnreachableApprovedExecutionState(approvedExecutionState);
  }
}

function resolveLegacyScaledTeamWorktreeMode(config: Pick<TeamConfig, 'name' | 'workspace_mode' | 'worktree_mode' | 'workers'>): WorktreeMode {
  if (config.worktree_mode) return config.worktree_mode;
  if (config.workspace_mode !== 'worktree') return { enabled: false };

  const workersWithMetadata = config.workers.filter((worker) =>
    worker.worktree_path || worker.worktree_branch || typeof worker.worktree_detached === 'boolean',
  );
  if (workersWithMetadata.length === 0) {
    throw new Error(`scale_up_missing_team_worktree_contract:${config.name}`);
  }

  if (workersWithMetadata.some((worker) => worker.worktree_detached === true)) {
    return { enabled: true, detached: true, name: null };
  }

  const branchPrefixes = new Set(
    workersWithMetadata
      .map((worker) => worker.worktree_branch?.trim())
      .filter((branch): branch is string => Boolean(branch))
      .map((branch) => {
        const match = /^(.*)\/worker-\d+$/.exec(branch);
        return match?.[1]?.trim() || '';
      })
      .filter(Boolean),
  );

  if (branchPrefixes.size === 1) {
    return { enabled: true, detached: false, name: [...branchPrefixes][0] };
  }

  throw new Error(`scale_up_missing_team_worktree_contract:${config.name}`);
}

function resolveScaleUpWorktreeMode(config: TeamConfig): WorktreeMode {
  if (config.workspace_mode !== 'worktree') return { enabled: false };
  try {
    return resolveLegacyScaledTeamWorktreeMode(config);
  } catch (error) {
    if (error instanceof Error && error.message === `scale_up_missing_team_worktree_contract:${config.name}`) {
      return { enabled: true, detached: true, name: null };
    }
    throw error;
  }
}

async function notifyWorkerPaneOutcome(
  sessionName: string,
  workerIndex: number,
  message: string,
  authority: VerifiedScaleSplitPane,
  workerCli?: 'codex' | 'claude' | 'gemini',
): Promise<DispatchOutcome> {
  if (!revalidateScaleSplitAuthority(authority)) {
    return { ok: false, transport: 'tmux_send_keys', reason: 'tmux_pane_authority_lost' };
  }
  try {
    await sendToWorker(
      sessionName,
      workerIndex,
      message,
      authority.paneId,
      workerCli,
      authority.panePid,
      () => revalidateScaleSplitAuthority(authority),
    );
    return { ok: true, transport: 'tmux_send_keys', reason: 'tmux_send_keys_sent' };
  } catch (error) {
    return {
      ok: false,
      transport: 'tmux_send_keys',
      reason: `tmux_send_keys_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── Scale Up ──────────────────────────────────────────────────────────────────

/**
 * Add workers to a running team mid-session.
 *
 * Acquires the file-based scaling lock, reads the current config,
 * validates capacity, creates new tmux panes, and bootstraps workers.
 */
export async function scaleUp(
  teamName: string,
  count: number,
  agentType: string,
  tasks: ScaleUpTaskInput[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScaleUpResult | ScaleError> {
  assertScalingEnabled(env);

  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, error: `count must be a positive integer (got ${count})` };
  }

  if (!isTmuxAvailable()) {
    return { ok: false, error: 'tmux is not available' };
  }

  const sanitized = sanitizeTeamName(teamName);
  const leaderCwd = resolve(cwd);

  return await withScalingLock(sanitized, leaderCwd, async (): Promise<ScaleUpResult | ScaleError> => {
    const config = await readTeamConfig(sanitized, leaderCwd);
    if (!config) {
      return { ok: false, error: `Team ${sanitized} not found` };
    }
    const persistedPaneIds = canonicalizePersistedTeamPaneIds(config);
    if (!persistedPaneIds) {
      return { ok: false, error: 'invalid_persisted_tmux_pane_ids' };
    }

    const maxWorkers = config.max_workers;
    const currentCount = config.workers.length;
    if (currentCount + count > maxWorkers) {
      return {
        ok: false,
        error: `Cannot add ${count} workers: would exceed max_workers (${currentCount} + ${count} > ${maxWorkers})`,
      };
    }

    const teamStateRoot = config.team_state_root ?? resolveCanonicalTeamStateRoot(leaderCwd);
    const codexHomeOverride = resolveCodexHomeForLaunch(leaderCwd, env);
    const launchEnv = codexHomeOverride
      ? { ...env, CODEX_HOME: codexHomeOverride }
      : env;
    // Build and validate every launch plan before any task, directory, worktree,
    // pane, process, or config mutation. The plan is the sole source of launch
    // policy; later task materialization must not alter it.
    const initialNextIndex = config.next_worker_index ?? (currentCount + 1);
    let workerLaunchPlans: readonly ScaleUpWorkerLaunchPlan[];
    try {
      const existingTasks = await listTasks(sanitized, leaderCwd);
      workerLaunchPlans = buildScaleUpWorkerLaunchPlans({
        count,
        nextWorkerIndex: initialNextIndex,
        agentType,
        existingTasks,
        incomingTasks: tasks,
        launchEnv,
        codexHomeOverride,
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    let nextIndex = initialNextIndex;
    const sessionName = config.tmux_session;
    const manifest = await readTeamManifestV2(sanitized, leaderCwd);
    const dispatchPolicy = normalizeTeamPolicy(manifest?.policy, {
      display_mode: manifest?.policy?.display_mode === 'split_pane' ? 'split_pane' : 'auto',
      worker_launch_mode: config.worker_launch_mode,
    });
    const approvedExecutionState = await resolvePersistedApprovedTeamExecutionContinuityState(
      sanitized,
      config.leader_cwd ?? leaderCwd,
      config.team_state_root ?? teamStateRoot,
    );
    const approvedExecutionGate = resolveScaleUpApprovedExecutionGate(
      sanitized,
      approvedExecutionState,
    );
    if (!approvedExecutionGate.ok) {
      return approvedExecutionGate;
    }
    const persistedUltragoalContext = await readPersistedTeamUltragoalContext(
      sanitized,
      config.leader_cwd ?? leaderCwd,
      config.team_state_root ?? teamStateRoot,
    );
    const approvedContextSection = joinContextSections(
      approvedExecutionGate.approvedContextSection,
      renderLeaderOwnedUltragoalContextSection(persistedUltragoalContext),
    );
    const initialSplitSourceWorker = config.workers[config.workers.length - 1];
    const initialSplitTarget = initialSplitSourceWorker
      ? (persistedPaneIds.workerPaneIds.get(initialSplitSourceWorker) ?? persistedPaneIds.leaderPaneId)
      : persistedPaneIds.leaderPaneId;
    if (!initialSplitTarget) {
      return { ok: false, error: 'failed_to_validate_team_tmux_pane_authority' };
    }
    const preSplitPaneIds = readGlobalTmuxPaneIdSnapshot();
    const teamPaneOwnerId = preSplitPaneIds
      ? validatePersistedTeamPaneAuthority(config, persistedPaneIds, preSplitPaneIds)
      : null;
    if (!preSplitPaneIds || !teamPaneOwnerId) {
      return { ok: false, error: 'failed_to_validate_team_tmux_pane_authority' };
    }
    if (new Set(config.workers.map((worker) => worker.name)).size !== config.workers.length) {
      return { ok: false, error: 'duplicate_worker_names_in_team_config' };
    }

    const effectiveWorktreeMode = config.worktree_mode ?? resolveScaleUpWorktreeMode(config);
    if (!config.worktree_mode && effectiveWorktreeMode.enabled) {
      config.worktree_mode = effectiveWorktreeMode;
      await saveTeamConfig(config, leaderCwd);
    }

    const addedWorkers: WorkerInfo[] = [];
    const createdTaskIds: string[] = [];
    const initialPaneIds = new Set(preSplitPaneIds);
    const knownPaneIds = new Set(initialPaneIds);
    const operationPaneIds = new Set<string>();
    const operationPaneAuthorities = new Map<string, VerifiedScaleSplitPane>();
    const rollbackPaneIds = new Set<string>();

    const rollbackScaleUp = async (
      error: string,
      context: { paneId?: string; workerName?: string; worktreePath?: string } = {},
    ): Promise<ScaleError> => {
      const killOperationPane = (paneId: string | undefined): void => {
        const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
        const authority = canonicalPaneId ? operationPaneAuthorities.get(canonicalPaneId) : undefined;
        if (
          !canonicalPaneId
          || !authority
          || !operationPaneIds.has(canonicalPaneId)
          || initialPaneIds.has(canonicalPaneId)
          || rollbackPaneIds.has(canonicalPaneId)
        ) return;
        rollbackPaneIds.add(canonicalPaneId);
        killScaleSplitPaneAtomically(authority);
      };

      for (const w of addedWorkers) {
        const idx = config.workers.findIndex((worker) => worker.name === w.name);
        if (idx >= 0) {
          config.workers.splice(idx, 1);
        }
        killOperationPane(w.pane_id);
        if (w.worktree_path) {
          await removeWorkerWorktreeRootAgentsFile(sanitized, w.name, teamStateRoot, w.worktree_path).catch(() => {});
        }
      }

      if (
        context.workerName &&
        context.worktreePath &&
        !addedWorkers.some((worker) => worker.name === context.workerName)
      ) {
        await removeWorkerWorktreeRootAgentsFile(
          sanitized,
          context.workerName,
          teamStateRoot,
          context.worktreePath,
        ).catch(() => {});
      }

      killOperationPane(context.paneId);

      for (const taskId of createdTaskIds) {
        await rm(join(leaderCwd, '.omx', 'state', 'team', sanitized, 'tasks', `task-${taskId}.json`), { force: true }).catch(() => {});
      }

      config.worker_count = config.workers.length;
      config.next_worker_index = initialNextIndex;
      await saveTeamConfig(config, leaderCwd);

      return { ok: false, error };
    };

    // Persist incoming tasks only after launch policy is frozen; the resulting
    // task listing is used for inbox and task materialization, never launch policy.
    for (const task of tasks) {
      const createdTask = await createStateTask(sanitized, {
        subject: task.subject,
        description: task.description,
        status: 'pending',
        owner: task.owner,
        blocked_by: task.blocked_by,
        role: task.role,
      }, leaderCwd);
      createdTaskIds.push(createdTask.id);
    }
    const materializedTasks = await listTasks(sanitized, leaderCwd);

    for (const workerLaunchPlan of workerLaunchPlans) {
      const {
        workerIndex,
        workerName,
        runtimeRole,
        workerLaunchArgs,
        workerCli,
      } = workerLaunchPlan;
      nextIndex = workerIndex + 1;
      if (workerLaunchPlan.mixedTaskRoles.length > 1) {
        console.log(`[omx:scaling] ${workerName}: mixed task roles [${workerLaunchPlan.mixedTaskRoles.join(', ')}], falling back to ${agentType}`);
      }

      // Create worker directory
      const workerDirPath = join(leaderCwd, '.omx', 'state', 'team', sanitized, 'workers', workerName);
      await mkdir(workerDirPath, { recursive: true });

      const worktreeMode = effectiveWorktreeMode;
      const workerWorkspaceResult = worktreeMode.enabled
        ? ensureWorktree(planWorktreeTarget({
            cwd: leaderCwd,
            scope: 'team',
            mode: worktreeMode,
            teamName: sanitized,
            workerName,
          }))
        : { enabled: false } as const;
      const workerWorkspace = workerWorkspaceResult.enabled ? workerWorkspaceResult : null;
      const workerCwd = workerWorkspace ? workerWorkspace.worktreePath : leaderCwd;

      // Build startup command and create tmux pane
      const rawRolePromptContent = await loadRolePrompt(runtimeRole, join(leaderCwd, '.codex', 'prompts'))
        ?? await loadRolePrompt(runtimeRole, codexPromptsDir());
      const resolvedWorkerModel = parseTeamWorkerLaunchArgs(workerLaunchArgs).modelOverride ?? undefined;
      const rolePromptContent = rawRolePromptContent
        ? composeRoleInstructionsForRole(runtimeRole, rawRolePromptContent, resolvedWorkerModel)
        : null;
      const teamInstructionsPath = join(leaderCwd, '.omx', 'state', 'team', sanitized, 'worker-agents.md');
      const instructionsFilePath = workerWorkspace
        ? await writeWorkerWorktreeRootAgentsFile({
            teamName: sanitized,
            workerName,
            workerRole: runtimeRole,
            rolePromptContent: rolePromptContent ?? '',
            teamStateRoot,
            leaderCwd,
            worktreePath: workerWorkspace.worktreePath,
          })
        : rolePromptContent
          ? await writeWorkerRoleInstructionsFile(sanitized, workerName, leaderCwd, teamInstructionsPath, runtimeRole, rolePromptContent)
          : teamInstructionsPath;
      const extraEnv: Record<string, string> = {
        OMX_TEAM_STATE_ROOT: teamStateRoot,
        OMX_TEAM_LEADER_CWD: leaderCwd,
        OMX_MODEL_INSTRUCTIONS_FILE: instructionsFilePath,
        ...(codexHomeOverride ? { CODEX_HOME: codexHomeOverride } : {}),
      };
      if (workerWorkspace) {
        extraEnv.OMX_TEAM_WORKTREE_PATH = workerWorkspace.worktreePath;
        if (workerWorkspace.branchName) {
          extraEnv.OMX_TEAM_WORKTREE_BRANCH = workerWorkspace.branchName;
        }
        extraEnv.OMX_TEAM_WORKTREE_DETACHED = workerWorkspace.detached ? '1' : '0';
      }
      trustWorkerMiseConfigIfAvailable(workerCwd);
      const cmd = writeWorkerStartupScriptCommand(
        sanitized,
        workerIndex,
        workerLaunchArgs,
        workerCwd,
        extraEnv,
        workerCli,
        undefined,
        runtimeRole,
      ) ?? buildWorkerStartupCommand(
        sanitized,
        workerIndex,
        workerLaunchArgs,
        workerCwd,
        extraEnv,
        workerCli,
        undefined,
        runtimeRole,
      );

      // Find the right-most worker pane to split from, or fall back to leader pane.
      // Keep the initial split from leader horizontal to preserve the leader-left
      // / workers-right composition.
      const splitSourceWorker = config.workers[config.workers.length - 1];
      const rawSplitTarget = splitSourceWorker
        ? (persistedPaneIds.workerPaneIds.get(splitSourceWorker) ?? persistedPaneIds.leaderPaneId)
        : persistedPaneIds.leaderPaneId;
      const splitTarget = parseCanonicalTmuxPaneId(rawSplitTarget);
      if (!splitTarget || !knownPaneIds.has(splitTarget)) {
        return await rollbackScaleUp(`Failed to validate tmux split target for ${workerName}`, {
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }
      if (!isFreshOwnedTeamPane(splitTarget, sessionName, teamPaneOwnerId)) {
        return await rollbackScaleUp(`Failed to revalidate tmux split target for ${workerName}`, {
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }

      const splitDirection = splitTarget === persistedPaneIds.leaderPaneId ? '-h' : '-v';
      const preSplitGlobalPaneIds = readGlobalTmuxPaneIdSnapshot();
      const preSplitSessionPaneOwners = readTeamPaneOwnerSnapshot(sessionName);
      if (
        !preSplitGlobalPaneIds
        || !preSplitSessionPaneOwners
        || !isConsistentTeamPaneSnapshot(preSplitGlobalPaneIds, preSplitSessionPaneOwners)
        || !preSplitGlobalPaneIds.has(splitTarget)
        || preSplitSessionPaneOwners.get(splitTarget) !== teamPaneOwnerId
      ) {
        return await rollbackScaleUp(`Failed to capture pre-split tmux authority for ${workerName}`, {
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }
      const ownerOption = `@omx_scale_split_owner_nonce_${randomUUID().replaceAll('-', '')}`;
      const ownerNonce = `scale-split:${randomUUID()}`;
      const operationMarker = randomUUID();
      const provisionalProof = `pending:${ownerNonce}`;
      if (
        spawnSync('tmux', ['set-option', '-g', ownerOption, provisionalProof], { encoding: 'utf-8' }).status !== 0
        || readTmuxOptionExactly(ownerOption) !== provisionalProof
      ) {
        return await rollbackScaleUp(`Failed to establish tmux split operation proof for ${workerName}`, {
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }
      const result = spawnSync('tmux', [
        'split-window', splitDirection, '-t', splitTarget, '-d', '-P', '-F', '#{pane_id}', '-c', workerCwd,
        writeScaleSplitOperationMarkedCommand(cmd, operationMarker),
      ], { encoding: 'utf-8' });

      if (result.status !== 0) {
        return await rollbackScaleUp(
          `Failed to create tmux pane for ${workerName}: ${(result.stderr || '').trim()}`,
          { workerName, worktreePath: workerWorkspace?.worktreePath },
        );
      }

      let postSplitGlobalPaneIds: Set<string> | null = null;
      let postSplitSessionPaneOwners: TeamPaneOwnerSnapshot | null = null;
      let paneId: string | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        postSplitGlobalPaneIds = readGlobalTmuxPaneIdSnapshot();
        postSplitSessionPaneOwners = readTeamPaneOwnerSnapshot(sessionName);
        const globalCandidate = postSplitGlobalPaneIds
          ? deriveSingleScaleSplitPaneId(preSplitGlobalPaneIds, postSplitGlobalPaneIds)
          : null;
        const sessionCandidate = postSplitSessionPaneOwners
          ? deriveSingleScaleSplitPaneId(new Set(preSplitSessionPaneOwners.keys()), new Set(postSplitSessionPaneOwners.keys()))
          : null;
        const markerCandidate = findScaleSplitOperationMarkerPaneId(operationMarker);
        if (globalCandidate && globalCandidate === sessionCandidate && markerCandidate === globalCandidate) {
          paneId = globalCandidate;
          break;
        }
        if (markerCandidate && !preSplitGlobalPaneIds.has(markerCandidate)) {
          const recoveredGlobalPaneIds = readGlobalTmuxPaneIdSnapshot();
          const recoveredSessionPaneOwners = readTeamPaneOwnerSnapshot(sessionName);
          const recoveredGlobalCandidate = recoveredGlobalPaneIds
            ? deriveSingleScaleSplitPaneId(preSplitGlobalPaneIds, recoveredGlobalPaneIds)
            : null;
          const recoveredSessionCandidate = recoveredSessionPaneOwners
            ? deriveSingleScaleSplitPaneId(
              new Set(preSplitSessionPaneOwners.keys()),
              new Set(recoveredSessionPaneOwners.keys()),
            )
            : null;
          if (
            recoveredGlobalPaneIds
            && recoveredSessionPaneOwners
            && isConsistentTeamPaneSnapshot(recoveredGlobalPaneIds, recoveredSessionPaneOwners)
            && recoveredGlobalCandidate === markerCandidate
            && recoveredSessionCandidate === markerCandidate
            && findScaleSplitOperationMarkerPaneId(operationMarker) === markerCandidate
          ) {
            postSplitGlobalPaneIds = recoveredGlobalPaneIds;
            postSplitSessionPaneOwners = recoveredSessionPaneOwners;
            paneId = markerCandidate;
            break;
          }
        }
        if (attempt < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      if (!paneId) {
        return await rollbackScaleUp(`Failed to derive exact tmux pane delta for ${workerName}`, {
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }
      const incarnation = readScalePaneIncarnation(paneId);
      if (!incarnation) {
        return await rollbackScaleUp(`Failed to capture tmux pane incarnation for ${workerName}`, {
          paneId, workerName, worktreePath: workerWorkspace?.worktreePath,
        });
      }
      operationPaneIds.add(paneId);
      const provisionalAuthority: VerifiedScaleSplitPane = {
        paneId,
        panePid: incarnation.panePid,
        sessionName,
        sessionId: incarnation.sessionId,
        ownerId: teamPaneOwnerId,
        ownerOption,
        ownerProof: provisionalProof,
        ownerTagged: false,
        operationMarker,
      };
      operationPaneAuthorities.set(paneId, provisionalAuthority);
      const boundProof = `${paneId}:${ownerNonce}`;
      if (
        spawnSync('tmux', ['set-option', '-g', ownerOption, boundProof], { encoding: 'utf-8' }).status !== 0
        || readTmuxOptionExactly(ownerOption) !== boundProof
      ) {
        return await rollbackScaleUp(`Failed to bind tmux split operation proof for ${workerName}`, {
          paneId,
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }
      provisionalAuthority.ownerProof = boundProof;
      if (parseFreshTmuxPaneId(result.stdout) !== paneId) {
        return await rollbackScaleUp(`Failed to validate tmux split output for ${workerName}`, {
          paneId,
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }
      if (
        !postSplitGlobalPaneIds
        || !postSplitSessionPaneOwners
        || !isConsistentTeamPaneSnapshot(postSplitGlobalPaneIds, postSplitSessionPaneOwners)
      ) {
        return await rollbackScaleUp(`Failed to validate exact tmux pane delta for ${workerName}`, {
          paneId,
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }

      try {
        if (!revalidateScaleSplitAuthority(provisionalAuthority)) {
          return await rollbackScaleUp(`Failed to revalidate tmux pane authority before owner tagging for ${workerName}`, {
            paneId,
            workerName,
            worktreePath: workerWorkspace?.worktreePath,
          });
        }
        tagPaneTeamOwner(paneId, teamPaneOwnerId);
        provisionalAuthority.ownerTagged = true;
      } catch (error) {
        return await rollbackScaleUp(
          `Failed to tag tmux pane for ${workerName}: ${error instanceof Error ? error.message : String(error)}`,
          { paneId, workerName, worktreePath: workerWorkspace?.worktreePath },
        );
      }
      if (!revalidateScaleSplitAuthority(provisionalAuthority) || !isScalePaneStablyLive(paneId, provisionalAuthority.panePid)) {
        return await rollbackScaleUp(`Failed to validate sustained tmux pane authority for ${workerName}`, {
          paneId,
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }
      knownPaneIds.add(paneId);

      // Intentionally avoid forcing `select-layout tiled` here.
      // Tiled relayout reflows leader/HUD panes and breaks team window layout.

      // The atomic split snapshot is the sole PID authority. A scalar PID read
      // here could accept a same-ID respawn that happened between probes.
      const workerInfo: WorkerInfo = {
        name: workerName,
        index: workerIndex,
        role: runtimeRole,
        worker_cli: workerCli,
        assigned_tasks: [],
        pid: Number(provisionalAuthority.panePid),
        pane_id: paneId,
        working_dir: workerCwd,
        worktree_repo_root: workerWorkspace ? workerWorkspace.repoRoot : undefined,
        worktree_path: workerWorkspace ? workerWorkspace.worktreePath : undefined,
        worktree_branch: workerWorkspace ? (workerWorkspace.branchName ?? undefined) : undefined,
        worktree_detached: workerWorkspace ? workerWorkspace.detached : undefined,
        worktree_created: workerWorkspace ? workerWorkspace.created : undefined,
        team_state_root: teamStateRoot,
      };

      // Readiness can block while a pane is recycled under the same ID.
      const readyTimeoutMs = resolveWorkerReadyTimeoutMs(env);
      const skipReadyWait = env.OMX_TEAM_SKIP_READY_WAIT === '1';
      if (!skipReadyWait) {
        if (!revalidateScaleSplitAuthority(provisionalAuthority)) {
          return await rollbackScaleUp(`Failed to revalidate tmux pane authority before readiness for ${workerName}`, {
            paneId, workerName, worktreePath: workerWorkspace?.worktreePath,
          });
        }
        const ready = waitForWorkerReady(
          sessionName,
          workerIndex,
          readyTimeoutMs,
          paneId,
          provisionalAuthority.panePid,
          () => revalidateScaleSplitAuthority(provisionalAuthority),
        );
        if (!ready) {
          console.log(`[omx:scaling] Warning: worker ${workerName} did not become ready within timeout`);
        }
      }
      if (!revalidateScaleSplitAuthority(provisionalAuthority)) {
        return await rollbackScaleUp(`Failed to revalidate tmux pane authority after readiness for ${workerName}`, {
          paneId, workerName, worktreePath: workerWorkspace?.worktreePath,
        });
      }

      // Get assigned tasks for this worker
      const workerTasks = materializedTasks.filter(t => t.owner === workerName);

      const inbox = generateInitialInbox(workerName, sanitized, agentType, workerTasks, {
        teamStateRoot,
        leaderCwd,
        workerRole: runtimeRole,
        rolePromptContent: rawRolePromptContent ?? undefined,
        worktreeRootAgentsCanonical: Boolean(workerWorkspace?.worktreePath),
        approvedContextSection,
        workerGoalInstruction: buildTeamWorkerGoalInstruction(sanitized, workerName, workerTasks, { teamStateRoot }),
      });

      const triggerDirective = buildTriggerDirective(
        workerName,
        sanitized,
        resolveInstructionStateRoot(workerInfo.worktree_path),
      );
      const queued = await queueInboxInstruction({
        teamName: sanitized,
        workerName,
        workerIndex,
        paneId,
        inbox,
        triggerMessage: triggerDirective.text,
        intent: triggerDirective.intent,
        cwd: leaderCwd,
        transportPreference: dispatchPolicy.dispatch_mode,
        fallbackAllowed: true,
        inboxCorrelationKey: `scale_up:${workerName}`,
        notify: async (_target, message) => {
          if (dispatchPolicy.dispatch_mode === 'hook_preferred_with_fallback') {
            return { ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' };
          }
          return await notifyWorkerPaneOutcome(sessionName, workerIndex, message, provisionalAuthority, workerCli);
        },
      });
      let outcome = queued;
      if (dispatchPolicy.dispatch_mode === 'hook_preferred_with_fallback' && queued.request_id) {
        const receipt = await waitForDispatchReceipt(sanitized, queued.request_id, leaderCwd, {
          timeoutMs: dispatchPolicy.dispatch_ack_timeout_ms,
          pollMs: 50,
        });
        if (receipt && (receipt.status === 'notified' || receipt.status === 'delivered')) {
          outcome = { ok: true, transport: 'hook', reason: `hook_receipt_${receipt.status}`, request_id: queued.request_id };
        } else {
          const fallback = await notifyWorkerPaneOutcome(sessionName, workerIndex, triggerDirective.text, provisionalAuthority, workerCli);
          if (receipt?.status === 'failed') {
            if (fallback.ok) {
              await transitionDispatchRequest(
                sanitized,
                queued.request_id,
                'failed',
                'failed',
                { last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
                leaderCwd,
              ).catch(() => {});
              outcome = {
                ok: true,
                transport: fallback.transport,
                reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}`,
                request_id: queued.request_id,
              };
            } else {
              await transitionDispatchRequest(
                sanitized,
                queued.request_id,
                'failed',
                'failed',
                { last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
                leaderCwd,
              ).catch(() => {});
              outcome = {
                ok: false,
                transport: fallback.transport,
                reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
                request_id: queued.request_id,
              };
            }
          } else if (fallback.ok) {
            const marked = await markDispatchRequestNotified(
              sanitized,
              queued.request_id,
              { last_reason: `fallback_confirmed:${fallback.reason}` },
              leaderCwd,
            );
            if (!marked) {
              await transitionDispatchRequest(
                sanitized,
                queued.request_id,
                'failed',
                'failed',
                { last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
                leaderCwd,
              ).catch(() => {});
            }
            outcome = {
              ok: true,
              transport: fallback.transport,
              reason: `hook_timeout_fallback_confirmed:${fallback.reason}`,
              request_id: queued.request_id,
            };
          } else {
            const current = await readDispatchRequest(sanitized, queued.request_id, leaderCwd);
            if (current) {
              await transitionDispatchRequest(
                sanitized,
                queued.request_id,
                current.status,
                'failed',
                { last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
                leaderCwd,
              ).catch(() => {});
            }
            outcome = {
              ok: false,
              transport: fallback.transport,
              reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
              request_id: queued.request_id,
            };
          }
        }
      }
      // Retry dispatch once if a trust prompt is blocking the worker pane (fixes #393).
      if (
        !outcome.ok
        && revalidateScaleSplitAuthority(provisionalAuthority)
        && dismissTrustPromptIfPresent(
          sessionName,
          workerIndex,
          paneId,
          provisionalAuthority.panePid,
          () => revalidateScaleSplitAuthority(provisionalAuthority),
        )
        && revalidateScaleSplitAuthority(provisionalAuthority)
      ) {
        waitForWorkerReady(
          sessionName,
          workerIndex,
          readyTimeoutMs,
          paneId,
          provisionalAuthority.panePid,
          () => revalidateScaleSplitAuthority(provisionalAuthority),
        );
        const retry = await notifyWorkerPaneOutcome(
          sessionName,
          workerIndex,
          triggerDirective.text,
          provisionalAuthority,
          workerCli,
        );
        if (retry.ok) {
          outcome = retry;
        }
      }
      if (!outcome.ok) {
        return await rollbackScaleUp(`scale_up_dispatch_failed:${workerName}:${outcome.reason}`, {
          paneId,
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }

      if (!revalidateScaleSplitAuthority(provisionalAuthority)) {
        return await rollbackScaleUp(`Failed to revalidate tmux pane authority before saving ${workerName}`, {
          paneId, workerName, worktreePath: workerWorkspace?.worktreePath,
        });
      }
      await writeWorkerIdentity(sanitized, workerName, workerInfo, leaderCwd);
      if (!revalidateScaleSplitAuthority(provisionalAuthority)) {
        return await rollbackScaleUp(`Failed to revalidate tmux pane authority immediately before saving ${workerName}`, {
          paneId, workerName, worktreePath: workerWorkspace?.worktreePath,
        });
      }
      addedWorkers.push(workerInfo);
      config.workers.push(workerInfo);
      persistedPaneIds.workerPaneIds.set(workerInfo, paneId);
      config.worker_count = config.workers.length;
      config.next_worker_index = nextIndex;
      await saveTeamConfig(config, leaderCwd);
    }

    await appendTeamEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason: `scale_up: added ${count} worker(s), new count=${config.worker_count}`,
    }, leaderCwd);

    return {
      ok: true,
      addedWorkers,
      newWorkerCount: config.worker_count,
      nextWorkerIndex: nextIndex,
    };
  });
}

// ── Scale Down ────────────────────────────────────────────────────────────────

export interface ScaleDownOptions {
  /** Worker names to remove. If empty, removes idle workers up to `count`. */
  workerNames?: string[];
  /** Number of idle workers to remove (used when workerNames is not specified). */
  count?: number;
  /** Force kill without waiting for drain. Default: false. */
  force?: boolean;
  /** Drain timeout in milliseconds. Default: 30000. */
  drainTimeoutMs?: number;
}

/**
 * Remove workers from a running team.
 *
 * Sets targeted workers to 'draining' status, waits for them to finish
 * current work (or force kills), then removes tmux panes and updates config.
 */
export async function scaleDown(
  teamName: string,
  cwd: string,
  options: ScaleDownOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScaleDownResult | ScaleError> {
  assertScalingEnabled(env);

  const sanitized = sanitizeTeamName(teamName);
  const leaderCwd = resolve(cwd);
  const force = options.force === true;
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;

  return await withScalingLock(sanitized, leaderCwd, async (): Promise<ScaleDownResult | ScaleError> => {
    const config = await readTeamConfig(sanitized, leaderCwd);
    if (!config) {
      return { ok: false, error: `Team ${sanitized} not found` };
    }
    const persistedPaneIds = canonicalizePersistedTeamPaneIds(config);
    if (!persistedPaneIds) {
      return { ok: false, error: 'invalid_persisted_tmux_pane_ids' };
    }

    // Determine which workers to remove
    let targetWorkers: WorkerInfo[];
    if (options.workerNames && options.workerNames.length > 0) {
      targetWorkers = [];
      for (const name of options.workerNames) {
        const w = config.workers.find(w => w.name === name);
        if (!w) {
          return { ok: false, error: `Worker ${name} not found in team ${sanitized}` };
        }
        targetWorkers.push(w);
      }
      if (new Set(options.workerNames).size !== options.workerNames.length) {
        return { ok: false, error: 'duplicate_worker_names_requested_for_scale_down' };
      }

    } else {
      const count = options.count ?? 1;
      if (!Number.isInteger(count) || count < 1) {
        return { ok: false, error: `count must be a positive integer (got ${count})` };
      }
      // Find idle workers to remove
      const idleWorkers: WorkerInfo[] = [];
      for (const w of config.workers) {
        const status = await readWorkerStatus(sanitized, w.name, leaderCwd);
        if (status.state === 'idle' || status.state === 'done' || status.state === 'unknown') {
          idleWorkers.push(w);
        }
      }
      if (idleWorkers.length < count && !force) {
        return {
          ok: false,
          error: `Not enough idle workers to remove: found ${idleWorkers.length}, requested ${count}. Use force=true to remove busy workers.`,
        };
      }
      targetWorkers = idleWorkers.slice(0, count);
      if (force && targetWorkers.length < count) {
        // Add non-idle workers if force is enabled
        const remaining = count - targetWorkers.length;
        const targetNames = new Set(targetWorkers.map(w => w.name));
        const nonIdle = config.workers.filter(w => !targetNames.has(w.name));
        targetWorkers.push(...nonIdle.slice(0, remaining));
      }
    }

    if (targetWorkers.length === 0) {
      return { ok: false, error: 'No workers selected for removal' };
    }

    // Minimum worker guard: must keep at least 1 worker
    if (config.workers.length - targetWorkers.length < 1) {
      return { ok: false, error: 'Cannot remove all workers — at least 1 must remain' };
    }

    if (persistedPaneIds.paneIds.size > 0) {
      const globalPaneIds = readGlobalTmuxPaneIdSnapshot();
      if (!globalPaneIds || validatePersistedTeamPaneAuthority(config, persistedPaneIds, globalPaneIds) === null) {
        return { ok: false, error: 'failed_to_validate_team_tmux_pane_authority' };
      }
    }

    const sessionName = config.tmux_session;
    const removedNames: string[] = [];

    // Phase 1: Set workers to 'draining' status
    for (const w of targetWorkers) {
      const drainingStatus: WorkerStatus = {
        state: 'draining',
        reason: 'scale_down requested by leader',
        updated_at: new Date().toISOString(),
      };
      await writeWorkerStatus(sanitized, w.name, drainingStatus, leaderCwd);
    }

    // Phase 2: Wait for draining workers to finish or timeout
    if (!force) {
      const deadline = Date.now() + drainTimeoutMs;
      while (Date.now() < deadline) {
        const allDrained = await Promise.all(
          targetWorkers.map(async (w) => {
            const status = await readWorkerStatus(sanitized, w.name, leaderCwd);
            return status.state === 'idle' || status.state === 'done' ||
                   status.state === 'draining' || !isWorkerAlive(sessionName, w.index, persistedPaneIds.workerPaneIds.get(w));
          }),
        );
        if (allDrained.every(Boolean)) break;
        await new Promise(r => setTimeout(r, 2_000));
      }
    }

    // Phase 3: Kill tmux panes and remove from config
    const expectedTargetPanePids = new Map<string, number>();
    const targetPaneIds: string[] = [];
    for (const worker of targetWorkers) {
      const paneId = persistedPaneIds.workerPaneIds.get(worker);
      if (!paneId) continue;
      const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
      if (!canonicalPaneId || canonicalPaneId !== paneId) {
        return { ok: false, error: 'invalid_persisted_tmux_pane_ids' };
      }
      const panePid = worker.pid;
      if (typeof panePid !== 'number' || !Number.isSafeInteger(panePid) || panePid <= 0) {
        return { ok: false, error: 'failed_to_validate_team_tmux_pane_authority' };
      }
      targetPaneIds.push(canonicalPaneId);
      expectedTargetPanePids.set(canonicalPaneId, panePid);
    }
    if (new Set(targetPaneIds).size !== targetPaneIds.length) {
      return { ok: false, error: 'duplicate_target_tmux_pane_ids' };
    }
    const freshGlobalPaneIds = readGlobalTmuxPaneIdSnapshot();
    const freshSessionPaneOwners = readTeamPaneOwnerSnapshot(sessionName);
    if (
      !isConsistentTeamPaneSnapshot(freshGlobalPaneIds, freshSessionPaneOwners)
      || targetPaneIds.some((paneId) => !freshGlobalPaneIds?.has(paneId) || freshSessionPaneOwners?.get(paneId) !== `team:${config.name}`)
    ) {
      return { ok: false, error: 'failed_to_revalidate_target_tmux_pane_authority' };
    }

    const teardown = await teardownWorkerPanes(targetPaneIds, {
      leaderPaneId: persistedPaneIds.leaderPaneId,
      hudPaneId: persistedPaneIds.hudPaneId,
      authority: {
        sessionName,
        expectedOwnerId: `team:${config.name}`,
        expectedPanePids: expectedTargetPanePids,
        revalidate: (paneId) => isFreshOwnedTeamPane(paneId, sessionName, `team:${config.name}`),
      },
    });
    if (
      teardown.kill.attempted !== targetPaneIds.length
      || teardown.kill.succeeded !== targetPaneIds.length
      || teardown.kill.failed !== 0
    ) {
      return { ok: false, error: 'scale_down_tmux_teardown_failed' };
    }
    const detachedWorktreesToRollback: EnsureWorktreeResult[] = targetWorkers
      .filter((worker) =>
        worker.worktree_created === true
        && worker.worktree_detached === true
        && typeof worker.worktree_repo_root === 'string'
        && worker.worktree_repo_root.length > 0
        && typeof worker.worktree_path === 'string'
        && worker.worktree_path.length > 0,
      )
      .map((worker) => ({
        enabled: true,
        repoRoot: worker.worktree_repo_root as string,
        worktreePath: resolve(worker.worktree_path as string),
        detached: true,
        branchName: null,
        created: true,
        reused: false,
        createdBranch: false,
      }));
    if (detachedWorktreesToRollback.length > 0) {
      try {
        await rollbackProvisionedWorktrees(detachedWorktreesToRollback);
      } catch (error) {
        return { ok: false, error: `scale_down_worktree_cleanup_failed:${String(error)}` };
      }
    }

    for (const w of targetWorkers) {
      if (w.worktree_path) {
        await removeWorkerWorktreeRootAgentsFile(sanitized, w.name, w.team_state_root ?? config.team_state_root ?? resolveCanonicalTeamStateRoot(leaderCwd), w.worktree_path).catch(() => {});
      }
      removedNames.push(w.name);
    }

    // Phase 4: Update config
    const removedSet = new Set(removedNames);
    config.workers = config.workers.filter(w => !removedSet.has(w.name));
    config.worker_count = config.workers.length;
    await saveTeamConfig(config, leaderCwd);

    await appendTeamEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason: `scale_down: removed ${removedNames.length} worker(s) [${removedNames.join(', ')}], new count=${config.worker_count}`,
    }, leaderCwd);

    return {
      ok: true,
      removedWorkers: removedNames,
      newWorkerCount: config.worker_count,
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveWorkerReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OMX_TEAM_READY_TIMEOUT_MS;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isFinite(parsed) && parsed >= 5_000) return parsed;
  return 45_000;
}

function resolveWorkerLaunchArgsForScaling(
  env: NodeJS.ProcessEnv,
  agentType: string,
  preferredReasoning?: TeamReasoningEffort,
  codexHomeOverride?: string,
): string[] {
  const inheritedLeaderModel = typeof env[TEAM_WORKER_INHERITED_MODEL_ENV] === 'string'
    ? env[TEAM_WORKER_INHERITED_MODEL_ENV]?.trim()
    : undefined;
  const inheritedArgs = inheritedLeaderModel ? ['--model', inheritedLeaderModel] : [];
  const fallbackModel = resolveAgentDefaultModel(agentType, codexHomeOverride ?? env.CODEX_HOME);

  return resolveTeamWorkerLaunchArgs({
    existingRaw: env.OMX_TEAM_WORKER_LAUNCH_ARGS,
    inheritedArgs,
    fallbackModel,
    preferredReasoning,
    honorExactRoleModel: shouldHonorAgentExactModel(agentType, codexHomeOverride),
  });
}
