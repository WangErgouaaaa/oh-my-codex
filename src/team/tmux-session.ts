import { randomUUID } from 'crypto';

import { spawnSync, execFile } from 'child_process';
import { promisify } from 'util';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import {
  CODEX_BYPASS_FLAG,
  CLAUDE_SKIP_PERMISSIONS_FLAG,
  MADMAX_FLAG,
  CONFIG_FLAG,
  LONG_CONFIG_FLAG,
  MODEL_FLAG,
} from '../cli/constants.js';
import { getAgent } from '../agents/definitions.js';
import {
  buildCapturePaneArgv as sharedBuildCapturePaneArgv,
  buildVisibleCapturePaneArgv as sharedBuildVisibleCapturePaneArgv,
  normalizeTmuxCapture as sharedNormalizeTmuxCapture,
  paneHasActiveTask as sharedPaneHasActiveTask,
  paneIsBootstrapping as sharedPaneIsBootstrapping,
  paneShowsCodexViewport as sharedPaneShowsCodexViewport,
  paneLooksReady as sharedPaneLooksReady,
} from '../scripts/tmux-hook-engine.js';
import { readActiveProviderEnvOverrides } from '../config/models.js';
import {
  classifyTeamWorkerLaunchPolicy,
  extractModelProviderOverrideValue,
  normalizeTeamWorkerLaunchArgs,
  parseTeamWorkerLaunchArgs,
} from './model-contract.js';

import { sleep, sleepSync } from '../utils/sleep.js';
import {
  buildPlatformCommandSpec,
  classifySpawnError,
  resolveCommandPathForPlatform,
  spawnPlatformCommandSync,
} from '../utils/platform-command.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';

const execFileAsync = promisify(execFile);
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS, HUD_TMUX_TEAM_HEIGHT_LINES } from '../hud/constants.js';

import { OMX_TMUX_HUD_OWNER_ENV } from '../hud/reconcile.js';
import {
  findHudWatchPaneIds,
  hudPaneMatchesOwner,
  OMX_TMUX_HUD_LEADER_PANE_ENV,
  parseCanonicalTmuxPaneId,
  parseExactTmuxAuthorityLines,
  parseExactTmuxAuthorityScalar,
  writeHudWatchCommand,
} from '../hud/tmux.js';


const OMX_INSTANCE_OPTION = '@omx_instance_id';
const OMX_PANE_INSTANCE_OPTION = '@omx_pane_instance_id';
const OMX_TEAM_PANE_OWNER_OPTION = '@omx_team_pane_owner_id';


export interface TeamSession {
  name: string; // tmux target in "session:window" form
  workerCount: number;
  cwd: string;
  workerPaneIds: string[];
  /** Leader's own pane ID — must never be targeted by worker cleanup routines. */
  leaderPaneId: string;
  /** HUD pane spawned below the leader column, or null if creation failed. */
  hudPaneId: string | null;
  /** Registered tmux resize hook name for the HUD pane, or null if unavailable. */
  resizeHookName: string | null;
  /** Registered tmux resize hook target in "<session>:<window>" form, or null. */
  resizeHookTarget: string | null;
  /** Team-scoped tmux pane ownership token used by shutdown safety checks. */
  teamPaneOwnerId: string;
  /** Exact worker pane incarnations captured during split adoption. */
  workerPaneIncarnations?: TeamPaneIncarnation[];
  /** Exact HUD pane incarnation captured during split adoption, or null. */
  hudPaneIncarnation?: TeamPaneIncarnation | null;
}

/** Immutable tmux pane identity captured from an atomic liveness snapshot. */
export interface TeamPaneIncarnation {
  paneId: string;
  panePid: string;
}


export interface CreateTeamSessionOptions {
  /**
   * Stable logical leader id forwarded to HUD/hook runtime and the generic
   * tmux pane instance tag. Team shutdown must not rely on this value because
   * environment session ids can be stale when a user starts OMX from another
   * tmux pane in the same shell/session.
   */
  ownerSessionId?: string | null;
  /** Team-scoped pane owner token used only for Team shutdown/teardown. */
  teamPaneOwnerId?: string | null;
}

export interface RestoreStandaloneHudPaneOptions {
  /** Session id that prompt-submit HUD reconciliation should use to dedupe the restored HUD. */
  sessionId?: string | null;
  /** Explicit HUD cwd override. When omitted, the live leader pane cwd is preferred over team launch cwd. */
  cwd?: string | null;
}

const INJECTION_MARKER = '[OMX_TMUX_INJECT]';
const MODEL_INSTRUCTIONS_FILE_KEY = 'model_instructions_file';
const OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV = 'OMX_BYPASS_DEFAULT_SYSTEM_PROMPT';
const OMX_MODEL_INSTRUCTIONS_FILE_ENV = 'OMX_MODEL_INSTRUCTIONS_FILE';
const OMX_TEAM_WORKER_CLI_ENV = 'OMX_TEAM_WORKER_CLI';
const OMX_TEAM_WORKER_CLI_MAP_ENV = 'OMX_TEAM_WORKER_CLI_MAP';
const OMX_TEAM_WORKER_LAUNCH_MODE_ENV = 'OMX_TEAM_WORKER_LAUNCH_MODE';
const OMX_TEAM_AUTO_INTERRUPT_RETRY_ENV = 'OMX_TEAM_AUTO_INTERRUPT_RETRY';
const OMX_TEAM_WORKER_MCP_COMPAT_ENV = 'OMX_TEAM_WORKER_MCP_COMPAT';
const CODEX_SQLITE_HOME_ENV = 'CODEX_SQLITE_HOME';
const GEMINI_PROMPT_INTERACTIVE_FLAG = '-i';
const GEMINI_APPROVAL_MODE_FLAG = '--approval-mode';
const GEMINI_APPROVAL_MODE_YOLO = 'yolo';
const OMX_LEADER_NODE_PATH_ENV = 'OMX_LEADER_NODE_PATH';
const OMX_LEADER_CLI_PATH_ENV = 'OMX_LEADER_CLI_PATH';
const TMUX_WORKER_AMBIENT_ENV_ALLOWLIST = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;

const TEAM_WORKER_DISABLED_OMX_MCP_SERVERS = [
  'omx_state',
  'omx_memory',
  'omx_code_intel',
  'omx_trace',
  'omx_wiki',
  'omx_hermes',
] as const;
const TMUX_NO_UNDERLINE_STYLE_FLAGS = [
  'nounderscore',
  'nodouble-underscore',
  'nocurly-underscore',
  'nodotted-underscore',
  'nodashed-underscore',
] as const;
const TMUX_COPY_MODE_STYLE_OPTIONS = [
  'mode-style',
  'copy-mode-selection-style',
] as const;

const OMX_TEAM_STATE_ROOT_ENV = 'OMX_TEAM_STATE_ROOT';

export type TeamWorkerCli = 'codex' | 'claude' | 'gemini';
type TeamWorkerCliMode = 'auto' | TeamWorkerCli;
export type TeamWorkerLaunchMode = 'interactive' | 'prompt';

export interface WorkerSubmitPlan {
  shouldInterrupt: boolean;
  queueFirstRound: boolean;
  rounds: number;
  submitKeyPressesPerRound: number;
  allowAdaptiveRetry: boolean;
}

interface WorkerLaunchSpec {
  shell: string;
  rcFile: string | null;
}

export interface WorkerProcessLaunchSpec {
  workerCli: TeamWorkerCli;
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface TmuxPaneInfo {
  paneId: string;
  currentCommand: string;
  startCommand: string;
}

type SpawnSyncLike = typeof spawnSync;

function runTmux(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const { result } = spawnPlatformCommandSync('tmux', args, { encoding: 'utf-8' });
  if (result.error) {
    return { ok: false, stderr: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || '').trim() || `tmux exited ${result.status}` };
  }
  return { ok: true, stdout: result.stdout || '' };
}

/** Authority parsing is centralized in hud/tmux and requires one terminal LF. */

function appendNoUnderlineStyleFlags(style: string): string {
  const normalized = style
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const combined = [...normalized];
  for (const flag of TMUX_NO_UNDERLINE_STYLE_FLAGS) {
    if (!combined.includes(flag)) combined.push(flag);
  }
  return combined.join(',');
}

function sanitizeTmuxStyleOption(sessionTarget: string, optionName: string): boolean {
  const shown = runTmux(['show-options', '-gv', '-t', sessionTarget, optionName]);
  if (!shown.ok) return false;

  const current = shown.stdout.trim();
  if (current === '') return false;

  const sanitized = appendNoUnderlineStyleFlags(current);
  if (sanitized === current) return true;

  const result = runTmux(['set-option', '-t', sessionTarget, optionName, sanitized]);
  return result.ok;
}

function tagPaneInstance(paneTarget: string, instanceId: string): void {
  const target = parseCanonicalTmuxPaneId(paneTarget);
  const sanitized = instanceId.trim();
  if (!target || !sanitized) return;
  const result = runTmux(['set-option', '-p', '-t', target, OMX_PANE_INSTANCE_OPTION, sanitized]);
  if (!result.ok) {
    throw new Error(`failed to tag tmux pane ${target}: ${result.stderr}`);
  }
}

export function tagPaneTeamOwner(paneTarget: string, teamOwnerId: string): void {
  const target = parseCanonicalTmuxPaneId(paneTarget);
  const sanitized = teamOwnerId.trim();
  if (!target || !sanitized) return;
  const result = runTmux(['set-option', '-p', '-t', target, OMX_TEAM_PANE_OWNER_OPTION, sanitized]);
  if (!result.ok) {
    throw new Error(`failed to tag tmux pane ${target}: ${result.stderr}`);
  }
}


export function mitigateCopyModeUnderlineArtifacts(sessionTarget: string): boolean {
  const normalizedTarget = sessionTarget.trim();
  if (normalizedTarget === '') return false;

  let applied = false;
  for (const optionName of TMUX_COPY_MODE_STYLE_OPTIONS) {
    if (sanitizeTmuxStyleOption(normalizedTarget, optionName)) {
      applied = true;
    }
  }
  return applied;
}

function parseCurrentTmuxContext(output: string): {
  sessionName: string;
  windowIndex: string;
  leaderPaneId: string;
} | null {
  const line = parseExactTmuxAuthorityScalar(output);
  if (line === null) return null;
  const match = /^([^:\s]+):([^\s]+) (%(?:0|[1-9]\d*))$/.exec(line);
  if (!match) return null;
  const leaderPaneId = parseCanonicalTmuxPaneId(match[3]);
  if (!leaderPaneId) return null;
  return { sessionName: match[1]!, windowIndex: match[2]!, leaderPaneId };
}


export function hasCurrentTmuxClientContext(): boolean {
  const rawTmuxPaneTarget = process.env.TMUX_PANE;
  const tmuxPaneTarget = parseCanonicalTmuxPaneId(rawTmuxPaneTarget);
  if (rawTmuxPaneTarget !== undefined && !tmuxPaneTarget) return false;
  const displayArgs = tmuxPaneTarget
    ? ['display-message', '-p', '-t', tmuxPaneTarget, '#{session_name}:#{window_index} #{pane_id}']
    : ['display-message', '-p', '#{session_name}:#{window_index} #{pane_id}'];
  const context = runTmux(displayArgs);
  return context.ok && parseCurrentTmuxContext(context.stdout) !== null;
}

export function isMsysOrGitBash(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  const msystem = String(env.MSYSTEM ?? '').trim();
  if (msystem !== '') return true;
  const ostype = String(env.OSTYPE ?? '').trim();
  if (/(msys|mingw|cygwin)/i.test(ostype)) return true;
  return false;
}

function fallbackMsysPathTranslation(value: string): string {
  const drivePathMatch = value.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!drivePathMatch) return value;
  const drive = drivePathMatch[1]?.toLowerCase();
  const tail = drivePathMatch[2]?.replace(/\\/g, '/');
  if (!drive || !tail) return value;
  return `/${drive}/${tail}`;
}

export function translatePathForMsys(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: SpawnSyncLike = spawnSync,
): string {
  if (typeof value !== 'string' || value.trim() === '') return value;
  if (!isMsysOrGitBash(env, platform)) return value;

  const result = spawnImpl('cygpath', ['-u', value], { encoding: 'utf-8' });
  if (!result.error && result.status === 0) {
    const translated = (result.stdout || '').trim();
    if (translated !== '') return translated;
  }

  return fallbackMsysPathTranslation(value);
}

function baseSessionName(target: string): string {
  return target.split(':')[0] || target;
}

function parseCanonicalTmuxPaneIdSnapshot(output: string, requireNonEmpty: boolean = false): Set<string> | null {
  const lines = parseExactTmuxAuthorityLines(output);
  if (!lines) return null;
  const paneIds = new Set<string>();
  for (const line of lines) {
    const paneId = parseCanonicalTmuxPaneId(line);
    if (!paneId || paneId !== line || paneIds.has(paneId)) return null;
    paneIds.add(paneId);
  }
  return requireNonEmpty && paneIds.size === 0 ? null : paneIds;
}


function listPanes(target: string): TmuxPaneInfo[] | null {
  const paneIdResult = runTmux(['list-panes', '-t', target, '-F', '#{pane_id}']);
  if (!paneIdResult.ok) return null;
  const authoritativePaneIds = parseCanonicalTmuxPaneIdSnapshot(paneIdResult.stdout);
  if (!authoritativePaneIds) return null;

  const result = runTmux(['list-panes', '-t', target, '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}']);
  if (!result.ok) return null;
  const lines = parseExactTmuxAuthorityLines(result.stdout);
  if (!lines) return null;
  const panes: TmuxPaneInfo[] = [];
  for (const line of lines) {
    if (line === '') return null;
    const [rawPaneId = '', currentCommand = '', ...startCommandParts] = line.split('\t');
    const paneId = parseCanonicalTmuxPaneId(rawPaneId);
    if (!paneId || paneId !== rawPaneId) return null;
    panes.push({ paneId, currentCommand, startCommand: startCommandParts.join('\t') });
  }

  const canonicalPanes = canonicalizeTmuxPaneInfoBatch(panes);
  if (
    !canonicalPanes
    || canonicalPanes.length !== authoritativePaneIds.size
    || canonicalPanes.some((pane) => !authoritativePaneIds.has(pane.paneId))
  ) return null;
  return canonicalPanes;
}

function canonicalizeTmuxPaneInfoBatch(panes: readonly TmuxPaneInfo[]): TmuxPaneInfo[] | null {
  const paneIds = new Set<string>();
  const canonicalPanes: TmuxPaneInfo[] = [];
  for (const pane of panes) {
    const paneId = parseCanonicalTmuxPaneId(pane.paneId);
    if (!paneId || paneId !== pane.paneId || paneIds.has(paneId)) return null;
    paneIds.add(paneId);
    canonicalPanes.push({ ...pane, paneId });
  }
  return canonicalPanes;
}

export function listPaneIds(target: string): string[] {
  return listPanes(target)?.map((pane) => pane.paneId) ?? [];
}

function readGlobalTmuxPaneIdSnapshot(): Set<string> | null {
  const result = runTmux(['list-panes', '-a', '-F', '#{pane_id}']);
  if (!result.ok) return null;
  return parseCanonicalTmuxPaneIdSnapshot(result.stdout, true);
}



function readPaneIncarnation(paneId: string): { paneDead: boolean; panePid: string } | null {
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  if (!canonicalPaneId || canonicalPaneId !== paneId) return null;
  const result = runTmux(['list-panes', '-a', '-F', '#{pane_id} #{pane_dead} #{pane_pid}']);
  if (!result.ok) return null;
  const lines = parseExactTmuxAuthorityLines(result.stdout);
  if (!lines) return null;
  const seen = new Set<string>();
  let incarnation: { paneDead: boolean; panePid: string } | null = null;
  for (const line of lines) {
    const match = /^(%0|%[1-9][0-9]*) ([01]) ([0-9]+)$/.exec(line);
    if (!match) return null;
    const observedPaneId = parseCanonicalTmuxPaneId(match[1]);
    if (!observedPaneId || observedPaneId !== match[1]) return null;
    // A remain-on-exit pane may legitimately report PID 0. Dead rows carry no
    // live-incarnation authority, so they cannot poison an otherwise valid
    // global snapshot or create a duplicate-live ambiguity.
    if (match[2] === '1') {
      if (observedPaneId === canonicalPaneId) incarnation = { paneDead: true, panePid: match[3]! };
      continue;
    }
    if (!/^[1-9][0-9]*$/.test(match[3]!) || seen.has(observedPaneId)) return null;
    seen.add(observedPaneId);
    if (observedPaneId === canonicalPaneId) incarnation = { paneDead: false, panePid: match[3]! };
  }
  return incarnation;
}

/** Returns the atomic liveness identity for a canonical pane, or null on any invalid batch. */
export function readTeamPaneIncarnation(paneId: string): TeamPaneIncarnation | null {
  const incarnation = readPaneIncarnation(paneId);
  return incarnation ? { paneId, panePid: incarnation.panePid } : null;
}

function isPaneLiveInStrictGlobalProbe(paneId: string, expectedPid?: string): boolean {
  const incarnation = readPaneIncarnation(paneId);
  return Boolean(incarnation && !incarnation.paneDead && (!expectedPid || incarnation.panePid === expectedPid));
}

/**
 * Verifies the exact tmux incarnation that was previously adopted. This is
 * deliberately a full global batch read so a recycled pane ID cannot inherit
 * authority from its predecessor.
 */
export function isTeamPaneIncarnationLive(
  paneId: string,
  expectedPanePid: string | number | null | undefined,
): boolean {
  const normalizedPid = String(expectedPanePid ?? '');
  return /^[1-9][0-9]*$/.test(normalizedPid)
    && isPaneLiveInStrictGlobalProbe(paneId, normalizedPid);
}

function buildTeamPaneIncarnationCondition(paneId: string, panePid: string): string {
  return `#{&&:#{==:#{pane_id},${paneId}},#{&&:#{==:#{pane_dead},0},#{==:#{pane_pid},${panePid}}}}`;
}

function createMutationReceipt(): string {
  return `__OMX_PANE_MUTATION_${randomUUID().replaceAll('-', '')}__`;
}

function isSafeTmuxFormatOperand(value: string): boolean {
  return /^[A-Za-z0-9_:@$-]+$/.test(value);
}

/** Removes only the exact pane incarnation and requires a tmux-server receipt. */

function removeTeamPaneIncarnation(pane: TeamPaneIncarnation): boolean {
  const paneId = parseCanonicalTmuxPaneId(pane.paneId);
  if (!paneId || paneId !== pane.paneId || !/^[1-9][0-9]*$/.test(pane.panePid)) return false;
  const receipt = createMutationReceipt();
  const result = runTmux([
    'if-shell', '-t', paneId, '-F', buildTeamPaneIncarnationCondition(paneId, pane.panePid),
    `kill-pane -t ${paneId} \\; display-message -p ${receipt}`,
    '',
  ]);
  return result.ok && parseExactTmuxAuthorityScalar(result.stdout) === receipt;
}

/** Resizes only the exact live pane incarnation and requires a tmux-server receipt. */
function resizeTeamPaneIncarnation(pane: TeamPaneIncarnation, heightLines: number): boolean {
  const paneId = parseCanonicalTmuxPaneId(pane.paneId);
  if (!paneId || paneId !== pane.paneId || !/^[1-9][0-9]*$/.test(pane.panePid)) return false;
  const height = Number.isFinite(heightLines) && heightLines > 0 ? Math.floor(heightLines) : HUD_TMUX_TEAM_HEIGHT_LINES;
  const receipt = createMutationReceipt();
  const result = runTmux([
    'if-shell', '-t', paneId, '-F', buildTeamPaneIncarnationCondition(paneId, pane.panePid),
    `resize-pane -t ${paneId} -y ${height} \\; display-message -p ${receipt}`,
    '',
  ]);
  return result.ok && parseExactTmuxAuthorityScalar(result.stdout) === receipt;
}


function isPaneStablyLiveInStrictGlobalProbe(
  paneId: string,
  expectedPid?: string,
  probeCount = 3,
  intervalSeconds = 0.1,
): boolean {
  if (!Number.isInteger(probeCount) || probeCount < 2) return false;
  for (let probe = 0; probe < probeCount; probe += 1) {
    if (!isPaneLiveInStrictGlobalProbe(paneId, expectedPid)) return false;
    if (probe + 1 < probeCount) sleepFractionalSeconds(intervalSeconds);
  }
  return true;
}


function deriveSingleSplitPaneId(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): string | null {
  if (after.size !== before.size + 1 || ![...before].every((paneId) => after.has(paneId))) return null;
  const created = [...after].filter((paneId) => !before.has(paneId));
  return created.length === 1 ? created[0] ?? null : null;
}

const OMX_TMUX_SPLIT_OPERATION_MARKER_ENV = 'OMX_TMUX_SPLIT_OPERATION_MARKER';

function writeSplitOperationMarkedCommand(command: string, marker: string): string {
  if (isNativeWindows()) {
    return `$env:${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV} = '${marker}'; ${command}`;
  }
  return `${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV}='${marker}'; export ${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV}; ${command}`;
}

function hasSplitOperationMarker(startCommand: string, marker: string): boolean {
  const posixMarker = `${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV}='${marker}'`;
  const powerShellMarker = `$env:${OMX_TMUX_SPLIT_OPERATION_MARKER_ENV} = '${marker}'`;
  return startCommand === posixMarker
    || startCommand.startsWith(`${posixMarker};`)
    || startCommand === powerShellMarker
    || startCommand.startsWith(`${powerShellMarker};`);
}

function findSplitOperationMarkerPaneId(marker: string): string | null {
  const result = runTmux(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_start_command}']);
  if (!result.ok) return null;
  const lines = parseExactTmuxAuthorityLines(result.stdout);
  if (!lines) return null;
  const paneIds = new Set<string>();
  let candidate: string | null = null;
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length !== 2) return null;
    const paneId = parseCanonicalTmuxPaneId(fields[0]);
    if (!paneId || paneId !== fields[0] || paneIds.has(paneId)) return null;
    paneIds.add(paneId);
    if (!hasSplitOperationMarker(fields[1] ?? '', marker)) continue;
    if (candidate) return null;
    candidate = paneId;
  }
  return candidate;
}

function readPostSplitCandidate(
  preGlobal: ReadonlySet<string>,
  preWindow: ReadonlySet<string>,
  windowTarget: string,
  marker: string,
): string | null {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const postGlobal = readGlobalTmuxPaneIdSnapshot();
    const postWindow = paneIdSetForTarget(windowTarget);
    const globalCandidate = postGlobal ? deriveSingleSplitPaneId(preGlobal, postGlobal) : null;
    const windowCandidate = postWindow ? deriveSingleSplitPaneId(preWindow, postWindow) : null;
    const markerCandidate = findSplitOperationMarkerPaneId(marker);
    if (globalCandidate && globalCandidate === windowCandidate && markerCandidate === globalCandidate) return globalCandidate;
    if (markerCandidate && !preGlobal.has(markerCandidate)) return markerCandidate;
    if (attempt < 2) sleepFractionalSeconds(0.05);
  }
  return null;
}

function splitOutputMatchesPaneId(rawPaneOutput: string | null | undefined, paneId: string): boolean {
  return typeof rawPaneOutput === 'string' && parseExactTmuxAuthorityScalar(rawPaneOutput) === paneId;
}



type VerifiedSplitPane = {
  paneId: string;
  panePid: string;
  sessionId: string;
  adoptionOption: string;
  adoptionReceipt: string;
  operationMarker: string;
  windowTarget: string;
};


function paneIdSetForTarget(target: string): Set<string> | null {
  const panes = listPanes(target);
  if (!panes || panes.length === 0) return null;
  return new Set(panes.map((pane) => pane.paneId));
}

function readTmuxPaneOptionExactly(paneId: string, option: string): string | null {
  const result = runTmux(['show-options', '-qv', '-p', '-t', paneId, option]);
  return result.ok ? parseExactTmuxAuthorityScalar(result.stdout) : null;
}

/**

 * Creates a pane only after proving its split output, global membership, window
 * membership, liveness, and an operation-scoped marker agree. The adoption
 * receipt is installed on the exact candidate pane before any destructive
 * rollback authority is retained.
 */
function splitAndAdoptPane(
  splitArgs: string[],
  sourcePaneId: string,
  windowTarget: string,
): VerifiedSplitPane | null {
  const sourcePane = parseCanonicalTmuxPaneId(sourcePaneId);
  if (!sourcePane || sourcePane !== sourcePaneId) return null;
  const preGlobal = readGlobalTmuxPaneIdSnapshot();
  const preWindow = paneIdSetForTarget(windowTarget);
  if (!preGlobal || !preWindow || !preGlobal.has(sourcePane) || !preWindow.has(sourcePane)) return null;

  const adoptionOption = `@omx_split_adoption_${randomUUID().replaceAll('-', '')}`;
  const adoptionReceipt = createMutationReceipt();
  const operationMarker = randomUUID();

  const markedSplitArgs = [...splitArgs];

  const commandIndex = markedSplitArgs.length - 1;
  const command = markedSplitArgs[commandIndex];
  if (!command) return null;
  markedSplitArgs[commandIndex] = writeSplitOperationMarkedCommand(command, operationMarker);
  const split = runTmux(markedSplitArgs);
  if (!split.ok) return null;

  // The snapshots plus the operation-local start-command marker—not split
  // stdout—identify the only pane this operation may subsequently bind or
  // roll back. If the first post-split snapshot is unavailable, the unique
  // marker provides a bounded recovery path without granting authority to
  // split stdout.
  const candidate = readPostSplitCandidate(preGlobal, preWindow, windowTarget, operationMarker);
  const sessionProbe = candidate
    ? runTmux(['display-message', '-p', '-t', candidate, '#{session_id}'])
    : null;
  const sessionId = sessionProbe?.ok
    ? parseExactTmuxAuthorityScalar(sessionProbe.stdout)
    : null;
  const incarnation = candidate ? readPaneIncarnation(candidate) : null;
  if (!candidate || !sessionId || !incarnation) return null;

  const provisionalAuthority: VerifiedSplitPane = {
    paneId: candidate,
    panePid: incarnation.panePid,
    sessionId,
    adoptionOption,
    adoptionReceipt,
    operationMarker,
    windowTarget,
  };
  if (
    !runTmux(['set-option', '-p', '-t', candidate, adoptionOption, adoptionReceipt]).ok
    || readTmuxPaneOptionExactly(candidate, adoptionOption) !== adoptionReceipt
  ) return null;
  const authority = provisionalAuthority;
  if (!splitOutputMatchesPaneId(split.stdout, candidate)) {

    rollbackSplitPaneAuthority(authority);
    return null;
  }
  if (!isPaneStablyLiveInStrictGlobalProbe(candidate, authority.panePid)) {
    rollbackSplitPaneAuthority(authority);
    return null;
  }
  return authority;
}

/** Re-establishes split authority immediately before a pane-targeted sink. */
function revalidateSplitPaneAuthority(authority: VerifiedSplitPane): boolean {
  const paneId = parseCanonicalTmuxPaneId(authority.paneId);
  if (!paneId || paneId !== authority.paneId) return false;
  const global = readGlobalTmuxPaneIdSnapshot();
  const window = paneIdSetForTarget(authority.windowTarget);
  return Boolean(
    global
      && window
      && global.has(paneId)
      && window.has(paneId)
      && findSplitOperationMarkerPaneId(authority.operationMarker) === paneId
      && isPaneLiveInStrictGlobalProbe(paneId, authority.panePid)
      && readTmuxPaneOptionExactly(paneId, authority.adoptionOption) === authority.adoptionReceipt,
  );
}

/**
 * Rollback intentionally does not require liveness: a dead operation-created
 * pane still needs removal. Membership and the exact operation proof remain
 * mandatory, preventing a recycled or pre-existing pane from being targeted.
 */
function hasSplitPaneRollbackAuthority(authority: VerifiedSplitPane): boolean {
  const paneId = parseCanonicalTmuxPaneId(authority.paneId);
  if (!paneId || paneId !== authority.paneId) return false;
  const global = readGlobalTmuxPaneIdSnapshot();
  const window = paneIdSetForTarget(authority.windowTarget);
  return Boolean(
    global
      && window
      && global.has(paneId)
      && window.has(paneId)
      && findSplitOperationMarkerPaneId(authority.operationMarker) === paneId
      && readPaneIncarnation(paneId)?.panePid === authority.panePid
      && readTmuxPaneOptionExactly(paneId, authority.adoptionOption) === authority.adoptionReceipt,
  );
}

function buildSplitPaneRollbackCondition(authority: VerifiedSplitPane): string | null {
  if (
    !isSafeTmuxFormatOperand(authority.sessionId)
    || !isSafeTmuxFormatOperand(authority.adoptionOption)
    || !isSafeTmuxFormatOperand(authority.adoptionReceipt)
  ) return null;
  return `#{&&:${buildTeamPaneIncarnationCondition(authority.paneId, authority.panePid)},#{&&:#{==:#{session_id},${authority.sessionId}},#{==:#{${authority.adoptionOption}},${authority.adoptionReceipt}}}}`;
}

function rollbackSplitPaneAuthority(authority: VerifiedSplitPane): boolean {
  if (!hasSplitPaneRollbackAuthority(authority)) return false;
  const condition = buildSplitPaneRollbackCondition(authority);
  if (!condition) return false;
  const receipt = createMutationReceipt();
  const result = runTmux([
    'if-shell', '-F', '-t', authority.paneId,
    condition,
    `kill-pane -t ${authority.paneId} ; display-message -p ${receipt}`,
    '',
  ]);
  return result.ok && parseExactTmuxAuthorityScalar(result.stdout) === receipt;
}

function isHudWatchPane(pane: TmuxPaneInfo): boolean {
  const start = pane.startCommand || '';
  return /\bomx\b.*\bhud\b.*--watch/i.test(start);
}

export function chooseTeamLeaderPaneId(panes: TmuxPaneInfo[], preferredPaneId: string): string {
  const preferred = panes.find((pane) => pane.paneId === preferredPaneId);
  if (preferred && !isHudWatchPane(preferred)) return preferred.paneId;

  const nonHud = panes.find((pane) => !isHudWatchPane(pane));
  if (nonHud) return nonHud.paneId;

  return preferredPaneId;
}


function readPaneCurrentPath(paneId: string): string | null {
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  if (!canonicalPaneId) return null;
  const result = runTmux(['display-message', '-p', '-t', canonicalPaneId, '#{pane_current_path}']);
  if (!result.ok) return null;
  const path = parseExactTmuxAuthorityScalar(result.stdout);
  return path === null ? null : path;
}

function pathIsUsableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

type RestoreCwdCandidateSource = 'explicit' | 'live' | 'fallback';

type RestoreCwdCandidate = {
  source: RestoreCwdCandidateSource;
  rawPath: string;
};

function isMsysDriveSlashPath(path: string): boolean {
  return /^\/[A-Za-z](?:\/|$)/.test(path);
}

function uniqueRestoreCwdCandidates(
  candidates: Array<{source: RestoreCwdCandidateSource; rawPath: string | null | undefined}>,
): RestoreCwdCandidate[] {
  const seen = new Set<string>();
  const result: RestoreCwdCandidate[] = [];
  for (const candidate of candidates) {
    const normalized = typeof candidate.rawPath === 'string' ? candidate.rawPath.trim() : '';
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ source: candidate.source, rawPath: normalized });
  }
  return result;
}

function shouldAttemptRestoreCwdCandidate(candidate: RestoreCwdCandidate): boolean {
  if (candidate.source === 'live' && isMsysOrGitBash() && isMsysDriveSlashPath(candidate.rawPath)) {
    return true;
  }

  return pathIsUsableDirectory(candidate.rawPath);
}

function resolveStandaloneHudRestoreCwdCandidates(
  leaderPaneId: string,
  fallbackCwd: string,
  explicitCwd?: string | null,
): RestoreCwdCandidate[] {
  const liveLeaderCwd = readPaneCurrentPath(leaderPaneId);
  return uniqueRestoreCwdCandidates([
    { source: 'explicit', rawPath: explicitCwd },
    { source: 'live', rawPath: liveLeaderCwd },
    { source: 'fallback', rawPath: fallbackCwd },
  ]).filter(shouldAttemptRestoreCwdCandidate);
}

const MAX_FRACTIONAL_SLEEP_MS = 60_000;

function toFractionalSleepMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const ms = Math.ceil(seconds * 1000);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(MAX_FRACTIONAL_SLEEP_MS, ms);
}

function sleepSeconds(seconds: number): void {
  sleepFractionalSeconds(seconds);
}

export function sleepFractionalSeconds(
  seconds: number,
  sleepImpl: (ms: number) => void = sleepSync,
): void {
  const ms = toFractionalSleepMs(seconds);
  if (ms <= 0) return;
  sleepImpl(ms);
}

// ── Async tmux helpers ──────────────────────────────────────────────────────

async function runTmuxAsync(args: string[]): Promise<{ok: true; stdout: string} | {ok: false; stderr: string}> {
  try {
    const spec = buildPlatformCommandSpec('tmux', args);
    const { stdout } = await execFileAsync(spec.command, spec.args, {
      encoding: 'utf-8',
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    });
    return { ok: true, stdout: stdout || '' };
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    return { ok: false, stderr: (err.stderr || err.message || '').trim() || 'tmux command failed' };
  }
}





async function capturePaneAsync(target: string): Promise<string> {
  const result = await runTmuxAsync(sharedBuildCapturePaneArgv(target, 80));
  if (!result.ok) return '';
  return result.stdout;
}

async function captureVisiblePaneAsync(target: string): Promise<string> {
  const result = await runTmuxAsync(sharedBuildVisibleCapturePaneArgv(target));
  if (!result.ok) return '';
  return result.stdout;
}

async function isWorkerAliveAsync(sessionName: string, workerIndex: number, workerPaneId?: string): Promise<boolean> {
  const canonicalWorkerPaneId = parseCanonicalTmuxPaneId(workerPaneId);
  if (workerPaneId && !canonicalWorkerPaneId) return false;
  if (canonicalWorkerPaneId) {
    const paneStatus = await readPaneLivenessByIdAsync(canonicalWorkerPaneId);
    if (paneStatus !== null) return paneStatus;
  }
  const result = await runTmuxAsync([
    'list-panes',
    '-t', paneTarget(sessionName, workerIndex, workerPaneId),
    '-F',
    '#{pane_dead} #{pane_pid}',
  ]);
  if (!result.ok) return false;

  const line = parseExactTmuxAuthorityScalar(result.stdout);
  if (!line) return false;
  const match = /^([01]) ([1-9][0-9]*)$/.exec(line);
  if (!match) return false;
  const paneDead = match[1];
  const pid = Number(match[2]);
  if (paneDead === '1' || !Number.isSafeInteger(pid)) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parsePaneLivenessBatch(output: string): Map<string, { dead: '0' | '1'; pid: number }> | null {
  const rows = new Map<string, { dead: '0' | '1'; pid: number }>();
  const livePaneIds = new Set<string>();
  const lines = parseExactTmuxAuthorityLines(output);
  if (!lines) return null;
  for (const line of lines) {
    if (line === '') return null;
    const match = /^(%0|%[1-9][0-9]*) ([01]) ([0-9]+)$/.exec(line);
    if (!match) return null;
    const paneId = parseCanonicalTmuxPaneId(match[1]);
    const pid = Number(match[3]);
    if (!paneId || paneId !== match[1] || !Number.isSafeInteger(pid)) return null;
    if (match[2] === '0') {
      if (pid < 1 || livePaneIds.has(paneId)) return null;
      livePaneIds.add(paneId);
    }
    // Dead remain-on-exit rows are structurally valid even with PID 0. They
    // never provide live authority, but retain target liveness semantics.
    rows.set(paneId, { dead: match[2] as '0' | '1', pid });
  }
  return rows;
}

function paneLivenessFromBatch(paneId: string, rows: ReadonlyMap<string, { dead: '0' | '1'; pid: number }>): boolean | null {
  const row = rows.get(paneId);
  if (!row) return null;
  if (row.dead !== '0') return false;
  try {
    process.kill(row.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type PaneLivenessOutcome =
  | { status: 'live' }
  | { status: 'dead' }
  | { status: 'absent' }
  | { status: 'invalid'; reason: 'invalid_id' | 'read_error' | 'malformed_batch' };

/**
 * Reads one pane from a strict full tmux liveness batch. Only a missing
 * canonical pane is authoritative absence; command/parser failures fail
 * closed so teardown never mistakes an unreadable snapshot for a dead pane.
 */
export function readPaneLivenessOutcome(paneId: string): PaneLivenessOutcome {
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  if (!canonicalPaneId || canonicalPaneId !== paneId) {
    return { status: 'invalid', reason: 'invalid_id' };
  }
  const result = runTmux(['list-panes', '-a', '-F', '#{pane_id} #{pane_dead} #{pane_pid}']);
  if (!result.ok) return { status: 'invalid', reason: 'read_error' };
  const rows = parsePaneLivenessBatch(result.stdout);
  if (!rows) return { status: 'invalid', reason: 'malformed_batch' };
  const row = rows.get(canonicalPaneId);
  if (!row) return { status: 'absent' };
  return row.dead === '0' ? { status: 'live' } : { status: 'dead' };
}

function readPaneLivenessById(paneId: string): boolean | null {
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  if (!canonicalPaneId || canonicalPaneId !== paneId) return null;
  const result = runTmux(['list-panes', '-a', '-F', '#{pane_id} #{pane_dead} #{pane_pid}']);
  if (!result.ok) return null;
  const rows = parsePaneLivenessBatch(result.stdout);
  return rows ? paneLivenessFromBatch(canonicalPaneId, rows) : null;
}

async function readPaneLivenessByIdAsync(paneId: string): Promise<boolean | null> {
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  if (!canonicalPaneId || canonicalPaneId !== paneId) return null;
  const result = await runTmuxAsync(['list-panes', '-a', '-F', '#{pane_id} #{pane_dead} #{pane_pid}']);
  if (!result.ok) return null;
  const rows = parsePaneLivenessBatch(result.stdout);
  return rows ? paneLivenessFromBatch(canonicalPaneId, rows) : null;
}

function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hudEnvValues(
  env: NodeJS.ProcessEnv = process.env,
  owner: { sessionId?: string | null; leaderPaneId?: string | null } = {},
): Array<[string, string]> {
  const sessionId = (owner.sessionId ?? '').trim();
  const leaderPaneId = (owner.leaderPaneId ?? '').trim();
  return [
    ...(sessionId ? [['OMX_SESSION_ID', sessionId] as [string, string]] : []),
    [OMX_TMUX_HUD_OWNER_ENV, '1'] as [string, string],
    ...(leaderPaneId ? [[OMX_TMUX_HUD_LEADER_PANE_ENV, leaderPaneId] as [string, string]] : []),
    ...(typeof env.OMX_ROOT === 'string' && env.OMX_ROOT.trim() !== ''
      ? [['OMX_ROOT', env.OMX_ROOT] as [string, string]]
      : []),
  ];
}


function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodePowerShellCommand(commandText: string): string {
  return Buffer.from(commandText, 'utf16le').toString('base64');
}

function resolveNativeWindowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const rootCandidates = [
    env.SystemRoot,
    env.SYSTEMROOT,
    env.windir,
    env.WINDIR,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value, index, values) => value !== '' && values.indexOf(value) === index);
  const systemPowerShellCandidates = rootCandidates.map(
    (root) => `${root.replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
  );
  const resolvedFromPath = resolveCommandPathForPlatform('powershell', process.platform, env);
  const existingCandidates = [
    ...systemPowerShellCandidates,
    resolvedFromPath,
  ].filter((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

  return existingCandidates.find((candidate) => !/\s/.test(candidate))
    ?? existingCandidates[0]
    ?? resolvedFromPath
    ?? 'powershell.exe';
}

export interface HudStartupCommandOptions {
  omxEntry: string;
  sessionId?: string | null;
  leaderPaneId?: string | null;
  /** Omit for the Team mode's existing bare-node POSIX command shape. */
  nodePath?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Test seam; production callers rely on native-platform detection. */
  nativeWindows?: boolean;
}

export function buildHudStartupCommand(options: HudStartupCommandOptions): string {
  const env = options.env ?? process.env;
  const omxEntry = translatePathForMsys(options.omxEntry);
  const configuredNodePath = options.nodePath?.trim() ?? '';
  const nativeWindows = options.nativeWindows ?? isNativeWindows();
  const nodeCommand = configuredNodePath
    ? translatePathForMsys(configuredNodePath)
    : nativeWindows
      ? translatePathForMsys(resolveLeaderNodePath())
      : 'node';
  return writeHudWatchCommand({
    omxEntry,
    runtimeEnv: Object.fromEntries(hudEnvValues(env, {
      sessionId: options.sessionId,
      leaderPaneId: options.leaderPaneId,
    })),
    nodeCommand,
    platform: nativeWindows ? 'win32' : process.platform,
  });
}

function normalizeTmuxHookToken(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return normalized === '' ? 'unknown' : normalized;
}

function normalizeHudPaneToken(hudPaneId: string): string {
  return normalizeTmuxHookToken(buildHudPaneTarget(hudPaneId).slice(1));
}

export function buildResizeHookTarget(sessionName: string, windowIndex: string): string {
  return `${sessionName}:${windowIndex}`;
}

export function buildResizeHookName(
  teamName: string,
  sessionName: string,
  windowIndex: string,
  hudPaneId: string,
): string {
  return [
    'omx_resize',
    normalizeTmuxHookToken(teamName),
    normalizeTmuxHookToken(sessionName),
    normalizeTmuxHookToken(windowIndex),
    normalizeHudPaneToken(hudPaneId),
  ].join('_');
}

export function buildHudPaneTarget(hudPaneId: string): string {
  const paneId = parseCanonicalTmuxPaneId(hudPaneId);
  if (!paneId || paneId !== hudPaneId) throw new Error(`invalid_tmux_pane_id:${hudPaneId}`);
  return paneId;
}

function resolveHudHeightLines(heightLines: number): number {
  if (!Number.isFinite(heightLines)) return HUD_TMUX_TEAM_HEIGHT_LINES;
  const normalized = Math.floor(heightLines);
  return normalized > 0 ? normalized : HUD_TMUX_TEAM_HEIGHT_LINES;
}

export interface HudResizeHookPaneIncarnations {
  leaderPaneId: string;
  leaderPanePid: string;
  hudPaneId: string;
  hudPanePid: string;
}

function buildHudResizeCommand(hudPaneId: string, heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES): string {
  return `resize-pane -t ${buildHudPaneTarget(hudPaneId)} -y ${resolveHudHeightLines(heightLines)}`;
}


function buildNestedTmuxShellCommand(command: string): string {
  if (process.platform !== 'win32') {
    return `tmux ${command}`;
  }

  const resolvedTmuxPath = resolveAbsoluteBinaryPath('tmux');
  if (resolvedTmuxPath === 'tmux') {
    return `tmux ${command}`;
  }

  return `${shellQuoteSingle(resolvedTmuxPath.replace(/\\/g, '/'))} ${command}`;
}

function buildBestEffortShellCommand(command: string): string {
  return isNativeWindows() ? `& ${command} | Out-Null` : `${command} >/dev/null 2>&1 || true`;
}

function validateHudResizeHookPaneIncarnations(incarnations: HudResizeHookPaneIncarnations): HudResizeHookPaneIncarnations {
  const leaderPaneId = parseCanonicalTmuxPaneId(incarnations.leaderPaneId);
  const hudPaneId = parseCanonicalTmuxPaneId(incarnations.hudPaneId);
  const leaderPanePid = String(incarnations.leaderPanePid);
  const hudPanePid = String(incarnations.hudPanePid);
  if (
    !leaderPaneId
    || !hudPaneId
    || leaderPaneId !== incarnations.leaderPaneId
    || hudPaneId !== incarnations.hudPaneId
    || !/^[1-9][0-9]*$/.test(leaderPanePid)
    || !/^[1-9][0-9]*$/.test(hudPanePid)
  ) throw new Error('invalid_tmux_hook_pane_incarnations');
  return { leaderPaneId, leaderPanePid, hudPaneId, hudPanePid };
}

function quoteHookShellArgument(value: string): string {
  return isNativeWindows()
    ? `'${value.replace(/'/g, "''")}'`
    : shellQuoteSingle(value);
}

function buildHudResizeIncarnationCondition(incarnation: TeamPaneIncarnation): string {
  return `#{&&:#{==:#{pane_id},${incarnation.paneId}},#{&&:#{==:#{pane_dead},0},#{==:#{pane_pid},${incarnation.panePid}}}}`;
}

function buildAtomicHudResizeMutation(
  hudPaneId: string,
  heightLines: number,
  incarnations: HudResizeHookPaneIncarnations,
  hookTarget?: string,
  hookSlot?: string,
  hookName?: string,
): string {
  const expected = validateHudResizeHookPaneIncarnations(incarnations);
  const leader = { paneId: expected.leaderPaneId, panePid: expected.leaderPanePid };
  const hud = { paneId: expected.hudPaneId, panePid: expected.hudPanePid };
  const unregister = hookTarget && hookSlot && hookName
    ? `if-shell -F -t ${hookTarget} ${quoteHookShellArgument(`#{==:${hookIdentityOption(hookSlot)},${hookIdentityToken(hookName)}}`)} ${quoteHookShellArgument(`set-hook -u -t ${hookTarget} ${hookSlot} \\; set-option -u -t ${hookTarget} ${hookIdentityOption(hookSlot)}`)} ''`
    : '';
  const inner = [
    'if-shell', '-F', '-t', hud.paneId,
    quoteHookShellArgument(buildHudResizeIncarnationCondition(hud)),
    quoteHookShellArgument(buildHudResizeCommand(hudPaneId, heightLines)),
    quoteHookShellArgument(unregister),
  ].join(' ');
  const conditional = [
    'if-shell', '-F', '-t', leader.paneId,
    quoteHookShellArgument(buildHudResizeIncarnationCondition(leader)),
    quoteHookShellArgument(inner),
    quoteHookShellArgument(unregister),
  ].join(' ');
  return buildBestEffortShellCommand(buildNestedTmuxShellCommand(conditional));
}


/** Upper bound for tmux hook indices (signed 32-bit max). */
const TMUX_HOOK_INDEX_MAX = 2147483647;

function hookIdentityOption(hookSlot: string): string {
  const match = /^(client-resized|client-attached)\[([0-9]+)\]$/.exec(hookSlot);
  if (!match) throw new Error('invalid_tmux_hook_slot');
  return `@omx_hook_identity_${match[1].replace('-', '_')}_${match[2]}`;
}

function hookIdentityToken(hookName: string): string {
  let hash = 2166136261;
  for (let i = 0; i < hookName.length; i++) {
    hash = Math.imul(hash ^ hookName.charCodeAt(i), 16777619);
  }
  return `omx-${(hash >>> 0).toString(16)}`;
}

function buildGuardedHookUnregisterArgs(hookTarget: string, hookSlot: string, hookName: string): string[] {
  const identityOption = hookIdentityOption(hookSlot);
  const identityToken = hookIdentityToken(hookName);
  return [
    'if-shell', '-F', '-t', hookTarget,
    `#{==:${identityOption},${identityToken}}`,
    `set-hook -u -t ${hookTarget} ${hookSlot} \\; set-option -u -t ${hookTarget} ${identityOption}`,
    '',
  ];
}

function buildHookIdentityRegistrationSuffix(hookTarget: string, hookSlot: string, hookName: string): string[] {
  return [
    ';', 'set-option', '-t', hookTarget,
    hookIdentityOption(hookSlot), hookIdentityToken(hookName),
  ];
}

function buildResizeHookSlot(hookName: string): string {
  let hash = 0;
  for (let i = 0; i < hookName.length; i++) {
    hash = (hash * 31 + hookName.charCodeAt(i)) | 0;
  }
  return `client-resized[${Math.abs(hash) % TMUX_HOOK_INDEX_MAX}]`;
}

function buildClientAttachedHookSlot(hookName: string): string {
  let hash = 0;
  for (let i = 0; i < hookName.length; i++) {
    hash = (hash * 31 + hookName.charCodeAt(i)) | 0;
  }
  return `client-attached[${Math.abs(hash) % TMUX_HOOK_INDEX_MAX}]`;
}

function buildHookMutationCommand(
  hudPaneId: string,
  heightLines: number,
  incarnations: HudResizeHookPaneIncarnations,
  hookTarget?: string,
  hookSlot?: string,
  hookName?: string,
): string {
  return buildAtomicHudResizeMutation(hudPaneId, heightLines, incarnations, hookTarget, hookSlot, hookName);
}

export function buildRegisterResizeHookArgs(
  hookTarget: string,
  hookName: string,
  hudPaneId: string,
  incarnationsOrHeight?: HudResizeHookPaneIncarnations | number,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
): string[] {
  const hookSlot = buildResizeHookSlot(hookName);
  const incarnations = typeof incarnationsOrHeight === 'object' ? incarnationsOrHeight : undefined;
  const effectiveHeight = typeof incarnationsOrHeight === 'number' ? incarnationsOrHeight : heightLines;
  const resizeCommand = buildBestEffortShellCommand(buildNestedTmuxShellCommand(buildHudResizeCommand(hudPaneId, effectiveHeight)));
  const guardedResize = incarnations
    ? buildHookMutationCommand(hudPaneId, effectiveHeight, incarnations, hookTarget, hookSlot, hookName)
    : resizeCommand;
  const hookBody = isNativeWindows()
    ? `${guardedResize}; Start-Sleep -Seconds ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}; ${guardedResize}`
    : `${guardedResize}; sleep ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}; ${guardedResize}`;
  const hookCommand = quoteHookShellArgument(hookBody);
  return [
    'set-hook', '-t', hookTarget, hookSlot, `run-shell -b ${hookCommand}`,
    ...buildHookIdentityRegistrationSuffix(hookTarget, hookSlot, hookName),
  ];
}

export function buildUnregisterResizeHookArgs(hookTarget: string, hookName: string): string[] {
  return buildGuardedHookUnregisterArgs(hookTarget, buildResizeHookSlot(hookName), hookName);
}

export function buildClientAttachedReconcileHookName(
  teamName: string,
  sessionName: string,
  windowIndex: string,
  hudPaneId: string,
): string {
  return [
    'omx_attached',
    normalizeTmuxHookToken(teamName),
    normalizeTmuxHookToken(sessionName),
    normalizeTmuxHookToken(windowIndex),
    normalizeHudPaneToken(hudPaneId),
  ].join('_');
}

export function buildRegisterClientAttachedReconcileArgs(
  hookTarget: string,
  hookName: string,
  hudPaneId: string,
  incarnationsOrHeight?: HudResizeHookPaneIncarnations | number,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
): string[] {
  const hookSlot = buildClientAttachedHookSlot(hookName);
  const incarnations = typeof incarnationsOrHeight === 'object' ? incarnationsOrHeight : undefined;
  const effectiveHeight = typeof incarnationsOrHeight === 'number' ? incarnationsOrHeight : heightLines;
  const resize = buildBestEffortShellCommand(buildNestedTmuxShellCommand(buildHudResizeCommand(hudPaneId, effectiveHeight)));
  const guardedResize = incarnations
    ? buildHookMutationCommand(hudPaneId, effectiveHeight, incarnations, hookTarget, hookSlot, hookName)
    : `${resize}; ${buildNestedTmuxShellCommand(`set-hook -u -t ${hookTarget} ${hookSlot}`)}`;
  const oneShotCommand = quoteHookShellArgument(guardedResize);
  return [
    'set-hook', '-t', hookTarget, hookSlot, `run-shell -b ${oneShotCommand}`,
    ...buildHookIdentityRegistrationSuffix(hookTarget, hookSlot, hookName),
  ];
}

export function buildUnregisterClientAttachedReconcileArgs(hookTarget: string, hookName: string): string[] {
  return buildGuardedHookUnregisterArgs(hookTarget, buildClientAttachedHookSlot(hookName), hookName);
}

export function unregisterResizeHook(hookTarget: string, hookName: string): boolean {
  const result = runTmux(buildUnregisterResizeHookArgs(hookTarget, hookName));
  return result.ok;
}

export function buildScheduleDelayedHudResizeArgs(
  hudPaneId: string,
  incarnations?: HudResizeHookPaneIncarnations,
  delaySeconds: number = HUD_RESIZE_RECONCILE_DELAY_SECONDS,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
): string[] {
  const delay = Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds : HUD_RESIZE_RECONCILE_DELAY_SECONDS;
  const resize = buildBestEffortShellCommand(buildNestedTmuxShellCommand(buildHudResizeCommand(hudPaneId, heightLines)));
  const command = incarnations ? buildHookMutationCommand(hudPaneId, heightLines, incarnations) : resize;
  return ['run-shell', '-b', isNativeWindows() ? `Start-Sleep -Seconds ${delay}; ${command}` : `sleep ${delay}; ${command}`];
}

export function buildReconcileHudResizeArgs(
  hudPaneId: string,
  incarnationsOrHeight?: HudResizeHookPaneIncarnations | number,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
): string[] {
  const incarnations = typeof incarnationsOrHeight === 'object' ? incarnationsOrHeight : undefined;
  const effectiveHeight = typeof incarnationsOrHeight === 'number' ? incarnationsOrHeight : heightLines;
  const resize = buildBestEffortShellCommand(buildNestedTmuxShellCommand(buildHudResizeCommand(hudPaneId, effectiveHeight)));
  return ['run-shell', incarnations ? buildHookMutationCommand(hudPaneId, effectiveHeight, incarnations) : resize];
}

function redrawLeaderPaneAfterTeamLayout(leaderPaneId: string): void {
  const target = parseCanonicalTmuxPaneId(leaderPaneId);
  if (!target) return;
  runTmux(['send-keys', '-t', target, 'C-l']);
}

const ZSH_CANDIDATE_PATHS = ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/local/bin/zsh', '/opt/homebrew/bin/zsh'];
const BASH_CANDIDATE_PATHS = ['/bin/bash', '/usr/bin/bash'];

function buildShellLaunchSpec(shell: string, rcFile: string | null): WorkerLaunchSpec {
  return { shell, rcFile };
}

export function shouldSourceTeamWorkerShellRc(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return String(env.OMX_TMUX_SOURCE_SHELL_RC ?? '').trim() === '1';
}

function resolveSupportedShellAffinity(shellPath: string | undefined): WorkerLaunchSpec | null {
  if (!shellPath || shellPath.trim() === '' || !existsSync(shellPath)) return null;
  if (/\/zsh$/i.test(shellPath)) return buildShellLaunchSpec(shellPath, '~/.zshrc');
  if (/\/bash$/i.test(shellPath)) return buildShellLaunchSpec(shellPath, '~/.bashrc');
  return null;
}

function resolveShellFromCandidates(paths: string[], rcFile: string): WorkerLaunchSpec | null {
  for (const shellPath of paths) {
    if (existsSync(shellPath)) return buildShellLaunchSpec(shellPath, rcFile);
  }
  return null;
}

function buildWorkerLaunchSpec(shellPath: string | undefined): WorkerLaunchSpec {
  if (isMsysOrGitBash()) {
    return buildShellLaunchSpec('/bin/sh', null);
  }

  const affinitySpec = resolveSupportedShellAffinity(shellPath);
  if (affinitySpec) return affinitySpec;

  const zshSpec = resolveShellFromCandidates(ZSH_CANDIDATE_PATHS, '~/.zshrc');
  if (zshSpec) return zshSpec;

  const bashSpec = resolveShellFromCandidates(BASH_CANDIDATE_PATHS, '~/.bashrc');
  if (bashSpec) return bashSpec;

  return buildShellLaunchSpec('/bin/sh', null);
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isModelInstructionsOverride(value: string): boolean {
  return new RegExp(`^${MODEL_INSTRUCTIONS_FILE_KEY}\\s*=`).test(value.trim());
}

function someConfigOverrideBeforeEndOfOptions(
  args: readonly string[],
  matches: (value: string) => boolean,
): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') break;

    let value: string | undefined;
    if (arg === CONFIG_FLAG || arg === LONG_CONFIG_FLAG) {
      value = args[index + 1];
      if (value === '--') break;
      index += 1;
    } else if (arg.startsWith(`${CONFIG_FLAG}=`)) {
      value = arg.slice(`${CONFIG_FLAG}=`.length);
    } else if (arg.startsWith(`${LONG_CONFIG_FLAG}=`)) {
      value = arg.slice(`${LONG_CONFIG_FLAG}=`.length);
    } else {
      continue;
    }

    if (typeof value === 'string' && matches(value)) return true;
  }
  return false;
}

function hasModelInstructionsOverride(args: readonly string[]): boolean {
  return someConfigOverrideBeforeEndOfOptions(args, isModelInstructionsOverride);
}

function normalizeTeamWorkerCliMode(raw: string | undefined, sourceEnv: string = OMX_TEAM_WORKER_CLI_ENV): TeamWorkerCliMode {
  const normalized = String(raw ?? 'auto').trim().toLowerCase();
  if (normalized === '' || normalized === 'auto') return 'auto';
  if (normalized === 'codex' || normalized === 'claude' || normalized === 'gemini') return normalized;
  throw new Error(`Invalid ${sourceEnv} value "${raw}". Expected: auto, codex, claude, gemini`);
}

export function resolveTeamWorkerLaunchMode(
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerLaunchMode {
  const raw = String(env[OMX_TEAM_WORKER_LAUNCH_MODE_ENV] ?? 'interactive').trim().toLowerCase();
  if (raw === '' || raw === 'interactive') return 'interactive';
  if (raw === 'prompt') return 'prompt';
  throw new Error(`Invalid ${OMX_TEAM_WORKER_LAUNCH_MODE_ENV} value "${env[OMX_TEAM_WORKER_LAUNCH_MODE_ENV]}". Expected: interactive, prompt`);
}

function extractModelOverride(args: string[]): string | null {
  let model: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === MODEL_FLAG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === 'string' && maybeValue.trim() !== '' && !maybeValue.startsWith('-')) {
        model = maybeValue.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(`${MODEL_FLAG}=`)) {
      const inline = arg.slice(`${MODEL_FLAG}=`.length).trim();
      if (inline !== '') model = inline;
    }
  }
  return model;
}

export function resolveTeamWorkerCli(launchArgs: string[] = [], env: NodeJS.ProcessEnv = process.env): TeamWorkerCli {
  const mode = normalizeTeamWorkerCliMode(env[OMX_TEAM_WORKER_CLI_ENV]);
  if (mode !== 'auto') return mode;
  return resolveTeamWorkerCliFromLaunchArgs(launchArgs);
}

function resolveTeamWorkerCliFromLaunchArgs(launchArgs: string[] = []): TeamWorkerCli {
  const model = extractModelOverride(launchArgs);
  if (model && /claude/i.test(model)) return 'claude';
  if (model && /gemini/i.test(model)) return 'gemini';
  return 'codex';
}

export function resolveTeamWorkerCliPlan(
  workerCount: number,
  launchArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerCli[] {
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(`workerCount must be >= 1 (got ${workerCount})`);
  }

  const rawMap = String(env[OMX_TEAM_WORKER_CLI_MAP_ENV] ?? '').trim();
  const fallback = (): TeamWorkerCli => resolveTeamWorkerCli(launchArgs, env);
  const fallbackAutoFromArgs = (): TeamWorkerCli => resolveTeamWorkerCliFromLaunchArgs(launchArgs);

  if (rawMap === '') {
    const cli = fallback();
    return Array.from({ length: workerCount }, () => cli);
  }

  const entries = rawMap
    .split(',')
    .map((part) => part.trim());

  if (entries.length === 0 || entries.every((part) => part.length === 0)) {
    throw new Error(
      `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} value "${env[OMX_TEAM_WORKER_CLI_MAP_ENV]}". `
        + `Expected comma-separated values: auto|codex|claude|gemini.`,
    );
  }
  if (entries.some((part) => part.length === 0)) {
    throw new Error(
      `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} value "${env[OMX_TEAM_WORKER_CLI_MAP_ENV]}". `
        + `Empty entries are not allowed.`,
    );
  }
  if (entries.length !== 1 && entries.length !== workerCount) {
    throw new Error(
      `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} length ${entries.length}; `
        + `expected 1 or ${workerCount} comma-separated values.`,
    );
  }

  const expanded = entries.length === 1 ? Array.from({ length: workerCount }, () => entries[0] as string) : entries;
  return expanded.map((entry) => {
    const mode = normalizeTeamWorkerCliMode(entry, OMX_TEAM_WORKER_CLI_MAP_ENV);
    return mode === 'auto' ? fallbackAutoFromArgs() : mode;
  });
}

export function resolveTeamWorkerCliForResolvedLaunchArgs(
  workerIndex: number,
  workerCount: number,
  resolvedLaunchArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerCli {
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(`workerCount must be >= 1 (got ${workerCount})`);
  }
  if (!Number.isInteger(workerIndex) || workerIndex < 1 || workerIndex > workerCount) {
    throw new Error(`workerIndex must be within 1..${workerCount} (got ${workerIndex})`);
  }

  const rawMap = String(env.OMX_TEAM_WORKER_CLI_MAP ?? '').trim();
  const autoCli = resolveTeamWorkerCli(resolvedLaunchArgs, {
    ...env,
    OMX_TEAM_WORKER_CLI: 'auto',
  });
  const normalizeEntry = (entry: string): TeamWorkerCli | 'auto' | null => {
    const normalized = entry.trim().toLowerCase();
    if (normalized === 'auto' || normalized === 'codex' || normalized === 'claude' || normalized === 'gemini') {
      return normalized;
    }
    return null;
  };
  const invalidMapError = () => new Error(
    `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} value "${env[OMX_TEAM_WORKER_CLI_MAP_ENV]}". `
      + `Expected comma-separated values: auto|codex|claude|gemini.`,
  );

  if (rawMap === '') {
    return resolveTeamWorkerCli(resolvedLaunchArgs, env);
  }

  const entries = rawMap.split(',').map((part) => part.trim());
  if (entries.length === 0 || entries.every((part) => part.length === 0)) {
    throw invalidMapError();
  }
  if (entries.some((part) => part.length === 0)) {
    throw new Error(
      `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} value "${env[OMX_TEAM_WORKER_CLI_MAP_ENV]}". `
        + `Empty entries are not allowed.`,
    );
  }
  if (entries.length !== 1 && entries.length !== workerCount) {
    throw new Error(
      `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} length ${entries.length}; `
        + `expected 1 or ${workerCount} comma-separated values.`,
    );
  }

  const entry = entries.length === 1 ? entries[0] as string : entries[workerIndex - 1];
  const mode = normalizeEntry(entry);
  if (!mode) throw invalidMapError();
  return mode === 'auto' ? autoCli : mode;
}

function shouldGrantExecutionBypassForRole(workerRole?: string): boolean {
  const normalizedRole = workerRole?.trim().toLowerCase();
  if (!normalizedRole) return true;
  const agent = getAgent(normalizedRole);
  if (!agent) return true;
  return agent.tools === 'execution';
}

export function assertTeamWorkerCliPolicyCompatibility(workerCli: TeamWorkerCli, launchArgs: string[]): void {
  const policy = classifyTeamWorkerLaunchPolicy(launchArgs);
  if ((workerCli === 'claude' || workerCli === 'gemini') && (policy === 'direct-policy' || policy === 'mixed-policy')) {
    throw new Error(
      `Selected team worker CLI "${workerCli}" is incompatible with an explicit approval or sandbox policy.`,
    );
  }
}

export function assertTeamWorkerLaunchPolicyInvariant(workerCli: TeamWorkerCli, launchArgs: string[]): void {
  assertTeamWorkerCliPolicyCompatibility(workerCli, launchArgs);
  if (workerCli === 'codex' && classifyTeamWorkerLaunchPolicy(launchArgs) === 'mixed-policy') {
    throw new Error('internal_mixed_codex_worker_policy_argv');
  }
}


export function translateWorkerLaunchArgsForCli(
  workerCli: TeamWorkerCli,
  args: string[],
  initialPrompt?: string,
  workerRole?: string,
): string[] {
  if (workerCli === 'codex') return [...args];
  if (workerCli === 'gemini') {
    const model = extractModelOverride(args);
    const geminiModel = model && /gemini/i.test(model) ? model : null;
    const translatedArgs = shouldGrantExecutionBypassForRole(workerRole)
      ? [GEMINI_APPROVAL_MODE_FLAG, GEMINI_APPROVAL_MODE_YOLO]
      : [];
    const trimmedPrompt = initialPrompt?.trim();
    if (trimmedPrompt) translatedArgs.push(GEMINI_PROMPT_INTERACTIVE_FLAG, trimmedPrompt);
    if (geminiModel) translatedArgs.push(MODEL_FLAG, geminiModel);
    return translatedArgs;
  }

  // Claude workers must launch with exactly one permissions bypass flag.
  // All other launch args are dropped to avoid Codex-only flags and model/config overrides.
  void args;
  return shouldGrantExecutionBypassForRole(workerRole) ? [CLAUDE_SKIP_PERMISSIONS_FLAG] : [];
}

function commandExists(binary: string): boolean {
  const { result } = spawnPlatformCommandSync(binary, ['--version'], { encoding: 'utf-8' });
  if (result.error) {
    return classifySpawnError(result.error as NodeJS.ErrnoException) !== 'missing';
  }
  return true;
}

export function trustWorkerMiseConfigIfAvailable(workerCwd: string): boolean {
  const miseConfigPath = join(workerCwd, '.mise.toml');
  if (!existsSync(miseConfigPath)) return false;
  if (!commandExists('mise')) return false;

  const { result } = spawnPlatformCommandSync('mise', ['trust', '--yes', miseConfigPath], { encoding: 'utf-8' });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || String(result.stderr || '').trim() || `mise exited ${result.status}`;
    console.warn(`[omx] mise trust failed for team worker config ${miseConfigPath}: ${reason}; continuing.`);
    return false;
  }
  return true;
}

/**
 * Resolve the absolute path of a binary from the leader's current environment.
 * Returns the absolute path or the bare command name as fallback.
 */
function resolveAbsoluteBinaryPath(binary: string): string {
  return resolveCommandPathForPlatform(binary) || binary;
}

/**
 * Resolve the leader's node binary path.
 * Caches results for the process lifetime.
 */
let _leaderPaths: { node: string; } | null = null;
function resolveLeaderNodePath(): string {
  const envOverride = process.env[OMX_LEADER_NODE_PATH_ENV];
  if (typeof envOverride === 'string' && envOverride.trim() !== '') {
    return envOverride.trim();
  }
  if (!_leaderPaths) {
    _leaderPaths = { node: resolveAbsoluteBinaryPath('node') };
  }
  return _leaderPaths.node;
}

export function assertTeamWorkerCliBinaryAvailable(
  workerCli: TeamWorkerCli,
  existsImpl: (binary: string) => boolean = commandExists,
): void {
  if (existsImpl(workerCli)) return;
  throw new Error(
    `Selected team worker CLI "${workerCli}" is not available on PATH. `
      + `Install "${workerCli}" or set ${OMX_TEAM_WORKER_CLI_ENV}=codex|claude|gemini.`,
  );
}

function shouldBypassDefaultSystemPrompt(env: NodeJS.ProcessEnv): boolean {
  return env[OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV] !== '0';
}

function buildModelInstructionsOverride(cwd: string, env: NodeJS.ProcessEnv): string {
  const filePath = translatePathForMsys(env[OMX_MODEL_INSTRUCTIONS_FILE_ENV] || join(cwd, 'AGENTS.md'));
  return `${MODEL_INSTRUCTIONS_FILE_KEY}="${escapeTomlString(filePath)}"`;
}

function readTmuxWorkerAmbientEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of TMUX_WORKER_AMBIENT_ENV_ALLOWLIST) {
    const value = env[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    inherited[key] = value;
  }
  return inherited;
}

export function scrubTeamWorkerHudOwnershipEnv<T extends Record<string, string | undefined>>(env: T): T {
  const scrubbed = { ...env };
  delete scrubbed[OMX_TMUX_HUD_OWNER_ENV];
  delete scrubbed[OMX_TMUX_HUD_LEADER_PANE_ENV];
  return scrubbed;
}

function hasConfigOverride(args: readonly string[], key: string): boolean {
  return someConfigOverrideBeforeEndOfOptions(args, (value) => {
    const trimmed = value.trim();
    return trimmed.startsWith(key) && /^\s*=/.test(trimmed.slice(key.length));
  });
}

function shouldDisableOmxMcpForTeamWorker(env: NodeJS.ProcessEnv): boolean {
  const raw = env[OMX_TEAM_WORKER_MCP_COMPAT_ENV]?.trim().toLowerCase();
  return !(raw === '1' || raw === 'true' || raw === 'on' || raw === 'compat');
}

function resolveCodexConfigPath(env: NodeJS.ProcessEnv): string {
  const codexHomeOverride = env.CODEX_HOME?.trim();
  const codexHomePath = codexHomeOverride
    ? (isAbsolute(codexHomeOverride) ? codexHomeOverride : resolve(codexHomeOverride))
    : join(homedir(), '.codex');
  return join(codexHomePath, 'config.toml');
}

function codexConfigDeclaresMcpServer(serverName: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const config = readFileSync(resolveCodexConfigPath(env), 'utf-8');
    const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${escaped}"|'${escaped}'|${escaped})\\s*\\]\\s*$`, 'm')
      .test(config);
  } catch {
    return false;
  }
}

function appendTeamWorkerMcpDisableOverrides(args: string[], env: NodeJS.ProcessEnv): void {
  if (!shouldDisableOmxMcpForTeamWorker(env)) return;
  for (const server of TEAM_WORKER_DISABLED_OMX_MCP_SERVERS) {
    if (!codexConfigDeclaresMcpServer(server, env)) continue;
    const key = `mcp_servers.${server}.enabled`;
    if (hasConfigOverride(args, key)) continue;
    const endOfOptionsIndex = args.indexOf('--');
    args.splice(endOfOptionsIndex < 0 ? args.length : endOfOptionsIndex, 0, CONFIG_FLAG, `${key}=false`);
  }
}

function insertArgsBeforeEndOfOptions(args: string[], insertedArgs: readonly string[]): string[] {
  const endOfOptionsIndex = args.indexOf('--');
  if (endOfOptionsIndex < 0) return [...args, ...insertedArgs];
  return [...args.slice(0, endOfOptionsIndex), ...insertedArgs, ...args.slice(endOfOptionsIndex)];
}

function insertCanonicalCodexBypassBeforeEndOfOptions(args: string[]): string[] {
  const endOfOptionsIndex = args.indexOf('--');
  const preMarkerArgs = endOfOptionsIndex < 0 ? args : args.slice(0, endOfOptionsIndex);
  const postMarkerArgs = endOfOptionsIndex < 0 ? [] : args.slice(endOfOptionsIndex);
  return [
    ...preMarkerArgs.filter((arg) => arg !== CODEX_BYPASS_FLAG && arg !== MADMAX_FLAG),
    CODEX_BYPASS_FLAG,
    ...postMarkerArgs,
  ];
}

function resolveWorkerLaunchArgs(extraArgs: string[] = [], cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  let merged = [...extraArgs];
  const initialPolicy = classifyTeamWorkerLaunchPolicy(merged);
  if (initialPolicy === 'direct-policy') {
    merged = normalizeTeamWorkerLaunchArgs(merged);
  }
  const policy = classifyTeamWorkerLaunchPolicy(merged);
  const ambientWantsBypass = parseTeamWorkerLaunchArgs(process.argv, 'ambient process arguments', { directPolicyMode: 'ignore' }).wantsBypass;
  if (policy === 'none' || policy === 'bypass') {
    const wantsBypass = ambientWantsBypass || policy === 'bypass';
    if (wantsBypass) {
      merged = insertCanonicalCodexBypassBeforeEndOfOptions(merged);
    }
  }
  if (shouldBypassDefaultSystemPrompt(env) && !hasModelInstructionsOverride(merged)) {
    merged = insertArgsBeforeEndOfOptions(merged, [CONFIG_FLAG, buildModelInstructionsOverride(cwd, env)]);
  }
  return merged;
}


export function buildWorkerStartupCommand(
  teamName: string,
  workerIndex: number,
  launchArgs: string[] = [],
  cwd: string = process.cwd(),
  extraEnv: Record<string, string> = {},
  workerCliOverride?: TeamWorkerCli,
  initialPrompt?: string,
  workerRole?: string,
): string {
  const processSpec = buildWorkerStartupProcessLaunchSpec(
    teamName,
    workerIndex,
    launchArgs,
    cwd,
    extraEnv,
    workerCliOverride,
    initialPrompt,
    workerRole,
  );
  const startupEnv = scrubTeamWorkerHudOwnershipEnv({
    ...readTmuxWorkerAmbientEnv(process.env),
    ...processSpec.env,
  });
  const startupArgs = [...processSpec.args];
  if (processSpec.workerCli === 'codex') {
    appendTeamWorkerMcpDisableOverrides(startupArgs, { ...process.env, ...extraEnv });
  }
  const resolvedLeaderNodePath = processSpec.env[OMX_LEADER_NODE_PATH_ENV]?.trim() || resolveLeaderNodePath();
  const leaderNodeDir = /[\\/]/.test(resolvedLeaderNodePath)
    ? translatePathForMsys(resolvedLeaderNodePath.replace(/[\\/][^\\/]+$/, ''))
    : '';
  if (isNativeWindows()) {
    const powershellPath = resolveNativeWindowsPowerShellPath();
    const pathBootstrap = leaderNodeDir
      ? `$env:PATH = ${quotePowerShellArg(`${leaderNodeDir};`)} + $env:PATH`
      : '';
    const hudEnvUnset = [OMX_TMUX_HUD_OWNER_ENV, OMX_TMUX_HUD_LEADER_PANE_ENV]
      .map((key) => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`)
      .join('; ');
    const envAssignments = Object.entries(startupEnv)
      .map(([key, value]) => `$env:${key} = ${quotePowerShellArg(value)}`)
      .join('; ');
    const invocation = ['&', quotePowerShellArg(processSpec.command), ...startupArgs.map(quotePowerShellArg)].join(' ');
    const encodedCommand = encodePowerShellCommand(
      [
        "$ErrorActionPreference = 'Stop'",
        pathBootstrap,
        hudEnvUnset,
        envAssignments,
        invocation,
      ].filter(Boolean).join('; '),
    );
    return `${powershellPath} -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`;
  }

  const launchSpec = buildWorkerLaunchSpec(process.env.SHELL);
  const pathPrefix = leaderNodeDir ? `export PATH=${shellQuoteSingle(leaderNodeDir)}:$PATH; ` : '';
  const quotedArgs = startupArgs.map((arg) => shellQuoteSingle(translatePathForMsys(arg))).join(' ');
  const quotedCommand = shellQuoteSingle(translatePathForMsys(processSpec.command));
  const cliInvocation = quotedArgs.length > 0 ? `exec ${quotedCommand} ${quotedArgs}` : `exec ${quotedCommand}`;
  // Keep worker tmux panes non-interactive and rc-free by default. PR #2283
  // blocked rc sourcing for detached leader/HUD panes, but team workers still
  // sourced ~/.bashrc or ~/.zshrc here, leaving the same #2239/#2282/#2358
  // recursive bash fan-out path open when team/ultrawork created workers.
  // Users who intentionally need legacy shell PATH bootstrapping can opt in
  // with the same tmux-pane escape hatch used by buildTmuxPaneCommand().
  const rcPrefix = shouldSourceTeamWorkerShellRc({ ...process.env, ...extraEnv }) && launchSpec.rcFile
    ? `if [ -f ${launchSpec.rcFile} ]; then source ${launchSpec.rcFile}; fi; `
    : '';
  const inner = `${rcPrefix}${pathPrefix}${cliInvocation}`;
  const envParts = Object.entries(startupEnv).map(([key, value]) => `${key}=${value}`);
  const unsetParts = ['-u', OMX_TMUX_HUD_OWNER_ENV, '-u', OMX_TMUX_HUD_LEADER_PANE_ENV];

  return `env ${[...unsetParts, ...envParts].map(shellQuoteSingle).join(' ')} ${shellQuoteSingle(launchSpec.shell)} -c ${shellQuoteSingle(inner)}`;
}

function assertShellEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`invalid worker startup env key: ${key}`);
  }
}

function buildWorkerStartupScriptContent(
  processSpec: WorkerProcessLaunchSpec,
  startupEnv: Record<string, string>,
  startupArgs: string[],
  cwd: string,
  extraEnv: Record<string, string>,
): string {
  const resolvedLeaderNodePath = processSpec.env[OMX_LEADER_NODE_PATH_ENV]?.trim() || resolveLeaderNodePath();
  const leaderNodeDir = /[\\/]/.test(resolvedLeaderNodePath)
    ? translatePathForMsys(resolvedLeaderNodePath.replace(/[\\/][^\\/]+$/, ''))
    : '';
  const launchSpec = buildWorkerLaunchSpec(process.env.SHELL);
  const pathPrefix = leaderNodeDir ? `export PATH=${shellQuoteSingle(leaderNodeDir)}:$PATH\n` : '';
  const quotedArgs = startupArgs.map((arg) => shellQuoteSingle(translatePathForMsys(arg))).join(' ');
  const quotedCommand = shellQuoteSingle(translatePathForMsys(processSpec.command));
  const cliInvocation = quotedArgs.length > 0 ? `exec ${quotedCommand} ${quotedArgs}` : `exec ${quotedCommand}`;
  const rcPrefix = shouldSourceTeamWorkerShellRc({ ...process.env, ...extraEnv }) && launchSpec.rcFile
    ? `if [ -f ${launchSpec.rcFile} ]; then . ${launchSpec.rcFile}; fi\n`
    : '';
  const envExports = Object.entries(startupEnv)
    .map(([key, value]) => {
      assertShellEnvKey(key);
      return `export ${key}=${shellQuoteSingle(value)}`;
    })
    .join('\n');

  return [
    '#!/bin/sh',
    'set -eu',
    `unset ${OMX_TMUX_HUD_OWNER_ENV} ${OMX_TMUX_HUD_LEADER_PANE_ENV}`,
    `cd ${shellQuoteSingle(translatePathForMsys(cwd))}`,
    envExports,
    `exec ${shellQuoteSingle(launchSpec.shell)} -c ${shellQuoteSingle(`${rcPrefix}${pathPrefix}${cliInvocation}`)}`,
    '',
  ].filter((line) => line !== '').join('\n');
}

export function writeWorkerStartupScriptCommand(
  teamName: string,
  workerIndex: number,
  launchArgs: string[] = [],
  cwd: string = process.cwd(),
  extraEnv: Record<string, string> = {},
  workerCliOverride?: TeamWorkerCli,
  initialPrompt?: string,
  workerRole?: string,
): string | null {
  if (process.platform === 'win32' && !isMsysOrGitBash()) return null;
  const stateRoot = extraEnv[OMX_TEAM_STATE_ROOT_ENV]?.trim();
  if (!stateRoot) return null;

  const processSpec = buildWorkerStartupProcessLaunchSpec(
    teamName,
    workerIndex,
    launchArgs,
    cwd,
    extraEnv,
    workerCliOverride,
    initialPrompt,
    workerRole,
  );
  const startupEnv = {
    ...readTmuxWorkerAmbientEnv(process.env),
    ...processSpec.env,
  };
  const startupArgs = [...processSpec.args];
  if (processSpec.workerCli === 'codex') {
    appendTeamWorkerMcpDisableOverrides(startupArgs, { ...process.env, ...extraEnv });
  }

  const scriptPath = join(stateRoot, 'team', teamName, 'runtime', `worker-${workerIndex}-startup.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, buildWorkerStartupScriptContent(processSpec, startupEnv, startupArgs, cwd, extraEnv), 'utf-8');
  chmodSync(scriptPath, 0o700);
  return `exec /bin/sh ${shellQuoteSingle(translatePathForMsys(scriptPath))}`;
}

type WorkerProcessLaunchMode = 'direct-spawn' | 'posix-startup-script';

export function buildWorkerProcessLaunchSpec(
  teamName: string,
  workerIndex: number,
  launchArgs: string[] = [],
  cwd: string = process.cwd(),
  extraEnv: Record<string, string> = {},
  workerCliOverride?: TeamWorkerCli,
  initialPrompt?: string,
  workerRole?: string,
): WorkerProcessLaunchSpec {
  return buildWorkerProcessLaunchSpecForMode(
    'direct-spawn',
    teamName,
    workerIndex,
    launchArgs,
    cwd,
    extraEnv,
    workerCliOverride,
    initialPrompt,
    workerRole,
  );
}

function buildWorkerStartupProcessLaunchSpec(
  teamName: string,
  workerIndex: number,
  launchArgs: string[] = [],
  cwd: string = process.cwd(),
  extraEnv: Record<string, string> = {},
  workerCliOverride?: TeamWorkerCli,
  initialPrompt?: string,
  workerRole?: string,
): WorkerProcessLaunchSpec {
  return buildWorkerProcessLaunchSpecForMode(
    'posix-startup-script',
    teamName,
    workerIndex,
    launchArgs,
    cwd,
    extraEnv,
    workerCliOverride,
    initialPrompt,
    workerRole,
  );
}

function buildWorkerProcessLaunchSpecForMode(
  mode: WorkerProcessLaunchMode,
  teamName: string,
  workerIndex: number,
  launchArgs: string[] = [],
  cwd: string = process.cwd(),
  extraEnv: Record<string, string> = {},
  workerCliOverride?: TeamWorkerCli,
  initialPrompt?: string,
  workerRole?: string,
): WorkerProcessLaunchSpec {
  const effectiveEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const fullLaunchArgs = resolveWorkerLaunchArgs(launchArgs, cwd, effectiveEnv);
  const workerCli = workerCliOverride ?? resolveTeamWorkerCli(fullLaunchArgs, effectiveEnv);
  assertTeamWorkerLaunchPolicyInvariant(workerCli, fullLaunchArgs);

  const cliLaunchArgs = translateWorkerLaunchArgsForCli(workerCli, fullLaunchArgs, initialPrompt, workerRole);
  const launchPolicy = workerCli === 'codex'
    ? classifyTeamWorkerLaunchPolicy(cliLaunchArgs)
    : 'none';
  const effectiveCliLaunchArgs = workerCli === 'codex'
    && shouldGrantExecutionBypassForRole(workerRole)
    && launchPolicy === 'none'
    ? insertCanonicalCodexBypassBeforeEndOfOptions(cliLaunchArgs)
    : cliLaunchArgs;
  const workerCodexHomeOverride = typeof effectiveEnv.CODEX_HOME === 'string'
    ? effectiveEnv.CODEX_HOME.trim()
    : undefined;
  const workerSqliteHomeOverride = typeof effectiveEnv[CODEX_SQLITE_HOME_ENV] === 'string'
    ? effectiveEnv[CODEX_SQLITE_HOME_ENV].trim()
    : undefined;
  const providerLookupCodexHome = workerCodexHomeOverride
    ? (isAbsolute(workerCodexHomeOverride) ? workerCodexHomeOverride : resolve(cwd, workerCodexHomeOverride))
    : undefined;

  const resolvedCliPath = resolveAbsoluteBinaryPath(workerCli);
  const shouldUseNativeWindowsLaunchSpec = process.platform === 'win32'
    && (mode === 'direct-spawn' || !isMsysOrGitBash(effectiveEnv, process.platform));

  const platformSpec = shouldUseNativeWindowsLaunchSpec
    ? buildPlatformCommandSpec(workerCli, effectiveCliLaunchArgs, process.platform, effectiveEnv)
    : { command: resolvedCliPath, args: effectiveCliLaunchArgs, resolvedPath: resolvedCliPath };
  const resolvedLauncherPath = platformSpec.resolvedPath || resolvedCliPath;
  const modelProviderOverride = workerCli === 'codex'
    ? extractModelProviderOverrideValue(effectiveCliLaunchArgs)
    : undefined;
  const codexProviderEnv = workerCli === 'codex'
    ? readActiveProviderEnvOverrides(
        effectiveEnv,
        providerLookupCodexHome,
        modelProviderOverride,
      )
    : {};
  const internalWorkerIdentity = `${teamName}/worker-${workerIndex}`;
  const displayTeamName = typeof extraEnv.OMX_TEAM_DISPLAY_NAME === 'string'
    ? extraEnv.OMX_TEAM_DISPLAY_NAME.trim()
    : '';
  const publicWorkerIdentity = displayTeamName
    ? `${displayTeamName}/worker-${workerIndex}`
    : internalWorkerIdentity;
  const workerEnv: Record<string, string> = {
    OMX_TEAM_WORKER: publicWorkerIdentity,
    OMX_TEAM_INTERNAL_WORKER: internalWorkerIdentity,
    [OMX_LEADER_NODE_PATH_ENV]: resolveLeaderNodePath(),
    [OMX_LEADER_CLI_PATH_ENV]: resolvedLauncherPath,
    ...(workerCli === 'codex' && workerCodexHomeOverride
      ? { CODEX_HOME: workerCodexHomeOverride }
      : {}),
    ...(workerCli === 'codex' && workerSqliteHomeOverride
      ? { [CODEX_SQLITE_HOME_ENV]: workerSqliteHomeOverride }
      : {}),
    ...codexProviderEnv,
  };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    workerEnv[key] = value;
  }

  return {
    workerCli,
    command: platformSpec.command,
    args: platformSpec.args,
    env: scrubTeamWorkerHudOwnershipEnv(workerEnv),
  };
}

// Sanitize team name: lowercase, alphanumeric + hyphens, max 30 chars
export function sanitizeTeamName(name: string): string {
  const lowered = name.toLowerCase();
  const replaced = lowered
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '');

  const truncated = replaced.slice(0, 30).replace(/-$/, '');
  if (truncated.trim() === '') {
    throw new Error('sanitizeTeamName: empty after sanitization');
  }
  return truncated;
}

/**
 * Detect whether the process is running inside a WSL2 environment.
 * WSL2 always sets WSL_DISTRO_NAME; WSL_INTEROP is also present.
 * Fallback: check /proc/version for the Microsoft kernel string.
 */
export function isWsl2(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return true;
  }
  try {
    const version = readFileSync('/proc/version', 'utf-8');
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
}

/**
 * Detect whether the process is running on native Windows (not WSL2).
 * OMX requires tmux, which is unavailable on native Windows.
 */
export function isNativeWindows(): boolean {
  return process.platform === 'win32' && !isWsl2() && !isMsysOrGitBash();
}

// Check if tmux is available
export function isTmuxAvailable(): boolean {
  const { result } = spawnPlatformCommandSync('tmux', ['-V'], { encoding: 'utf-8' });
  if (result.error) return false;
  return result.status === 0;
}

// Create tmux session with N worker windows
// Split the current tmux leader window into worker panes.
// Returns TeamSession or throws if tmux not available
export function createTeamSession(
  teamName: string,
  workerCount: number,
  cwd: string,
  workerLaunchArgs: string[] = [],
  workerStartups: Array<{
    cwd?: string;
    env?: Record<string, string>;
    initialPrompt?: string;
    launchArgs?: string[];
    workerCli?: TeamWorkerCli;
    workerRole?: string;
  }> = [],
  options: CreateTeamSessionOptions = {},
): TeamSession {
  if (!isTmuxAvailable()) {
    throw new Error('tmux is not available');
  }
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(`workerCount must be >= 1 (got ${workerCount})`);
  }
  if (!hasCurrentTmuxClientContext()) {
    throw new Error('team mode requires running inside tmux leader pane');
  }
  const normalizedWorkerLaunchArgs = resolveWorkerLaunchArgs(workerLaunchArgs, cwd);
  const defaultWorkerCliPlan = resolveTeamWorkerCliPlan(workerCount, normalizedWorkerLaunchArgs, process.env);
  const workerCliPlan = Array.from(
    { length: workerCount },
    (_, index) => workerStartups[index]?.workerCli ?? defaultWorkerCliPlan[index]!,
  );
  for (const workerCli of new Set(workerCliPlan)) {
    assertTeamWorkerCliBinaryAvailable(workerCli);
  }
  const workerLaunchPolicyPlan = Array.from({ length: workerCount }, (_, index) => {
    const startup = workerStartups[index] ?? {};
    const workerCwd = startup.cwd || cwd;
    const workerEnv = startup.env || {};
    const launchArgs = startup.launchArgs || workerLaunchArgs;
    const effectiveLaunchArgs = resolveWorkerLaunchArgs(
      launchArgs,
      workerCwd,
      { ...process.env, ...workerEnv },
    );
    assertTeamWorkerLaunchPolicyInvariant(workerCliPlan[index]!, effectiveLaunchArgs);
    return Object.freeze([...launchArgs]);
  });

  const safeTeamName = sanitizeTeamName(teamName);
  let registeredResizeHook: { name: string; target: string } | null = null;
  let registeredClientAttachedHook: { name: string; target: string } | null = null;
  let rollbackLeaderPaneId: string | null = null;
  const rollbackPreExistingPaneIds = new Set<string>();
  const operationCreatedPaneIds = new Set<string>();
  const rollbackPaneIds: string[] = [];
  const rollbackPaneAuthorities = new Map<string, VerifiedSplitPane>();

  try {
    const rawTmuxPaneTarget = process.env.TMUX_PANE;
    const tmuxPaneTarget = parseCanonicalTmuxPaneId(rawTmuxPaneTarget);
    if (rawTmuxPaneTarget !== undefined && !tmuxPaneTarget) {
      throw new Error(`refusing non-canonical TMUX_PANE target: ${rawTmuxPaneTarget}`);
    }
    const displayArgs = tmuxPaneTarget
      ? ['display-message', '-p', '-t', tmuxPaneTarget, '#{session_name}:#{window_index} #{pane_id}']
      : ['display-message', '-p', '#{session_name}:#{window_index} #{pane_id}'];
    const context = runTmux(displayArgs);
    if (!context.ok) {
      const paneHint = tmuxPaneTarget ? ` (TMUX_PANE=${tmuxPaneTarget})` : '';
      throw new Error(`failed to detect current tmux target${paneHint}: ${context.stderr}`);
    }
    const currentContext = parseCurrentTmuxContext(context.stdout);
    if (!currentContext) {
      throw new Error(`failed to parse current tmux target: ${context.stdout}`);
    }
    const { sessionName, windowIndex, leaderPaneId: detectedLeaderPaneId } = currentContext;
    const teamTarget = `${sessionName}:${windowIndex}`;
    const globalPaneIds = readGlobalTmuxPaneIdSnapshot();
    if (!globalPaneIds) {
      throw new Error('failed to snapshot nonempty canonical global tmux pane ids before team creation');
    }
    const panes = listPanes(teamTarget);
    if (
      !panes
      || panes.length === 0
      || !panes.some((pane) => pane.paneId === detectedLeaderPaneId)
      || !globalPaneIds.has(detectedLeaderPaneId)
      || panes.some((pane) => !globalPaneIds.has(pane.paneId))
    ) {
      throw new Error('failed to establish current leader/window/global tmux pane agreement before team creation');
    }
    const selectedLeaderPaneId = chooseTeamLeaderPaneId(panes, detectedLeaderPaneId);
    const leaderPaneId = parseCanonicalTmuxPaneId(selectedLeaderPaneId);
    if (!leaderPaneId || !globalPaneIds.has(leaderPaneId)) {
      throw new Error(`failed to select a canonical team leader pane: ${selectedLeaderPaneId}`);
    }
    const initialLeaderHudPaneIds = findHudWatchPaneIds(panes, leaderPaneId, { leaderPaneId });
    const initialLeaderPaneIncarnation = initialLeaderHudPaneIds.length > 0
      ? readTeamPaneIncarnation(leaderPaneId)
      : null;
    if (initialLeaderHudPaneIds.length > 0 && (!initialLeaderPaneIncarnation || !isTeamPaneIncarnationLive(leaderPaneId, initialLeaderPaneIncarnation.panePid))) {
      throw new Error('failed to capture exact current leader pane authority before team creation');
    }
    const initialLeaderHudPaneIncarnations = initialLeaderHudPaneIds.map((paneId) => {
      if (!globalPaneIds.has(paneId) || paneId === leaderPaneId) {
        throw new Error('failed to validate initial leader HUD snapshot');
      }
      const incarnation = readTeamPaneIncarnation(paneId);
      if (!incarnation || !isTeamPaneIncarnationLive(paneId, incarnation.panePid)) {
        throw new Error('failed to capture exact initial leader HUD authority');
      }
      return incarnation;
    });

    rollbackLeaderPaneId = leaderPaneId;
    for (const paneId of globalPaneIds) rollbackPreExistingPaneIds.add(paneId);
    const ownerSessionId = (options.ownerSessionId ?? process.env.OMX_SESSION_ID ?? '').trim();
    const teamPaneOwnerId = (options.teamPaneOwnerId ?? `team:${safeTeamName}`).trim();
    if (ownerSessionId) {
      const tagResult = runTmux(['set-option', '-t', sessionName, OMX_INSTANCE_OPTION, ownerSessionId]);
      if (!tagResult.ok) {
        throw new Error(`failed to tag tmux session ${sessionName}: ${tagResult.stderr}`);
      }
    }
    tagPaneInstance(leaderPaneId, ownerSessionId);
    tagPaneTeamOwner(leaderPaneId, teamPaneOwnerId);


    const omxEntry = resolveOmxCliEntryPath();
    const canRecreateTeamHud = Boolean(omxEntry && omxEntry.trim() !== '');
    // Team mode prioritizes leader + worker visibility. Recreate any HUD owned
    // by this leader only from the initial canonical snapshot; neighboring HUDs
    // are never inferred from a later, mutable layout observation.
    let hudPaneId: string | null = null;
    let hudPaneIncarnation: TeamPaneIncarnation | null = null;
    if (initialLeaderHudPaneIncarnations.length > 0) {
      const leaderIncarnation = initialLeaderPaneIncarnation;
      if (!leaderIncarnation) {
        throw new Error('missing initial leader authority for leader-owned HUD reconciliation');
      }
      if (initialLeaderHudPaneIncarnations.length !== 1) {
        throw new Error('cannot safely converge multiple leader-owned HUD panes during team creation');
      }
      const [existingHud] = initialLeaderHudPaneIncarnations;
      if (!isTeamPaneIncarnationLive(leaderIncarnation.paneId, leaderIncarnation.panePid)
        || !isTeamPaneIncarnationLive(existingHud!.paneId, existingHud!.panePid)) {
        throw new Error('leader or existing HUD authority changed before Team HUD reconciliation');
      }
      if (!canRecreateTeamHud) {
        hudPaneId = existingHud!.paneId;
        hudPaneIncarnation = existingHud!;
      }
    }


    const workerPaneIds: string[] = [];
    let rightStackRootPaneId: string | null = null;
    for (let i = 1; i <= workerCount; i++) {
      const startup = workerStartups[i - 1] || {};
      const workerCwd = startup.cwd || cwd;
      const tmuxWorkerCwd = translatePathForMsys(workerCwd);
      const workerEnv = startup.env || {};
      const launchArgsForWorker = [...(workerLaunchPolicyPlan[i - 1] ?? workerLaunchArgs)];
      trustWorkerMiseConfigIfAvailable(workerCwd);
      const cmd = writeWorkerStartupScriptCommand(
        safeTeamName,
        i,
        launchArgsForWorker,
        workerCwd,
        workerEnv,
        workerCliPlan[i - 1],
        startup.initialPrompt,
        startup.workerRole,
      ) ?? buildWorkerStartupCommand(
        safeTeamName,
        i,
        launchArgsForWorker,
        workerCwd,
        workerEnv,
        workerCliPlan[i - 1],
        startup.initialPrompt,
        startup.workerRole,
      );

      // First split creates the right side from leader. Remaining splits stack on the right.
      const splitDirection = i === 1 ? '-h' : '-v';
      const splitTarget = i === 1 ? leaderPaneId : (rightStackRootPaneId ?? leaderPaneId);
      const splitAuthority = splitAndAdoptPane([
        'split-window',
        splitDirection,
        '-t',
        splitTarget,
        '-d',
        '-P',
        '-F',
        '#{pane_id}',
        '-c',
        tmuxWorkerCwd,
        cmd,
      ], splitTarget, teamTarget);
      if (!splitAuthority) {
        throw new Error(`failed to prove worker pane authority for worker ${i}`);
      }
      const paneId = splitAuthority.paneId;
      operationCreatedPaneIds.add(paneId);
      rollbackPaneIds.push(paneId);
      rollbackPaneAuthorities.set(paneId, splitAuthority);

      if (!revalidateSplitPaneAuthority(splitAuthority)) {
        throw new Error(`worker pane ${i} authority changed before ownership adoption`);
      }
      tagPaneInstance(paneId, ownerSessionId);
      tagPaneTeamOwner(paneId, teamPaneOwnerId);
      workerPaneIds.push(paneId);
      if (i === 1) rightStackRootPaneId = paneId;

    }
    if (!workerPaneIds.every((paneId) => revalidateSplitPaneAuthority(rollbackPaneAuthorities.get(paneId) ?? { paneId: '', panePid: '', sessionId: '', adoptionOption: '', adoptionReceipt: '', operationMarker: '', windowTarget: '' }))) {
      throw new Error('worker pane authority changed before team layout mutation');
    }


    // Keep leader as full left/main pane; workers stay stacked on the right.
    runTmux(['select-layout', '-t', teamTarget, 'main-vertical']);

    // Force leader pane to use half the window width.
    const windowWidthResult = runTmux(['display-message', '-p', '-t', teamTarget, '#{window_width}']);
    if (windowWidthResult.ok) {
      const width = Number.parseInt(windowWidthResult.stdout.split('\n')[0]?.trim() || '', 10);
      if (Number.isFinite(width) && width >= 40) {
        const half = String(Math.floor(width / 2));
        runTmux(['set-window-option', '-t', teamTarget, 'main-pane-width', half]);
        runTmux(['select-layout', '-t', teamTarget, 'main-vertical']);
      }
    }

    // Create a full-width bottom strip after layout sizing when no existing
    // leader-owned HUD can be reused safely.
    let resizeHookName: string | null = null;
    let resizeHookTarget: string | null = null;

    if (!hudPaneId && canRecreateTeamHud && omxEntry) {
      const hudCmd = buildHudStartupCommand({
        omxEntry,
        sessionId: ownerSessionId,
        leaderPaneId,
      });
      const hudCwd = translatePathForMsys(cwd);
      const hudAuthority = splitAndAdoptPane([
        'split-window', '-v', '-f', '-l', String(HUD_TMUX_TEAM_HEIGHT_LINES), '-t', teamTarget, '-d', '-P', '-F', '#{pane_id}', '-c', hudCwd, hudCmd,
      ], leaderPaneId, teamTarget);
      if (!hudAuthority) {
        throw new Error('failed to prove team HUD pane authority');
      }
      const hudPaneCandidate = hudAuthority.paneId;
      operationCreatedPaneIds.add(hudPaneCandidate);
      rollbackPaneIds.push(hudPaneCandidate);
      rollbackPaneAuthorities.set(hudPaneCandidate, hudAuthority);

      if (!revalidateSplitPaneAuthority(hudAuthority)) {
        throw new Error('team HUD pane authority changed before ownership adoption');
      }
      tagPaneInstance(hudPaneCandidate, ownerSessionId);
      tagPaneTeamOwner(hudPaneCandidate, teamPaneOwnerId);
      hudPaneId = hudPaneCandidate;
      hudPaneIncarnation = { paneId: hudAuthority.paneId, panePid: hudAuthority.panePid };

      if (!revalidateSplitPaneAuthority(hudAuthority)) {
        throw new Error('team HUD pane authority changed before resize or hook registration');
      }


          if (isNativeWindows()) {
            // Native Windows tmux support may flow through psmux; keep the
            // authority check and resize in one server-side transaction.
            if (!resizeTeamPaneIncarnation(hudAuthority, HUD_TMUX_TEAM_HEIGHT_LINES)) {
              throw new Error('failed to reconcile exact HUD pane resize');
            }
          } else {
            const hookTarget = buildResizeHookTarget(sessionName, windowIndex);
            const hookName = buildResizeHookName(safeTeamName, sessionName, windowIndex, hudPaneId);
            if (!revalidateSplitPaneAuthority(hudAuthority)) throw new Error('team HUD pane authority changed before resize hook registration');
            const leaderPaneIncarnation = readTeamPaneIncarnation(leaderPaneId);
            if (!leaderPaneIncarnation || !isTeamPaneIncarnationLive(leaderPaneIncarnation.paneId, leaderPaneIncarnation.panePid)) {
              throw new Error('team leader pane authority changed before resize hook registration');
            }
            const hookPaneIncarnations: HudResizeHookPaneIncarnations = {
              leaderPaneId: leaderPaneIncarnation.paneId,
              leaderPanePid: leaderPaneIncarnation.panePid,
              hudPaneId: hudAuthority.paneId,
              hudPanePid: hudAuthority.panePid,
            };

            const registerHook = runTmux(buildRegisterResizeHookArgs(hookTarget, hookName, hudPaneId, hookPaneIncarnations));
            const clientAttachedHookName = buildClientAttachedReconcileHookName(
              safeTeamName,
              sessionName,
              windowIndex,
              hudPaneId,
            );
            if (registerHook.ok) {
              resizeHookTarget = hookTarget;
              resizeHookName = hookName;
              registeredResizeHook = { name: resizeHookName, target: resizeHookTarget };
            } else {
              // tmux versions/builds that reject indexed client-resized hooks should not
              // abort madmax/team startup after panes were successfully created. Keep the
              // fallback narrow: skip only the long-lived resize hook metadata, then
              // still try the one-shot client-attached reconcile plus the explicit
              // delayed/direct resize checks below so real tmux/run-shell failures
              // still surface.
              console.warn(
                `[omx] tmux resize hook unavailable for ${hookTarget} (${hookName}): ${registerHook.stderr}; `
                  + 'continuing with best-effort HUD resize fallback.',
              );
            }
            if (!revalidateSplitPaneAuthority(hudAuthority)) throw new Error('team HUD pane authority changed before client hook registration');

            const registerClientAttachedHook = runTmux(
              buildRegisterClientAttachedReconcileArgs(hookTarget, clientAttachedHookName, hudPaneId, hookPaneIncarnations),
            );
            if (registerClientAttachedHook.ok) {
              registeredClientAttachedHook = { name: clientAttachedHookName, target: hookTarget };
            } else {
              console.warn(
                `[omx] tmux client-attached resize fallback unavailable for ${hookTarget} `
                  + `(${clientAttachedHookName}): ${registerClientAttachedHook.stderr}; continuing with delayed HUD resize fallback.`,
              );
            }

            if (!revalidateSplitPaneAuthority(hudAuthority)) throw new Error('team HUD pane authority changed before delayed resize');

            const delayed = runTmux(buildScheduleDelayedHudResizeArgs(hudPaneId, hookPaneIncarnations));
            if (!delayed.ok) {
              console.warn(`[omx] tmux delayed HUD resize unavailable for ${hudPaneId}: ${delayed.stderr}; continuing.`);
            }
            if (!revalidateSplitPaneAuthority(hudAuthority)) throw new Error('team HUD pane authority changed before reconcile resize');

            const reconcile = runTmux(buildReconcileHudResizeArgs(hudPaneId, hookPaneIncarnations));
            if (!reconcile.ok) {
              console.warn(`[omx] tmux HUD resize reconcile unavailable for ${hudPaneId}: ${reconcile.stderr}; continuing.`);
            }
          }

      }

    if (hudPaneId && (!hudPaneIncarnation || !isTeamPaneIncarnationLive(hudPaneIncarnation.paneId, hudPaneIncarnation.panePid))) {
      throw new Error('team HUD pane authority changed before leader selection');
    }
    runTmux(['select-pane', '-t', leaderPaneId]);
    redrawLeaderPaneAfterTeamLayout(leaderPaneId);
    sleepSeconds(0.5);
    const finalWorkerAuthorities = workerPaneIds.map((paneId) => rollbackPaneAuthorities.get(paneId));
    if (
      finalWorkerAuthorities.some((authority) => !authority || !revalidateSplitPaneAuthority(authority) || !isPaneStablyLiveInStrictGlobalProbe(authority.paneId, authority.panePid))
      || (hudPaneIncarnation !== null && !isPaneStablyLiveInStrictGlobalProbe(hudPaneIncarnation.paneId, hudPaneIncarnation.panePid))
    ) {
      throw new Error('team pane authority changed during final stabilization');
    }
    if (canRecreateTeamHud && initialLeaderHudPaneIncarnations.length === 1) {
      const priorHud = initialLeaderHudPaneIncarnations[0]!;
      if (!hudPaneIncarnation || hudPaneIncarnation.paneId === priorHud.paneId || !removeTeamPaneIncarnation(priorHud)) {
        throw new Error('failed to replace the exact initial leader-owned HUD pane');
      }
    }

    // Enable mouse scrolling so agent output panes can be scrolled with the
    // mouse wheel without conflicting with keyboard up/down arrow-key input
    // history navigation in the Codex CLI input field. (issue #103)
    // Opt-out: set OMX_TEAM_MOUSE=0 in the environment.
    if (process.env.OMX_TEAM_MOUSE !== '0') {
      enableMouseScrolling(sessionName);
    }

    return {
      name: teamTarget,
      workerCount,
      cwd,
      workerPaneIds,
      workerPaneIncarnations: workerPaneIds.map((paneId) => {
        const authority = rollbackPaneAuthorities.get(paneId);
        if (!authority) throw new Error(`missing worker pane incarnation: ${paneId}`);
        return { paneId: authority.paneId, panePid: authority.panePid };
      }),
      leaderPaneId,
      hudPaneId,
      hudPaneIncarnation,
      resizeHookName,
      resizeHookTarget,
      teamPaneOwnerId,
    };
  } catch (error) {
    if (registeredClientAttachedHook) {
      runTmux(
        buildUnregisterClientAttachedReconcileArgs(
          registeredClientAttachedHook.target,
          registeredClientAttachedHook.name,
        ),
      );
    }
    if (registeredResizeHook) {
      runTmux(buildUnregisterResizeHookArgs(registeredResizeHook.target, registeredResizeHook.name));
    }
    for (const paneId of rollbackPaneIds) {
      const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
      if (
        !canonicalPaneId
        || canonicalPaneId === rollbackLeaderPaneId
        || rollbackPreExistingPaneIds.has(canonicalPaneId)
        || !operationCreatedPaneIds.has(canonicalPaneId)
        || !hasSplitPaneRollbackAuthority(rollbackPaneAuthorities.get(canonicalPaneId) ?? { paneId: '', panePid: '', sessionId: '', adoptionOption: '', adoptionReceipt: '', operationMarker: '', windowTarget: '' })

      ) {
        continue;
      }
      rollbackSplitPaneAuthority(rollbackPaneAuthorities.get(canonicalPaneId)!);
    }
    throw error;
  }
}

export function restoreStandaloneHudPane(
  leaderPaneId: string | null | undefined,
  cwd: string,
  options: RestoreStandaloneHudPaneOptions = {},
): string | null {
  const normalizedLeaderPaneId = parseCanonicalTmuxPaneId(leaderPaneId);
  if (!normalizedLeaderPaneId) return null;

  const omxEntry = resolveOmxCliEntryPath();
  if (!omxEntry || omxEntry.trim() === '') return null;
  const nativeWindows = isNativeWindows();
  const globalPaneIds = readGlobalTmuxPaneIdSnapshot();
  if (!globalPaneIds) return null;
  const preSplitPanes = listPanes(normalizedLeaderPaneId);
  if (
    !preSplitPanes
    || preSplitPanes.length === 0
    || !preSplitPanes.some((pane) => pane.paneId === normalizedLeaderPaneId)
    || !globalPaneIds.has(normalizedLeaderPaneId)
    || preSplitPanes.some((pane) => !globalPaneIds.has(pane.paneId))
  ) return null;
  const leaderPaneIncarnation = readTeamPaneIncarnation(normalizedLeaderPaneId);
  if (!leaderPaneIncarnation || !isTeamPaneIncarnationLive(leaderPaneIncarnation.paneId, leaderPaneIncarnation.panePid)) return null;

  const ownedHudPaneCandidates = findHudWatchPaneIds(
    preSplitPanes,
    normalizedLeaderPaneId,
    { leaderPaneId: normalizedLeaderPaneId },
  );

  const ownedHudPaneIds: string[] = [];
  for (const candidate of ownedHudPaneCandidates) {
    const ownedHudPaneId = parseCanonicalTmuxPaneId(candidate);
    if (
      !ownedHudPaneId
      || ownedHudPaneId !== candidate
      || ownedHudPaneId === normalizedLeaderPaneId
      || !globalPaneIds.has(ownedHudPaneId)
    ) return null;
    ownedHudPaneIds.push(ownedHudPaneId);
  }
  const [existingHudPaneId] = ownedHudPaneIds;

  const existingHudPaneIncarnation = existingHudPaneId ? readTeamPaneIncarnation(existingHudPaneId) : null;
  if (existingHudPaneId && (!existingHudPaneIncarnation || !isTeamPaneIncarnationLive(existingHudPaneId, existingHudPaneIncarnation.panePid))) return null;


  if (existingHudPaneId && existingHudPaneIncarnation) {
    const hasFreshExistingHudAuthority = (): boolean => (
      isTeamPaneIncarnationLive(leaderPaneIncarnation.paneId, leaderPaneIncarnation.panePid)
      && isTeamPaneIncarnationLive(existingHudPaneIncarnation.paneId, existingHudPaneIncarnation.panePid)
    );
    if (!hasFreshExistingHudAuthority()) return null;
    if (nativeWindows) {
      if (!resizeTeamPaneIncarnation(existingHudPaneIncarnation, HUD_TMUX_TEAM_HEIGHT_LINES)) return null;
    } else {
      if (!hasFreshExistingHudAuthority()) return null;
      runTmux(buildScheduleDelayedHudResizeArgs(existingHudPaneId, {
        leaderPaneId: leaderPaneIncarnation.paneId,
        leaderPanePid: leaderPaneIncarnation.panePid,
        hudPaneId: existingHudPaneIncarnation.paneId,
        hudPanePid: existingHudPaneIncarnation.panePid,
      }));
      if (!hasFreshExistingHudAuthority()) return null;
      runTmux(buildReconcileHudResizeArgs(existingHudPaneId, {
        leaderPaneId: leaderPaneIncarnation.paneId,
        leaderPanePid: leaderPaneIncarnation.panePid,
        hudPaneId: existingHudPaneIncarnation.paneId,
        hudPanePid: existingHudPaneIncarnation.panePid,
      }));
    }
    if (!hasFreshExistingHudAuthority()) return null;
    runTmux(['select-pane', '-t', normalizedLeaderPaneId]);
    return existingHudPaneId;
  }

  const hudCmd = buildHudStartupCommand({
    omxEntry,
    sessionId: options.sessionId,
    leaderPaneId: normalizedLeaderPaneId,
    nodePath: resolveLeaderNodePath(),
  });
  let paneAuthority: VerifiedSplitPane | null = null;
  for (const restoreCwd of resolveStandaloneHudRestoreCwdCandidates(
    normalizedLeaderPaneId,
    cwd,
    options.cwd,
  )) {
    if (!isTeamPaneIncarnationLive(leaderPaneIncarnation.paneId, leaderPaneIncarnation.panePid)) return null;
    const authority = splitAndAdoptPane([
      'split-window',
      '-v',
      '-l',
      String(HUD_TMUX_TEAM_HEIGHT_LINES),
      '-t',
      normalizedLeaderPaneId,
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-c',
      translatePathForMsys(restoreCwd.rawPath),
      hudCmd,
    ], normalizedLeaderPaneId, normalizedLeaderPaneId);
    if (!authority) continue;
    paneAuthority = authority;
    break;
  }
  if (!paneAuthority) return null;
  const rollbackAndFail = (): null => {
    rollbackSplitPaneAuthority(paneAuthority!);
    return null;
  };
  const hasFreshNewHudAuthority = (): boolean => (
    isTeamPaneIncarnationLive(leaderPaneIncarnation.paneId, leaderPaneIncarnation.panePid)
    && revalidateSplitPaneAuthority(paneAuthority!)
  );
  if (!hasFreshNewHudAuthority()) return rollbackAndFail();
  const paneId = paneAuthority.paneId;

  if (nativeWindows) {
    if (!hasFreshNewHudAuthority() || !resizeTeamPaneIncarnation(paneAuthority, HUD_TMUX_TEAM_HEIGHT_LINES)) return rollbackAndFail();
  } else {
    if (!hasFreshNewHudAuthority()) return rollbackAndFail();
    runTmux(buildScheduleDelayedHudResizeArgs(paneId, {
      leaderPaneId: leaderPaneIncarnation.paneId,
      leaderPanePid: leaderPaneIncarnation.panePid,
      hudPaneId: paneAuthority.paneId,
      hudPanePid: paneAuthority.panePid,
    }));
    if (!hasFreshNewHudAuthority()) return rollbackAndFail();
    runTmux(buildReconcileHudResizeArgs(paneId, {
      leaderPaneId: leaderPaneIncarnation.paneId,
      leaderPanePid: leaderPaneIncarnation.panePid,
      hudPaneId: paneAuthority.paneId,
      hudPanePid: paneAuthority.panePid,
    }));
  }
  sleepSeconds(0.5);
  if (!hasFreshNewHudAuthority() || !isPaneStablyLiveInStrictGlobalProbe(paneId, paneAuthority.panePid) || !isPaneStablyLiveInStrictGlobalProbe(leaderPaneIncarnation.paneId, leaderPaneIncarnation.panePid)) {
    return rollbackAndFail();
  }
  if (!hasFreshNewHudAuthority()) return rollbackAndFail();
  runTmux(['select-pane', '-t', normalizedLeaderPaneId]);
  return paneId;
}

/**
 * Enable tmux mouse mode for a session so users can scroll pane content
 * (e.g. long agent output) with the mouse wheel instead of arrow keys.
 *
 * This helper is intentionally limited to session-scoped options so OMX
 * does not overwrite server-global tmux bindings/options owned by users,
 * oh-my-tmux, or other sessions. Returns true if the session mouse option
 * was set successfully, false otherwise.
 */
export function enableMouseScrolling(sessionTarget: string): boolean {
  const result = runTmux(['set-option', '-t', sessionTarget, 'mouse', 'on']);
  if (!result.ok) return false;

  // Enable OSC 52 so copy-selection-and-cancel propagates selected text to
  // the terminal's clipboard without requiring xclip or pbcopy. (closes #206)
  runTmux(['set-option', '-t', sessionTarget, 'set-clipboard', 'on']);

  // Mouse selection enters tmux copy-mode. Keep the mitigation session-scoped
  // so OMX does not mutate users' global tmux style defaults. (issue #1448)
  mitigateCopyModeUnderlineArtifacts(sessionTarget);

  return true;
}

function paneTarget(sessionName: string, workerIndex: number, workerPaneId?: string): string {
  if (workerPaneId !== undefined) {
    const paneId = parseCanonicalTmuxPaneId(workerPaneId);
    if (!paneId) throw new Error(`invalid_tmux_pane_id:${workerPaneId}`);
    return paneId;
  }
  if (sessionName.includes(':')) {
    return `${sessionName}.${workerIndex}`;
  }
  return `${sessionName}:${workerIndex}`;
}

export const paneIsBootstrapping = sharedPaneIsBootstrapping;
export const paneLooksReady = sharedPaneLooksReady;

function paneHasTrustPrompt(captured: string): boolean {
  const lines = captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-12);
  const hasQuestion = tail.some((line) => /Do you trust the contents of this directory\?/i.test(line));
  const hasActiveChoices = tail.some((line) => /Yes,\s*continue|No,\s*quit|Press enter to continue/i.test(line));
  return hasQuestion && hasActiveChoices;
}

function paneHasClaudeBypassPermissionsPrompt(captured: string): boolean {
  const lines = captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-20);
  const hasWarning = tail.some((line) => /Bypass Permissions mode/i.test(line));
  const hasChoices = tail.some((line) => /No,\s*exit/i.test(line))
    && tail.some((line) => /Yes,\s*I\s*accept/i.test(line))
    && tail.some((line) => /Enter\s*to\s*confirm/i.test(line));
  return hasWarning && hasChoices;
}


export type StartupDirectTriggerSafety =
  | { safe: true; reason: 'ready_prompt' | 'codex_viewport' }
  | { safe: false; reason: 'tmux_unavailable' | 'capture_failed' | 'trust_prompt' | 'claude_bypass_prompt' | 'bootstrapping' | 'not_agent_viewport' };

export function evaluateStartupDirectTriggerSafetyCapture(captured: string, workerCli?: TeamWorkerCli): StartupDirectTriggerSafety {
  if (paneHasTrustPrompt(captured)) return { safe: false, reason: 'trust_prompt' };
  if (paneHasClaudeBypassPermissionsPrompt(captured)) return { safe: false, reason: 'claude_bypass_prompt' };
  if (paneLooksReady(captured)) return { safe: true, reason: 'ready_prompt' };
  if (paneIsBootstrapping(captured)) return { safe: false, reason: 'bootstrapping' };
  if (workerCli === 'codex' && sharedPaneShowsCodexViewport(captured)) return { safe: true, reason: 'codex_viewport' };
  return { safe: false, reason: 'not_agent_viewport' };
}

export async function evaluateStartupDirectTriggerSafety(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
  workerCli?: TeamWorkerCli,
): Promise<StartupDirectTriggerSafety> {
  if (!isTmuxAvailable()) return { safe: false, reason: 'tmux_unavailable' };
  const target = paneTarget(sessionName, workerIndex, workerPaneId);
  const result = await runTmuxAsync(sharedBuildVisibleCapturePaneArgv(target));
  if (!result.ok) return { safe: false, reason: 'capture_failed' };
  return evaluateStartupDirectTriggerSafetyCapture(result.stdout, workerCli);
}

function acceptClaudeBypassPermissionsPrompt(target: string, assertAuthority?: () => void): void {
  assertAuthority?.();
  runTmux(['send-keys', '-t', target, '-l', '--', '2']);
  sleepFractionalSeconds(0.12);
  assertAuthority?.();
  runTmux(['send-keys', '-t', target, 'C-m']);
}

function dismissClaudeBypassPermissionsPromptIfPresent(
  target: string,
  captured: string,
  assertAuthority?: () => void,
): boolean {
  if (process.env.OMX_TEAM_AUTO_ACCEPT_BYPASS === '0') return false;
  if (!paneHasClaudeBypassPermissionsPrompt(captured)) return false;
  acceptClaudeBypassPermissionsPrompt(target, assertAuthority);
  return true;
}

export const paneHasActiveTask = sharedPaneHasActiveTask;

export type WorkerStartupInjectSafety =
  | 'safe'
  | 'trust_prompt'
  | 'claude_bypass_prompt'
  | 'bootstrapping'
  | 'active_task'
  | 'not_ready';

export function classifyWorkerStartupInjectSafety(captured: string): WorkerStartupInjectSafety {
  if (paneHasTrustPrompt(captured)) return 'trust_prompt';
  if (paneHasClaudeBypassPermissionsPrompt(captured)) return 'claude_bypass_prompt';
  if (paneIsBootstrapping(captured)) return 'bootstrapping';
  if (paneHasActiveTask(captured)) return 'active_task';
  if (!paneLooksReady(captured)) return 'not_ready';
  return 'safe';
}

export async function checkWorkerStartupInjectSafety(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
): Promise<{ safe: true; reason: 'safe' } | { safe: false; reason: Exclude<WorkerStartupInjectSafety, 'safe'> }> {
  const target = paneTarget(sessionName, workerIndex, workerPaneId);
  const visibleCapture = await captureVisiblePaneAsync(target);
  const visibleSafety = classifyWorkerStartupInjectSafety(visibleCapture);
  if (visibleSafety === 'safe') return { safe: true, reason: 'safe' };
  if (visibleSafety !== 'not_ready') return { safe: false, reason: visibleSafety };

  if (!sharedPaneShowsCodexViewport(visibleCapture)) {
    return { safe: false, reason: visibleSafety };
  }

  const scrollbackCapture = await capturePaneAsync(target);
  const scrollbackSafety = classifyWorkerStartupInjectSafety(scrollbackCapture);
  return scrollbackSafety === 'safe'
    ? { safe: true, reason: 'safe' }
    : { safe: false, reason: scrollbackSafety };
}

function resolveSendStrategyFromEnv(): 'auto' | 'queue' | 'interrupt' {
  const raw = String(process.env.OMX_TEAM_SEND_STRATEGY || '')
    .trim()
    .toLowerCase();
  if (raw === 'interrupt' || raw === 'queue' || raw === 'auto') {
    return raw;
  }
  return 'auto';
}

function resolveWorkerCliFromMapForSend(
  workerIndex: number,
  launchArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerCli | null {
  const rawMap = String(env[OMX_TEAM_WORKER_CLI_MAP_ENV] ?? '').trim();
  if (rawMap === '') return null;
  const entries = rawMap.split(',').map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) return null;
  const selectedRaw = entries.length === 1 ? entries[0] : entries[workerIndex - 1];
  if (!selectedRaw) return null;
  try {
    const mode = normalizeTeamWorkerCliMode(selectedRaw, OMX_TEAM_WORKER_CLI_MAP_ENV);
    return mode === 'auto' ? resolveTeamWorkerCliFromLaunchArgs(launchArgs) : mode;
  } catch {
    return null;
  }
}

/**
 * Worker CLI resolution contract for submit routing:
 * 1) explicit workerCli param from caller
 * 2) per-worker OMX_TEAM_WORKER_CLI_MAP entry (worker index aware)
 * 3) global/default OMX_TEAM_WORKER_CLI behavior
 */
export function resolveWorkerCliForSend(
  workerIndex: number,
  workerCli?: TeamWorkerCli,
  launchArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerCli {
  if (workerCli) return workerCli;
  const mapped = resolveWorkerCliFromMapForSend(workerIndex, launchArgs, env);
  if (mapped) return mapped;
  return resolveTeamWorkerCli(launchArgs, env);
}

export function buildWorkerSubmitPlan(
  strategy: 'auto' | 'queue' | 'interrupt',
  workerCli: TeamWorkerCli,
  paneBusyAtStart: boolean,
  allowAdaptiveRetry: boolean,
): WorkerSubmitPlan {
  const queueRequested = strategy === 'queue' || (strategy === 'auto' && paneBusyAtStart);
  return {
    shouldInterrupt: strategy === 'interrupt',
    queueFirstRound: workerCli === 'codex' && queueRequested,
    rounds: 6,
    submitKeyPressesPerRound: workerCli === 'claude' ? 1 : 2,
    allowAdaptiveRetry: workerCli === 'codex' && allowAdaptiveRetry,
  };
}

export function shouldAttemptAdaptiveRetry(
  strategy: 'auto' | 'queue' | 'interrupt',
  paneBusyAtStart: boolean,
  allowAdaptiveRetry: boolean,
  latestCapture: string | null,
  text: string,
): boolean {
  if (!allowAdaptiveRetry) return false;
  if (strategy !== 'auto') return false;
  if (!paneBusyAtStart) return false;
  if (typeof latestCapture !== 'string') return false;

  const normalizedText = normalizeWorkerTriggerForDraftMatch(text);
  if (normalizedText === '') return false;

  const normalizedCapture = normalizeWorkerTriggerForDraftMatch(latestCapture);
  if (!normalizedCapture.includes(normalizedText)) return false;
  if (paneHasActiveTask(latestCapture)) return false;
  if (!paneLooksReady(latestCapture)) return false;
  return true;
}

interface SendPaneAuthority {
  paneId: string;
  panePid: string;
  revalidateAuthority?: SendPaneAuthorityRevalidator;
}

type SendPaneAuthorityRevalidator = () => boolean;

function assertSendPaneAuthority(
  workerPaneId: string | undefined,
  expectedPanePid: string | number | undefined,
  revalidateAuthority: SendPaneAuthorityRevalidator | undefined,
  stage: string,
): void {
  if (
    (workerPaneId !== undefined && expectedPanePid !== undefined
      && !isTeamPaneIncarnationLive(workerPaneId, expectedPanePid))
    || (revalidateAuthority !== undefined && !revalidateAuthority())
  ) {
    throw new Error(`sendToWorker: pane authority changed before ${stage}`);
  }
}

function buildSendPaneIncarnationCondition(authority: SendPaneAuthority): string {
  return `#{&&:#{==:#{pane_id},${authority.paneId}},#{&&:#{==:#{pane_dead},0},#{==:#{pane_pid},${authority.panePid}}}}`;
}

function quoteTmuxCommandArgument(value: string): string {
  return JSON.stringify(value);
}

function buildAtomicSendKeysCommand(authority: SendPaneAuthority, key: string, literal: boolean): string {
  return literal
    ? `send-keys -t ${authority.paneId} -l -- ${quoteTmuxCommandArgument(key)}`
    : `send-keys -t ${authority.paneId} ${quoteTmuxCommandArgument(key)}`;
}

async function runAtomicPaneCommandAsync(authority: SendPaneAuthority, command: string, stage: string): Promise<string> {
  if (authority.revalidateAuthority !== undefined && !authority.revalidateAuthority()) {
    throw new Error(`sendToWorker: pane authority changed before ${stage}`);
  }
  const rejectedMarker = '__omx_send_authority_rejected__';
  const result = await runTmuxAsync([
    'if-shell', '-F', '-t', authority.paneId, buildSendPaneIncarnationCondition(authority), command,
    `display-message -p ${quoteTmuxCommandArgument(rejectedMarker)}`,
  ]);
  if (!result.ok) throw new Error(`sendToWorker: failed ${stage}: ${result.stderr}`);
  if (result.stdout === `${rejectedMarker}\n`) throw new Error(`sendToWorker: pane authority changed before ${stage}`);
  return result.stdout;
}

async function requireAtomicCapturePaneEvidenceAsync(
  authority: SendPaneAuthority,
  scrollbackLines: number | null,
  stage: string,
): Promise<string> {
  const command = scrollbackLines === null
    ? `capture-pane -t ${authority.paneId} -p`
    : `capture-pane -t ${authority.paneId} -p -S -${scrollbackLines}`;
  const stdout = await runAtomicPaneCommandAsync(authority, command, stage);
  if (!stdout.endsWith('\n') || stdout.endsWith('\r\n')) {
    throw new Error(`sendToWorker: ${stage}_capture_unavailable_or_unframed`);
  }
  const captured = stdout.slice(0, -1);
  if (captured.length === 0) throw new Error(`sendToWorker: ${stage}_capture_unavailable_or_unframed`);
  return captured;
}

function resolveSendPaneAuthority(
  workerPaneId: string | undefined,
  expectedPanePid: string | number | undefined,
  revalidateAuthority: SendPaneAuthorityRevalidator | undefined,
): SendPaneAuthority {
  const paneId = parseCanonicalTmuxPaneId(workerPaneId);
  const panePid = String(expectedPanePid ?? '').trim();
  if (!paneId || !/^[1-9][0-9]*$/.test(panePid)) {
    throw new Error('sendToWorker: immutable pane_id and pane_pid authority are required');
  }
  return { paneId, panePid, revalidateAuthority };
}

async function sendAtomicWorkerKeyAsync(authority: SendPaneAuthority, key: string, stage: string): Promise<void> {
  await runAtomicPaneCommandAsync(authority, buildAtomicSendKeysCommand(authority, key, false), stage);
}

async function sendAtomicLiteralTextAsync(authority: SendPaneAuthority, text: string, stage: string): Promise<void> {
  await runAtomicPaneCommandAsync(authority, buildAtomicSendKeysCommand(authority, text, true), stage);
}

function paneHasQueuedCodexSubmission(captured: string | null | undefined): boolean {
  const normalized = normalizeTmuxCapture(captured ?? '');
  if (normalized === '') return false;
  return /messages to be submitted after next tool call/i.test(normalized)
    || /press esc to interrupt and send immediately/i.test(normalized);
}

async function attemptSubmitRounds(
  authority: SendPaneAuthority,
  text: string,
  rounds: number,
  queueFirstRound: boolean,
  submitKeyPressesPerRound: number,
): Promise<boolean> {
  const presses = Math.max(1, Math.floor(submitKeyPressesPerRound));
  for (let round = 0; round < rounds; round++) {
    await sleep(100);
    if (round === 0 && queueFirstRound) {
      await sendAtomicWorkerKeyAsync(authority, 'Tab', 'queue key');
      await sleep(80);
      await sendAtomicWorkerKeyAsync(authority, 'C-m', 'submit key');
    } else {
      for (let press = 0; press < presses; press++) {
        await sendAtomicWorkerKeyAsync(authority, 'C-m', 'submit key');
        if (press < presses - 1) await sleep(200);
      }
    }
    await sleep(140);
    const [captured, visibleCapture] = await Promise.all([
      requireAtomicCapturePaneEvidenceAsync(authority, 80, 'post_submit_scrollback'),
      requireAtomicCapturePaneEvidenceAsync(authority, null, 'post_submit_visible'),
    ]);
    const normalizedCapture = normalizeWorkerTriggerForDraftMatch(captured);
    if (!normalizedCapture.includes(normalizeWorkerTriggerForDraftMatch(text)) && !paneHasQueuedCodexSubmission(visibleCapture)) return true;
    await sleep(140);
  }
  return false;
}

export function waitForWorkerReady(
  sessionName: string,
  workerIndex: number,
  timeoutMs: number = 30_000,
  workerPaneId?: string,
  expectedPanePid?: string | number,
  revalidateAuthority?: SendPaneAuthorityRevalidator,
): boolean {
  const initialBackoffMs = 150;
  const maxBackoffMs = 8000;
  const startedAt = Date.now();
  let blockedByTrustPrompt = false;
  let promptDismissed = false;

  const assertAuthority = (): boolean => {
    try {
      assertSendPaneAuthority(workerPaneId, expectedPanePid, revalidateAuthority, 'worker readiness trust key');
      return true;
    } catch {
      return false;
    }
  };
  const sendRobustEnter = (): boolean => {
    const target = paneTarget(sessionName, workerIndex, workerPaneId);
    if (!assertAuthority()) return false;
    runTmux(['send-keys', '-t', target, 'C-m']);
    sleepFractionalSeconds(0.12);
    if (!assertAuthority()) return false;
    runTmux(['send-keys', '-t', target, 'C-m']);
    return true;
  };

  const check = (): boolean => {
    const target = paneTarget(sessionName, workerIndex, workerPaneId);
    const result = runTmux(sharedBuildVisibleCapturePaneArgv(target));
    if (!result.ok) return false;
    if (dismissClaudeBypassPermissionsPromptIfPresent(target, result.stdout, () => {
      if (!assertAuthority()) throw new Error('waitForWorkerReady: pane authority changed before trust key');
    })) {
      promptDismissed = true;
      return false;
    }
    if (paneHasClaudeBypassPermissionsPrompt(result.stdout)) {
      return false;
    }
    if (paneHasTrustPrompt(result.stdout)) {
      // Default-on for team workers: they are spawned explicitly by the leader in the same cwd.
      // Opt-out by setting OMX_TEAM_AUTO_TRUST=0.
      if (process.env.OMX_TEAM_AUTO_TRUST !== '0') {
        if (!sendRobustEnter()) return false;
        promptDismissed = true;
        return false;
      }
      blockedByTrustPrompt = true;
      return false;
    }
    if (paneLooksReady(result.stdout)) return true;
    // Keep startup safety checks anchored to the visible pane. Only if the
    // visible slice already proves a live Codex viewport do we consult recent
    // scrollback for the prompt/helper text that may have slipped below the fold.
    if (!sharedPaneShowsCodexViewport(result.stdout)) return false;

    const scrollbackResult = runTmux(sharedBuildCapturePaneArgv(target, 80));
    if (!scrollbackResult.ok) return false;
    return paneLooksReady(scrollbackResult.stdout);
  };

  let delayMs = initialBackoffMs;
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return true;
    if (blockedByTrustPrompt) return false;
    // After dismissing a trust prompt, reset backoff so we re-check quickly
    // instead of sleeping 2s/4s/8s while the worker is starting up.
    if (promptDismissed) {
      delayMs = initialBackoffMs;
      promptDismissed = false;
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    sleepSeconds(Math.max(0, Math.min(delayMs, remaining)) / 1000);
    delayMs = Math.min(maxBackoffMs, delayMs * 2);
  }

  return false;
}

// Async twin of waitForWorkerReady for team startup fan-out. Keep the readiness
// semantics mirrored with the synchronous helper above, but yield between polls
// so one slow worker pane cannot block later workers' startup attempts.
export async function waitForWorkerReadyAsync(
  sessionName: string,
  workerIndex: number,
  timeoutMs: number = 30_000,
  workerPaneId?: string,
  expectedPanePid?: string | number,
): Promise<boolean> {
  const initialBackoffMs = 150;
  const maxBackoffMs = 8000;
  const startedAt = Date.now();
  let blockedByTrustPrompt = false;
  let promptDismissed = false;

  const sendRobustEnter = async (): Promise<void> => {
    const target = paneTarget(sessionName, workerIndex, workerPaneId);
    // Trust + follow-up splash can require two submits in Codex TUI.
    // Use C-m (carriage return) for raw-mode compatibility.
    await runTmuxAsync(['send-keys', '-t', target, 'C-m']);
    await sleep(120);
    await runTmuxAsync(['send-keys', '-t', target, 'C-m']);
  };

  const check = async (): Promise<boolean> => {
    if (workerPaneId && expectedPanePid !== undefined && !isTeamPaneIncarnationLive(workerPaneId, expectedPanePid)) return false;
    const target = paneTarget(sessionName, workerIndex, workerPaneId);
    const result = await runTmuxAsync(sharedBuildVisibleCapturePaneArgv(target));
    if (!result.ok) return false;
    if (dismissClaudeBypassPermissionsPromptIfPresent(target, result.stdout)) {
      promptDismissed = true;
      return false;
    }
    if (paneHasClaudeBypassPermissionsPrompt(result.stdout)) {
      return false;
    }
    if (paneHasTrustPrompt(result.stdout)) {
      // Default-on for team workers: they are spawned explicitly by the leader in the same cwd.
      // Opt-out by setting OMX_TEAM_AUTO_TRUST=0.
      if (process.env.OMX_TEAM_AUTO_TRUST !== '0') {
        await sendRobustEnter();
        promptDismissed = true;
        return false;
      }
      blockedByTrustPrompt = true;
      return false;
    }
    if (paneLooksReady(result.stdout)) return true;
    // Keep startup safety checks anchored to the visible pane. Only if the
    // visible slice already proves a live Codex viewport do we consult recent
    // scrollback for the prompt/helper text that may have slipped below the fold.
    if (!sharedPaneShowsCodexViewport(result.stdout)) return false;

    const scrollbackResult = await runTmuxAsync(sharedBuildCapturePaneArgv(target, 80));
    if (!scrollbackResult.ok) return false;
    return paneLooksReady(scrollbackResult.stdout);
  };

  let delayMs = initialBackoffMs;
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return true;
    if (blockedByTrustPrompt) return false;
    // After dismissing a trust prompt, reset backoff so we re-check quickly
    // instead of sleeping 2s/4s/8s while the worker is starting up.
    if (promptDismissed) {
      delayMs = initialBackoffMs;
      promptDismissed = false;
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.max(0, Math.min(delayMs, remaining)));
    delayMs = Math.min(maxBackoffMs, delayMs * 2);
  }

  return false;
}

/**
 * Detect and auto-dismiss a Codex "Trust this directory?" prompt in a worker pane.
 * Returns true if a trust prompt was found and dismissed, false otherwise.
 * Opt-out: set OMX_TEAM_AUTO_TRUST=0 to disable auto-dismissal.
 */
export function dismissTrustPromptIfPresent(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
  expectedPanePid?: string | number,
  revalidateAuthority?: SendPaneAuthorityRevalidator,
): boolean {
  if (process.env.OMX_TEAM_AUTO_TRUST === '0') return false;
  if (!isTmuxAvailable()) return false;
  const target = paneTarget(sessionName, workerIndex, workerPaneId);
  const result = runTmux(sharedBuildVisibleCapturePaneArgv(target));
  if (!result.ok || !paneHasTrustPrompt(result.stdout)) return false;
  try {
    assertSendPaneAuthority(workerPaneId, expectedPanePid, revalidateAuthority, 'trust key');
    runTmux(['send-keys', '-t', target, 'C-m']);
    sleepFractionalSeconds(0.12);
    assertSendPaneAuthority(workerPaneId, expectedPanePid, revalidateAuthority, 'trust key');
    runTmux(['send-keys', '-t', target, 'C-m']);
    return true;
  } catch {
    return false;
  }
}

export const normalizeTmuxCapture = sharedNormalizeTmuxCapture;

function normalizeWorkerTriggerForDraftMatch(value: string | null | undefined): string {
  // Codex/tmux can wrap long path-like trigger text after a hyphen, e.g.
  // `worker-\n  1/inbox.md`. Treat those visual wraps as the original token so
  // delivery verification does not mistake an unsent draft for consumed input.
  return normalizeTmuxCapture(value ?? '').replace(/-\s+/g, '-');
}

function assertWorkerTriggerText(text: string): void {
  if (text.length >= 200) {
    throw new Error('sendToWorker: text must be < 200 characters');
  }
  if (text.trim().length === 0) {
    throw new Error('sendToWorker: text must be non-empty');
  }
  if (text.includes(INJECTION_MARKER)) {
    throw new Error('sendToWorker: injection marker is not allowed');
  }
}

export function sendToWorkerStdin(
  stdin: Pick<NodeJS.WritableStream, 'write' | 'writable'> | null | undefined,
  text: string,
): void {
  assertWorkerTriggerText(text);
  if (!stdin || !stdin.writable) {
    throw new Error('sendToWorkerStdin: stdin is not writable');
  }
  stdin.write(`${text}\n`);
}

// Send SHORT text (<200 chars) to worker via tmux send-keys
// Validates: text < 200 chars, no injection marker
// Throws on violation
export async function sendToWorker(
  _sessionName: string,
  workerIndex: number,
  text: string,
  workerPaneId?: string,
  workerCli?: TeamWorkerCli,
  expectedPanePid?: string | number,
  revalidateAuthority?: SendPaneAuthorityRevalidator,
): Promise<void> {
  assertWorkerTriggerText(text);
  const authority = resolveSendPaneAuthority(workerPaneId, expectedPanePid, revalidateAuthority);
  const strategy = resolveSendStrategyFromEnv();
  const resolvedWorkerCli = resolveWorkerCliForSend(workerIndex, workerCli);
  const capturedStr = await requireAtomicCapturePaneEvidenceAsync(authority, 80, 'pre_dispatch_scrollback');
  const paneBusy = paneHasActiveTask(capturedStr);
  if (paneHasClaudeBypassPermissionsPrompt(capturedStr) || paneHasTrustPrompt(capturedStr)) {
    await sendAtomicWorkerKeyAsync(authority, 'C-m', 'trust key');
    await sleep(120);
    await sendAtomicWorkerKeyAsync(authority, 'C-m', 'trust key');
    await sleep(200);
  }

  await sendAtomicLiteralTextAsync(authority, text, 'literal typing');
  await sleep(150);

  const allowAutoInterruptRetry = process.env[OMX_TEAM_AUTO_INTERRUPT_RETRY_ENV] !== '0';
  const submitPlan = buildWorkerSubmitPlan(strategy, resolvedWorkerCli, paneBusy, allowAutoInterruptRetry);
  if (submitPlan.shouldInterrupt) {
    await sendAtomicWorkerKeyAsync(authority, 'C-c', 'interrupt key');
    await sleep(100);
  }
  if (await attemptSubmitRounds(authority, text, submitPlan.rounds, submitPlan.queueFirstRound, submitPlan.submitKeyPressesPerRound)) return;

  const latestCapture = await requireAtomicCapturePaneEvidenceAsync(authority, 80, 'adaptive_retry_scrollback');
  if (shouldAttemptAdaptiveRetry(strategy, paneBusy, submitPlan.allowAdaptiveRetry, latestCapture, text)) {
    await sendAtomicWorkerKeyAsync(authority, 'C-u', 'retry clear key');
    await sleep(80);
    await sendAtomicLiteralTextAsync(authority, text, 'retry literal typing');
    await sleep(120);
    if (await attemptSubmitRounds(authority, text, 4, false, submitPlan.submitKeyPressesPerRound)) return;
  }

  if (process.env.OMX_TEAM_STRICT_SUBMIT === '1') throw new Error('sendToWorker: submit_failed (trigger text still visible after retries)');

  await sendAtomicWorkerKeyAsync(authority, 'C-m', 'nudge key');
  await sleep(120);
  await sendAtomicWorkerKeyAsync(authority, 'C-m', 'nudge key');
  await sleep(300);
  const [verifyCapture, verifyVisibleCapture] = await Promise.all([
    requireAtomicCapturePaneEvidenceAsync(authority, 80, 'post_nudge_scrollback'),
    requireAtomicCapturePaneEvidenceAsync(authority, null, 'post_nudge_visible'),
  ]);
  if (paneHasActiveTask(verifyCapture)) return;
  if (!normalizeWorkerTriggerForDraftMatch(verifyCapture).includes(normalizeWorkerTriggerForDraftMatch(text)) && !paneHasQueuedCodexSubmission(verifyVisibleCapture)) return;

  await sendAtomicWorkerKeyAsync(authority, 'C-m', 'retry nudge key');
  await sleep(150);
  await sendAtomicWorkerKeyAsync(authority, 'C-m', 'retry nudge key');
  const finalVisibleCapture = await requireAtomicCapturePaneEvidenceAsync(authority, null, 'final_visible');
  if (paneHasQueuedCodexSubmission(finalVisibleCapture)) throw new Error('sendToWorker: submit_queued_after_tool_call');
  const finalCapture = await requireAtomicCapturePaneEvidenceAsync(authority, 80, 'final_scrollback');
  if (
    normalizeWorkerTriggerForDraftMatch(finalCapture).includes(normalizeWorkerTriggerForDraftMatch(text))
    && !paneHasActiveTask(finalCapture)
    && paneLooksReady(finalCapture)
  ) throw new Error('sendToWorker: submit_failed (trigger text still visible after retries)');
}

export function notifyLeaderStatus(sessionName: string, message: string): boolean {
  if (!isTmuxAvailable()) return false;
  const trimmed = message.trim();
  if (!trimmed) return false;
  const capped = trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
  const result = runTmux(['display-message', '-t', sessionName, '--', capped]);
  return result.ok;
}

// Get PID of the shell process in a worker's tmux pane
export function getWorkerPanePid(sessionName: string, workerIndex: number, workerPaneId?: string): number | null {
  const result = runTmux(['list-panes', '-t', paneTarget(sessionName, workerIndex, workerPaneId), '-F', '#{pane_pid}']);
  if (!result.ok) return null;

  const firstLine = result.stdout.split('\n')[0]?.trim();
  if (!firstLine) return null;

  const pid = Number.parseInt(firstLine, 10);
  if (!Number.isFinite(pid)) return null;
  return pid;
}

// Check if worker's tmux pane has a running process
export function isWorkerAlive(sessionName: string, workerIndex: number, workerPaneId?: string): boolean {
  const canonicalWorkerPaneId = parseCanonicalTmuxPaneId(workerPaneId);
  if (workerPaneId && !canonicalWorkerPaneId) return false;
  if (canonicalWorkerPaneId) {
    const paneStatus = readPaneLivenessById(canonicalWorkerPaneId);
    if (paneStatus !== null) return paneStatus;
  }
  const result = runTmux([
    'list-panes',
    '-t', paneTarget(sessionName, workerIndex, workerPaneId),
    '-F',
    '#{pane_dead} #{pane_pid}',
  ]);
  if (!result.ok) return false;

  const line = result.stdout.split('\n')[0]?.trim();
  if (!line) return false;

  const parts = line.split(/\s+/);
  if (parts.length < 2) return false;

  const paneDead = parts[0];
  const pid = Number.parseInt(parts[1], 10);

  if (paneDead === '1') return false;
  if (!Number.isFinite(pid)) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isWorkerPaneOpen(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
  expectedPanePid?: string | number,
): boolean {
  const canonicalWorkerPaneId = parseCanonicalTmuxPaneId(workerPaneId);
  if (workerPaneId && !canonicalWorkerPaneId) return false;
  if (canonicalWorkerPaneId) {
    if (expectedPanePid !== undefined && !isTeamPaneIncarnationLive(canonicalWorkerPaneId, expectedPanePid)) return false;
    const paneStatus = readPaneLivenessById(canonicalWorkerPaneId);
    if (paneStatus !== null) return paneStatus;
  }
  const result = runTmux([
    'list-panes',
    '-t', paneTarget(sessionName, workerIndex, workerPaneId),
    '-F',
    '#{pane_dead}',
  ]);
  if (!result.ok) return false;
  const line = result.stdout.split('\n')[0]?.trim();
  if (!line) return false;
  return line !== '1';
}

// Kill a specific worker: send C-c, then C-d, then kill-pane if still alive.
// leaderPaneId: when provided, the kill is skipped entirely if workerPaneId matches it.
export async function killWorker(sessionName: string, workerIndex: number, workerPaneId?: string, leaderPaneId?: string): Promise<void> {
  const canonicalWorkerPaneId = workerPaneId ? parseCanonicalTmuxPaneId(workerPaneId) : null;
  if (workerPaneId && !canonicalWorkerPaneId) return;
  const canonicalLeaderPaneId = leaderPaneId ? parseCanonicalTmuxPaneId(leaderPaneId) : null;
  if (leaderPaneId && !canonicalLeaderPaneId) return;
  const target = canonicalWorkerPaneId ?? paneTarget(sessionName, workerIndex);
  if (canonicalLeaderPaneId && target === canonicalLeaderPaneId) return;

  await runTmuxAsync(['send-keys', '-t', target, 'C-c']);
  await sleep(1000);

  if (await isWorkerAliveAsync(sessionName, workerIndex, canonicalWorkerPaneId ?? undefined)) {
    await runTmuxAsync(['send-keys', '-t', target, 'C-d']);
    await sleep(1000);
  }

  // This legacy API cannot carry exact pane authority, so it must never escalate
  // its advisory interrupt sequence into a destructive pane kill.
}

/** Legacy direct kill wrapper deliberately fails closed without structured authority. */
export function killWorkerByPaneId(_workerPaneId: string, _leaderPaneId?: string): void {
}


export function paneHasOmxInstanceTag(paneId: string | null | undefined, instanceId: string | null | undefined): boolean {
  const normalizedPaneId = normalizePaneTarget(paneId);
  const expectedInstanceId = typeof instanceId === 'string' ? instanceId : '';
  if (!normalizedPaneId || expectedInstanceId === '' || expectedInstanceId.trim() !== expectedInstanceId) return false;
  const result = runTmux(['show-option', '-qv', '-p', '-t', normalizedPaneId, OMX_PANE_INSTANCE_OPTION]);
  return result.ok && parseExactTmuxAuthorityScalar(result.stdout) === expectedInstanceId;
}


export function paneHasOmxTeamOwnerTag(paneId: string | null | undefined, teamOwnerId: string | null | undefined): boolean {
  const expectedTeamOwnerId = typeof teamOwnerId === 'string' ? teamOwnerId : '';
  if (expectedTeamOwnerId === '' || expectedTeamOwnerId.trim() !== expectedTeamOwnerId) return false;
  const result = readPaneTeamOwnerTagResult(paneId);
  return result.status === 'value' && result.value === expectedTeamOwnerId;
}


export function readPaneTeamOwnerTag(paneId: string | null | undefined): string | null {
  const result = readPaneTeamOwnerTagResult(paneId);
  return result.status === 'value' ? result.value : null;
}

export type PaneTeamOwnerTagReadResult =
  | { status: 'value'; value: string }
  | { status: 'missing' }
  | { status: 'error'; error: string };

export function readPaneTeamOwnerTagResult(paneId: string | null | undefined): PaneTeamOwnerTagReadResult {
  const normalizedPaneId = normalizePaneTarget(paneId);
  if (!normalizedPaneId) return { status: 'error', error: 'invalid pane target' };
  const { result } = spawnPlatformCommandSync('tmux', [
    'show-option',
    '-qv',
    '-p',
    '-t',
    normalizedPaneId,
    OMX_TEAM_PANE_OWNER_OPTION,
  ], { encoding: 'utf-8' });
  if (result.error) {
    return { status: 'error', error: result.error.message };
  }
  const stdout = typeof result.stdout === 'string' ? parseExactTmuxAuthorityScalar(result.stdout) : null;
  if (result.status === 0) {
    if (stdout === null) return { status: 'error', error: 'invalid owner tag framing' };
    return stdout === '' ? { status: 'missing' } : { status: 'value', value: stdout };
  }
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  // tmux reports an unset user option as status 1 with no diagnostic on
  // supported versions. Treat other failures, including signal/null exits,
  // as real read errors so shared-pane shutdown fails closed instead of
  // killing a pane whose owner could not be read.
  if (result.status === 1 && stderr === '') return { status: 'missing' };
  return { status: 'error', error: stderr || `tmux show-option exited ${result.status ?? 'unknown'}` };
}

/** Legacy direct kill wrapper deliberately fails closed without structured authority. */
export async function killWorkerByPaneIdAsync(_workerPaneId: string, _leaderPaneId?: string): Promise<void> {
}


export interface PaneTeardownSummary {
  attemptedPaneIds: string[];
  excluded: {
    leader: number;
    hud: number;
    invalid: number;
  };
  kill: {
    attempted: number;
    succeeded: number;
    failed: number;
  };
}

export interface PaneTeardownAuthority {
  sessionName: string;
  expectedOwnerId: string;
  /** Bound pane PIDs captured at creation; omitting one denies its teardown. */
  expectedPanePids?: ReadonlyMap<string, string | number>;
  revalidate?: (paneId: string) => Promise<boolean> | boolean;
  verifyOwnership?: (paneId: string) => boolean;
}

export interface PaneTeardownOptions {
  leaderPaneId?: string | null;
  hudPaneId?: string | null;
  graceMs?: number;
  authority?: PaneTeardownAuthority;
}

export interface SharedSessionShutdownTopology {
  livePaneIds: string[];
  teamWorkerPaneIds: string[];
  leaderPaneId: string | null;
  hudPaneIds: string[];
  leaderOwnedHudPaneIds: string[];
}

function normalizePaneTarget(value: string | null | undefined): string | null {
  return parseCanonicalTmuxPaneId(value);
}

function normalizeTeardownGuard(value: string | null | undefined): { paneId: string | null; invalid: boolean } {
  if (value === null || value === undefined || value.trim() === '') {
    return { paneId: null, invalid: false };
  }
  const paneId = parseCanonicalTmuxPaneId(value);
  return { paneId, invalid: !paneId || paneId !== value };
}

function normalizePaneTargets(
  paneIds: string[],
  options: PaneTeardownOptions = {},
): { killablePaneIds: string[]; excluded: PaneTeardownSummary['excluded'] } {
  const leaderGuard = normalizeTeardownGuard(options.leaderPaneId);
  const hudGuard = normalizeTeardownGuard(options.hudPaneId);
  const excluded = { leader: 0, hud: 0, invalid: 0 };
  const normalizedPaneIds: string[] = [];
  const seenPaneIds = new Set<string>();

  for (const paneId of paneIds) {
    const normalized = typeof paneId === 'string' ? parseCanonicalTmuxPaneId(paneId) : null;
    if (!normalized || normalized !== paneId || seenPaneIds.has(normalized)) {
      excluded.invalid += 1;
      continue;
    }
    seenPaneIds.add(normalized);
    normalizedPaneIds.push(normalized);
  }
  if (leaderGuard.invalid) excluded.invalid += 1;
  if (hudGuard.invalid) excluded.invalid += 1;
  if (excluded.invalid > 0) return { killablePaneIds: [], excluded };

  const killablePaneIds: string[] = [];
  for (const paneId of normalizedPaneIds) {
    if (leaderGuard.paneId && paneId === leaderGuard.paneId) {
      excluded.leader += 1;
      continue;
    }
    if (hudGuard.paneId && paneId === hudGuard.paneId) {
      excluded.hud += 1;
      continue;
    }
    killablePaneIds.push(paneId);
  }
  return { killablePaneIds, excluded };
}

export function resolveSharedSessionShutdownTopology(
  sessionName: string,
  preferredLeaderPaneId?: string | null,
  teamName?: string | null,
): SharedSessionShutdownTopology {
  const panes = listPanes(sessionName);
  const fallbackLeaderPaneId = normalizePaneTarget(preferredLeaderPaneId);
  if (!panes) {
    return {
      livePaneIds: [],
      teamWorkerPaneIds: [],
      leaderPaneId: null,
      hudPaneIds: [],
      leaderOwnedHudPaneIds: [],
    };
  }
  const livePaneIds = panes.map((pane) => pane.paneId);
  if (panes.length === 0) {
    return {
      livePaneIds,
      teamWorkerPaneIds: [],
      leaderPaneId: fallbackLeaderPaneId,
      hudPaneIds: [],
      leaderOwnedHudPaneIds: [],
    };
  }

  const normalizedTeamName = typeof teamName === 'string' ? teamName.trim() : '';
  const normalizedTeamWorkerPaneIds = normalizedTeamName
    ? panes
      .filter((pane) => !isHudWatchPane(pane))
      .filter((pane) => paneLooksLikeTeamWorkerPane(pane, normalizedTeamName))
      .map((pane) => pane.paneId)
    : [];
  const workerPaneIdSet = new Set(normalizedTeamWorkerPaneIds);
  const resolvedLeaderPaneId = chooseSharedSessionShutdownLeaderPaneId(
    panes,
    fallbackLeaderPaneId,
    workerPaneIdSet,
  );
  const hudPaneIds = panes
    .filter((pane) => pane.paneId !== resolvedLeaderPaneId)
    .filter((pane) => isHudWatchPane(pane))
    .map((pane) => pane.paneId);
  const leaderOwnedHudPaneIds = resolvedLeaderPaneId
    ? panes
      .filter((pane) => pane.paneId !== resolvedLeaderPaneId)
      .filter((pane) => hudPaneMatchesOwner(pane, { leaderPaneId: resolvedLeaderPaneId }))
      .map((pane) => pane.paneId)
    : [];

  return {
    livePaneIds,
    teamWorkerPaneIds: normalizedTeamWorkerPaneIds,
    leaderPaneId: resolvedLeaderPaneId,
    hudPaneIds,
    leaderOwnedHudPaneIds,
  };
}

function chooseSharedSessionShutdownLeaderPaneId(
  panes: TmuxPaneInfo[],
  preferredLeaderPaneId: string | null,
  teamWorkerPaneIds: ReadonlySet<string>,
): string | null {
  const preferred = panes.find((pane) => pane.paneId === preferredLeaderPaneId);
  if (preferred && !isHudWatchPane(preferred) && !teamWorkerPaneIds.has(preferred.paneId)) {
    return preferred.paneId;
  }
  return null;
}

function paneLooksLikeTeamWorkerPane(pane: TmuxPaneInfo, teamName: string): boolean {
  const command = `${pane.startCommand || ''} ${pane.currentCommand || ''}`.replace(/\\/g, '/');
  if (!command.trim() || !teamName) return false;
  if (command.includes(`/team/${teamName}/runtime/worker-`) && command.includes('-startup.sh')) {
    return true;
  }
  const commandVariants = [command, ...decodePowerShellEncodedCommands(command)];
  return commandVariants.some((candidate) => (
    commandHasTeamWorkerEnvMarker(candidate, 'OMX_TEAM_INTERNAL_WORKER', teamName)
    || commandHasTeamWorkerEnvMarker(candidate, 'OMX_TEAM_WORKER', teamName)
  ));
}

function commandHasTeamWorkerEnvMarker(command: string, envName: string, teamName: string): boolean {
  const normalized = command.replace(/\\/g, '/');
  const key = escapeRegExp(envName);
  const workerValue = `${escapeRegExp(teamName)}/worker-[A-Za-z0-9_-]+`;
  const shellAssignment = new RegExp(
    `(?:^|[\\s;])(?:export\\s+)?(?:["']${key}=${workerValue}|${key}=(?:["']?${workerValue}))`,
    'g',
  );
  return hasWorkerCliAfterEnvAssignment(
    normalized,
    shellAssignment,
    hasSafeShellEnvAssignmentContext,
    shellTailInvokesWorkerCli,
  ) || powerShellCommandHasTeamWorkerEnvMarker(normalized, envName, workerValue);
}

function powerShellCommandHasTeamWorkerEnvMarker(command: string, envName: string, workerValue: string): boolean {
  const assignment = new RegExp(
    `^\\s*\\$env:${escapeRegExp(envName)}\\s*=\\s*(?:'${workerValue}'|"${workerValue}")\\s*$`,
    'i',
  );
  const statements = splitPowerShellExecutableStatements(command);
  for (let index = 0; index < statements.length; index += 1) {
    if (!assignment.test(statements[index]!)) continue;
    for (let candidateIndex = index + 1; candidateIndex < statements.length; candidateIndex += 1) {
      const candidate = statements[candidateIndex]!;
      if (isPowerShellEnvironmentAssignment(candidate)) continue;
      if (powerShellStatementInvokesWorkerCli(candidate)) return true;
    }
  }
  return false;
}

/** Splits executable PowerShell statements while discarding comments and respecting quoted literals. */
function splitPowerShellExecutableStatements(command: string): string[] {
  const statements: string[] = [];
  let statement = '';
  let quote: 'single' | 'double' | null = null;
  let comment = false;
  const pushStatement = (): void => {
    if (statement.trim()) statements.push(statement);
    statement = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (comment) {
      if (char === '\n' || char === '\r') {
        comment = false;
        pushStatement();
      }
      continue;
    }
    if (quote === 'single') {
      statement += char;
      if (char === "'" && next === "'") {
        statement += next;
        index += 1;
      } else if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (quote === 'double') {
      statement += char;
      if (char === '`' && next !== undefined) {
        statement += next;
        index += 1;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }
    if (char === '#') {
      comment = true;
    } else if (char === "'") {
      quote = 'single';
      statement += char;
    } else if (char === '"') {
      quote = 'double';
      statement += char;
    } else if (char === ';' || char === '\n' || char === '\r') {
      pushStatement();
    } else {
      statement += char;
    }
  }
  if (!comment) pushStatement();
  return statements;
}

function isPowerShellEnvironmentAssignment(statement: string): boolean {
  return /^\s*\$env:[A-Za-z_][A-Za-z0-9_]*\s*=/.test(statement);
}

function tokenizePowerShellCommand(statement: string): string[] | null {
  const tokens: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | null = null;
  const pushToken = (): void => {
    if (token) tokens.push(token);
    token = '';
  };
  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index]!;
    const next = statement[index + 1];
    if (quote === 'single') {
      if (char === "'" && next === "'") {
        token += "'";
        index += 1;
      } else if (char === "'") {
        quote = null;
      } else {
        token += char;
      }
      continue;
    }
    if (quote === 'double') {
      if (char === '`' && next !== undefined) {
        token += next;
        index += 1;
      } else if (char === '"') {
        quote = null;
      } else {
        token += char;
      }
      continue;
    }
    if (/\s/.test(char)) {
      pushToken();
    } else if (char === "'") {
      quote = 'single';
    } else if (char === '"') {
      quote = 'double';
    } else {
      token += char;
    }
  }
  if (quote) return null;
  pushToken();
  return tokens;
}

function isWorkerCliToken(token: string): boolean {
  return /(?:^|[\\/])?(?:codex|claude|gemini)(?:\.(?:js|mjs|cjs|cmd|exe|bat|ps1))?$/i.test(token);
}

function isNodeExecutableToken(token: string): boolean {
  return /(?:^|[\\/])node(?:\.exe)?$/i.test(token);
}

function powerShellStatementInvokesWorkerCli(statement: string): boolean {
  const trimmed = statement.trimStart();
  // A bare quoted literal writes a string; only the call operator may execute a quoted path.
  if (trimmed.startsWith("'") || trimmed.startsWith('"')) return false;
  const tokens = tokenizePowerShellCommand(trimmed);
  if (!tokens || tokens.length === 0) return false;
  const invocation = tokens[0] === '&' ? tokens.slice(1) : tokens;
  if (invocation.length === 0) return false;
  if (isWorkerCliToken(invocation[0]!)) return true;
  return isNodeExecutableToken(invocation[0]!) && invocation.slice(1).some(isWorkerCliToken);
}

function hasWorkerCliAfterEnvAssignment(
  command: string,
  assignmentPattern: RegExp,
  contextIsSafe: (command: string, matchIndex: number) => boolean = () => true,
  tailInvokesWorkerCli: (tail: string) => boolean = shellTailInvokesWorkerCli,
): boolean {
  assignmentPattern.lastIndex = 0;
  for (const match of command.matchAll(assignmentPattern)) {
    const matchIndex = match.index ?? 0;
    if (!contextIsSafe(command, matchIndex)) continue;
    const afterAssignment = command.slice(matchIndex + match[0].length);
    if (tailInvokesWorkerCli(afterAssignment)) {
      return true;
    }
  }
  return false;
}

const WORKER_CLI_TOKEN_PATTERN = String.raw`(?:"[^"]*(?:^|[\/\\])?(?:codex|claude|gemini)(?:\.(?:js|mjs|cjs|cmd|exe|bat|ps1))?"|'[^']*(?:^|[\/\\])?(?:codex|claude|gemini)(?:\.(?:js|mjs|cjs|cmd|exe|bat|ps1))?'|(?:\S*[\/\\])?(?:codex|claude|gemini)(?:\.(?:js|mjs|cjs|cmd|exe|bat|ps1))?)`;
function shellTailInvokesWorkerCli(tail: string): boolean {
  const directTail = stripShellAssignmentTailPrefix(tail);
  const directCliPattern = new RegExp(`^(?:exec\\s+)?${WORKER_CLI_TOKEN_PATTERN}(?:[\\s;"'\`]|$)`, 'i');
  if (directCliPattern.test(directTail)) return true;

  const shellCommandPattern = /(?:^|\s)-(?:c|lc)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
  for (const match of directTail.matchAll(shellCommandPattern)) {
    const commandText = match[1] ?? match[2] ?? match[3] ?? '';
    const execCliPattern = new RegExp(`(?:^|[\\s;&|])exec\\s+${WORKER_CLI_TOKEN_PATTERN}(?:[\\s;"'\`]|$)`, 'i');
    if (execCliPattern.test(commandText)) return true;
  }
  return false;
}

function stripShellAssignmentTailPrefix(tail: string): string {
  let value = tail.trimStart();
  while (value.startsWith("'") || value.startsWith('"')) {
    value = value.slice(1).trimStart();
  }
  const envAssignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+/;
  let changed = true;
  while (changed) {
    changed = false;
    const match = value.match(envAssignmentPattern);
    if (match) {
      value = value.slice(match[0].length).trimStart();
      changed = true;
    }
  }
  return value;
}

function hasSafeShellEnvAssignmentContext(command: string, matchIndex: number): boolean {
  const prefix = command.slice(0, matchIndex).trimEnd();
  if (!prefix) return true;
  const segment = prefix.split(/&&|\|\||[;|]/).pop()?.trimEnd() ?? '';
  if (!segment) return true;
  return /(?:^|\s)(?:env|export)(?:\s+(?:'[^']*'|"[^"]*"|\S+))*$/.test(segment)
    || /(?:^|\s)worker[-_]wrapper(?:\s+(?:'[^']*'|"[^"]*"|\S+))*$/.test(segment);
}

function decodePowerShellEncodedCommands(command: string): string[] {
  const decoded: string[] = [];
  const encodedCommandPattern = /(?:^|\s)-(?:EncodedCommand|enc|e)(?:\s+|:)([A-Za-z0-9+/=]+)/gi;
  for (const match of command.matchAll(encodedCommandPattern)) {
    const encoded = match[1];
    if (!encoded) continue;
    try {
      const text = Buffer.from(encoded, 'base64').toString('utf16le').trim();
      if (text) decoded.push(text.replace(/\\/g, '/'));
    } catch {
      // Ignore malformed pane command fragments; they are not team ownership evidence.
    }
  }
  return decoded;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasFreshPaneTeardownAuthority(paneId: string, authority: PaneTeardownAuthority | undefined): boolean {
  if (!authority || !authority.sessionName || !authority.expectedOwnerId) return false;
  const canonicalPaneId = parseCanonicalTmuxPaneId(paneId);
  const expectedPanePid = authority.expectedPanePids?.get(paneId);
  const normalizedPid = String(expectedPanePid ?? '');
  if (
    !canonicalPaneId
    || canonicalPaneId !== paneId
    || !/^[1-9][0-9]*$/.test(normalizedPid)
    || !isTeamPaneIncarnationLive(paneId, normalizedPid)
  ) return false;
  const globalPaneIds = readGlobalTmuxPaneIdSnapshot();
  const sessionPanes = listPanes(authority.sessionName);
  if (!globalPaneIds || !sessionPanes || !globalPaneIds.has(paneId) || !sessionPanes.some((pane) => pane.paneId === paneId)) {
    return false;
  }
  const owner = readPaneTeamOwnerTagResult(paneId);
  if (owner.status === 'value' && owner.value === authority.expectedOwnerId) return true;
  return authority.verifyOwnership?.(paneId) ?? false;
}

/**
 * Shared pane-id-direct teardown primitive for worker pane cleanup.
 * Each sink validates current global/session membership and Team ownership.
 */
export async function teardownWorkerPanes(
  paneIds: string[],
  options: PaneTeardownOptions = {},
): Promise<PaneTeardownSummary> {
  const { killablePaneIds, excluded } = normalizePaneTargets(paneIds, options);
  const graceMs = options.graceMs ?? 2000;
  const perPaneGrace = killablePaneIds.length > 0
    ? Math.max(100, Math.floor(graceMs / killablePaneIds.length))
    : 0;

  const summary: PaneTeardownSummary = {
    attemptedPaneIds: killablePaneIds,
    excluded,
    kill: {
      attempted: killablePaneIds.length,
      succeeded: 0,
      failed: 0,
    },
  };

  for (const paneId of killablePaneIds) {
    if (!options.authority) {
      summary.kill.failed += 1;
      break;
    }
    const sourceAuthorityValid = await options.authority.revalidate?.(paneId) ?? true;
    if (!sourceAuthorityValid || !hasFreshPaneTeardownAuthority(paneId, options.authority)) {
      summary.kill.failed += 1;
      break;
    }
    const expectedPanePid = String(options.authority.expectedPanePids?.get(paneId) ?? '');
    const expectedOwnerId = options.authority.expectedOwnerId;
    const sessionName = options.authority.sessionName;
    if (
      !/^[1-9][0-9]*$/.test(expectedPanePid)
      || !isSafeTmuxFormatOperand(expectedOwnerId)
      || !isSafeTmuxFormatOperand(sessionName)
    ) {
      summary.kill.failed += 1;
      break;
    }
    const receipt = createMutationReceipt();
    const condition = `#{&&:${buildTeamPaneIncarnationCondition(paneId, expectedPanePid)},#{&&:#{==:#{session_name},${sessionName}},#{==:#{${OMX_TEAM_PANE_OWNER_OPTION}},${expectedOwnerId}}}}`;
    const result = await runTmuxAsync([
      'if-shell', '-F', '-t', paneId,
      condition,
      `kill-pane -t ${paneId} ; display-message -p ${receipt}`,
      '',
    ]);
    if (result.ok && parseExactTmuxAuthorityScalar(result.stdout) === receipt) summary.kill.succeeded += 1;
    else {
      summary.kill.failed += 1;
      break;
    }
    await sleep(perPaneGrace);
  }

  return summary;
}

export async function killWorkerPanes(
  paneIds: string[],
  leaderPaneId: string,
  graceMs: number = 2000,
  hudPaneId?: string,
): Promise<PaneTeardownSummary> {
  return teardownWorkerPanes(paneIds, { leaderPaneId, hudPaneId: hudPaneId ?? null, graceMs });
}

// Kill entire tmux session. Tolerates already-dead sessions.
export function destroyTeamSession(sessionName: string): void {
  try {
    runTmux(['kill-session', '-t', sessionName]);
  } catch {
    // tolerate
  }
}

// List all tmux sessions matching omx-team-* pattern
export function listTeamSessions(): string[] {
  const result = runTmux(['list-sessions', '-F', '#{session_name}']);
  if (!result.ok) return [];

  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(baseSessionName);
}

/**
 * Notify the leader through durable mailbox state only.
 *
 * Team leaders are a coordination endpoint, not a direct tmux control target:
 * workers and runtime paths may message `leader-fixed` via `omx team api`
 * / mailbox persistence, but team code must not inject text or control keys
 * into the leader pane. This is the async mailbox-based replacement for
 * `notifyLeaderStatus()`.
 */
export async function notifyLeaderMailboxAsync(
  teamName: string,
  fromWorker: string,
  message: string,
  cwd: string,
): Promise<boolean> {
  try {
    const { sendDirectMessage } = await import('./state.js');
    await sendDirectMessage(teamName, fromWorker, 'leader-fixed', message, cwd);
    return true;
  } catch {
    return false;
  }
}
