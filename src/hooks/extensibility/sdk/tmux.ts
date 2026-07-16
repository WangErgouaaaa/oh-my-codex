import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { sleepSync } from '../../../utils/sleep.js';
import { resolveCodexPane } from '../../../scripts/tmux-hook-engine.js';
import { parseCanonicalTmuxPaneId, parseExactTmuxAuthorityLines, parseExactTmuxAuthorityScalar } from '../../../hud/tmux.js';
import { spawnPlatformCommandSync } from '../../../utils/platform-command.js';
import type {
  HookEventEnvelope,
  HookPluginSdk,
  HookPluginSendKeysOptions,
  HookPluginSendKeysResult,
} from '../types.js';
import { appendHookPluginLog } from './logging.js';
import { hookPluginTmuxStatePath } from './paths.js';

const INJECTION_MARKER = '[OMX_TMUX_INJECT]';
const DEFAULT_COOLDOWN_MS = 15_000;
const DEFAULT_DEDUPE_WINDOW_MS = 60_000;

interface PluginTmuxState {
  last_sent_at: number;
  recent_keys: Record<string, number>;
}

interface HookPluginTmuxApiOptions {
  cwd: string;
  pluginName: string;
  event: HookEventEnvelope;
  sideEffectsEnabled?: boolean;
}

function asPositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function readJsonIfExists<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function hashDedupeKey(target: string, text: string): string {
  return createHash('sha256').update(`${target}|${text}`).digest('hex');
}

function sleepFractionalSeconds(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  sleepSync(Math.round(seconds * 1000));
}

function runTmux(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const { result } = spawnPlatformCommandSync('tmux', args, { encoding: 'utf-8' });
  if (result.error) return { ok: false, stderr: result.error.message };
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || '').trim() || `tmux exited ${result.status}` };
  }
  return { ok: true, stdout: result.stdout || '' };
}





interface SessionPaneRow {
  paneId: string;
  dead: boolean;
  pid: number;
  active: boolean;
  startCommand: string;
}

interface SessionPaneSnapshot {
  sessionName: string;
  rows: SessionPaneRow[];
}

interface TmuxTarget {
  paneId: string;
  pid: number;
  dead: boolean;
  sessionSnapshot?: SessionPaneSnapshot;
}

function tmuxCommandToken(value: string): string | null {
  return /^[A-Za-z0-9_.:%-]+$/.test(value) ? value : null;
}

function paneAuthorityFormat(target: TmuxTarget, requireBracketPaste = false): string | null {
  if (parseCanonicalTmuxPaneId(target.paneId) !== target.paneId) return null;
  const sessionName = target.sessionSnapshot?.sessionName;
  if (sessionName && /[,#{}\r\n]/.test(sessionName)) return null;
  const sessionCondition = sessionName ? `#{==:#{session_name},${sessionName}}` : '1';
  const bracketPasteCondition = requireBracketPaste ? '#{==:#{bracket_paste_flag},1}' : '1';
  return `#{&&:#{==:#{pane_id},${target.paneId}},#{&&:#{==:#{pane_dead},0},#{&&:#{==:#{pane_pid},${target.pid}},#{&&:${sessionCondition},#{&&:#{m:*codex*,#{pane_start_command}},${bracketPasteCondition}}}}}}`;
}

function exactPaneMutationReceipt(receipt: string, stdout: string): boolean {
  return parseExactTmuxAuthorityScalar(stdout) === receipt;
}

function runPaneMutationAtomically(target: TmuxTarget, command: string[], requireBracketPaste = false): boolean {
  const condition = paneAuthorityFormat(target, requireBracketPaste);
  const commandTokens = command.map(tmuxCommandToken);
  const receipt = randomUUID().replace(/-/g, '');
  if (!condition || commandTokens.some((token) => token === null) || !/^[a-f0-9]{32}$/.test(receipt)) return false;
  const thenCommand = `${commandTokens.join(' ')} ; display-message -p ${receipt}`;
  const result = runTmux(['if-shell', '-t', target.paneId, '-F', condition, thenCommand, '']);
  return result.ok && exactPaneMutationReceipt(receipt, result.stdout);
}

function confirmPaneAuthorityAtomically(target: TmuxTarget): boolean {
  const condition = paneAuthorityFormat(target);
  const receipt = randomUUID().replace(/-/g, '');
  if (!condition || !/^[a-f0-9]{32}$/.test(receipt)) return false;
  const result = runTmux(['if-shell', '-t', target.paneId, '-F', condition, `display-message -p ${receipt}`, '']);
  return result.ok && exactPaneMutationReceipt(receipt, result.stdout);
}
function pasteLiteralPanePayloadAtomically(target: TmuxTarget, payload: string): boolean {
  const tempDir = mkdtempSync(join(tmpdir(), 'omx-tmux-payload-'));
  const payloadPath = join(tempDir, 'payload');
  const bufferName = `omx_payload_${randomUUID().replace(/-/g, '')}`;
  const multiline = /[\r\n]/.test(payload);
  try {
    writeFileSync(payloadPath, payload, { encoding: 'utf8', flag: 'wx' });
    const loaded = runTmux(['load-buffer', '-b', bufferName, payloadPath]);
    if (!loaded.ok) return false;
    const command = ['paste-buffer', '-b', bufferName, '-t', target.paneId, '-d'];
    if (multiline) command.push('-r', '-p');
    return runPaneMutationAtomically(target, command, multiline);
  } catch {
    return false;
  } finally {
    runTmux(['delete-buffer', '-b', bufferName]);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function isStrictPanePid(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) return false;
  try {
    return BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
  } catch {
    return false;
  }
}

function parseSessionPaneRows(stdout: string): SessionPaneRow[] | null {
  const rows = parseExactTmuxAuthorityLines(stdout);
  if (!rows) return null;
  const paneIds = new Set<string>();
  const parsedRows: SessionPaneRow[] = [];
  for (const row of rows) {
    const fields = row.split('\t');
    if (
      fields.length !== 5
      || parseCanonicalTmuxPaneId(fields[0]) !== fields[0]
      || (fields[1] !== '0' && fields[1] !== '1')
      || (fields[3] !== '0' && fields[3] !== '1')
    ) return null;
    if (fields[1] === '1') continue;
    if (!isStrictPanePid(fields[2]) || paneIds.has(fields[0])) return null;
    paneIds.add(fields[0]);
    parsedRows.push({
      paneId: fields[0],
      dead: false,
      pid: Number(fields[2]),
      active: fields[3] === '1',
      startCommand: fields[4],
    });
  }
  return parsedRows;
}

function parseStrictPaneSnapshot(stdout: string): Map<string, TmuxTarget> | null {
  const rows = parseExactTmuxAuthorityLines(stdout);
  if (!rows) return null;
  const panes = new Map<string, TmuxTarget>();
  for (const row of rows) {
    const fields = row.split('\t');
    if (
      fields.length !== 3
      || parseCanonicalTmuxPaneId(fields[0]) !== fields[0]
      || (fields[1] !== '0' && fields[1] !== '1')
    ) return null;
    if (fields[1] === '1') continue;
    if (!isStrictPanePid(fields[2]) || panes.has(fields[0])) return null;
    panes.set(fields[0], { paneId: fields[0], pid: Number(fields[2]), dead: false });
  }
  return panes;
}

function samePaneIds(rows: SessionPaneRow[], paneIds: Set<string>): boolean {
  return rows.length === paneIds.size && rows.every((row) => paneIds.has(row.paneId));
}

function sameSessionPaneRows(left: SessionPaneRow[], right: SessionPaneRow[]): boolean {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index];
    return row.paneId === other.paneId
      && row.dead === other.dead
      && row.pid === other.pid
      && row.active === other.active
      && row.startCommand === other.startCommand;
  });
}

function readSessionPaneSnapshot(sessionName: string): SessionPaneSnapshot | null {
  const paneList = runTmux(['list-panes', '-t', sessionName, '-F', '#{pane_id}\t#{pane_dead}\t#{pane_pid}\t#{pane_active}\t#{pane_start_command}']);
  if (!paneList.ok) return null;
  const rows = parseSessionPaneRows(paneList.stdout);
  if (!rows) return null;

  const idSnapshot = runTmux(['list-panes', '-t', sessionName, '-F', '#{pane_id}\t#{pane_dead}\t#{pane_pid}']);
  const paneIds = idSnapshot.ok ? parseStrictPaneSnapshot(idSnapshot.stdout) : null;
  return paneIds && samePaneIds(rows, new Set(paneIds.keys())) ? { sessionName, rows } : null;
}

function strictPaneSnapshot(target: string | undefined): TmuxTarget | null {
  const paneSnapshot = runTmux(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_dead}\t#{pane_pid}']);
  const panes = paneSnapshot.ok ? parseStrictPaneSnapshot(paneSnapshot.stdout) : null;
  const pane = target ? panes?.get(target) : undefined;
  return pane && !pane.dead ? pane : null;
}

function isHudStartCommand(startCommand: string): boolean {
  return /\bomx\b.*\bhud\b.*--watch/i.test(startCommand);
}

interface TargetResolution {
  result: HookPluginSendKeysResult;
  target?: TmuxTarget;
}

function missingTarget(error?: string): TargetResolution {
  return { result: { ok: false, reason: 'target_missing', ...(error ? { error } : {}) } };
}

function resolvePaneSessionName(paneId: string): string | null {
  const sessionName = runTmux(['display-message', '-p', '-t', paneId, '#{session_name}']);
  if (!sessionName.ok || !sessionName.stdout.endsWith('\n')) return null;
  const value = sessionName.stdout.slice(0, -1);
  return value && !/[\t\r\n]/.test(value) ? value : null;
}

function resolvePaneIdTarget(paneId: string): TargetResolution {
  const sessionName = resolvePaneSessionName(paneId);
  const sessionSnapshot = sessionName ? readSessionPaneSnapshot(sessionName) : null;
  const resolved = sessionSnapshot?.rows.find((row) => row.paneId === paneId && !row.dead);
  const authoritativePane = resolved ? strictPaneSnapshot(paneId) : null;
  return resolved && authoritativePane?.pid === resolved.pid
    ? {
      result: { ok: true, reason: 'ok', target: paneId, paneId },
      target: { paneId, pid: resolved.pid, dead: false, sessionSnapshot: sessionSnapshot! },
    }
    : missingTarget('pane_snapshot_mismatch');
}

function resolveSessionPaneTarget(sessionName: string): TargetResolution {
  const sessionSnapshot = readSessionPaneSnapshot(sessionName);
  if (!sessionSnapshot) return missingTarget('pane_snapshot_mismatch');

  const liveRows = sessionSnapshot.rows.filter((row) => !row.dead);
  const nonHudRows = liveRows.filter((row) => !isHudStartCommand(row.startCommand));
  const canonicalRows = nonHudRows.filter((row) => /\bcodex\b/i.test(row.startCommand));
  const resolved = canonicalRows.find((row) => row.active)
    || canonicalRows[0]
    || nonHudRows.find((row) => row.active)
    || nonHudRows[0];
  const authoritativePane = resolved ? strictPaneSnapshot(resolved.paneId) : null;
  if (!resolved || authoritativePane?.pid !== resolved.pid) return missingTarget('pane_snapshot_mismatch');
  return {
    result: { ok: true, reason: 'ok', target: resolved.paneId, paneId: resolved.paneId },
    target: {
      paneId: resolved.paneId,
      pid: resolved.pid,
      dead: false,
      sessionSnapshot,
    },
  };
}

function resolveTmuxTarget(options: HookPluginSendKeysOptions): TargetResolution {
  const paneId = typeof options.paneId === 'string' ? options.paneId : '';
  if (paneId) {
    if (parseCanonicalTmuxPaneId(paneId) !== paneId) return missingTarget('invalid_pane_id');
    return resolvePaneIdTarget(paneId);
  }

  const sessionName = typeof options.sessionName === 'string' ? options.sessionName : '';
  if (sessionName) return resolveSessionPaneTarget(sessionName);

  const envPane = String(resolveCodexPane() || '');
  if (parseCanonicalTmuxPaneId(envPane) !== envPane) return missingTarget();
  return resolvePaneIdTarget(envPane);
}

async function sendTmuxKeys(
  options: HookPluginSendKeysOptions,
  context: HookPluginTmuxApiOptions,
): Promise<HookPluginSendKeysResult> {
  if (!context.sideEffectsEnabled) {
    return { ok: false, reason: 'side_effects_disabled' };
  }

  const text = typeof options.text === 'string' ? options.text : '';
  if (!text.trim()) {
    return { ok: false, reason: 'invalid_text' };
  }

  const marker = process.env.OMX_HOOK_PLUGIN_LOOP_MARKER || '[OMX_HOOK_PLUGIN]';
  if (marker && text.includes(marker)) {
    return { ok: false, reason: 'loop_guard_input_marker' };
  }

  const targetResolution = resolveTmuxTarget(options);
  if (!targetResolution.result.ok || !targetResolution.target) return targetResolution.result;
  const target = targetResolution.target;

  const tmuxStatePath = hookPluginTmuxStatePath(context.cwd, context.pluginName);
  await mkdir(dirname(tmuxStatePath), { recursive: true });
  const tmuxState = await readJsonIfExists<PluginTmuxState>(tmuxStatePath, {
    last_sent_at: 0,
    recent_keys: {},
  });

  const now = Date.now();
  const cooldownMs = typeof options.cooldownMs === 'number'
    ? Math.max(0, options.cooldownMs)
    : asPositiveNumber(process.env.OMX_HOOK_PLUGIN_COOLDOWN_MS, DEFAULT_COOLDOWN_MS);
  const dedupeWindowMs = asPositiveNumber(process.env.OMX_HOOK_PLUGIN_DEDUPE_MS, DEFAULT_DEDUPE_WINDOW_MS);
  const minTs = now - dedupeWindowMs;

  tmuxState.recent_keys = Object.fromEntries(
    Object.entries(tmuxState.recent_keys || {}).filter(([, ts]) => Number.isFinite(ts) && ts >= minTs),
  );

  if (cooldownMs > 0 && now - (tmuxState.last_sent_at || 0) < cooldownMs) {
    return { ok: false, reason: 'cooldown_active', target: target.paneId, paneId: target.paneId };
  }

  const dedupeKey = hashDedupeKey(target.paneId, text);
  if (tmuxState.recent_keys[dedupeKey]) {
    return { ok: false, reason: 'duplicate_event', target: target.paneId, paneId: target.paneId };
  }

  const targetIsAuthoritative = (): boolean => {
    const paneSnapshot = strictPaneSnapshot(target.paneId);
    if (paneSnapshot?.pid !== target.pid) return false;
    if (!target.sessionSnapshot) return true;

    const currentSessionSnapshot = readSessionPaneSnapshot(target.sessionSnapshot.sessionName);
    return currentSessionSnapshot !== null
      && sameSessionPaneRows(target.sessionSnapshot.rows, currentSessionSnapshot.rows);
  };
  const missingAuthoritativeTarget = (): HookPluginSendKeysResult => ({
    ok: false,
    reason: 'target_missing',
    target: target.paneId,
    paneId: target.paneId,
    error: 'pane_snapshot_mismatch',
  });

  if (!confirmPaneAuthorityAtomically(target)) return missingAuthoritativeTarget();

  if (!targetIsAuthoritative()) return missingAuthoritativeTarget();

  const markedText = `${text} ${INJECTION_MARKER}`;
  if (!pasteLiteralPanePayloadAtomically(target, markedText)) return missingAuthoritativeTarget();



  if (options.submit !== false) {
    sleepFractionalSeconds(0.12);
    if (!confirmPaneAuthorityAtomically(target)) return missingAuthoritativeTarget();
    const submitA = runPaneMutationAtomically(target, ['send-keys', '-t', target.paneId, 'C-m']);

    sleepFractionalSeconds(0.1);
    if (!confirmPaneAuthorityAtomically(target)) return missingAuthoritativeTarget();
    const submitB = runPaneMutationAtomically(target, ['send-keys', '-t', target.paneId, 'C-m']);

    if (!submitA && !submitB) return missingAuthoritativeTarget();
  }
  if (!confirmPaneAuthorityAtomically(target)) return missingAuthoritativeTarget();

  tmuxState.last_sent_at = now;
  tmuxState.recent_keys[dedupeKey] = now;
  await writeFile(tmuxStatePath, JSON.stringify(tmuxState, null, 2));

  await appendHookPluginLog(context.cwd, context.pluginName, 'info', 'tmux.sendKeys', {
    hook_event: context.event.event,
    target: target.paneId,
    submitted: options.submit !== false,
  }).catch(() => {});

  return {
    ok: true,
    reason: 'ok',
    target: target.paneId,
    paneId: target.paneId,
  };
}

export function createHookPluginTmuxApi(options: HookPluginTmuxApiOptions): HookPluginSdk['tmux'] {
  return {
    sendKeys: (sendOptions: HookPluginSendKeysOptions) => sendTmuxKeys(sendOptions, options),
  };
}
