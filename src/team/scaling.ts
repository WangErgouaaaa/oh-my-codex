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
  teamWithTaskMembershipBarrier as withTaskMembershipBarrier,
  recoverTeamMembershipTaskTransaction,
  commitTeamMembershipTaskTransaction,
  finalizeTeamMembershipTaskTransaction,
  writeAtomic,
  teamRemoveDurableFile as removeDurableFile,
  teamAppendEvent as appendTeamEvent,
  teamCreateTask as createStateTask,
  teamListTasks as listTasks,
  teamReadTask as readTask,
  teamMarkDispatchRequestNotified as markDispatchRequestNotified,
  teamReadDispatchRequest as readDispatchRequest,
  teamTransitionDispatchRequest as transitionDispatchRequest,
  teamRemoveDispatchRequestsForWorkers as removeDispatchRequestsForWorkers,
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
  type PlannedWorktreeTarget,
  type WorktreeMode,
} from './worktree.js';
import { withTaskClaimLock } from './state/locks.js';

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

const TASK_CLAIM_LOCK_STALE_MS = 5 * 60 * 1000;

async function withTaskClaimLocks<T>(
  teamName: string,
  taskIds: readonly string[],
  cwd: string,
  fn: () => Promise<T>,
): Promise<T> {
  const uniqueTaskIds = [...new Set(taskIds)].sort((left, right) => Number(left) - Number(right));
  const teamDir = (name: string, lockCwd: string) => join(resolveCanonicalTeamStateRoot(lockCwd), 'team', name);
  const locks = {
    teamDir,
    taskClaimLockDir: (name: string, taskId: string, lockCwd: string) => (
      join(teamDir(name, lockCwd), 'claims', `task-${taskId}.lock`)
    ),
    mailboxLockDir: (name: string, workerName: string, lockCwd: string) => (
      join(teamDir(name, lockCwd), 'mailbox', `.lock-${workerName}`)
    ),
  };
  const acquire = async (index: number): Promise<T> => {
    if (index >= uniqueTaskIds.length) return await fn();
    const taskId = uniqueTaskIds[index]!;
    const locked = await withTaskClaimLock(
      teamName,
      taskId,
      cwd,
      TASK_CLAIM_LOCK_STALE_MS,
      locks,
      async () => await acquire(index + 1),
    );
    if (!locked.ok) throw new Error(`Timed out acquiring task claim lock for ${teamName}/${taskId}`);
    return locked.value;
  };
  return await acquire(0);
}

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

function parseScaleSplitAuthorityOutput(output: string): { paneId: string; panePid: string; sessionId: string } | null {
  const line = parseExactTmuxAuthorityScalar(output);
  const match = line ? /^(%[1-9][0-9]*)\t([1-9][0-9]*)\t(\$[0-9]+)$/.exec(line) : null;
  const paneId = parseCanonicalTmuxPaneId(match?.[1]);
  return match && paneId && paneId === match[1]
    ? { paneId, panePid: match[2]!, sessionId: match[3]! }
    : null;
}

function hasScaleSplitRollbackAuthority(authority: VerifiedScaleSplitPane): boolean {
  const paneId = parseCanonicalTmuxPaneId(authority.paneId);
  const globalPaneIds = readGlobalTmuxPaneIdSnapshot();
  const sessionPaneOwners = readTeamPaneOwnerSnapshot(authority.sessionName);
  const incarnation = paneId ? readScalePaneIncarnation(paneId) : null;
  const markerPaneId = findScaleSplitOperationMarkerPaneId(authority.operationMarker);
  const optionProof = readTmuxOptionExactly(authority.ownerOption);
  const valid = Boolean(
    paneId
      && paneId === authority.paneId
      && markerPaneId === paneId
      && globalPaneIds?.has(paneId)
      && sessionPaneOwners?.has(paneId)
      && isConsistentTeamPaneSnapshot(globalPaneIds, sessionPaneOwners)
      && incarnation?.panePid === authority.panePid
      && incarnation.sessionId === authority.sessionId
      && optionProof === authority.ownerProof,
  );
  return valid;
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

function hasScaleUpFailureInjection(env: NodeJS.ProcessEnv, phase: string): boolean {
  return env.OMX_TEAM_SCALE_UP_INJECT_FAILURE?.split(',').map((value) => value.trim()).includes(phase) ?? false;
}

function throwIfScaleUpFailureInjected(env: NodeJS.ProcessEnv, phase: string): void {
  if (hasScaleUpFailureInjection(env, phase)) {
    throw new Error(`injected_scale_up_failure:${phase}`);
  }
}

function recoverCreatedWorktreeAfterEnsureFailure(
  plan: PlannedWorktreeTarget,
  worktreePathExistedBeforeEnsure: boolean,
  branchExistedBeforeEnsure: boolean,
): EnsureWorktreeResult | null {
  if (worktreePathExistedBeforeEnsure || !existsSync(plan.worktreePath)) return null;

  const commonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: plan.worktreePath,
    encoding: 'utf-8',
    windowsHide: true,
  });
  const repoCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: plan.repoRoot,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (
    commonDir.status !== 0
    || repoCommonDir.status !== 0
    || resolve(plan.worktreePath, (commonDir.stdout || '').trim())
      !== resolve(plan.repoRoot, (repoCommonDir.stdout || '').trim())
  ) {
    return null;
  }

  if (plan.branchName) {
    const branch = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
      cwd: plan.worktreePath,
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (branch.status !== 0 || (branch.stdout || '').trim() !== `refs/heads/${plan.branchName}`) return null;
  } else {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: plan.worktreePath,
      encoding: 'utf-8',
      windowsHide: true,
    });
    const branch = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
      cwd: plan.worktreePath,
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (head.status !== 0 || branch.status === 0 || (head.stdout || '').trim() !== plan.baseRef) return null;
  }

  return {
    enabled: true,
    repoRoot: plan.repoRoot,
    worktreePath: plan.worktreePath,
    detached: plan.detached,
    branchName: plan.branchName,
    created: true,
    reused: false,
    createdBranch: Boolean(plan.branchName && !branchExistedBeforeEnsure),
  };
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
  expectedPanePid?: number,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
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
      buildScaleSplitRollbackCondition(authority) ?? undefined,
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
    return await withTaskMembershipBarrier(sanitized, leaderCwd, async () => {
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
    }

    const addedWorkers: WorkerInfo[] = [];
    // A scale-up pane becomes killable during rollback only after its exact
    // process identity was pinned and, when Team ownership is configured, its
    // owner tag command completed. A returned pane ID alone is cleanup debt,
    // never authority to affect a potentially recycled pane.
    const rollbackTaggedPaneOwnerIds = new Map<string, string>();

    const createdTaskIds: string[] = [];
    const initialPaneIds = new Set(preSplitPaneIds);
    const knownPaneIds = new Set(initialPaneIds);
    const operationPaneIds = new Set<string>();
    const operationPaneAuthorities = new Map<string, VerifiedScaleSplitPane>();
    const rollbackPaneIds = new Set<string>();

    const provisionedWorktrees: EnsureWorktreeResult[] = [];
    const preparedWorkerDirectoryOwner = new Map<string, string>();
    const preparedStartupScriptOwner = new Map<string, string>();
    const runtimeDirectoryPath = join(teamStateRoot, 'team', sanitized, 'runtime');
    const runtimeDirectoryExisted = existsSync(runtimeDirectoryPath);
    const rollbackScaleUp = async (
      error: string,
      context: { paneId?: string; worker?: WorkerInfo; workerName?: string; worktreePath?: string } = {},
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
        if (requiredTeamOwnerId && rollbackTaggedPaneOwnerIds.get(paneId) !== requiredTeamOwnerId) {
          unresolvedPaneIds.add(paneId);
          cleanupDebt.push(`pane_owner_unverified:${paneId}`);
          continue;
        }
        expectedPanePids[paneId] = expectedPanePid;
        authorizedRollbackPaneIds.add(paneId);
      }
      try {
        const paneTeardown = await teardownWorkerPanes([...authorizedRollbackPaneIds], {
          leaderPaneId: config.leader_pane_id,
          hudPaneId: config.hud_pane_id,
          expectedPanePids,
          authorizePaneKill: (paneId) => {
            if (!requiredTeamOwnerId) return true;
            const expectedOwnerId = rollbackTaggedPaneOwnerIds.get(paneId);
            if (expectedOwnerId !== requiredTeamOwnerId) return false;
            const currentOwner = readPaneTeamOwnerTagResult(paneId);
            return currentOwner.status === 'value' && currentOwner.value === expectedOwnerId;
          },
        });
        for (const paneId of [...paneTeardown.provenGonePaneIds, ...paneTeardown.killedPaneIds]) resolvedPaneIds.add(paneId);
        for (const paneId of paneTeardown.kill.failedPaneIds) unresolvedPaneIds.add(paneId);
        for (const proof of paneTeardown.proofUnavailable) unresolvedPaneIds.add(proof.paneId);
        if (paneTeardown.kill.failedPaneIds.length > 0) cleanupDebt.push(`pane_teardown_failed:${paneTeardown.kill.failedPaneIds.join(',')}`);
        if (paneTeardown.proofUnavailable.length > 0) {
          cleanupDebt.push(`pane_proof_unavailable:${paneTeardown.proofUnavailable.map((proof) => `${proof.paneId}:${proof.reason}`).join(',')}`);
        }
        if (paneTeardown.kill.failedPaneIds.length > 0 || paneTeardown.proofUnavailable.length > 0) {
          for (const paneId of rollbackPaneIds) {
            if (!resolvedPaneIds.has(paneId)) unresolvedPaneIds.add(paneId);
          }
          const unresolvedWithoutDirectFailure = [...unresolvedPaneIds].filter((paneId) =>
            !paneTeardown.kill.failedPaneIds.includes(paneId)
            && !paneTeardown.proofUnavailable.some((proof) => proof.paneId === paneId));
          if (unresolvedWithoutDirectFailure.length > 0) {
            cleanupDebt.push(`pane_teardown_unresolved:${unresolvedWithoutDirectFailure.join(',')}`);
          }
        }
      } catch (cleanupError) {
        for (const paneId of rollbackPaneIds) unresolvedPaneIds.add(paneId);
        cleanupDebt.push(`pane_cleanup_exception:${String(cleanupError)}`);
      }

      const unresolvedWorkerNames = new Set(rollbackWorkers
        .filter((worker) => typeof worker.pane_id === 'string' && unresolvedPaneIds.has(worker.pane_id))
        .map((worker) => worker.name));
      if (context.workerName && context.paneId && unresolvedPaneIds.has(context.paneId)) {
        unresolvedWorkerNames.add(context.workerName);
      }
      try {
        await withTaskMembershipBarrier(sanitized, leaderCwd, async () => {
          await recoverTeamMembershipTaskTransaction(sanitized, leaderCwd);
          const currentConfigBytes = await readFile(configPath, 'utf8');
          const currentConfig = JSON.parse(currentConfigBytes) as TeamConfig;
          const currentManifestBytes = existsSync(manifestPath) ? await readFile(manifestPath, 'utf8') : null;
          const retainedWorkers = rollbackWorkers.filter((worker) => unresolvedWorkerNames.has(worker.name));
          const desiredByName = new Map(originalConfig.workers.map((worker) => [worker.name, worker]));
          for (const worker of retainedWorkers) desiredByName.set(worker.name, worker);
          const desiredConfig: TeamConfig = {
            ...originalConfig,
            workers: [...desiredByName.values()],
            worker_count: desiredByName.size,
            next_worker_index: Math.max(
              originalConfig.next_worker_index ?? (originalConfig.workers.length + 1),
              ...retainedWorkers.map((worker) => worker.index + 1),
            ),
          };
          const desiredManifestBytes = originalManifestBytes === null
            ? null
            : JSON.stringify({
              ...(JSON.parse(originalManifestBytes) as Record<string, unknown>),
              workers: desiredConfig.workers,
              worker_count: desiredConfig.worker_count,
              next_worker_index: desiredConfig.next_worker_index,
            }, null, 2);
          const taskChanges = [];
          for (const taskId of createdTaskIds) {
            const taskPath = join(teamStateRoot, 'team', sanitized, 'tasks', `task-${taskId}.json`);
            const task = await readTask(sanitized, taskId, leaderCwd);
            taskChanges.push({
              taskId,
              oldBytes: existsSync(taskPath) ? await readFile(taskPath, 'utf8') : null,
              newBytes: task && unresolvedWorkerNames.has(task.owner ?? '')
                ? JSON.stringify(task, null, 2)
                : null,
            });
          }
          await commitTeamMembershipTaskTransaction(sanitized, leaderCwd, {
            baseGeneration: currentConfig.config_generation ?? 0,
            tasks: taskChanges,
            config: { oldBytes: currentConfigBytes, newBytes: JSON.stringify(desiredConfig, null, 2) },
            manifest: { oldBytes: currentManifestBytes, newBytes: desiredManifestBytes },
            recoverToNewOnFailure: true,
            retainJournalOnSuccess: true,
            failRollbackPersistence: hasScaleUpFailureInjection(env, 'rollback-membership-persistence'),
            failRollbackPersistenceAfter: hasScaleUpFailureInjection(env, 'rollback-membership-config-persistence')
              ? 'config'
              : hasScaleUpFailureInjection(env, 'rollback-membership-manifest-persistence')
                ? 'manifest'
                : undefined,
          });
          const verified = JSON.parse(await readFile(configPath, 'utf8')) as TeamConfig;
          if (!verified || retainedWorkers.some((worker) => !verified.workers.some((entry) => entry.name === worker.name && entry.pane_id === worker.pane_id))) {
            throw new Error('canonical_scale_up_rollback_membership_verification_failed');
          }
          if (verified.workers.some((worker) => rollbackWorkerNames.has(worker.name) && !unresolvedWorkerNames.has(worker.name))) {
            throw new Error('canonical_scale_up_rollback_resolved_membership_verification_failed');
          }
          await finalizeTeamMembershipTaskTransaction(sanitized, leaderCwd);
          Object.assign(config, verified);
        });
      } catch (rollbackError) {
        const journalPath = join(teamStateRoot, 'team', sanitized, '.membership-task-transaction.json');
        const suffix = existsSync(journalPath) ? String(rollbackError) : `no_recoverable_journal:${String(rollbackError)}`;
        return { ok: false, error: `scale_up_rollback_membership_persistence_failed:${suffix}` };
      }
      const cleanupWorkerNames = new Set([
        ...rollbackWorkers
          .filter((worker) => typeof worker.pane_id !== 'string' || resolvedPaneIds.has(worker.pane_id))
          .map((worker) => worker.name),
        ...(context.workerName && !unresolvedWorkerNames.has(context.workerName) ? [context.workerName] : []),
      ]);
      try {
        for (const taskId of createdTaskIds) {
          const task = await readTask(sanitized, taskId, leaderCwd);
          if (task && unresolvedWorkerNames.has(task.owner ?? '')) continue;
          await rm(join(teamStateRoot, 'team', sanitized, 'tasks', `task-${taskId}.json`), { force: true });
        }
        await Promise.all([...cleanupWorkerNames].map(async (workerName) => {
          await rm(join(teamStateRoot, 'team', sanitized, 'workers', workerName), { recursive: true, force: true });
        }));
        for (const taskId of createdTaskIds) {
          const task = await readTask(sanitized, taskId, leaderCwd);
          if (task && unresolvedWorkerNames.has(task.owner ?? '')) continue;
          if (task) throw new Error(`canonical_scale_up_rollback_task_verification_failed:${taskId}`);
        }
        for (const workerName of cleanupWorkerNames) {
          if (existsSync(join(teamStateRoot, 'team', sanitized, 'workers', workerName))) {
            throw new Error(`canonical_scale_up_rollback_worker_verification_failed:${workerName}`);
          }
        }
      } catch (rollbackError) {
        cleanupDebt.push(`canonical_cleanup_failed:${String(rollbackError)}`);
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
    let materializedTasks: TeamTask[];
    try {
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
      materializedTasks = await listTasks(sanitized, leaderCwd);
    } catch (error) {
      return await rollbackScaleUp(
        `scale_up_task_materialization_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const workerLaunchPlan of workerLaunchPlans) {
      const {
        workerIndex,
        workerName,
        runtimeRole,
        workerLaunchArgs,
        workerCli,
      } = workerLaunchPlan;
      // Freeze the split target and its identity before preparing any artifacts.
      // Later proof must establish that this exact pane process still owns the
      // target; a recycled pane ID must never become split authority.
      const splitTargetCandidate = config.workers[config.workers.length - 1];
      const splitTargetWorker = splitTargetCandidate?.pane_id?.trim() ? splitTargetCandidate : undefined;
      const splitTarget = splitTargetWorker?.pane_id ?? config.leader_pane_id ?? '';
      const expectedSplitTargetPid = splitTargetWorker
        ? splitTargetWorker.pid
        : config.leader_pane_pid;
      const expectedSplitTargetOwnerId = typeof config.tmux_pane_owner_id === 'string'
        ? config.tmux_pane_owner_id.trim()
        : '';
      if (
        typeof expectedSplitTargetPid !== 'number'
        || !Number.isSafeInteger(expectedSplitTargetPid)
        || expectedSplitTargetPid <= 0
      ) {
        return await rollbackScaleUp(`scale_up_split_target_pid_missing:${splitTarget}`);
      }
      if (!expectedSplitTargetOwnerId) {
        return await rollbackScaleUp(`scale_up_split_target_owner_unavailable:${splitTarget}`);
      }
      const splitDirection = splitTarget === (config.leader_pane_id ?? '') ? '-h' : '-v';

      nextIndex = workerIndex + 1;
      if (workerLaunchPlan.mixedTaskRoles.length > 1) {
        console.log(`[omx:scaling] ${workerName}: mixed task roles [${workerLaunchPlan.mixedTaskRoles.join(', ')}], falling back to ${agentType}`);
      }

      // Prepare every pre-pane artifact under the rollback boundary. A pane is
      // not required for ownership: workerName and any created worktree are
      // sufficient for rollback to clean a failed preparation.
      const workerDirPath = join(leaderCwd, '.omx', 'state', 'team', sanitized, 'workers', workerName);
      const startupScriptPath = join(
        teamStateRoot,
        'team',
        sanitized,
        'runtime',
        `worker-${workerIndex}-startup.sh`,
      );
      let workerWorkspace: EnsureWorktreeResult | null = null;
      let workerCwd = leaderCwd;
      let cmd: string;
      let rawRolePromptContent: string | null = null;
      try {
        preparedWorkerDirectoryOwner.set(workerDirPath, workerName);
        await mkdir(workerDirPath, { recursive: true });

        if (effectiveWorktreeMode.enabled) {
          const worktreePlan = planWorktreeTarget({
            cwd: leaderCwd,
            scope: 'team',
            mode: effectiveWorktreeMode,
            teamName: sanitized,
            workerName,
          });
          if (!worktreePlan.enabled) throw new Error(`worktree_not_planned:${workerName}`);
          const worktreePathExistedBeforeEnsure = existsSync(worktreePlan.worktreePath);
          const branchExistedBeforeEnsure = worktreePlan.branchName
            ? spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${worktreePlan.branchName}`], {
                cwd: worktreePlan.repoRoot,
                encoding: 'utf-8',
                windowsHide: true,
              }).status === 0
            : false;
          try {
            const ensuredWorkspace = ensureWorktree(worktreePlan);
            throwIfScaleUpFailureInjected(env, 'worktree-ensure-post-create');
            if (!ensuredWorkspace.enabled) throw new Error(`worktree_not_provisioned:${workerName}`);
            workerWorkspace = ensuredWorkspace;
          } catch (error) {
            const recoveredWorkspace = recoverCreatedWorktreeAfterEnsureFailure(
              worktreePlan,
              worktreePathExistedBeforeEnsure,
              branchExistedBeforeEnsure,
            );
            if (recoveredWorkspace) {
              workerWorkspace = recoveredWorkspace;
              provisionedWorktrees.push(recoveredWorkspace);
            }
            throw error;
          }
          if (!workerWorkspace) throw new Error(`worktree_not_provisioned:${workerName}`);
          provisionedWorktrees.push(workerWorkspace);
          throwIfScaleUpFailureInjected(env, 'worktree-post-create');
          workerCwd = workerWorkspace.worktreePath;
        }

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
        'split-window', splitDirection, '-t', splitTarget, '-d', '-P', '-F', '#{pane_id}\t#{pane_pid}\t#{session_id}', '-c', workerCwd,
        writeScaleSplitOperationMarkedCommand(cmd, operationMarker),
      ], { encoding: 'utf-8' });

      if (result.status !== 0) {
        return await rollbackScaleUp(
          `Failed to create tmux pane for ${workerName}: ${(result.stderr || '').trim()}`,
          { workerName, worktreePath: workerWorkspace?.worktreePath },
        );
      }
      const splitScalar = parseExactTmuxAuthorityScalar(result.stdout || '');
      if (!splitScalar) {
        return await rollbackScaleUp(`Failed to capture atomic tmux split authority for ${workerName}`, {
          workerName, worktreePath: workerWorkspace?.worktreePath,
        });
      }
      const splitAuthority = parseScaleSplitAuthorityOutput(result.stdout || '');
      let earlyAuthority: VerifiedScaleSplitPane | null = null;
      if (splitAuthority && !preSplitGlobalPaneIds.has(splitAuthority.paneId)) {
        earlyAuthority = {
          paneId: splitAuthority.paneId,
          panePid: splitAuthority.panePid,
          sessionName,
          sessionId: splitAuthority.sessionId,
          ownerId: teamPaneOwnerId,
          ownerOption,
          ownerProof: provisionalProof,
          ownerTagged: false,
          operationMarker,
        };
        operationPaneIds.add(earlyAuthority.paneId);
        operationPaneAuthorities.set(earlyAuthority.paneId, earlyAuthority);
      }
      if (!earlyAuthority) {
        const markerPaneId = findScaleSplitOperationMarkerPaneId(operationMarker);
        const markerIncarnation = markerPaneId && !preSplitGlobalPaneIds.has(markerPaneId)
          ? readScalePaneIncarnation(markerPaneId)
          : null;
        if (markerPaneId && markerIncarnation) {
          earlyAuthority = {
            paneId: markerPaneId,
            panePid: markerIncarnation.panePid,
            sessionName,
            sessionId: markerIncarnation.sessionId,
            ownerId: teamPaneOwnerId,
            ownerOption,
            ownerProof: provisionalProof,
            ownerTagged: false,
            operationMarker,
          };
          operationPaneIds.add(markerPaneId);
          operationPaneAuthorities.set(markerPaneId, earlyAuthority);
        }
      }
      if (splitAuthority && preSplitGlobalPaneIds.has(splitAuthority.paneId)) {
        return await rollbackScaleUp(`Failed to validate fresh tmux split authority for ${workerName}`, {
          paneId: earlyAuthority?.paneId, workerName, worktreePath: workerWorkspace?.worktreePath,
        });
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
      if (!paneId || (splitAuthority && paneId !== splitAuthority.paneId)) {
        return await rollbackScaleUp(`Failed to derive exact tmux pane delta for ${workerName}`, {
          paneId: earlyAuthority?.paneId ?? splitAuthority?.paneId, workerName, worktreePath: workerWorkspace?.worktreePath,
        });
      }
      const incarnation = readScalePaneIncarnation(paneId);
      if (!incarnation || (splitAuthority && (incarnation.panePid !== splitAuthority.panePid || incarnation.sessionId !== splitAuthority.sessionId))) {
        return await rollbackScaleUp(`Failed to capture tmux pane incarnation for ${workerName}`, {
          paneId, workerName, worktreePath: workerWorkspace?.worktreePath,
        });
      }
      const provisionalAuthority: VerifiedScaleSplitPane = earlyAuthority ?? {
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
      if (!earlyAuthority) {
        operationPaneIds.add(paneId);
        operationPaneAuthorities.set(paneId, provisionalAuthority);
      }
      if ((!splitAuthority && splitScalar !== paneId) || (splitAuthority && splitAuthority.paneId !== paneId)) {
        return await rollbackScaleUp(`Failed to validate tmux split output for ${workerName}`, {
          paneId, workerName, worktreePath: workerWorkspace?.worktreePath,
        });
      }
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
      throwIfScaleUpFailureInjected(env, 'inbox');


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
          worker: workerInfo,
        });
      }
      throwIfScaleUpFailureInjected(env, 'post-dispatch-rollback');

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
      throwIfScaleUpFailureInjected(env, 'config');

      await saveTeamConfig(config, leaderCwd);
      throwIfScaleUpFailureInjected(env, 'finalization');
      } catch (error) {
        return await rollbackScaleUp(
          `scale_up_worker_materialization_failed:${workerName}:${error instanceof Error ? error.message : String(error)}`,
          { paneId, worker: workerInfo },
        );
      }
    }

    try {
      await appendTeamEvent(sanitized, {
        type: 'team_leader_nudge',
        worker: 'leader-fixed',
        reason: `scale_up: added ${count} worker(s), new count=${config.worker_count}`,
      }, leaderCwd);
    } catch (error) {
      return await rollbackScaleUp(
        `scale_up_finalization_failed:${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      ok: true,
      addedWorkers,
      newWorkerCount: config.worker_count,
      nextWorkerIndex: nextIndex,
    };
    });
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

interface ScaleDownCleanupDebtPane {
  name?: string;
  index?: number;
  pane_id: string;
  pid: number | null;
}

interface ScaleDownCleanupDebtResource {
  name: string;
  worktree_path?: string;
  worktree_repo_root?: string;
  worktree_branch?: string;
  worktree_detached?: boolean;
  worktree_created?: boolean;
  team_state_root?: string;
}

interface ScaleDownCleanupDebt {
  schema_version: 1;
  operation: 'scale_down';
  status: string;
  created_at?: string;
  updated_at?: string;
  workers?: ScaleDownCleanupDebtPane[];
  unresolved_panes?: ScaleDownCleanupDebtPane[];
  resource_workers?: ScaleDownCleanupDebtResource[];
  reasons?: string[];
  removed_worker_names?: string[];
}

interface PathContainmentSemantics {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

export function isSameOrInsidePath(
  path: string,
  root: string,
  pathSemantics: PathContainmentSemantics = { relative, isAbsolute, sep },
): boolean {
  const relativePath = pathSemantics.relative(root, path);
  return relativePath === ''
    || (!pathSemantics.isAbsolute(relativePath)
      && relativePath !== '..'
      && !relativePath.startsWith(`..${pathSemantics.sep}`));
}

async function assertExistingPathParentContained(path: string, root: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  let candidate = resolve(path);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error(`scale_down_cleanup_debt_path_missing_parent:${path}`);
    candidate = parent;
  }
  const canonicalExistingPath = await realpath(candidate);
  if (!isSameOrInsidePath(canonicalExistingPath, canonicalRoot)) {
    throw new Error(`scale_down_cleanup_debt_path_escape:${path}`);
  }
}

async function validateScaleDownCleanupResources(
  teamName: string,
  leaderCwd: string,
  teamStateRoot: string,
  workers: readonly ScaleDownCleanupDebtResource[],
): Promise<void> {
  const canonicalLeaderCwd = await realpath(leaderCwd);
  let repoRoot = canonicalLeaderCwd;
  const repoRootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: leaderCwd,
    encoding: 'utf-8',
    windowsHide: true,
  });
  const reportedRepoRoot = (repoRootResult.stdout || '').trim();
  if (repoRootResult.status === 0 && reportedRepoRoot) {
    repoRoot = await realpath(resolve(reportedRepoRoot));
  }
  const canonicalTeamStateRoot = await realpath(resolve(teamStateRoot));
  const expectedWorkerRoot = join(canonicalTeamStateRoot, 'team', teamName, 'workers');

  for (const worker of workers) {
    const expectedWorkerDirectory = join(expectedWorkerRoot, worker.name);
    await assertExistingPathParentContained(expectedWorkerDirectory, canonicalTeamStateRoot);
    if (worker.team_state_root !== undefined
      && (!isAbsolute(worker.team_state_root) || worker.team_state_root !== resolve(worker.team_state_root)
        || resolve(worker.team_state_root) !== canonicalTeamStateRoot)) {
      throw new Error(`scale_down_cleanup_debt_invalid_team_state_root:${worker.name}`);
    }
    if (worker.worktree_path === undefined) {
      if (worker.worktree_repo_root !== undefined || worker.worktree_branch !== undefined
        || worker.worktree_detached !== undefined || worker.worktree_created !== undefined) {
        throw new Error(`scale_down_cleanup_debt_invalid_worktree_metadata:${worker.name}`);
      }
      continue;
    }

    const expectedWorktreePath = join(repoRoot, '.omx', 'team', teamName, 'worktrees', worker.name);
    if (!isAbsolute(worker.worktree_path) || worker.worktree_path !== resolve(worker.worktree_path)
      || resolve(worker.worktree_path) !== expectedWorktreePath
      || (worker.worktree_repo_root !== undefined && (
        !isAbsolute(worker.worktree_repo_root)
        || worker.worktree_repo_root !== resolve(worker.worktree_repo_root)
        || resolve(worker.worktree_repo_root) !== repoRoot
      ))
      || (worker.worktree_detached !== undefined && typeof worker.worktree_detached !== 'boolean')
      || (worker.worktree_created !== undefined && typeof worker.worktree_created !== 'boolean')
      || (worker.worktree_created === true && (
        typeof worker.worktree_repo_root !== 'string' || typeof worker.worktree_detached !== 'boolean'
      ))) {
      throw new Error(`scale_down_cleanup_debt_invalid_worktree_target:${worker.name}`);
    }
    await assertExistingPathParentContained(expectedWorktreePath, repoRoot);
    if (existsSync(expectedWorktreePath) && await realpath(expectedWorktreePath) !== expectedWorktreePath) {
      throw new Error(`scale_down_cleanup_debt_worktree_symlink:${worker.name}`);
    }
  }
}

async function cleanupScaleDownResources(
  teamName: string,
  teamStateRoot: string,
  workers: readonly ScaleDownCleanupDebtResource[],
): Promise<void> {
  for (const worker of workers) {
    // An absent exact worktree means a prior cleanup completed before crashing.
    // Do not replay a restoration or git removal against a replacement path.
    if (worker.worktree_path && existsSync(worker.worktree_path)) {
      await removeWorkerWorktreeRootAgentsFile(
        teamName,
        worker.name,
        worker.team_state_root ?? teamStateRoot,
        worker.worktree_path,
      );
    }
  }
  const worktrees: EnsureWorktreeResult[] = workers
    .filter((worker): worker is ScaleDownCleanupDebtResource & {
      worktree_path: string;
      worktree_repo_root: string;
      worktree_detached: boolean;
      worktree_created: true;
    } => worker.worktree_created === true
      && typeof worker.worktree_path === 'string'
      && existsSync(worker.worktree_path)
      && typeof worker.worktree_repo_root === 'string'
      && typeof worker.worktree_detached === 'boolean')
    .map((worker) => ({
      enabled: true,
      repoRoot: worker.worktree_repo_root,
      worktreePath: worker.worktree_path,
      detached: worker.worktree_detached,
      branchName: worker.worktree_branch ?? null,
      created: true,
      reused: false,
      // Membership records do not establish branch ownership. Preserve a named
      // branch rather than deleting one that may have predated this worker.
      createdBranch: false,
    }));
  if (worktrees.length > 0) await rollbackProvisionedWorktrees(worktrees);
  await Promise.all(workers.map(async (worker) => {
    await rm(join(teamStateRoot, 'team', teamName, 'workers', worker.name), { recursive: true, force: true });
  }));
}

function asScaleDownDebtResources(
  debt: ScaleDownCleanupDebt,
  removedWorkerNames: readonly string[],
): ScaleDownCleanupDebtResource[] | null {
  const resources = debt.resource_workers;
  if (!Array.isArray(resources) || resources.length !== removedWorkerNames.length) return null;
  const expected = new Set(removedWorkerNames);
  const seen = new Set<string>();
  for (const worker of resources) {
    if (!worker || typeof worker.name !== 'string' || !expected.has(worker.name) || seen.has(worker.name)
      || (worker.worktree_path !== undefined && typeof worker.worktree_path !== 'string')
      || (worker.worktree_repo_root !== undefined && typeof worker.worktree_repo_root !== 'string')
      || (worker.worktree_branch !== undefined && typeof worker.worktree_branch !== 'string')
      || (worker.worktree_detached !== undefined && typeof worker.worktree_detached !== 'boolean')
      || (worker.worktree_created !== undefined && typeof worker.worktree_created !== 'boolean')
      || (worker.team_state_root !== undefined && typeof worker.team_state_root !== 'string')) return null;
    seen.add(worker.name);
  }
  return resources;
}

function asScaleDownDebtPanes(
  debt: ScaleDownCleanupDebt,
  removedWorkerNames: readonly string[],
  resources: readonly ScaleDownCleanupDebtResource[],
  leaderPaneId: string | null | undefined,
  hudPaneId: string | null | undefined,
): ScaleDownCleanupDebtPane[] | null {
  const workers = debt.workers;
  const unresolved = debt.unresolved_panes;
  if (!Array.isArray(workers) || (unresolved !== undefined && !Array.isArray(unresolved))) return null;

  const expectedNames = new Set(removedWorkerNames);
  const resourceNames = new Set(resources.map((resource) => resource.name));
  const canonicalByName = new Map<string, ScaleDownCleanupDebtPane>();
  const allPaneIds = new Set<string>();
  const normalizedLeaderPaneId = typeof leaderPaneId === 'string' ? leaderPaneId.trim() : '';
  const normalizedHudPaneId = typeof hudPaneId === 'string' ? hudPaneId.trim() : '';
  const validate = (pane: ScaleDownCleanupDebtPane, requireCanonicalMatch: boolean): boolean => {
    if (!pane || typeof pane.name !== 'string' || !expectedNames.has(pane.name) || !resourceNames.has(pane.name)
      || typeof pane.index !== 'number' || !Number.isInteger(pane.index) || pane.index <= 0
      || pane.index !== Number(pane.name.slice('worker-'.length))
      || typeof pane.pane_id !== 'string' || !/^%\d+$/.test(pane.pane_id)
      || pane.pane_id === normalizedLeaderPaneId || pane.pane_id === normalizedHudPaneId
      || (pane.pid !== null && (!Number.isSafeInteger(pane.pid) || pane.pid <= 0))) return false;
    const canonical = canonicalByName.get(pane.name);
    if (requireCanonicalMatch) {
      return canonical !== undefined
        && canonical.index === pane.index
        && canonical.pane_id === pane.pane_id
        && canonical.pid === pane.pid;
    }
    if (canonical !== undefined || allPaneIds.has(pane.pane_id)) return false;
    canonicalByName.set(pane.name, pane);
    allPaneIds.add(pane.pane_id);
    return true;
  };

  for (const worker of workers) {
    if (!validate(worker, false)) return null;
  }
  const unresolvedNames = new Set<string>();
  const unresolvedPaneIds = new Set<string>();
  for (const pane of unresolved ?? []) {
    if (unresolvedNames.has(pane.name ?? '') || unresolvedPaneIds.has(pane.pane_id)
      || !validate(pane, true)) return null;
    unresolvedNames.add(pane.name!);
    unresolvedPaneIds.add(pane.pane_id);
  }
  return unresolved && unresolved.length > 0 ? unresolved : workers;
}

async function hasMatchingScaleDownDebtWorkerIdentity(
  teamStateRoot: string,
  teamName: string,
  pane: ScaleDownCleanupDebtPane,
): Promise<boolean> {
  try {
    const identity = JSON.parse(await readFile(
      join(teamStateRoot, 'team', teamName, 'workers', pane.name ?? '', 'identity.json'),
      'utf8',
    )) as Partial<WorkerInfo>;
    return identity.name === pane.name
      && identity.index === pane.index
      && identity.pane_id === pane.pane_id
      && identity.pid === pane.pid;
  } catch {
    return false;
  }
}

export async function reconcileScaleDownCleanupDebt(
  teamName: string,
  cwd: string,
  _callerConfig: TeamConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sanitized = sanitizeTeamName(teamName);
  const leaderCwd = resolve(cwd);
  return await withTaskMembershipBarrier(sanitized, leaderCwd, async () => {
    await recoverTeamMembershipTaskTransaction(sanitized, leaderCwd);
    // Authorization is derived only from the canonical state observed under the
    // membership barrier; callers may hold a stale pre-transaction config.
    const config = await readTeamConfig(sanitized, leaderCwd);
    if (!config) return { ok: false, error: `Team ${sanitized} not found` };
    const teamStateRoot = config.team_state_root ?? resolveCanonicalTeamStateRoot(leaderCwd);
    const cleanupDebtPath = join(teamStateRoot, 'team', sanitized, '.scale-down-cleanup-debt.json');
    if (!existsSync(cleanupDebtPath)) return { ok: true };

    let debt: ScaleDownCleanupDebt;
    try {
      debt = JSON.parse(await readFile(cleanupDebtPath, 'utf8')) as ScaleDownCleanupDebt;
    } catch (error) {
      return { ok: false, error: `scale_down_cleanup_debt_unreadable:${String(error)}` };
    }
    if (debt.schema_version !== 1 || debt.operation !== 'scale_down') {
      return { ok: false, error: 'scale_down_cleanup_debt_malformed' };
    }
    const removedWorkerNames = Array.isArray(debt.removed_worker_names)
      ? debt.removed_worker_names
      : (Array.isArray(debt.workers) ? debt.workers.map((worker) => worker?.name).filter((name): name is string => typeof name === 'string') : []);
    if (removedWorkerNames.length === 0
      || removedWorkerNames.some((name) => !/^worker-\d+$/.test(name))
      || new Set(removedWorkerNames).size !== removedWorkerNames.length) {
      return { ok: false, error: 'scale_down_cleanup_debt_malformed' };
    }
    const resources = asScaleDownDebtResources(debt, removedWorkerNames);
    if (!resources) return { ok: false, error: 'scale_down_cleanup_debt_malformed' };
    try {
      await validateScaleDownCleanupResources(sanitized, leaderCwd, teamStateRoot, resources);
    } catch {
      return { ok: false, error: 'scale_down_cleanup_debt_malformed' };
    }
    const panes = asScaleDownDebtPanes(
      debt,
      removedWorkerNames,
      resources,
      config.leader_pane_id,
      config.hud_pane_id,
    );
    // Validate all journal bindings before classifying or mutating recovery state.
    // A journal is evidence, never authority to target an arbitrary global pane.
    if (!panes) return { ok: false, error: 'scale_down_cleanup_debt_malformed' };
    const stillCanonical = removedWorkerNames.filter((name) => config.workers.some((worker) => worker.name === name));
    // A pre-commit journal is not authorization to kill or remove anything.
    if (stillCanonical.length === removedWorkerNames.length) {
      await removeDurableFile(cleanupDebtPath);
      return { ok: true };
    }
    if (stillCanonical.length > 0) return { ok: false, error: 'scale_down_cleanup_debt_membership_inconsistent' };
    // A cleanup journal may never reuse a pane identity held by a worker that
    // survived the committed membership update. This is checked before any
    // liveness or owner probes so malformed debt cannot cause a tmux effect.
    const survivingWorkers = config.workers.filter((worker) => !removedWorkerNames.includes(worker.name));
    if (panes.some((pane) => survivingWorkers.some((worker) => (
      worker.pane_id === pane.pane_id
      || (pane.pid !== null && worker.pid === pane.pid)
    )))) {
      return { ok: false, error: 'scale_down_cleanup_debt_malformed' };
    }
    const resolvedPaneIds = new Set<string>();
    const reasons: string[] = [];
    const expectedOwnerId = typeof config.tmux_pane_owner_id === 'string'
      ? config.tmux_pane_owner_id.trim()
      : '';
    for (const pane of panes) {
      // Legacy PID-less records can establish convergence from an authoritative
      // global absence/dead proof, but can never authorize a live-pane effect.
      const freshProof = readExactPaneProofSync(pane.pane_id);
      if (freshProof.status === 'gone') {
        resolvedPaneIds.add(pane.pane_id);
        continue;
      }
      if (freshProof.status === 'unavailable') {
        reasons.push(`${pane.pane_id}:${freshProof.reason}`);
        continue;
      }
      if (pane.pid === null) {
        reasons.push(`${pane.pane_id}:legacy_pid_missing_live`);
        continue;
      }
      if (freshProof.pid !== pane.pid) {
        reasons.push(`${pane.pane_id}:pane_pid_changed`);
        continue;
      }
      // A live debt pane must remain bound to the removed worker's recorded
      // identity; the team-wide owner token alone only proves team membership.
      if (!await hasMatchingScaleDownDebtWorkerIdentity(teamStateRoot, sanitized, pane)) {
        reasons.push(`${pane.pane_id}:worker_identity_unavailable`);
        continue;
      }
      // Owner reads are authoritative only for this canonical Team token. Missing,
      // mismatched, and unavailable tags all fail closed for a live pane effect.
      if (!expectedOwnerId) {
        reasons.push(`${pane.pane_id}:team_owner_unavailable`);
        continue;
      }
      const owner = readPaneTeamOwnerTagResult(pane.pane_id);
      if (owner.status === 'error') {
        reasons.push(`${pane.pane_id}:team_owner_unavailable`);
        continue;
      }
      if (owner.status !== 'value' || owner.value !== expectedOwnerId) {
        reasons.push(`${pane.pane_id}:team_owner_mismatch`);
        continue;
      }
      // teardownWorkerPanes re-proves this exact pane immediately before the kill
      // and pins the same durable PID through the kill confirmation.
      const teardown = await teardownWorkerPanes([pane.pane_id], {
        leaderPaneId: config.leader_pane_id,
        hudPaneId: config.hud_pane_id,
        expectedPanePids: { [pane.pane_id]: pane.pid },
        authorizePaneKill: (paneId) => {
          const currentOwner = readPaneTeamOwnerTagResult(paneId);
          return currentOwner.status === 'value' && currentOwner.value === expectedOwnerId;
        },
      });
      if (teardown.provenGonePaneIds.includes(pane.pane_id) || teardown.killedPaneIds.includes(pane.pane_id)) {
        resolvedPaneIds.add(pane.pane_id);
        continue;
      }
      reasons.push(...teardown.proofUnavailable.map((proof) => `${proof.paneId}:${proof.reason}`));
      reasons.push(...teardown.kill.failedPaneIds.map((paneId) => `${paneId}:kill_failed`));
      if (teardown.proofUnavailable.length === 0 && teardown.kill.failedPaneIds.length === 0) {
        reasons.push(`${pane.pane_id}:teardown_unresolved`);
      }
    }
    const unresolvedPanes = panes.filter((pane) => !resolvedPaneIds.has(pane.pane_id));
    if (unresolvedPanes.length > 0) {
      await writeAtomic(cleanupDebtPath, JSON.stringify({
        ...debt,
        status: 'unresolved',
        updated_at: new Date().toISOString(),
        unresolved_panes: unresolvedPanes,
        reasons,
      }, null, 2));
      return { ok: false, error: `scale_down_cleanup_debt_unresolved:${unresolvedPanes.map((pane) => pane.pane_id).join(',')}` };
    }
    try {
      await cleanupScaleDownResources(sanitized, teamStateRoot, resources);
    } catch (error) {
      await writeAtomic(cleanupDebtPath, JSON.stringify({
        ...debt,
        status: 'resource_cleanup_pending',
        updated_at: new Date().toISOString(),
        unresolved_panes: [],
        reasons: [`resource_cleanup_failed:${String(error)}`],
      }, null, 2));
      return { ok: false, error: `scale_down_cleanup_debt_resource_cleanup_failed:${String(error)}` };
    }
    await removeDurableFile(cleanupDebtPath);
    return { ok: true };
  });
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
    const config = await withTaskMembershipBarrier(sanitized, leaderCwd, async () => {
      await recoverTeamMembershipTaskTransaction(sanitized, leaderCwd);
      return await readTeamConfig(sanitized, leaderCwd);
    });
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
    const priorWorkerStatusArtifacts = new Map<string, { exists: true; raw: Buffer } | { exists: false }>();
    for (const worker of targetWorkers) {
      const statusPath = join(teamStateRoot, 'team', sanitized, 'workers', worker.name, 'status.json');
      try {
        priorWorkerStatusArtifacts.set(worker.name, { exists: true, raw: await readFile(statusPath) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          priorWorkerStatusArtifacts.set(worker.name, { exists: false });
        } else {
          throw error;
        }
      }
    }
    const restorePriorWorkerStatuses = async (workers: readonly WorkerInfo[]): Promise<void> => {
      await Promise.all(workers.map(async (worker) => {
        const statusPath = join(teamStateRoot, 'team', sanitized, 'workers', worker.name, 'status.json');
        const priorArtifact = priorWorkerStatusArtifacts.get(worker.name);
        if (priorArtifact?.exists) {
          await writeFile(statusPath, priorArtifact.raw);
        } else {
          await rm(statusPath, { force: true });
        }
      }));
    };



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
    const expectedTargetPaneSessionIds = new Map<string, string>();
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
      const incarnation = readScalePaneIncarnation(canonicalPaneId);
      if (!incarnation || incarnation.panePid !== String(panePid)) {
        return { ok: false, error: 'failed_to_validate_team_tmux_pane_authority' };
      }
      targetPaneIds.push(canonicalPaneId);
      expectedTargetPanePids.set(canonicalPaneId, panePid);
      expectedTargetPaneSessionIds.set(canonicalPaneId, incarnation.sessionId);
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
        expectedPaneSessionIds: expectedTargetPaneSessionIds,
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
    if (teardownFailure) return teardownFailure;
    targetWorkers = removableWorkers;

    // Resource cleanup remains represented by the committed debt until every
    // worker directory, status, generated AGENTS file, and provisioned worktree
    // has converged. Reconciliation reacquires authority before consuming it.
    removedNames.push(...targetWorkers.map((worker) => worker.name));
    const resourceCleanup = await reconcileScaleDownCleanupDebt(sanitized, leaderCwd, config);
    if (!resourceCleanup.ok) return resourceCleanup;
    const reason = `scale_down: removed ${removedNames.length} worker(s) [${removedNames.join(', ')}], new count=${config.worker_count}`;
    try {
      await appendTeamEvent(sanitized, { type: 'team_leader_nudge', worker: 'leader-fixed', reason }, leaderCwd);
    } catch {
      // The cleanup transaction has already converged; event delivery is advisory.
    }
    return { ok: true, removedWorkers: removedNames, newWorkerCount: config.worker_count };
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
