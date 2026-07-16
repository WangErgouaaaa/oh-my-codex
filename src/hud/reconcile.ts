import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readAllState, readHudConfig } from './state.js';
import { getHudRenderMaxLines } from './render.js';
import { HUD_TMUX_HEIGHT_LINES, isTmuxWindowTooCrampedForHudSplit } from './constants.js';
import {
  buildHudWatchCommand,
  createHudWatchPane,
  findLegacyFocusedHudWatchPaneIds,
  findHudWatchPaneIds,
  isHudWatchPane,
  hasValidHudOwnerMarker,
  killTmuxPaneIfCurrent,
  listCurrentWindowPanes,
  readCurrentWindowSize,
  readHudPaneOwner,
  registerHudResizeHook,
  unregisterHudResizeHook,
  resizeTmuxPaneIfCurrent,
  parseCanonicalTmuxPaneId,
  rollbackHudWatchPaneAuthority,
  verifyHudWatchPaneAuthority,
  hudPaneMatchesOwner,
  type HudPaneOwner,
  type TmuxPaneSnapshot,

} from './tmux.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';

export const OMX_TMUX_HUD_OWNER_ENV = 'OMX_TMUX_HUD_OWNER';

function isExplicitOmxOwnedTmuxEnv(env: NodeJS.ProcessEnv): boolean {
  return env[OMX_TMUX_HUD_OWNER_ENV] === '1';
}

function isStrictLivePaneSnapshot(panes: readonly TmuxPaneSnapshot[], currentPaneId: string | undefined): boolean {
  const canonicalCurrentPaneId = parseCanonicalTmuxPaneId(currentPaneId);
  if (!canonicalCurrentPaneId || panes.length === 0) return false;
  const paneIds = new Set<string>();
  for (const pane of panes) {
    if (
      parseCanonicalTmuxPaneId(pane.paneId) !== pane.paneId
      || pane.paneDead !== false
      || !/^[1-9][0-9]*$/.test(pane.panePid ?? '')
      || paneIds.has(pane.paneId)
    ) return false;
    paneIds.add(pane.paneId);
  }
  return paneIds.has(canonicalCurrentPaneId);
}

function samePaneIncarnation(expected: TmuxPaneSnapshot, observed: TmuxPaneSnapshot): boolean {
  return expected.paneId === observed.paneId
    && expected.panePid === observed.panePid
    && expected.paneDead === false
    && observed.paneDead === false;
}

function sameLeaderIncarnation(
  expectedLeader: TmuxPaneSnapshot,
  observedPanes: readonly TmuxPaneSnapshot[],
): boolean {
  const observedLeader = observedPanes.find((pane) => pane.paneId === expectedLeader.paneId);
  return Boolean(observedLeader && !isHudWatchPane(observedLeader) && samePaneIncarnation(expectedLeader, observedLeader));
}

function readFreshLeaderPane(
  expectedLeader: TmuxPaneSnapshot,
  currentPaneId: string | undefined,
  listPanes: (currentPaneId?: string) => TmuxPaneSnapshot[],
): TmuxPaneSnapshot | null {
  const panes = listPanes(currentPaneId);
  return isStrictLivePaneSnapshot(panes, currentPaneId) && sameLeaderIncarnation(expectedLeader, panes)
    ? panes.find((pane) => pane.paneId === expectedLeader.paneId) ?? null
    : null;
}

type FreshHudKillPredicate = (pane: TmuxPaneSnapshot, panes: readonly TmuxPaneSnapshot[]) => boolean;

function killFreshHudPanes(
  paneIds: readonly string[],
  expectedPanes: readonly TmuxPaneSnapshot[],
  expectedLeader: TmuxPaneSnapshot,
  currentPaneId: string | undefined,
  listPanes: (currentPaneId?: string) => TmuxPaneSnapshot[],
  killPane: (pane: TmuxPaneSnapshot) => boolean,
  shouldKill: FreshHudKillPredicate,
): { reaped: string[]; complete: boolean } {
  const candidatePaneIds = [...new Set(paneIds)];
  if (candidatePaneIds.some((paneId) => parseCanonicalTmuxPaneId(paneId) !== paneId)) {
    return { reaped: [], complete: false };
  }
  const expectedById = new Map(expectedPanes.map((pane) => [pane.paneId, pane]));

  const reaped: string[] = [];
  for (const paneId of candidatePaneIds) {
    // A pane id can be recycled after a prior kill. Re-read the complete window
    // immediately before every sink and re-prove owner and exact PID incarnation.
    const panes = listPanes(currentPaneId);
    if (!isStrictLivePaneSnapshot(panes, currentPaneId) || !sameLeaderIncarnation(expectedLeader, panes)) {
      return { reaped, complete: false };
    }
    const pane = panes.find((candidate) => candidate.paneId === paneId);
    const expectedPane = expectedById.get(paneId);
    if (!pane || !expectedPane || !samePaneIncarnation(expectedPane, pane) || !isHudWatchPane(pane) || !shouldKill(pane, panes) || !killPane(pane)) {
      return { reaped, complete: false };
    }
    reaped.push(paneId);
  }
  return { reaped, complete: true };
}

function matchesOwnedHudScope(
  pane: TmuxPaneSnapshot,
  panes: readonly TmuxPaneSnapshot[],
  currentPaneId: string | undefined,
  owner: HudPaneOwner,
): boolean {
  return hudPaneMatchesOwner(pane, owner)
    || findLegacyFocusedHudWatchPaneIds([...panes], currentPaneId).includes(pane.paneId);
}

function matchesFreshHudPane(
  paneId: string,
  expectedPane: TmuxPaneSnapshot,
  expectedLeader: TmuxPaneSnapshot,
  currentPaneId: string | undefined,
  owner: HudPaneOwner,
  listPanes: (currentPaneId?: string) => TmuxPaneSnapshot[],
): TmuxPaneSnapshot | null {
  const readFreshPane = (): TmuxPaneSnapshot | null => {
    const panes = listPanes(currentPaneId);
    if (!isStrictLivePaneSnapshot(panes, currentPaneId) || !sameLeaderIncarnation(expectedLeader, panes)) return null;
    const pane = panes.find((candidate) => candidate.paneId === paneId);
    if (!pane || !samePaneIncarnation(expectedPane, pane) || !isHudWatchPane(pane) || !matchesOwnedHudScope(pane, panes, currentPaneId, owner)) return null;
    return pane.startCommand === expectedPane.startCommand
      && pane.currentCommand === expectedPane.currentCommand
      && pane.currentPath === expectedPane.currentPath
      ? pane
      : null;
  };

  const first = readFreshPane();
  if (!first) return null;
  const second = readFreshPane();
  return second
    && samePaneIncarnation(first, second)
    && second.startCommand === first.startCommand
    && second.currentCommand === first.currentCommand
    && second.currentPath === first.currentPath
    ? second
    : null;
}

function failedReconcileResult(desiredHeight: number | null = null, duplicateCount = 0): ReconcileHudForPromptSubmitResult {
  return { status: 'failed', paneId: null, desiredHeight, duplicateCount };
}


/**
 * Kill HUD watch panes that belong to the *current* session but whose owning
 * leader pane is no longer alive in this window.
 *
 * When a leader pane is destroyed (e.g. during a `team` setup/teardown cycle that
 * tears down the leader REPL pane), its owner-tagged HUD panes are left pointing at
 * the dead leader id. They are matched by neither `findHudWatchPaneIds` — whose
 * owner check requires the recorded leader to equal the current pane — nor
 * `findLegacyFocusedHudWatchPaneIds`, which only adopts HUD panes that *lack* owner
 * metadata. So the reconcile below sees "no HUD", recreates one, and repeats on
 * every prompt submit until the window degenerates into a column of stacked HUD
 * strips with no leader or worker panes left.
 *
 * The reap is intentionally scoped to the current session: HUD panes owned by other
 * sessions (whose leader may legitimately live in a different tmux window we cannot
 * see from this window's pane list) are never touched.
 */
function reapOrphanedSessionHudPanes(
  panes: TmuxPaneSnapshot[],
  opts: {
    sessionId: string | undefined;
    sessionIds?: string[];
    currentPaneId: string | undefined;
    expectedLeader: TmuxPaneSnapshot;
    listPanes: (currentPaneId?: string) => TmuxPaneSnapshot[];
    killPane: (pane: TmuxPaneSnapshot) => boolean;
  },
): { reaped: string[]; complete: boolean } {
  const { sessionId, currentPaneId, killPane, listPanes } = opts;
  const sameSessionIds = new Set(
    [sessionId, ...(opts.sessionIds ?? [])]
      .map((candidate) => candidate?.trim() ?? '')
      .filter((candidate) => candidate !== ''),
  );
  if (sameSessionIds.size === 0) return { reaped: [], complete: true };
  const liveNonHudPaneIds = new Set(
    panes.filter((pane) => !isHudWatchPane(pane)).map((pane) => pane.paneId),
  );
  const orphanPaneIds = panes
    .filter((pane) => isHudWatchPane(pane))
    .filter((pane) => {
      const owner = readHudPaneOwner(pane);
      return Boolean(owner.sessionId && sameSessionIds.has(owner.sessionId) && owner.leaderPaneId)
        && owner.leaderPaneId !== currentPaneId
        && !liveNonHudPaneIds.has(owner.leaderPaneId!);

    })
    .map((pane) => pane.paneId);

  return killFreshHudPanes(orphanPaneIds, panes, opts.expectedLeader, currentPaneId, listPanes, killPane, (pane, freshPanes) => {
    const owner = readHudPaneOwner(pane);
    if (!owner.sessionId || !sameSessionIds.has(owner.sessionId) || !owner.leaderPaneId) return false;
    const liveNonHudPaneIds = new Set(
      freshPanes.filter((candidate) => !isHudWatchPane(candidate)).map((candidate) => candidate.paneId),
    );
    return owner.leaderPaneId !== currentPaneId && !liveNonHudPaneIds.has(owner.leaderPaneId);
  });
}


function reapStaleCurrentLeaderHudPanes(
  panes: TmuxPaneSnapshot[],
  opts: {
    sessionIds: string[];
    currentPaneId: string | undefined;
    listPanes: (currentPaneId?: string) => TmuxPaneSnapshot[];
    expectedLeader: TmuxPaneSnapshot;
    killPane: (pane: TmuxPaneSnapshot) => boolean;
  },
): { reaped: string[]; complete: boolean } {
  const { currentPaneId, killPane, listPanes } = opts;
  if (!currentPaneId) return { reaped: [], complete: true };
  const currentSessionIds = new Set(opts.sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean));
  if (currentSessionIds.size === 0) return { reaped: [], complete: true };
  const stalePaneIds = panes
    .filter((pane) => isHudWatchPane(pane))
    .filter((pane) => {
      const owner = readHudPaneOwner(pane);
      return owner.leaderPaneId === currentPaneId
        && hasValidHudOwnerMarker(pane)
        && Boolean(owner.sessionId && !currentSessionIds.has(owner.sessionId));
    })
    .map((pane) => pane.paneId);

  return killFreshHudPanes(stalePaneIds, panes, opts.expectedLeader, currentPaneId, listPanes, killPane, (pane) => {
    const owner = readHudPaneOwner(pane);
    return owner.leaderPaneId === currentPaneId
      && hasValidHudOwnerMarker(pane)
      && Boolean(owner.sessionId && !currentSessionIds.has(owner.sessionId));
  });
}

export interface ReconcileHudForPromptSubmitResult {
  status:
    | 'skipped_not_tmux'
    | 'skipped_no_entry'
    | 'skipped_not_omx_owned_tmux'
    | 'skipped_no_session_id'
    | 'skipped_window_too_cramped'
    | 'unchanged'
    | 'resized'
    | 'recreated'
    | 'replaced_duplicates'
    | 'skipped_concurrent'
    | 'failed';
  paneId: string | null;
  desiredHeight: number | null;
  duplicateCount: number;
}

export interface ReconcileHudForPromptSubmitDeps {
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  sessionIds?: string[];
  listCurrentWindowPanes?: (currentPaneId?: string) => TmuxPaneSnapshot[];
  createHudWatchPane?: (
    cwd: string,
    hudCmd: string,
    options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string },
  ) => string | null;
  killTmuxPane?: (paneId: string) => boolean;
  resizeTmuxPane?: (paneId: string, heightLines: number) => boolean;
  readHudConfig?: typeof readHudConfig;
  readAllState?: typeof readAllState;
  resolveOmxCliEntryPath?: typeof resolveOmxCliEntryPath;
  registerHudResizeHook?: (
    hudPaneId: string,
    leaderPaneId: string | undefined,
    heightLines: number,
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => boolean;
  unregisterHudResizeHook?: (leaderPaneId: string | undefined) => boolean;
  readCurrentWindowSize?: (currentPaneId?: string) => { width: number | null; height: number | null };
  nowMs?: () => number;
  isProcessLive?: (pid: number) => boolean | null;
}

function ensureHudResizeHook(
  hudPaneId: string,
  leaderPaneId: string | undefined,
  desiredHeight: number,
  cwd: string,
  deps: ReconcileHudForPromptSubmitDeps,
): void {
  try {
    (deps.registerHudResizeHook ?? registerHudResizeHook)(hudPaneId, leaderPaneId, desiredHeight, {
      cwd,
      env: deps.env ?? process.env,
    });
  } catch {
    // Non-critical — hook registration failure does not break HUD lifecycle.
  }
}

function hasCompleteGeometry(pane: TmuxPaneSnapshot): boolean {
  return (
    typeof pane.paneLeft === 'number'
    && typeof pane.paneWidth === 'number'
    && typeof pane.paneBottom === 'number'
    && typeof pane.windowWidth === 'number'
    && typeof pane.windowHeight === 'number'
  );
}

function needsHudTopologyRecreate(pane: TmuxPaneSnapshot, leaderPane?: TmuxPaneSnapshot): boolean {
  if (!hasCompleteGeometry(pane)) return false;
  const expectedLeft = typeof leaderPane?.paneLeft === 'number' ? leaderPane.paneLeft : 0;
  const expectedWidth = typeof leaderPane?.paneWidth === 'number' ? leaderPane.paneWidth : pane.windowWidth;
  const spansExpectedWidth = pane.paneLeft === expectedLeft && pane.paneWidth === expectedWidth;
  const touchesWindowBottom = pane.paneBottom === (pane.windowHeight ?? 0) - 1;
  return !spansExpectedWidth || !touchesWindowBottom;
}

function shouldCreateFullWidthHud(leaderPane?: TmuxPaneSnapshot): boolean {
  return Boolean(
    leaderPane
    && typeof leaderPane.paneLeft === 'number'
    && typeof leaderPane.paneWidth === 'number'
    && typeof leaderPane.windowWidth === 'number'
    && leaderPane.paneLeft === 0
    && leaderPane.paneWidth === leaderPane.windowWidth,
  );
}

function needsHudHeightResize(pane: TmuxPaneSnapshot, desiredHeight: number): boolean {
  return typeof pane.paneHeight !== 'number' || pane.paneHeight !== desiredHeight;
}

function planOwnedHudPaneDedupe(
  panes: TmuxPaneSnapshot[],
  currentPaneId: string | undefined,
  owner: HudPaneOwner,
  preferredPaneId: string,
): { paneId: string; duplicatePaneIds: string[] } {
  const ownedPaneIds = [
    ...findHudWatchPaneIds(panes, currentPaneId, owner),
    ...findLegacyFocusedHudWatchPaneIds(panes, currentPaneId),
  ].filter((paneId, index, paneIds) => paneIds.indexOf(paneId) === index);
  const keeperPaneId = ownedPaneIds.includes(preferredPaneId)
    ? preferredPaneId
    : (ownedPaneIds[0] ?? preferredPaneId);

  return {
    paneId: keeperPaneId,
    duplicatePaneIds: ownedPaneIds.filter((paneId) => paneId !== keeperPaneId),
  };
}

const HUD_RECONCILE_LOCK_STALE_MS = 10_000;

interface HudReconcileLock {
  path: string;
  token: string;
}

interface HudReconcileLockOwner {
  token?: unknown;
  pid?: unknown;
  acquired_at?: unknown;
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultIsProcessLive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

async function readHudReconcileLockOwner(lockPath: string): Promise<HudReconcileLockOwner | null> {
  return readFile(join(lockPath, 'owner.json'), 'utf-8')
    .then((content) => JSON.parse(content) as HudReconcileLockOwner)
    .catch(() => null);
}

async function tryCreateHudReconcileLock(lockPath: string, nowMs: number): Promise<HudReconcileLock | null> {
  const token = randomUUID();
  let createdDir = false;
  try {
    await mkdir(lockPath, { recursive: false });
    createdDir = true;
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      token,
      pid: process.pid,
      acquired_at: new Date(nowMs).toISOString(),
    }, null, 2));
    return { path: lockPath, token };
  } catch {
    if (createdDir) await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

async function restoreMovedLock(fromPath: string, toPath: string): Promise<void> {
  const restored = await rename(fromPath, toPath).then(() => true).catch(() => false);
  if (!restored) await rm(fromPath, { recursive: true, force: true }).catch(() => {});
}

async function acquireHudReconcileLock(
  lockPath: string,
  nowMs: number,
  staleMs: number,
  isProcessLive: (pid: number) => boolean | null,
): Promise<HudReconcileLock | null> {
  const created = await tryCreateHudReconcileLock(lockPath, nowMs);
  if (created) return created;

  const observedOwner = await readHudReconcileLockOwner(lockPath);
  const lockStat = await stat(lockPath).catch(() => null);
  if (!lockStat) return null;

  const ownerPid = typeof observedOwner?.pid === 'number' && Number.isInteger(observedOwner.pid) && observedOwner.pid > 0
    ? observedOwner.pid
    : null;
  const ownerAcquiredMs = parseIsoMs(observedOwner?.acquired_at);
  const lockAgeMs = ownerAcquiredMs === null ? nowMs - lockStat.mtimeMs : nowMs - ownerAcquiredMs;
  if (lockAgeMs <= staleMs) return null;

  if (ownerPid !== null) {
    const liveness = isProcessLive(ownerPid);
    if (liveness !== false) return null;
  }

  const reapPath = `${lockPath}.stale.${process.pid}.${nowMs}.${randomUUID()}`;
  try {
    await rename(lockPath, reapPath);
  } catch {
    return null;
  }

  const reapedOwner = await readHudReconcileLockOwner(reapPath);
  const reapedStat = await stat(reapPath).catch(() => null);
  const reapedOwnerAcquiredMs = parseIsoMs(reapedOwner?.acquired_at);
  const reapedAgeMs = reapedOwnerAcquiredMs === null && reapedStat
    ? nowMs - reapedStat.mtimeMs
    : reapedOwnerAcquiredMs === null ? 0 : nowMs - reapedOwnerAcquiredMs;
  const reapedObservedLock = observedOwner?.token === reapedOwner?.token
    && reapedStat?.mtimeMs === lockStat.mtimeMs
    && reapedAgeMs > staleMs;

  if (!reapedObservedLock) {
    await restoreMovedLock(reapPath, lockPath);
    return null;
  }

  await rm(reapPath, { recursive: true, force: true }).catch(() => {});
  return tryCreateHudReconcileLock(lockPath, nowMs);
}

async function releaseHudReconcileLock(lock: HudReconcileLock): Promise<void> {
  const releasePath = `${lock.path}.release.${process.pid}.${Date.now()}.${lock.token}`;
  try {
    await rename(lock.path, releasePath);
  } catch {
    return;
  }

  const releaseOwner = await readHudReconcileLockOwner(releasePath);
  if (releaseOwner?.token === lock.token) {
    await rm(releasePath, { recursive: true, force: true }).catch(() => {});
    return;
  }

  await restoreMovedLock(releasePath, lock.path);
}


export async function reconcileHudForPromptSubmit(
  cwd: string,
  deps: ReconcileHudForPromptSubmitDeps = {},
): Promise<ReconcileHudForPromptSubmitResult> {
  const env = deps.env ?? process.env;
  if (!env.TMUX) {
    return {
      status: 'skipped_not_tmux',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  if (!isExplicitOmxOwnedTmuxEnv(env)) {
    return {
      status: 'skipped_not_omx_owned_tmux',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const resolveOmxCliEntryPathFn = deps.resolveOmxCliEntryPath ?? resolveOmxCliEntryPath;
  const omxBin = resolveOmxCliEntryPathFn();
  if (!omxBin) {
    return {
      status: 'skipped_no_entry',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const listPanes = deps.listCurrentWindowPanes ?? ((paneId) => listCurrentWindowPanes(undefined, paneId));
  const createPane = deps.createHudWatchPane ?? ((hudCwd, hudCmd, options) => createHudWatchPane(hudCwd, hudCmd, options));
  const killPane = deps.killTmuxPane
    ? (pane: TmuxPaneSnapshot) => deps.killTmuxPane!(pane.paneId)
    : (pane: TmuxPaneSnapshot) => killTmuxPaneIfCurrent(pane.paneId, pane.panePid ?? '');
  const resizePane = deps.resizeTmuxPane
    ? (pane: TmuxPaneSnapshot, lines: number) => deps.resizeTmuxPane!(pane.paneId, lines)
    : (pane: TmuxPaneSnapshot, lines: number) => resizeTmuxPaneIfCurrent(pane.paneId, pane.panePid ?? '', lines);

  const lockPath = join(cwd, '.omx', 'state', 'hud-reconcile.lock');
  const lockDirReady = await mkdir(dirname(lockPath), { recursive: true }).then(() => true).catch(() => false);
  const lock = lockDirReady
    ? await acquireHudReconcileLock(
      lockPath,
      deps.nowMs?.() ?? Date.now(),
      HUD_RECONCILE_LOCK_STALE_MS,
      deps.isProcessLive ?? defaultIsProcessLive,
    )
    : null;
  if (lockDirReady && !lock) {
    return {
      status: 'skipped_concurrent',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  try {

  const currentPaneId = env.TMUX_PANE;
  const resolvedSessionId = deps.sessionId?.trim() || env.OMX_SESSION_ID?.trim() || undefined;
  const equivalentSessionIds = [
    resolvedSessionId,
    env.OMX_SESSION_ID?.trim(),
    ...(deps.sessionIds ?? []),
  ]
    .map((sessionId) => sessionId?.trim() ?? '')
    .filter((sessionId, index, sessionIds) => sessionId !== '' && sessionIds.indexOf(sessionId) === index);
  let panes = listPanes(currentPaneId);
  if (!isStrictLivePaneSnapshot(panes, currentPaneId)) {
    return {
      status: 'failed',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };

  }
  const expectedLeaderPane = panes.find((pane) => pane.paneId === currentPaneId && !isHudWatchPane(pane));
  if (!expectedLeaderPane) return failedReconcileResult();

  // Reclaim orphaned HUD panes left behind by a destroyed leader before deciding
  // whether a HUD already exists; otherwise dead-leader HUDs accumulate one per
  // prompt submit and the window fills with stacked HUD strips.
  const orphanReap = reapOrphanedSessionHudPanes(panes, {
    sessionId: resolvedSessionId,
    sessionIds: equivalentSessionIds,
    currentPaneId,
    expectedLeader: expectedLeaderPane,
    listPanes,
    killPane,
  });
  if (!orphanReap.complete) return failedReconcileResult();
  const reapedOrphanPaneIds = orphanReap.reaped;
  if (reapedOrphanPaneIds.length > 0) {
    const reapedPaneIdSet = new Set(reapedOrphanPaneIds);
    panes = panes.filter((pane) => !reapedPaneIdSet.has(pane.paneId));
  }

  // A Codex self-update can restart/resume the leader in the same tmux pane with
  // a new OMX session id while the old HUD watcher stays alive. That stale HUD
  // still names the current leader pane, but with the previous session id, so it
  // does not match same-owner dedupe and the next launch would create a second HUD
  // beside it. Reap only HUDs tied to this exact leader pane; neighboring panes'
  // HUDs remain isolated by leaderPaneId.
  const staleLeaderReap = reapStaleCurrentLeaderHudPanes(panes, {
    sessionIds: equivalentSessionIds,
    currentPaneId,
    expectedLeader: expectedLeaderPane,
    listPanes,
    killPane,
  });
  if (!staleLeaderReap.complete) return failedReconcileResult();
  const reapedStaleLeaderPaneIds = staleLeaderReap.reaped;
  if (reapedStaleLeaderPaneIds.length > 0) {
    const reapedPaneIdSet = new Set(reapedStaleLeaderPaneIds);
    panes = panes.filter((pane) => !reapedPaneIdSet.has(pane.paneId));
  }


  const owner = {
    sessionId: resolvedSessionId,
    sessionIds: equivalentSessionIds,
    leaderPaneId: currentPaneId,
  };
  const hudPaneIds = [
    ...findHudWatchPaneIds(panes, currentPaneId, owner),
    ...findLegacyFocusedHudWatchPaneIds(panes, currentPaneId),
  ].filter((paneId, index, paneIds) => paneIds.indexOf(paneId) === index);
  const duplicateCount = Math.max(0, hudPaneIds.length - 1);
  const readHudConfigFn = deps.readHudConfig ?? readHudConfig;
  const hudConfig = await readHudConfigFn(cwd).catch(() => null);
  const readAllStateFn = deps.readAllState ?? readAllState;
  const hudState = hudConfig ? await readAllStateFn(cwd, hudConfig).catch(() => null) : null;
  const desiredHeight = hudState ? getHudRenderMaxLines(hudState) : HUD_TMUX_HEIGHT_LINES;
  const preset = hudConfig?.preset;
  const hudCmd = buildHudWatchCommand(omxBin, preset, resolvedSessionId, env.OMX_ROOT, currentPaneId, {
    omxStateRoot: env.OMX_STATE_ROOT,
    omxTeamStateRoot: env.OMX_TEAM_STATE_ROOT,
    rootSource: env.OMX_TEAM_STATE_ROOT ? 'team-env' : env.OMX_ROOT ? 'omx-root-env' : env.OMX_STATE_ROOT ? 'omx-state-root-env' : 'cwd-default',
  });
  const leaderPane = expectedLeaderPane;

  const singleHudPane = hudPaneIds.length === 1
    ? panes.find((pane) => pane.paneId === hudPaneIds[0])
    : undefined;
  if (singleHudPane && !needsHudTopologyRecreate(singleHudPane, leaderPane)) {
    const shouldResize = needsHudHeightResize(singleHudPane, desiredHeight);
    const paneForResize = matchesFreshHudPane(singleHudPane.paneId, singleHudPane, expectedLeaderPane, currentPaneId, owner, listPanes);
    if (!paneForResize) return failedReconcileResult(desiredHeight, duplicateCount);
    const resized = shouldResize ? resizePane(paneForResize, desiredHeight) : true;
    const paneForHook = resized
      ? matchesFreshHudPane(paneForResize.paneId, paneForResize, expectedLeaderPane, currentPaneId, owner, listPanes)
      : null;
    if (paneForHook) ensureHudResizeHook(paneForHook.paneId, currentPaneId, desiredHeight, cwd, deps);
    return {
      status: resized && paneForHook ? (shouldResize ? 'resized' : 'unchanged') : 'failed',
      paneId: paneForHook?.paneId ?? null,
      desiredHeight,
      duplicateCount,
    };
  }

  if (hudPaneIds.length > 1) {
    const hudPanes = hudPaneIds
      .map((paneId) => panes.find((pane) => pane.paneId === paneId))
      .filter((pane): pane is TmuxPaneSnapshot => Boolean(pane));
    const keeperPane = hudPanes.find((pane) => !needsHudTopologyRecreate(pane, leaderPane));

    if (keeperPane) {
      const duplicateReap = killFreshHudPanes(
        hudPaneIds.filter((paneId) => paneId !== keeperPane.paneId),
        panes,
        expectedLeaderPane,
        currentPaneId,
        listPanes,
        killPane,
        (pane, freshPanes) => pane.paneId !== keeperPane.paneId
          && matchesOwnedHudScope(pane, freshPanes, currentPaneId, owner),
      );
      if (!duplicateReap.complete) return failedReconcileResult(desiredHeight, duplicateCount);
      const freshPanes = listPanes(currentPaneId);
      const freshKeeperPane = freshPanes.find((pane) => pane.paneId === keeperPane.paneId);
      if (
        !isStrictLivePaneSnapshot(freshPanes, currentPaneId)
        || !sameLeaderIncarnation(expectedLeaderPane, freshPanes)
        || !freshKeeperPane
        || !matchesOwnedHudScope(freshKeeperPane, freshPanes, currentPaneId, owner)
      ) return failedReconcileResult(desiredHeight, duplicateCount);
      const keeperForResize = matchesFreshHudPane(freshKeeperPane.paneId, freshKeeperPane, expectedLeaderPane, currentPaneId, owner, listPanes);
      if (!keeperForResize) return failedReconcileResult(desiredHeight, duplicateCount);
      const resized = resizePane(keeperForResize, desiredHeight);
      const keeperForHook = resized
        ? matchesFreshHudPane(keeperForResize.paneId, keeperForResize, expectedLeaderPane, currentPaneId, owner, listPanes)
        : null;
      if (keeperForHook) ensureHudResizeHook(keeperForHook.paneId, currentPaneId, desiredHeight, cwd, deps);
      return {
        status: resized && keeperForHook ? 'replaced_duplicates' : 'failed',
        paneId: keeperForHook?.paneId ?? null,
        desiredHeight,
        duplicateCount,
      };
    }

  }
  const createFullWidth = hudPaneIds
    .map((paneId) => panes.find((pane) => pane.paneId === paneId))
    .some((pane) => Boolean(pane && needsHudTopologyRecreate(pane, leaderPane)))
    && (!leaderPane || shouldCreateFullWidthHud(leaderPane));

  if (!resolvedSessionId) {
    return {
      status: 'skipped_no_session_id',
      paneId: null,
      desiredHeight,
      duplicateCount,
    };
  }

  // When there is no existing HUD pane to keep/recreate, this reconcile would
  // create a fresh HUD split. Mirror the launch-time guard: if the current tmux
  // window is too short, skip the split so the first prompt submit cannot
  // recreate the cramped, unreadable 2-line HUD the launch path already
  // declined to add. Default behavior is preserved for normal/unknown heights.
  // (closes #2754)
  if (hudPaneIds.length === 0 && (deps.readCurrentWindowSize || !deps.listCurrentWindowPanes)) {
    const readWindowSize = deps.readCurrentWindowSize ?? ((paneId) => readCurrentWindowSize(undefined, paneId));
    const windowHeight = readWindowSize(currentPaneId).height;
    if (isTmuxWindowTooCrampedForHudSplit(windowHeight)) {
      return {
        status: 'skipped_window_too_cramped',
        paneId: null,
        desiredHeight,
        duplicateCount,
      };
    }
  }

  const unregisterHook = deps.unregisterHudResizeHook ?? unregisterHudResizeHook;
  if (!readFreshLeaderPane(expectedLeaderPane, currentPaneId, listPanes)) return failedReconcileResult(desiredHeight, duplicateCount);
  unregisterHook(currentPaneId);

  const initialHudRemoval = killFreshHudPanes(
    hudPaneIds,
    panes,
    expectedLeaderPane,
    currentPaneId,
    listPanes,
    killPane,
    (pane, freshPanes) => matchesOwnedHudScope(pane, freshPanes, currentPaneId, owner),
  );
  if (!initialHudRemoval.complete) return failedReconcileResult(desiredHeight, duplicateCount);
  const removedHudPaneIds = new Set(initialHudRemoval.reaped);


  const createOptions: { heightLines: number; fullWidth?: boolean; targetPaneId?: string } = {
    heightLines: desiredHeight,
    targetPaneId: currentPaneId,
  };
  if (!readFreshLeaderPane(expectedLeaderPane, currentPaneId, listPanes)) return failedReconcileResult(desiredHeight, duplicateCount);

  if (createFullWidth) createOptions.fullWidth = true;
  const paneId = createPane(cwd, hudCmd, createOptions);
  if (!paneId) {
    return {
      status: 'failed',
      paneId: null,
      desiredHeight,
      duplicateCount,
    };
  }

  // A launch-path restore and prompt-submit reconciliation can both observe
  // "no HUD" before either split-window has materialized. Re-scan after create
  // and collapse same-owner panes so the second creator cleans up the race
  // instead of leaving a duplicate HUD in the user window.
  const postCreatePanes = listPanes(currentPaneId).filter((pane) => !removedHudPaneIds.has(pane.paneId));
  const createdBySharedPrimitive = !deps.createHudWatchPane;
  if (!isStrictLivePaneSnapshot(postCreatePanes, currentPaneId) || !sameLeaderIncarnation(expectedLeaderPane, postCreatePanes) || (createdBySharedPrimitive && !verifyHudWatchPaneAuthority(paneId))) {
    if (createdBySharedPrimitive) rollbackHudWatchPaneAuthority(paneId);
    return {
      status: 'failed',
      paneId: null,
      desiredHeight,
      duplicateCount,
    };
  }
  const postCreate = planOwnedHudPaneDedupe(
    postCreatePanes,
    currentPaneId,
    owner,
    paneId,
  );
  const postCreateDuplicateReap = killFreshHudPanes(
    postCreate.duplicatePaneIds,
    postCreatePanes,
    expectedLeaderPane,
    currentPaneId,
    listPanes,
    killPane,
    (pane, freshPanes) => pane.paneId !== postCreate.paneId
      && matchesOwnedHudScope(pane, freshPanes, currentPaneId, owner),
  );
  if (!postCreateDuplicateReap.complete) {
    if (createdBySharedPrimitive) rollbackHudWatchPaneAuthority(paneId);
    return failedReconcileResult(desiredHeight, postCreate.duplicatePaneIds.length);
  }
  if (createdBySharedPrimitive && !verifyHudWatchPaneAuthority(postCreate.paneId)) {
    rollbackHudWatchPaneAuthority(postCreate.paneId);
    return {
      status: 'failed',
      paneId: null,
      desiredHeight,
      duplicateCount: postCreate.duplicatePaneIds.length,
    };
  }
  const postCreatePane = postCreatePanes.find((pane) => pane.paneId === postCreate.paneId);
  const paneForResize = postCreatePane
    ? matchesFreshHudPane(postCreate.paneId, postCreatePane, expectedLeaderPane, currentPaneId, owner, listPanes)
    : null;
  if (!paneForResize) {
    if (createdBySharedPrimitive) rollbackHudWatchPaneAuthority(paneId);
    return failedReconcileResult(desiredHeight, postCreate.duplicatePaneIds.length);
  }
  const resized = resizePane(paneForResize, desiredHeight);
  if (!resized) {
    if (createdBySharedPrimitive) rollbackHudWatchPaneAuthority(paneId);
    return {
      status: 'failed',
      paneId: paneForResize.paneId,
      desiredHeight,
      duplicateCount: postCreate.duplicatePaneIds.length,
    };
  }
  const paneForHook = matchesFreshHudPane(paneForResize.paneId, paneForResize, expectedLeaderPane, currentPaneId, owner, listPanes);
  if (!paneForHook) {
    if (createdBySharedPrimitive) rollbackHudWatchPaneAuthority(paneId);
    return failedReconcileResult(desiredHeight, postCreate.duplicatePaneIds.length);
  }
  if (createdBySharedPrimitive && !verifyHudWatchPaneAuthority(paneForHook.paneId)) {
    rollbackHudWatchPaneAuthority(paneForHook.paneId);
    return {
      status: 'failed',
      paneId: null,
      desiredHeight,
      duplicateCount: postCreate.duplicatePaneIds.length,
    };
  }
  ensureHudResizeHook(paneForHook.paneId, currentPaneId, desiredHeight, cwd, deps);

  return {
    status: postCreate.duplicatePaneIds.length > 0 || hudPaneIds.length > 1 ? 'replaced_duplicates' : 'recreated',
    paneId: postCreate.paneId,
    desiredHeight,
    duplicateCount: postCreate.duplicatePaneIds.length,
  };
  } finally {
    if (lock) await releaseHudReconcileLock(lock);
  }
}
