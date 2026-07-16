import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, readdir, symlink } from 'fs/promises';
import { join, posix, relative, win32 } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync } from 'fs';
import {
  initTeamState,
  createTask,
  claimTask,
  readTask,
  readTeamConfig,
  saveTeamConfig,
  readWorkerStatus,
  writeWorkerStatus,
  withScalingLock,
  recoverTeamMembershipTaskTransaction,
  commitTeamMembershipTaskTransaction,
  withTeamTaskBarrier,
  DEFAULT_MAX_WORKERS,
  listDispatchRequests,
  readTeamManifestV2,
} from '../state.js';
import { isSameOrInsidePath, isScalingEnabled, reconcileScaleDownCleanupDebt, scaleUp, scaleDown } from '../scaling.js';
import { resolveCanonicalTeamStateRoot } from '../state-root.js';
import {
  resolvePersistedApprovedTeamExecutionContinuityState,
  writePersistedApprovedTeamExecutionBinding,
} from '../approved-execution.js';
import { TEAM_WORKER_INHERITED_MODEL_ENV } from '../model-contract.js';
import { buildWorkerProcessLaunchSpec } from '../tmux-session.js';


delete process.env.OMX_TEAM_STATE_ROOT;
process.env.OMX_RUNTIME_BRIDGE = '0';

async function initCommittedGitRepo(cwd: string): Promise<void> {
  execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'OMX Test'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'omx@example.com'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });
}

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-worktree-repo-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

function computeGitBlobSha1(content: string): string {
  const buffer = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf-8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

function withoutConfigGeneration(bytes: string): Record<string, unknown> {
  const value = JSON.parse(bytes) as Record<string, unknown>;
  delete value.config_generation;
  return value;
}

function canonicalContextPackRelativePath(slug: string): string {
  return `.omx/context/context-20260507T120000Z-${slug}.json`;
}

function buildContextPackOutcome(relativePackPath: string): string {
  return [
    '## Context Pack Outcome',
    '',
    `- pack: created \`${relativePackPath}\``,
  ].join('\n');
}


function workerStartupScriptPath(cwd: string, teamName: string, workerName: string): string {
  return join(cwd, '.omx', 'state', 'team', teamName, 'runtime', `${workerName}-startup.sh`);
}

type ContextPackRole = 'scope' | 'build' | 'verify';

type ScaleUpApprovedBindingState =
  | 'missing'
  | 'malformed'
  | 'stale'
  | 'ambiguous'
  | 'missing-baseline'
  | 'plan-only'
  | 'incomplete'
  | 'invalid'
  | 'ready';

type ScaleUpObservedOutcome = 'generic' | 'blocked' | 'approved';

type ScaleUpCount = 1 | 2 | 3;

type BlockedScaleUpApprovedBindingState = Exclude<
  ScaleUpApprovedBindingState,
  'missing' | 'plan-only' | 'incomplete' | 'invalid' | 'ready'
>;

const BLOCKED_SCALE_UP_APPROVED_BINDING_STATES: readonly BlockedScaleUpApprovedBindingState[] = [
  'malformed',
  'stale',
  'ambiguous',
  'missing-baseline',
];

const SCALE_UP_STATE_TEAM_SUFFIX: Record<ScaleUpApprovedBindingState, string> = {
  missing: 'miss',
  malformed: 'mal',
  stale: 'stale',
  ambiguous: 'amb',
  'missing-baseline': 'mbase',
  'plan-only': 'ponly',
  incomplete: 'inc',
  invalid: 'inv',
  ready: 'ready',
};

const SCALE_UP_APPROVED_BINDING_STATES: readonly ScaleUpApprovedBindingState[] = [
  'missing',
  ...BLOCKED_SCALE_UP_APPROVED_BINDING_STATES,
  'plan-only',
  'incomplete',
  'invalid',
  'ready',
];

const SCALE_UP_COUNTS: readonly ScaleUpCount[] = [1, 2, 3];

function assertNeverScaleUpState(state: never): never {
  throw new Error(`unexpected scale-up approved binding state: ${state}`);
}

function expectedScaleUpOutcome(state: ScaleUpApprovedBindingState): ScaleUpObservedOutcome {
  if (state === 'missing') {
    return 'generic';
  }
  return BLOCKED_SCALE_UP_APPROVED_BINDING_STATES.includes(state as BlockedScaleUpApprovedBindingState)
    ? 'blocked'
    : 'approved';
}

function forbiddenScaleUpOutcomes(
  state: ScaleUpApprovedBindingState,
): readonly ScaleUpObservedOutcome[] {
  switch (state) {
    case 'missing':
      return ['blocked', 'approved'];
    case 'plan-only':
    case 'incomplete':
    case 'invalid':
    case 'ready':
      return ['blocked', 'generic'];
    case 'malformed':
    case 'stale':
    case 'ambiguous':
    case 'missing-baseline':
      return ['generic', 'approved'];
    default:
      return assertNeverScaleUpState(state);
  }
}

function buildScaleUpScenarioTasks(
  state: ScaleUpApprovedBindingState,
  count: ScaleUpCount,
): Array<{ subject: string; description: string; owner: string }> {
  return Array.from({ length: count }, (_, index) => {
    const workerIndex = index + 2;
    return {
      subject: `Implement ${state} follow-up ${workerIndex}/${count}`,
      description: `Implement ${state} follow-up ${workerIndex}/${count}`,
      owner: `worker-${workerIndex}`,
    };
  });
}

async function writeContextPack(
  cwd: string,
  slug: string,
  prdPath: string,
  testSpecPath: string,
  roles: readonly ContextPackRole[],
): Promise<void> {
  const contextDir = join(cwd, '.omx', 'context');
  const packPath = join(cwd, canonicalContextPackRelativePath(slug));
  const prdContent = await readFile(prdPath, 'utf-8');
  const testSpecContent = await readFile(testSpecPath, 'utf-8');
  await mkdir(contextDir, { recursive: true });
  await writeFile(packPath, JSON.stringify({
    slug,
    basis: {
      prd: {
        path: relative(cwd, prdPath).replaceAll('\\', '/'),
        sha1: computeGitBlobSha1(prdContent),
      },
      testSpecs: [{
        path: relative(cwd, testSpecPath).replaceAll('\\', '/'),
        sha1: computeGitBlobSha1(testSpecContent),
      }],
    },
    entries: roles.map((role, index) => ({
      path: `src/${role}-${index}.ts`,
      roles: [role],
    })),
  }, null, 2));
}

async function writeReadyContextPack(
  cwd: string,
  slug: string,
  prdPath: string,
  testSpecPath: string,
): Promise<void> {
  await writeContextPack(cwd, slug, prdPath, testSpecPath, ['scope', 'build', 'verify']);
}

async function writeSuccessfulScaleUpTmuxStub(
  fakeBinDir: string,
  tmuxLogPath: string,
  deadAfterInitialLive = false,
  options: {
    malformedFirstPostSplitSnapshot?: boolean;
    malformedLivenessBatch?: boolean;
    recycleOperationMarker?: boolean;
    recyclePidAtLivenessProbe?: number;
    readyCapture?: boolean;
  } = {},
): Promise<void> {
  const splitCountPath = join(fakeBinDir, 'split-count');
  const strictProbePath = join(fakeBinDir, 'strict-probe-count');
  const tmuxStubPath = join(fakeBinDir, 'tmux');
  await writeFile(
    tmuxStubPath,
    [
      '#!/bin/sh',
      'set -eu',
      `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
      'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
      '  -V)',
      '    echo "tmux 3.2a"',
      '    ;;',
      '  set-option)',
      '    case "${2:-}" in',
      '      -g) printf "%s" "${4:-}" > "$0.option-${3:-}" ;;',
      '      -p) if [ "${3:-}" = "-t" ] && [ "${5:-}" = "@omx_team_pane_owner_id" ]; then printf "%s\n" "${6:-}" > "$0.pane-owner-${4:-}"; : > "$0.owner-tagged"; fi ;;',
      '    esac',
      '    ;;',
      '  show-options)',
      '    case "${2:-}" in',
      '      -g) cat "$0.option-${4:-}"; printf "\\n" ;;',

      '    esac',
      '    ;;',
      '  split-window)',
      `    count=0; if [ -f "${splitCountPath}" ]; then IFS= read -r count < "${splitCountPath}"; fi`,
      `    count=$((count + 1)); printf '%s\\n' "$count" > "${splitCountPath}"`,
      '    split_command=""; for arg do split_command="$arg"; done',

      "    printf '%%%s\\t%s\\t$1\\n' \"$((30 + count))\" \"$((1000000000 + 30 + count))\"",
      '    printf \'%%%s\\n\' "$((30 + count))" >> "$0.created-panes"',
      '    printf \'%%%s\\t%s\\n\' "$((30 + count))" "$((1000000000 + 30 + count))" >> "$0.created-pane-pids"',
      '    printf \'%%%s\\t%s\\n\' "$((30 + count))" "$split_command" >> "$0.created-pane-commands"',


      '    ;;',
      ...tmuxAuthorityListPanesCase(
        ['%11', '%21', '%12'],
        '42424',
        deadAfterInitialLive,
        strictProbePath,
        options,
      ),
      '  send-keys)',
      '    ;;',
      '  kill-pane)',
      `    : > "${join(fakeBinDir, 'killed-')}$3"`,
      '    ;;',
      '  capture-pane)',
      `    echo "${options.readyCapture ? '›' : ''}"`,
      '    ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  );
  await chmod(tmuxStubPath, 0o755);
  await writeFile(tmuxLogPath, '');
}

function tmuxAuthorityListPanesCase(
  paneIds: readonly string[],
  fallbackOutput = '42424',
  deadAfterInitialLive = false,
  strictProbePath = '',
  options: {
    malformedFirstPostSplitSnapshot?: boolean;
    malformedLivenessBatch?: boolean;
    recycleOperationMarker?: boolean;
    recyclePidAtLivenessProbe?: number;
    readyCapture?: boolean;
    atomicSendFailure?: boolean;
  } = {},
): string[] {
  const globalPaneFormat = paneIds.map((paneId) => `${paneId.replace('%', '%%')}\\n`).join('');
  const ownedPaneFormat = paneIds.map((paneId) => `${paneId.replace('%', '%%')}\\t%s\\n`).join('');
  const ownerArgs = paneIds.map(() => '"$owner"').join(' ');
  const staticLivenessFormat = paneIds.map((paneId) => `${paneId.replace('%', '%%')} 0 42424\\n`).join('');
  const createdLiveness = deadAfterInitialLive
    ? `probe_count=0; if [ -f "${strictProbePath}" ]; then IFS= read -r probe_count < "${strictProbePath}"; fi; probe_count=$((probe_count + 1)); printf '%s\\n' "$probe_count" > "${strictProbePath}";`
    : options.recyclePidAtLivenessProbe
      ? `liveness_probe_count=0; if [ -f "$0.liveness-probe-count" ]; then IFS= read -r liveness_probe_count < "$0.liveness-probe-count"; fi; liveness_probe_count=$((liveness_probe_count + 1)); printf '%s\\n' "$liveness_probe_count" > "$0.liveness-probe-count";`
      : '';
  return [
    '  set-option)',
    '    if [ "${2:-}" = "-g" ] && [ -n "${3:-}" ]; then printf "%s" "${4:-}" > "$0.global-option-${3:-}"; fi',
    '    if [ "${2:-}" = "-p" ] && [ "${3:-}" = "-t" ] && [ "${5:-}" = "@omx_team_pane_owner_id" ]; then printf "%s\n" "${6:-}" > "$0.pane-owner-${4:-}"; : > "$0.owner-tagged"; fi',
    '    ;;',
    '  show-options)',
    '    if [ "${2:-}" = "-g" ] && [ "${3:-}" = "-v" ]; then cat "$0.global-option-${4:-}"; printf "\\n"; else exit 1; fi',

    '    ;;',
    '  list-panes)',
    '    case "${2:-}" in',
    `      -a) case "\${4:-}" in '#{pane_id}\t#{pane_start_command}') if [ "${options.recycleOperationMarker === true ? '1' : '0'}" = 1 ] && [ -f "$0.owner-tagged" ]; then printf '%s\tbash\n' '%31'; elif [ -f "$0.created-pane-commands" ]; then printf "${globalPaneFormat}" | while IFS= read -r pane; do [ -n "$pane" ] && printf '%s\tbash\n' "$pane"; done; while IFS="$(printf '\t')" read -r pane command; do printf '%s\t%s\n' "$pane" "$command"; done < "$0.created-pane-commands"; fi ;; '#{pane_id} #{pane_dead} #{pane_pid}') if [ "${options.malformedLivenessBatch === true ? '1' : '0'}" = 1 ] && [ -f "$0.owner-tagged" ]; then printf "${staticLivenessFormat}%s 1 0\n" '${paneIds[0]}'; else ${createdLiveness} printf "${staticLivenessFormat}"; if [ -f "$0.created-pane-pids" ]; then while IFS="$(printf '\t')" read -r pane pid; do if [ "${deadAfterInitialLive ? '$probe_count' : '0'}" -ge 18 ]; then printf '%s 1 %s\n' "$pane" "$pid"; else ${options.recyclePidAtLivenessProbe ? `if [ "$liveness_probe_count" -ge ${options.recyclePidAtLivenessProbe} ]; then pid=$((pid + 1)); fi;` : ''} printf '%s 0 %s\n' "$pane" "$pid"; fi; done < "$0.created-pane-pids"; fi; fi ;; '#{pane_id} #{pane_dead}') printf "${globalPaneFormat}" | while IFS= read -r pane; do [ -n "$pane" ] && printf '%s 0\n' "$pane"; done; if [ -f "$0.created-panes" ]; then while IFS= read -r pane; do printf '%s 0\n' "$pane"; done < "$0.created-panes"; fi ;; *) if [ "${options.malformedFirstPostSplitSnapshot === true ? '1' : '0'}" = 1 ] && [ -f "$0.created-panes" ] && [ ! -f "$0.malformed-post-snapshot" ]; then : > "$0.malformed-post-snapshot"; printf 'malformed\n'; else printf "${globalPaneFormat}"; if [ -f "$0.created-panes" ]; then cat "$0.created-panes"; fi; fi ;; esac ;;`,

    '      -t)',
    '        session="${3:-}"',
    '        owner="team:${session#omx-team-}"',
    `        case "\${5:-}" in '#{pane_id}') printf "${globalPaneFormat}"; if [ -f "$0.created-panes" ]; then cat "$0.created-panes"; fi ;; '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}') { printf "${globalPaneFormat}"; if [ -f "$0.created-panes" ]; then cat "$0.created-panes"; fi; } | while IFS= read -r pane; do [ -n "$pane" ] && printf '%s\tbash\tbash\n' "$pane"; done ;; '#{pane_dead} #{pane_pid}') printf '0 42424\n' ;; *) printf "${ownedPaneFormat}" ${ownerArgs}; if [ -f "$0.created-panes" ]; then while IFS= read -r pane; do owner_value=''; if [ -f "$0.pane-owner-$pane" ]; then IFS= read -r owner_value < "$0.pane-owner-$pane"; fi; printf '%s\t%s\n' "$pane" "$owner_value"; done < "$0.created-panes"; fi ;; esac`,
    '        ;;',
    `      *) echo "${fallbackOutput}" ;;`,
    '    esac',
    '    ;;',
  '  display-message)',
  "    case \"$*\" in *'#{session_id}') printf '$1\\n' ;; esac",
  '    ;;',
  '  if-shell)',
    `    if [ "${options.recyclePidAtLivenessProbe === undefined ? '0' : '1'}" = 1 ] && [ -f "$0.liveness-probe-count" ]; then IFS= read -r liveness_probe_count < "$0.liveness-probe-count"; if [ "$liveness_probe_count" -ge ${options.recyclePidAtLivenessProbe ?? 0} ]; then case "\${5:-}" in *1000000031*) printf '%s\\n' '__omx_send_authority_rejected__'; exit 0 ;; esac; fi; fi`,
    `    success="\${6:-}"; receipt="\${success##*display-message -p }"; receipt="\${receipt%% *}"; case "$success" in ${options.atomicSendFailure === true ? '*paste-buffer*) exit 1 ;; ' : ''}*capture-pane*) printf '%s\\n' '›' ;; esac; case "$success" in *display-message\\ -p\\ __OMX_PANE_MUTATION_[a-f0-9]*__*|*display-message\\ -p\\ __OMX_SEND_AUTHORITY_[a-f0-9]*__*) printf '%s\\n' "$receipt" ;; esac`,
    '    ;;',
  ];
}

function tmuxCreatedPaneMarkerLine(paneId: string): string {
  const panePid = `10000000${paneId.slice(1)}`;
  return `    split_command=""; for arg do split_command="$arg"; done
    printf '%s\\n' '${paneId}' >> "$0.created-panes"
    printf '%s\\t%s\\n' '${paneId}' '${panePid}' >> "$0.created-pane-pids"
    printf '%s\\t%s\\n' '${paneId}' "$split_command" >> "$0.created-pane-commands"`;
}


async function configureScaleUpTeamForDirectDispatch(teamName: string, cwd: string): Promise<void> {
  const config = await readTeamConfig(teamName, cwd);
  assert.ok(config);
  if (!config) {
    throw new Error(`missing team config for ${teamName}`);
  }
  config.tmux_session = `omx-team-${teamName}`;
  config.tmux_pane_owner_id = 'team:scale-up';
  config.leader_pane_id = '%11';

  config.tmux_pane_owner_id = 'team:scale-up';
  config.leader_pane_pid = 42411;
  config.workers[0]!.pane_id = '%21';
  config.workers[0]!.pid = 42421;
  await saveTeamConfig(config, cwd);

  const manifestPath = join(cwd, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
  if (!existsSync(manifestPath)) {
    await mkdir(join(cwd, '.omx', 'state', 'team', teamName), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify({ version: 2, policy: {} }, null, 2)}\n`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
  manifest.policy = {
    ...(manifest.policy ?? {}),
    dispatch_mode: 'transport_direct',
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

async function readScaleUpTmuxLogCommands(tmuxLogPath: string): Promise<string[]> {
  const content = await readFile(tmuxLogPath, 'utf-8');
  const trimmed = content.trim();
  return trimmed === '' ? [] : trimmed.split('\n');
}

async function readScaleUpTaskPayloads(teamName: string, cwd: string): Promise<string[]> {
  const tasksDir = join(cwd, '.omx', 'state', 'team', teamName, 'tasks');
  if (!existsSync(tasksDir)) {
    return [];
  }
  const taskFiles = (await readdir(tasksDir)).filter((entry) => entry.endsWith('.json')).sort();
  return await Promise.all(taskFiles.map((entry) => readFile(join(tasksDir, entry), 'utf-8')));
}

async function readExpectedScaleUpApprovedBindingError(
  teamName: string,
  cwd: string,
): Promise<string | null> {
  const continuity = await resolvePersistedApprovedTeamExecutionContinuityState(teamName, cwd);
  if (continuity.status === 'missing') {
    return null;
  }
  if (continuity.status === 'malformed') {
    return `approved_execution_binding_malformed:${teamName}`;
  }
  if (continuity.status === 'ambiguous') {
    return `approved_execution_binding_ambiguous:${continuity.binding.prd_path}:${continuity.binding.task}`;
  }
  if (continuity.status === 'stale') {
    return `approved_execution_binding_stale:${continuity.binding.prd_path}:${continuity.binding.task}`;
  }
  return null;
}

async function prepareScaleUpApprovedBindingState(
  teamName: string,
  cwd: string,
  state: Exclude<ScaleUpApprovedBindingState, 'missing'>,
): Promise<void> {
  if (state === 'malformed') {
    await writeFile(
      join(cwd, '.omx', 'state', 'team', teamName, 'approved-execution.json'),
      '{"prd_path":42}\n',
    );
    return;
  }

  const plansDir = join(cwd, '.omx', 'plans');
  const approvedTask = `Execute ${state} scale-up handoff`;
  const prdPath = join(plansDir, `prd-${state}.md`);
  const testSpecPath = join(plansDir, `test-spec-${state}.md`);
  await mkdir(plansDir, { recursive: true });

  if (state === 'stale') {
    await writePersistedApprovedTeamExecutionBinding(teamName, cwd, {
      prd_path: prdPath,
      task: approvedTask,
      command: `omx team 1:executor "${approvedTask}"`,
    });
    return;
  }

  if (state === 'ambiguous') {
    await writeFile(
      prdPath,
      [
        '# Approved plan',
        '',
        `Launch via omx team 1:executor "${approvedTask}"`,
        `Launch via omx team 2:writer "${approvedTask}"`,
      ].join('\n'),
    );
    await writePersistedApprovedTeamExecutionBinding(teamName, cwd, {
      prd_path: prdPath,
      task: approvedTask,
    });
    return;
  }

  const prdLines = ['# Approved plan', ''];
  if (state === 'incomplete' || state === 'invalid' || state === 'ready') {
    prdLines.push(buildContextPackOutcome(canonicalContextPackRelativePath(state)), '');
  }
  prdLines.push(`Launch via omx team 1:executor "${approvedTask}"`);
  await writeFile(prdPath, prdLines.join('\n'));

  if (state !== 'missing-baseline') {
    await writeFile(testSpecPath, `# ${state} test spec\n`);
  }

  if (state === 'incomplete') {
    await writeContextPack(cwd, state, prdPath, testSpecPath, ['scope']);
  }
  if (state === 'invalid') {
    await writeContextPack(cwd, state, prdPath, testSpecPath, ['scope', 'build', 'verify']);
    await writeFile(testSpecPath, '# invalid drifted test spec\n');
  }
  if (state === 'ready') {
    await writeContextPack(cwd, state, prdPath, testSpecPath, ['scope', 'build', 'verify']);
  }

  await writePersistedApprovedTeamExecutionBinding(teamName, cwd, {
    prd_path: prdPath,
    task: approvedTask,
    command: `omx team 1:executor "${approvedTask}"`,
  });
}

// ── isScalingEnabled ──────────────────────────────────────────────────────────

describe('isScalingEnabled', () => {
  it('returns false when env var is not set', () => {
    assert.equal(isScalingEnabled({}), false);
  });

  it('returns false when env var is empty string', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '' }), false);
  });

  it('returns false when env var is "0"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '0' }), false);
  });

  it('returns false when env var is "false"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'false' }), false);
  });

  it('returns false when env var is "no"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'no' }), false);
  });

  it('returns true when env var is "1"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '1' }), true);
  });

  it('returns true when env var is "true"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'true' }), true);
  });

  it('returns true when env var is "yes"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'yes' }), true);
  });

  it('returns true when env var is "on"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'on' }), true);
  });

  it('returns true when env var is "enabled"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'enabled' }), true);
  });

  it('returns true case-insensitively', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'TRUE' }), true);
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'Yes' }), true);
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'ON' }), true);
  });

  it('returns true with leading/trailing whitespace', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '  1  ' }), true);
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: ' true ' }), true);
  });
});

// ── scale-down cleanup debt path containment ──────────────────────────────────

describe('scale-down cleanup debt path containment', () => {
  const windowsPathSemantics = {
    relative: win32.relative,
    isAbsolute: win32.isAbsolute,
    sep: win32.sep,
  };

  it('accepts same-root and descendant native Windows canonical paths', () => {
    assert.equal(isSameOrInsidePath('C:\\repo', 'C:\\repo', windowsPathSemantics), true);
    assert.equal(isSameOrInsidePath('C:\\repo\\.omx\\team\\alpha', 'C:\\repo', windowsPathSemantics), true);
  });

  it('accepts mixed-separator, drive-letter, and case-equivalent Windows descendants', () => {
    assert.equal(isSameOrInsidePath('c:/REPO/.omx\\team/alpha', 'C:\\repo', windowsPathSemantics), true);
  });

  it('accepts same-share UNC descendants across host and share casing', () => {
    assert.equal(
      isSameOrInsidePath('\\\\SERVER\\Share\\repo/.omx\\team\\alpha', '\\\\server\\share\\REPO', windowsPathSemantics),
      true,
    );
  });

  for (const [name, candidate] of [
    ['a sibling prefix collision', 'C:\\repo-other\\worker'],
    ['a parent traversal escape', 'C:\\repo\\..\\foreign\\worker'],
    ['a foreign same-volume root', 'C:\\foreign\\worker'],
    ['an absolute relative result from a foreign drive', 'D:\\foreign\\worker'],
    ['a foreign UNC host', '\\\\foreign-server\\share\\repo\\worker'],
    ['a foreign UNC share', '\\\\server\\foreign-share\\repo\\worker'],
    ['a UNC sibling prefix collision', '\\\\server\\share\\repo-other\\worker'],
  ] as const) {
    it(`rejects ${name} under native Windows path semantics`, () => {
      assert.equal(isSameOrInsidePath(candidate, 'C:\\repo', windowsPathSemantics), false);
    });
  }

  for (const [name, candidate] of [
    ['a foreign UNC host', '\\\\foreign-server\\share\\repo\\worker'],
    ['a foreign UNC share', '\\\\server\\foreign-share\\repo\\worker'],
    ['a UNC sibling prefix collision', '\\\\server\\share\\repo-other\\worker'],
  ] as const) {
    it(`rejects ${name} under native Windows UNC path semantics`, () => {
      assert.equal(isSameOrInsidePath(candidate, '\\\\server\\share\\repo', windowsPathSemantics), false);
    });
  }

  const posixPathSemantics = {
    relative: posix.relative,
    isAbsolute: posix.isAbsolute,
    sep: posix.sep,
  };

  it('preserves POSIX same-root and descendant containment', () => {
    assert.equal(isSameOrInsidePath('/repo', '/repo', posixPathSemantics), true);
    assert.equal(isSameOrInsidePath('/repo/.omx/team/alpha', '/repo', posixPathSemantics), true);
  });

  it('rejects POSIX siblings, traversal, and foreign roots', () => {
    assert.equal(isSameOrInsidePath('/repo-other/worker', '/repo', posixPathSemantics), false);
    assert.equal(isSameOrInsidePath('/repo/../foreign/worker', '/repo', posixPathSemantics), false);
    assert.equal(isSameOrInsidePath('/foreign/worker', '/repo', posixPathSemantics), false);
  });
});
// ── WorkerStatus draining state ───────────────────────────────────────────────

describe('WorkerStatus draining state', () => {
  it('writeWorkerStatus writes draining status and readWorkerStatus reads it back', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-drain-'));
    try {
      await initTeamState('drain-test', 'task', 'executor', 2, cwd);
      const drainingStatus = {
        state: 'draining' as const,
        reason: 'scale_down requested',
        updated_at: new Date().toISOString(),
      };
      await writeWorkerStatus('drain-test', 'worker-1', drainingStatus, cwd);
      const status = await readWorkerStatus('drain-test', 'worker-1', cwd);
      assert.equal(status.state, 'draining');
      assert.equal(status.reason, 'scale_down requested');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readWorkerStatus returns unknown for non-existent worker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-nw-'));
    try {
      await initTeamState('nw-test', 'task', 'executor', 1, cwd);
      const status = await readWorkerStatus('nw-test', 'worker-99', cwd);
      assert.equal(status.state, 'unknown');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── Monotonic worker index counter ────────────────────────────────────────────

describe('Monotonic worker index counter', () => {
  it('initTeamState sets next_worker_index to workerCount + 1', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-idx-'));
    try {
      const cfg = await initTeamState('idx-test', 'task', 'executor', 3, cwd);
      assert.equal(cfg.next_worker_index, 4);

      // Verify on disk
      const diskCfg = JSON.parse(
        readFileSync(join(cwd, '.omx', 'state', 'team', 'idx-test', 'config.json'), 'utf8'),
      ) as { next_worker_index?: number };
      assert.equal(diskCfg.next_worker_index, 4);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('next_worker_index is present in manifest.v2.json', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-manif-'));
    try {
      await initTeamState('manif-test', 'task', 'executor', 2, cwd);
      const manifest = JSON.parse(
        readFileSync(join(cwd, '.omx', 'state', 'team', 'manif-test', 'manifest.v2.json'), 'utf8'),
      ) as { next_worker_index?: number };
      assert.equal(manifest.next_worker_index, 3);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readTeamConfig preserves next_worker_index', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-read-'));
    try {
      await initTeamState('read-test', 'task', 'executor', 5, cwd);
      const config = await readTeamConfig('read-test', cwd);
      assert.ok(config);
      assert.equal(config.next_worker_index, 6);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── File-based scaling lock ───────────────────────────────────────────────────

describe('withScalingLock', () => {
  it('acquires and releases lock for successful operations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-lock-'));
    try {
      await initTeamState('lock-test', 'task', 'executor', 1, cwd);
      const lockDir = join(cwd, '.omx', 'state', '.team-locks', 'lock-test.scaling');

      const result = await withScalingLock('lock-test', cwd, async () => {
        // Lock should exist during execution
        assert.equal(existsSync(lockDir), true);
        return 42;
      });

      assert.equal(result, 42);
      // Lock should be released after execution
      assert.equal(existsSync(lockDir), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('releases lock even when function throws', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-lock-err-'));
    try {
      await initTeamState('lock-err', 'task', 'executor', 1, cwd);
      const lockDir = join(cwd, '.omx', 'state', '.team-locks', 'lock-err.scaling');

      await assert.rejects(
        withScalingLock('lock-err', cwd, async () => {
          throw new Error('test error');
        }),
        { message: 'test error' },
      );

      // Lock should be released after error
      assert.equal(existsSync(lockDir), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('serializes concurrent operations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-lock-con-'));
    try {
      await initTeamState('lock-con', 'task', 'executor', 1, cwd);
      const order: number[] = [];

      // Launch two operations concurrently - second should wait for first
      const op1 = withScalingLock('lock-con', cwd, async () => {
        order.push(1);
        await new Promise(r => setTimeout(r, 100));
        order.push(2);
        return 'first';
      });

      // Small delay to ensure op1 acquires lock first
      await new Promise(r => setTimeout(r, 10));

      const op2 = withScalingLock('lock-con', cwd, async () => {
        order.push(3);
        return 'second';
      });

      const [r1, r2] = await Promise.all([op1, op2]);
      assert.equal(r1, 'first');
      assert.equal(r2, 'second');
      // First operation should complete (1, 2) before second starts (3)
      assert.deepEqual(order, [1, 2, 3]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── scaleUp / scaleDown error cases ──────────────────────────────────────────

describe('scaleUp', () => {
  it('rejects when scaling is disabled', async () => {
    await assert.rejects(
      scaleUp('test', 1, 'executor', [], '/tmp', {}),
      /Dynamic scaling is disabled/,
    );
  });

  it('returns error for invalid count', async () => {
    const result = await scaleUp(
      'test', 0, 'executor', [], '/tmp',
      { OMX_TEAM_SCALING_ENABLED: '1' },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /count must be a positive integer/);
    }
  });

  it('returns error for negative count', async () => {
    const result = await scaleUp(
      'test', -1, 'executor', [], '/tmp',
      { OMX_TEAM_SCALING_ENABLED: '1' },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /count must be a positive integer/);
    }
  });

  it('returns error when tmux is not available', async () => {
    // Temporarily remove PATH so tmux binary is not found
    const prevPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const result = await scaleUp(
        'test', 1, 'executor', [], '/tmp',
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /tmux is not available/);
      }
    } finally {
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
    }
  });

  it('fails closed before scale-up pane commands for invalid persisted pane identities', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-invalid-panes-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-invalid-panes-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, `#!/bin/sh
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  -V) echo 'tmux 3.2a' ;;
esac
`);
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const cases: Array<{ paneId: string; update: (manifest: Record<string, unknown>) => void }> = [
        { paneId: '%01', update: (manifest) => { manifest.leader_pane_id = '%01'; } },
        { paneId: '%4294967296', update: (manifest) => { manifest.hud_pane_id = '%4294967296'; } },
        {
          paneId: '%18446744073709551616',
          update: (manifest) => {
            (manifest.workers as Array<Record<string, unknown>>)[0]!.pane_id = '%18446744073709551616';
          },
        },
      ];
      for (const [index, testCase] of cases.entries()) {
        const teamName = `scale-up-invalid-pane-${index + 1}`;
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        const manifestPath = join(cwd, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
        testCase.update(manifest);
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
        await writeFile(tmuxLogPath, '');

        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: 'new work', description: 'new work', owner: 'worker-2' }],
          cwd,
          { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
        );
        assert.equal(result.ok, false);
        const commands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        assert.equal(commands.some((command) => command.includes(testCase.paneId)), false);
        assert.equal(commands.some((command) => /^(split-window|set-option|list-panes|kill-pane|send-keys)\b/.test(command)), false);
      }
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('fails closed before scale-up mutations for recycled, unowned, mismatched, or wrong-session panes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-pane-authority-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-pane-authority-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      const cases: Array<{
        name: string;
        workerPaneId: string;
        globalPaneIds: string[];
        sessionRows: Array<[string, 'expected' | 'missing' | 'other']>;
      }> = [
        {
          name: 'missing owner option',
          workerPaneId: '%21',
          globalPaneIds: ['%11', '%21'],
          sessionRows: [['%11', 'expected'], ['%21', 'missing']],
        },
        {
          name: 'mismatched owner option',
          workerPaneId: '%21',
          globalPaneIds: ['%11', '%21'],
          sessionRows: [['%11', 'expected'], ['%21', 'other']],
        },
        {
          name: 'wrong session membership',
          workerPaneId: '%21',
          globalPaneIds: ['%11', '%21'],
          sessionRows: [['%11', 'expected']],
        },
        {
          name: 'recycled unrelated pane',
          workerPaneId: '%30',
          globalPaneIds: ['%11', '%21', '%30'],
          sessionRows: [['%11', 'expected'], ['%21', 'expected']],
        },
      ];
      for (const [index, testCase] of cases.entries()) {
        const globalPaneFormat = testCase.globalPaneIds
          .map((paneId) => `${paneId.replace('%', '%%')} 0 42424\\n`)
          .join('');
        const sessionCommands = testCase.sessionRows.map(([paneId, owner]) => {
          const formatPaneId = paneId.replace('%', '%%');
          if (owner === 'expected') return `        printf '${formatPaneId}\\t%s\\n' "$owner"`;
          if (owner === 'missing') return `        printf '${formatPaneId}\\t\\n'`;
          return `        printf '${formatPaneId}\\tteam:other\\n'`;
        });
        await writeFile(
          tmuxStubPath,
          [
            '#!/bin/sh',
            `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
            'case "${1:-}" in',
            '  -V)',
            '    echo "tmux 3.2a"',
            '    ;;',
            '  list-panes)',
            '    case "${2:-}" in',
            `      -a) printf "${globalPaneFormat}" ;;`,
            '      -t)',
            '        session="${3:-}"',
            '        owner="team:${session#omx-team-}"',
            ...sessionCommands,
            '        ;;',
            '    esac',
            '    ;;',
            'esac',
            '',
          ].join('\n'),
        );
        await chmod(tmuxStubPath, 0o755);
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

        const teamName = `scale-up-pane-authority-${index + 1}`;
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);
        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) throw new Error(`missing team config for ${teamName}`);
        config.workers[0]!.pane_id = testCase.workerPaneId;
        await saveTeamConfig(config, cwd);
        await writeFile(tmuxLogPath, '');

        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: 'new work', description: 'new work', owner: 'worker-2' }],
          cwd,
          { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
        );
        assert.deepEqual(result, { ok: false, error: 'failed_to_validate_team_tmux_pane_authority' }, testCase.name);
        assert.deepEqual(await readScaleUpTaskPayloads(teamName, cwd), [], testCase.name);
        const commands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        assert.ok(commands.includes('list-panes -a -F #{pane_id} #{pane_dead} #{pane_pid}'), testCase.name);
        assert.ok(commands.some((command) => command.startsWith('list-panes -t omx-team-')), testCase.name);
        assert.equal(commands.some((command) => /^(split-window|set-option|send-keys|kill-pane)\b/.test(command)), false, testCase.name);
      }
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('scales up through verified live Team-owned pane authority', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-owned-panes-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-owned-panes-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('scale-up-owned-panes', 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch('scale-up-owned-panes', cwd);

      const result = await scaleUp(
        'scale-up-owned-panes',
        1,
        'executor',
        [{ subject: 'new work', description: 'new work', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      const commands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.ok(commands.some((command) => command.startsWith('list-panes -t omx-team-scale-up-owned-panes ')));
      assert.ok(commands.some((command) => command.startsWith('split-window -v -t %21 ')));
      assert.ok(commands.includes('set-option -p -t %31 @omx_team_pane_owner_id team:scale-up-owned-panes'));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous, noncanonical, and colliding fresh split output before pane authority', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-fresh-pane-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-fresh-pane-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      const cases = [
        { name: 'multiline output', output: ['%31', '%32'] },
        { name: 'duplicate output', output: ['%31', '%31'] },
        { name: 'leading-zero output', output: ['%01'] },
        { name: '32-bit overflow output', output: ['%4294967296'] },
        { name: 'large overflow output', output: ['%18446744073709551616'] },
        { name: 'leader collision', output: ['%11'] },
        { name: 'HUD collision', output: ['%12'] },
        { name: 'worker collision', output: ['%21'] },
        { name: 'unrelated pre-existing pane', output: ['%30'] },
      ];
      for (const [index, testCase] of cases.entries()) {
        await rm(`${tmuxStubPath}.created-panes`, { force: true });
        await rm(`${tmuxStubPath}.created-pane-commands`, { force: true });
        await rm(`${tmuxStubPath}.created-pane-pids`, { force: true });
        await rm(tmuxStubPath, { force: true });
        await writeFile(
          tmuxStubPath,
          [
            '#!/bin/sh',
            `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
            'case "${1:-}" in',
            '  -V)',
            '    echo "tmux 3.2a"',
            '    ;;',
            '  split-window)',
            testCase.output.length === 2
              ? `    { printf '%s\\n' '${testCase.output[0]}'; printf '%s\\n' '${testCase.output[1]}'; } | tee "$0.split-output"`
              : `    printf '%s\\n' '${testCase.output[0]}' | tee "$0.split-output"`,
            tmuxCreatedPaneMarkerLine('%31'),

            '    ;;',
            ...tmuxAuthorityListPanesCase(['%11', '%21', '%12', '%30']),
            'esac',
            '',
          ].join('\n'),
        );
        await chmod(tmuxStubPath, 0o755);
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
        const teamName = `scale-up-fresh-pane-${index + 1}`;
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);
        if (testCase.name === 'HUD collision') {
          const collisionConfig = await readTeamConfig(teamName, cwd);
          assert.ok(collisionConfig);
          if (!collisionConfig) throw new Error(`missing team config for ${teamName}`);
          collisionConfig.hud_pane_id = '%12';
          await saveTeamConfig(collisionConfig, cwd);
        }
        await writeFile(tmuxLogPath, '');

        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: 'new work', description: 'new work', owner: 'worker-2' }],
          cwd,
          { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
        );
        if (testCase.name === 'multiline output') {
          assert.equal(await readFile(`${tmuxStubPath}.split-output`, 'utf-8'), '%31\n%32\n');
        }
        assert.equal(result.ok, false, testCase.name);
        const config = await readTeamConfig(teamName, cwd);
        assert.equal(config?.workers.length, 1, testCase.name);
        const commands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        assert.ok(commands.some((command) => command === 'list-panes -a -F #{pane_id} #{pane_dead} #{pane_pid}'), testCase.name);
        assert.ok(commands.some((command) => command.startsWith('list-panes -t omx-team-')), testCase.name);
        assert.ok(commands.some((command) => command.startsWith('split-window -v -t %21 ')), testCase.name);
        assert.equal(commands.some((command) => command === 'kill-pane -t %11' || command === 'kill-pane -t %12' || command === 'kill-pane -t %21' || command === 'kill-pane -t %30'), false, testCase.name);
        assert.equal(commands.some((command) => /^kill-pane\b/.test(command)), false, testCase.name);
        assert.equal(
          commands.some((command) => command !== '-V'
            && command !== 'list-panes -a -F #{pane_id} #{pane_dead} #{pane_pid}'
            && command !== 'list-panes -a -F #{pane_id}\t#{pane_start_command}'
            && command !== 'display-message -p -t %31 #{session_id}'
            && !command.startsWith('list-panes -t omx-team-')
            && !command.startsWith('set-option -g @omx_scale_split_owner_nonce_')
            && !command.startsWith('show-options -g -v @omx_scale_split_owner_nonce_')
            && !command.startsWith('split-window -v -t %21 ')
            && !command.startsWith('if-shell -F -t %31 ')),
          false,
          testCase.name,
        );
      }
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('rejects explicit mixed worker policy before scale-up creates worker state or a pane', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-explicit-policy-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-explicit-policy-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, `#!/bin/sh
printf '%s\n' "$*" >> "${tmuxLogPath}"
exit 0
`);
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('scale-up-explicit-policy', 'task', 'executor', 1, cwd);

      const result = await scaleUp(
        'scale-up-explicit-policy',
        1,
        'executor',
        [{ subject: 'new task', description: 'new task', owner: 'worker-2' }],
        cwd,
        {
          OMX_TEAM_SCALING_ENABLED: '1',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--dangerously-bypass-approvals-and-sandbox --sandbox workspace-write',
        },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /Invalid OMX_TEAM_WORKER_LAUNCH_ARGS: bypass cannot be combined with direct approval or sandbox policy/);
      }
      const config = await readTeamConfig('scale-up-explicit-policy', cwd);
      assert.equal(config?.workers.length, 1);
      assert.equal(config?.next_worker_index, 2);
      assert.deepEqual(await readScaleUpTaskPayloads('scale-up-explicit-policy', cwd), []);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'scale-up-explicit-policy', 'workers', 'worker-2')), false);
      assert.equal(existsSync(workerStartupScriptPath(cwd, 'scale-up-explicit-policy', 'worker-2')), false);
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ')), false);
      assert.equal(tmuxCommands.some((command) => command.startsWith('send-keys ')), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('rejects Claude and Gemini restrictive config policy before scale-up creates task payloads, worker state, a pane, or process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-restrictive-noncodex-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-restrictive-noncodex-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, `#!/bin/sh
printf '%s\n' "$*" >> "${tmuxLogPath}"
exit 0
`);
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      for (const workerCli of ['claude', 'gemini'] as const) {
        const teamName = `scale-up-restrictive-${workerCli}`;
        await writeFile(tmuxLogPath, '');
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: 'new task', description: 'new task', owner: 'worker-2' }],
          cwd,
          {
            OMX_TEAM_SCALING_ENABLED: '1',
            OMX_TEAM_WORKER_CLI: workerCli,
            OMX_TEAM_WORKER_LAUNCH_ARGS: `--config 'sandbox_mode="workspace-write"'`,
          },
        );
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.match(result.error, new RegExp(`Selected team worker CLI "${workerCli}" is incompatible with an explicit approval or sandbox policy\\.`));
        }
        const config = await readTeamConfig(teamName, cwd);
        assert.equal(config?.workers.length, 1);
        assert.equal(config?.next_worker_index, 2);
        assert.deepEqual(await readScaleUpTaskPayloads(teamName, cwd), []);
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2')), false);
        assert.equal(existsSync(workerStartupScriptPath(cwd, teamName, 'worker-2')), false);
        const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ')), false);
        assert.equal(tmuxCommands.some((command) => command.startsWith('send-keys ')), false);
      }
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });


  it('persists scaled-up task roles in canonical task state and inbox ids', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-role-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-role-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '\%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  show-option) echo "team:scale-up-role" ;;',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%31"',
          tmuxCreatedPaneMarkerLine('%31'),
          '    ;;',
          ...tmuxAuthorityListPanesCase(['%11', '%21']),
          '  send-keys)',
          '    ;;',
          '  kill-pane)',
          `    : > "${join(fakeBinDir, 'scale-up-role-killed-')}$3"`,
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'scale-up-role'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'worker-agents.md'), '# Base worker instructions\n');

      await initTeamState('scale-up-role', 'task', 'executor', 1, cwd);
      await createTask('scale-up-role', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('scale-up-role', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-scale-up-role';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up-role';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'scale-up-role',
        1,
        'executor',
        [{ subject: 'document routing report only', description: 'document routing report only', owner: 'worker-2', role: 'writer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },


      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const createdTask = await readTask('scale-up-role', '2', cwd);
      assert.equal(createdTask?.role, 'writer');
      assert.equal(createdTask?.owner, 'worker-2');

      const workerIdentity = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'workers', 'worker-2', 'identity.json'), 'utf-8')) as { role?: string };
      assert.equal(workerIdentity.role, 'writer');

      const inbox = await readFile(join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'workers', 'worker-2', 'inbox.md'), 'utf-8');
      assert.match(inbox, /Task 2/);
      assert.match(inbox, /Role: writer/);

      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.ok(tmuxCommands.some((command) => (
        command === 'set-option -p -t %31 @omx_team_pane_owner_id team:scale-up-role'
      )));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('covers the scale-up config-policy and no-policy argv matrix', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-policy-matrix-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-policy-matrix-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const capturePath = join(cwd, 'worker-argv.txt');
    const emptyCodexHome = await mkdtemp(join(tmpdir(), 'omx-scale-up-policy-matrix-codex-home-'));
    const previousPath = process.env.PATH;
    const previousArgv = process.argv;
    const previousBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      await writeFile(
        join(fakeBinDir, 'codex'),
        `#!/bin/sh
printf '%s\\n' "$@" > '${capturePath}'
`,
      );
      await chmod(join(fakeBinDir, 'codex'), 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';

      const runScaleUpCase = async (params: {
        teamName: string;
        role?: string;
        launchArgs: string;
        inheritedModel?: string;
      }): Promise<string[]> => {
        await writeFile(capturePath, '');
        await initTeamState(params.teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(params.teamName, cwd);
        const result = await scaleUp(
          params.teamName,
          1,
          'executor',
          [{
            subject: 'implement task',
            description: 'implement task',
            owner: 'worker-2',
            ...(params.role === undefined ? {} : { role: params.role }),
          }],
          cwd,
          {
            OMX_TEAM_SCALING_ENABLED: '1',
            OMX_TEAM_SKIP_READY_WAIT: '1',
            CODEX_HOME: emptyCodexHome,
            OMX_TEAM_WORKER_LAUNCH_ARGS: params.launchArgs,
            ...(params.inheritedModel ? { [TEAM_WORKER_INHERITED_MODEL_ENV]: params.inheritedModel } : {}),
          },
        );
        if (!result.ok) assert.fail(result.error);

        const startupScriptPath = workerStartupScriptPath(cwd, params.teamName, 'worker-2');
        const scriptResult = execFileSync('/bin/sh', [startupScriptPath], { encoding: 'utf-8' });
        assert.equal(scriptResult, '');
        return (await readFile(capturePath, 'utf-8')).trim().split('\n');
      };

      process.argv = [
        ...previousArgv.filter((arg) => arg !== '--dangerously-bypass-approvals-and-sandbox' && arg !== '--madmax'),
        '--madmax',
      ];
      const sandboxArgs = await runScaleUpCase({
        teamName: 'scale-up-sandbox-policy',
        role: 'executor',
        launchArgs: String.raw`--config 'sandbox_mode="workspace-write"' -- 'C:\scale-up\nested\' '--sandbox=read-only' '--madmax'`,
        inheritedModel: 'leader-model',
      });
      const expectedSandboxArgs = [
        '--sandbox', 'workspace-write',
        '-c', 'model_reasoning_effort="medium"',
        '--model', 'leader-model',
        '--', 'C:\\scale-up\\nested\\', '--sandbox=read-only', '--madmax',
      ];
      assert.deepEqual(sandboxArgs, expectedSandboxArgs);
      assert.deepEqual(
        buildWorkerProcessLaunchSpec(
          'initial-policy-team',
          1,
          expectedSandboxArgs,
          cwd,
          { CODEX_HOME: emptyCodexHome },
          'codex',
          undefined,
          'executor',
        ).args,
        sandboxArgs,
      );

      const approvalArgs = await runScaleUpCase({
        teamName: 'scale-up-approval-policy',
        role: 'executor',
        launchArgs: '--ask-for-approval=on-request',
        inheritedModel: 'leader-model',
      });
      assert.deepEqual(approvalArgs, [
        '--ask-for-approval', 'on-request',
        '-c', 'model_reasoning_effort="medium"',
        '--model', 'leader-model',
      ]);

      process.argv = previousArgv.filter((arg) => arg !== '--dangerously-bypass-approvals-and-sandbox' && arg !== '--madmax');
      const bypass = '--dangerously-bypass-approvals-and-sandbox';
      assert.deepEqual(
        await runScaleUpCase({ teamName: 'scale-up-execution-default', role: 'executor', launchArgs: '--model policy-model' }),
        ['-c', 'model_reasoning_effort="medium"', '--model', 'policy-model', bypass],
      );
      assert.deepEqual(
        await runScaleUpCase({ teamName: 'scale-up-nonexecution-default', role: 'explore', launchArgs: '--model policy-model' }),
        ['-c', 'model_reasoning_effort="low"', '--model', 'policy-model'],
      );
      assert.deepEqual(
        await runScaleUpCase({ teamName: 'scale-up-absent-role-default', launchArgs: '--model policy-model' }),
        ['-c', 'model_reasoning_effort="medium"', '--model', 'policy-model', bypass],
      );
      assert.deepEqual(
        await runScaleUpCase({ teamName: 'scale-up-unknown-role-default', role: 'unknown-role', launchArgs: '--model policy-model' }),
        ['-c', 'model_reasoning_effort="medium"', '--model', 'policy-model', bypass],
      );
    } finally {
      process.argv = previousArgv;
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = previousBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      await rm(emptyCodexHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('persists a newly created worker when rollback pane proof is unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-owner-tag-rollback-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-owner-tag-rollback-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const previousBridge = process.env.OMX_RUNTIME_BRIDGE;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  show-option) echo "team:scale-up-owner-tag-rollback" ;;',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%31"',
          tmuxCreatedPaneMarkerLine('%31'),
          '    ;;',
          '  set-option)',
          '    case "$*" in',
          '      *"@omx_team_pane_owner_id"*)',
          '        echo "owner tag failed" >&2',
          '        exit 1',
          '        ;;',
          '      "set-option -g "*) printf "%s" "${4:-}" > "$0.option-${3:-}" ;;',
          '    esac',
          '    ;;',
          '  show-options) cat "$0.option-${4:-}"; printf "\\n" ;;',
          '  display-message)',
          "    case \"$*\" in *'#{session_id}') printf '$1\\n' ;; esac",
          '    ;;',
          '  if-shell)',
          "    success=\"${6:-}\"; receipt=\"${success##*display-message -p }\"; receipt=\"${receipt%% *}\"; case \"$receipt\" in __OMX_PANE_MUTATION_[a-f0-9]*__) printf '%s\\n' \"$receipt\" ;; esac",
          '    ;;',

          ...tmuxAuthorityListPanesCase(['%11', '%21']),
          '  kill-pane|send-keys|capture-pane)',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      process.env.OMX_RUNTIME_BRIDGE = '0';

      await initTeamState('scale-up-owner-tag-rollback', 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch('scale-up-owner-tag-rollback', cwd);
      const ownerConfig = await readTeamConfig('scale-up-owner-tag-rollback', cwd);
      assert.ok(ownerConfig);
      if (!ownerConfig) return;
      ownerConfig.tmux_pane_owner_id = 'team:scale-up-owner-tag-rollback';
      await saveTeamConfig(ownerConfig, cwd);

      const result = await scaleUp(
        'scale-up-owner-tag-rollback',
        1,
        'executor',
        [{ subject: 'new work', description: 'new work', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /scale_up_rollback_cleanup_debt:pane_owner_unverified:%31/);

      const config = await readTeamConfig('scale-up-owner-tag-rollback', cwd);
      assert.deepEqual(config?.workers.map((worker) => worker.name), ['worker-1', 'worker-2']);
      assert.equal(config?.workers[1]?.pane_id, '%31');
      assert.equal(config?.next_worker_index, 3);
      assert.equal((await readTask('scale-up-owner-tag-rollback', '1', cwd))?.owner, 'worker-2');
      assert.equal(existsSync(
        join(cwd, '.omx', 'state', 'team', 'scale-up-owner-tag-rollback', 'workers', 'worker-2', 'identity.json'),
      ), false);
      assert.equal(existsSync(
        join(cwd, '.omx', 'state', 'team', 'scale-up-owner-tag-rollback', 'workers', 'worker-2', 'inbox.md'),
      ), false);
      const dispatch = JSON.parse(await readFile(
        join(cwd, '.omx', 'state', 'team', 'scale-up-owner-tag-rollback', 'dispatch', 'requests.json'),
        'utf8',
      )) as Array<{ to_worker?: string }>;
      assert.equal(dispatch.some((request) => request.to_worker === 'worker-2'), false);
      assert.equal((await listDispatchRequests('scale-up-owner-tag-rollback', cwd, { to_worker: 'worker-2' })).length, 0);

      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.ok(tmuxCommands.some((command) => (
        command === 'set-option -p -t %31 @omx_team_pane_owner_id team:scale-up-owner-tag-rollback'
      )));
      assert.ok(tmuxCommands.some((command) => command.startsWith('if-shell -F -t %31 ')));
      assert.equal(tmuxCommands.some((command) => /^kill-pane\b/.test(command)), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });


  it('uses a server-side rollback transaction that rejects final-boundary pane recycling and malformed receipts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-atomic-rollback-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-atomic-rollback-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const unrelatedKillPath = join(fakeBinDir, 'unrelated-killed');
    const previousPath = process.env.PATH;

    try {
      for (const [receiptIndex, receiptMode] of (['exact', 'missing-lf', 'crlf', 'extra-line', 'recycled-at-transaction'] as const).entries()) {
        await Promise.all([
          rm(`${tmuxStubPath}.created-panes`, { force: true }),
          rm(`${tmuxStubPath}.created-pane-pids`, { force: true }),
          rm(`${tmuxStubPath}.created-pane-commands`, { force: true }),
          rm(`${tmuxStubPath}.owner-tagged`, { force: true }),
        ]);
        await writeFile(
          tmuxStubPath,
          [
            '#!/bin/sh',
            'set -eu',
            `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
            'case "${1:-}" in',
            '  -V) echo "tmux 3.2a" ;;',
            '  split-window)',
            '    echo "%31"',
            tmuxCreatedPaneMarkerLine('%31'),
            '    ;;',
            '  set-option)',
            '    case "${2:-}" in',
            '      -g) printf "%s" "${4:-}" > "$0.option-${3:-}" ;;',
            '      -p) echo "owner tag failed" >&2; exit 1 ;;',
            '    esac',
            '    ;;',
            '  show-options) cat "$0.option-${4:-}"; printf "\\n" ;;',
            "  display-message) case \"$*\" in *'#{session_id}') printf '$1\\n' ;; esac ;;",
            '  if-shell)',
            '    success="${6:-}"; receipt="${success##*display-message -p }"; receipt="${receipt%% *}"',
            '    case "$success" in',
            '      *"kill-pane -t %31"*)',
            receiptMode === 'exact'
              ? '        printf "%s\\n" "$receipt" ;;'
              : receiptMode === 'missing-lf'
                ? '        printf "%s" "$receipt" ;;'
                : receiptMode === 'crlf'
                  ? '        printf "%s\\r\\n" "$receipt" ;;'
                  : receiptMode === 'extra-line'
                    ? '        printf "%s\\nextra\\n" "$receipt" ;;'
                    : '        printf "%s\\n" "__omx_scale_split_rollback_rejected_${receipt}" ;;',
            '    esac',
            '    ;;',
            ...tmuxAuthorityListPanesCase(['%11', '%21']),
            `  kill-pane) : > "${unrelatedKillPath}" ;;`,
            'esac',
            'exit 0',
            '',
          ].join('\n'),
        );
        await chmod(tmuxStubPath, 0o755);
        await writeFile(tmuxLogPath, '');
        await rm(unrelatedKillPath, { force: true });
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

        const teamName = `scale-rb-${receiptIndex}`;
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);
        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: 'new work', description: 'new work', owner: 'worker-2' }],
          cwd,
          { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
        );

        assert.equal(result.ok, false, `${receiptMode}: ${JSON.stringify(result)}`);
        assert.equal(existsSync(unrelatedKillPath), false, receiptMode);
        const commands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        const rollback = commands.find((command) => command.startsWith('if-shell -F -t %31 '));
        assert.ok(rollback, `${receiptMode}: ${JSON.stringify(result)}\n${commands.join('\n')}`);
        assert.match(rollback, /#\{==:#\{pane_id\},%31\}/, receiptMode);
        assert.match(rollback, /#\{==:#\{pane_pid\},1000000031\}/, receiptMode);
        assert.match(rollback, /#\{==:#\{session_id\},\$1\}/, receiptMode);
        assert.match(rollback, /@omx_scale_split_owner_nonce_[a-f0-9]{32}/, receiptMode);
        assert.match(rollback, /kill-pane -t %31 \\; display-message -p __OMX_PANE_MUTATION_[a-f0-9]{32}__/, receiptMode);
        assert.equal(commands.some((command) => command === 'kill-pane -t %31'), false, receiptMode);
      }
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('rolls back a worker that dies after its initial scale-up liveness probe', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-dead-worker-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-dead-worker-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath, true);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('scale-up-dead-worker', 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch('scale-up-dead-worker', cwd);
      const result = await scaleUp(
        'scale-up-dead-worker', 1, 'executor',
        [{ subject: 'new work', description: 'new work', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /sustained tmux pane authority/);
      assert.equal((await readTeamConfig('scale-up-dead-worker', cwd))?.workers.length, 1);
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.equal(tmuxCommands.includes('kill-pane -t %31'), false, tmuxCommands.join('\n'));
      assert.ok(!tmuxCommands.includes('kill-pane -t %11'));
      assert.ok(!tmuxCommands.includes('kill-pane -t %21'));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('recovers a marker-bound pane after a malformed first post-split snapshot', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-marker-recovery-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-marker-recovery-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath, false, { malformedFirstPostSplitSnapshot: true });
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('scale-up-marker-recovery', 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch('scale-up-marker-recovery', cwd);
      const result = await scaleUp(
        'scale-up-marker-recovery', 1, 'executor',
        [{ subject: 'new work', description: 'new work', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      const commands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.ok(commands.filter((command) => command === 'list-panes -a -F #{pane_id} #{pane_dead} #{pane_pid}').length >= 4);
      assert.ok(commands.some((command) => command === 'list-panes -a -F #{pane_id}\t#{pane_start_command}'));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('refuses to kill a same-ID pane after its operation marker is recycled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-marker-recycle-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-marker-recycle-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath, false, { recycleOperationMarker: true });
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('scale-up-marker-recycle', 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch('scale-up-marker-recycle', cwd);
      const result = await scaleUp(
        'scale-up-marker-recycle', 1, 'executor',
        [{ subject: 'new work', description: 'new work', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, false);
      const commands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.equal(commands.includes('kill-pane -t %31'), false, commands.join('\n'));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('rejects an atomic liveness batch with a duplicate dead authority row', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-malformed-liveness-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-malformed-liveness-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath, false, { malformedLivenessBatch: true });
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('scale-up-malformed-liveness', 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch('scale-up-malformed-liveness', cwd);
      const result = await scaleUp(
        'scale-up-malformed-liveness', 1, 'executor',
        [{ subject: 'new work', description: 'new work', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, false);
      const commands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.ok(commands.includes('list-panes -a -F #{pane_id} #{pane_dead} #{pane_pid}'), commands.join('\n'));
      assert.equal(commands.includes('kill-pane -t %31'), false, commands.join('\n'));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a verified split PID is recycled during readiness, dispatch, or pre-save', async () => {
    const cases = [
      { phase: 'readiness', recyclePidAtLivenessProbe: 11, readyCapture: true, skipReadyWait: false, expectDispatch: false },
      { phase: 'dispatch', recyclePidAtLivenessProbe: 11, readyCapture: false, skipReadyWait: true, expectDispatch: false },
      { phase: 'pre-save', recyclePidAtLivenessProbe: 60, readyCapture: false, skipReadyWait: true, expectDispatch: true },
    ] as const;

    for (const testCase of cases) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-scale-up-pid-recycle-${testCase.phase}-`));
      const fakeBinDir = await mkdtemp(join(tmpdir(), `omx-scale-up-pid-recycle-${testCase.phase}-bin-`));
      const tmuxLogPath = join(fakeBinDir, 'tmux.log');
      const previousPath = process.env.PATH;
      try {
        await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath, false, testCase);
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
        const teamName = `scale-up-pid-recycle-${testCase.phase}`;
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);

        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: 'new work', description: 'new work', owner: 'worker-2' }],
          cwd,
          {
            OMX_TEAM_SCALING_ENABLED: '1',
            ...(testCase.skipReadyWait ? { OMX_TEAM_SKIP_READY_WAIT: '1' } : {}),
          },
        );
        assert.equal(result.ok, false, testCase.phase);
        const config = await readTeamConfig(teamName, cwd);
        assert.equal(config?.workers.length, 1, testCase.phase);
        const commands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        assert.equal(commands.some((command) => command.startsWith('kill-pane -t %31')), false, commands.join('\n'));
        assert.equal(commands.some((command) => command.startsWith('if-shell -F -t %31 ') && command.includes('#{==:#{pane_id},%31}') && command.includes('#{==:#{pane_dead},0}') && command.includes('#{==:#{pane_pid},1000000031}') && command.includes('#{==:#{session_id},$1}') && command.includes('@omx_scale_split_owner_nonce_') && command.includes('paste-buffer -d -b omx-send-') && command.includes('display-message -p __OMX_SEND_AUTHORITY_')), testCase.expectDispatch, commands.join('\n'));
        assert.ok(commands.some((command) => command.startsWith('if-shell -F -t %31 ') && command.includes('#{m:*') && command.includes('kill-pane -t %31 \\; display-message -p __OMX_PANE_MUTATION_')), commands.join('\n'));
        assert.equal(
          existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'identity.json')),
          false,
          testCase.phase,
        );
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    }
  });

  it('injects persisted leader-owned Ultragoal context into scaled worker inboxes', async () => {
    const teamName = 'scale-up-ultragoal-context';
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-ultragoal-context-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-ultragoal-context-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;

    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState(teamName, 'ultragoal scale-up test', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const teamStateRoot = resolveCanonicalTeamStateRoot(cwd);
      await mkdir(join(teamStateRoot, 'team', teamName), { recursive: true });
      await writeFile(
        join(teamStateRoot, 'team', teamName, 'ultragoal-context.json'),
        `${JSON.stringify({
          kind: 'leader_owned_ultragoal_context',
          goalsPath: '.omx/ultragoal/goals.json',
          ledgerPath: '.omx/ultragoal/ledger.jsonl',
          activeGoalId: 'G001-team-runtime-bridge',
          activeGoalTitle: 'Team runtime bridge',
          codexGoalMode: 'aggregate',
          checkpointPolicy: 'fresh_leader_get_goal_required',
        })}\n`,
      );

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'Implement ultragoal follow-up', description: 'Implement ultragoal follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inboxStateRoot = result.addedWorkers[0]?.team_state_root ?? resolveCanonicalTeamStateRoot(cwd);
      const inbox = await readFile(
        join(inboxStateRoot, 'team', teamName, 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.match(inbox, /Implement ultragoal follow-up/);
      assert.match(inbox, /### Leader-owned Ultragoal context/);
      assert.match(inbox, /G001-team-runtime-bridge/);
      assert.match(inbox, /workers do not own Ultragoal goal state/i);
      assert.match(inbox, /omx ultragoal checkpoint --goal-id G001-team-runtime-bridge/);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('keeps scale-up on the generic path when no approved binding is persisted', async () => {
    const teamName = 'scale-up-no-approved-binding';
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-no-approved-binding-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-no-approved-binding-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;

    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState(teamName, 'generic scale-up test', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);

      assert.equal(await readExpectedScaleUpApprovedBindingError(teamName, cwd), null);

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'Implement generic follow-up', description: 'Implement generic follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.match(inbox, /Implement generic follow-up/);
      assert.doesNotMatch(inbox, /## Approved Handoff Context/);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('injects approved handoff context on scale-up when the persisted binding is baseline-ready without context-pack metadata', async () => {
    const teamName = 'scale-up-plan-only';
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-plan-only-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-plan-only-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;

    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState(teamName, 'plan-only scale-up test', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      await prepareScaleUpApprovedBindingState(teamName, cwd, 'plan-only');

      assert.equal(await readExpectedScaleUpApprovedBindingError(teamName, cwd), null);

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'Implement plan-only follow-up', description: 'Implement plan-only follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.match(inbox, /Implement plan-only follow-up/);
      assert.match(inbox, /## Approved Handoff Context/);
      assert.match(inbox, /Use the approved plan and matching test specs as the execution baseline/);
      assert.doesNotMatch(inbox, /Approved context pack|Context pack index/);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('injects approved handoff context into scaled worker inboxes when the persisted binding stays ready', async () => {
    const teamName = 'scale-up-approved-context';
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-approved-context-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-approved-context-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    const approvedTask = 'Execute approved issue 1410 plan';

    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState(teamName, 'approved scale-up test', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);

      const plansDir = join(cwd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const prdPath = join(plansDir, 'prd-issue-1410.md');
      const testSpecPath = join(plansDir, 'test-spec-issue-1410.md');
      await writeFile(
        prdPath,
        [
          '# Approved plan',
          '',
          buildContextPackOutcome(canonicalContextPackRelativePath('issue-1410')),
          '',
          `Launch via omx team 1:executor "${approvedTask}"`,
        ].join('\n'),
      );
      await writeFile(testSpecPath, '# Test spec\n');
      await writeReadyContextPack(cwd, 'issue-1410', prdPath, testSpecPath);
      await writeFile(
        join(plansDir, 'repo-context-issue-1410.md'),
        'Read the approved repository slice first.\n',
      );
      await writePersistedApprovedTeamExecutionBinding(teamName, cwd, {
        prd_path: prdPath,
        task: approvedTask,
        command: `omx team 1:executor "${approvedTask}"`,
      });

      assert.equal(await readExpectedScaleUpApprovedBindingError(teamName, cwd), null);

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'Implement approved follow-up', description: 'Implement approved follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.match(inbox, /## Approved Handoff Context/);
      assert.ok(inbox.includes(`Approved plan: ${prdPath}`));
      assert.ok(inbox.includes(`Test specs: ${testSpecPath}`));
      assert.match(inbox, /Approved repository context summary source: .*repo-context-issue-1410\.md/);
      assert.match(inbox, /Read the approved repository slice first\./);
      assert.match(inbox, /Use the approved plan and matching test specs as the execution baseline/);
      assert.doesNotMatch(inbox, /Approved context pack|Build refs|Verify refs|Scope refs|query the canonical pack|Context pack index/);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('proves the approved-binding scale-up model across generated state/count scenarios, including forbidden counterfactuals', async () => {
    for (const state of SCALE_UP_APPROVED_BINDING_STATES) {
      for (const count of SCALE_UP_COUNTS) {
        const teamName = `su-model-${SCALE_UP_STATE_TEAM_SUFFIX[state]}-${count}`;
        const cwd = await mkdtemp(join(tmpdir(), `omx-scale-up-model-${state}-${count}-`));
        const fakeBinDir = await mkdtemp(join(tmpdir(), `omx-scale-up-model-${state}-${count}-bin-`));
        const tmuxLogPath = join(fakeBinDir, 'tmux.log');
        const previousPath = process.env.PATH;

        try {
          await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
          process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

          await initTeamState(teamName, `approved ${state} scale-up model`, 'executor', 1, cwd);
          await configureScaleUpTeamForDirectDispatch(teamName, cwd);

          if (state !== 'missing') {
            await prepareScaleUpApprovedBindingState(teamName, cwd, state);
          }

          const expectedOutcome = expectedScaleUpOutcome(state);
          const expectedError = await readExpectedScaleUpApprovedBindingError(teamName, cwd);
          const tasks = buildScaleUpScenarioTasks(state, count);

          const result = await scaleUp(
            teamName,
            count,
            'executor',
            tasks,
            cwd,
            { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
          );
          const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
          const splitWindowCommands = tmuxCommands.filter((command) => command.startsWith('split-window '));
          const inboxes = await Promise.all(tasks.map(async (task) => {
            const inboxPath = join(
              cwd,
              '.omx',
              'state',
              'team',
              teamName,
              'workers',
              task.owner,
              'inbox.md',
            );
            return existsSync(inboxPath)
              ? await readFile(inboxPath, 'utf-8')
              : null;
          }));
          const approvedInboxCount = inboxes.filter((inbox) =>
            typeof inbox === 'string' && inbox.includes('## Approved Handoff Context')
          ).length;
          assert.ok(
            approvedInboxCount === 0 || approvedInboxCount === tasks.length,
            `expected approved handoff context presence to stay consistent across all scaled workers (state=${state} count=${count})`,
          );
          const observedOutcome: ScaleUpObservedOutcome = !result.ok
            ? 'blocked'
            : approvedInboxCount === tasks.length
              ? 'approved'
              : 'generic';
          const taskPayloads = await readScaleUpTaskPayloads(teamName, cwd);

          assert.equal(observedOutcome, expectedOutcome, `state=${state} count=${count}`);
          assert.equal(
            forbiddenScaleUpOutcomes(state).includes(observedOutcome),
            false,
            `state=${state} count=${count} produced forbidden counterfactual outcome ${observedOutcome}`,
          );
          if (expectedOutcome === 'blocked') {
            assert.equal(result.ok, false);
            if (result.ok) {
              throw new Error(`expected blocked scale-up outcome for ${state} count=${count}`);
            }
            assert.equal(result.error, expectedError);
            assert.deepEqual(tmuxCommands, ['-V']);
            assert.deepEqual(splitWindowCommands, []);
            assert.ok(inboxes.every((inbox) => inbox === null));
            assert.equal(
              taskPayloads.some((payload) => tasks.some((task) => payload.includes(task.subject))),
              false,
            );

            const config = await readTeamConfig(teamName, cwd);
            assert.ok(config);
            if (!config) {
              throw new Error(`missing team config for ${teamName}`);
            }
            assert.equal(config.workers.length, 1);
            assert.equal(config.worker_count, 1);
            assert.equal(config.next_worker_index, 2);
            continue;
          }

          assert.equal(result.ok, true);
          if (!result.ok) {
            throw new Error(`expected successful scale-up outcome for ${state} count=${count}`);
          }
          assert.equal(result.newWorkerCount, 1 + count);
          assert.equal(result.nextWorkerIndex, 2 + count);
          assert.equal(splitWindowCommands.length, count);
          assert.equal(expectedError, null);
          assert.ok(inboxes.every((inbox): inbox is string => typeof inbox === 'string'));

          for (const [index, inbox] of inboxes.entries()) {
            const task = tasks[index]!;
            assert.ok(inbox.includes(task.subject), `expected inbox to include task subject ${task.subject}`);
          }
          assert.equal(
            taskPayloads.filter((payload) => tasks.some((task) => payload.includes(task.subject))).length,
            count,
          );
          if (expectedOutcome === 'approved') {
            assert.ok(inboxes.every((inbox) => inbox.includes('## Approved Handoff Context')));
          } else {
            assert.ok(inboxes.every((inbox) => !inbox.includes('## Approved Handoff Context')));
          }
        } finally {
          if (typeof previousPath === 'string') process.env.PATH = previousPath;
          else delete process.env.PATH;
          await rm(cwd, { recursive: true, force: true });
          await rm(fakeBinDir, { recursive: true, force: true });
        }
      }
    }
  });

  for (const state of BLOCKED_SCALE_UP_APPROVED_BINDING_STATES) {
    it(`fails closed before worker launch when the persisted approved binding is ${state}`, async () => {
      const teamName = `su-block-${SCALE_UP_STATE_TEAM_SUFFIX[state]}`;
      const cwd = await mkdtemp(join(tmpdir(), `omx-scale-up-approved-${state}-`));
      const fakeBinDir = await mkdtemp(join(tmpdir(), `omx-scale-up-approved-${state}-bin-`));
      const tmuxLogPath = join(fakeBinDir, 'tmux.log');
      const previousPath = process.env.PATH;

      try {
        await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

        await initTeamState(teamName, `approved ${state} scale-up test`, 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);
        await prepareScaleUpApprovedBindingState(teamName, cwd, state);

        const expectedError = await readExpectedScaleUpApprovedBindingError(teamName, cwd);
        assert.ok(expectedError);

        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: 'Implement approved follow-up', description: 'Implement approved follow-up', owner: 'worker-2' }],
          cwd,
          { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
        );
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.error, expectedError);

        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) return;
        assert.equal(config.workers.length, 1);
        assert.equal(config.worker_count, 1);
        assert.equal(config.next_worker_index, 2);

        const taskPayloads = await readScaleUpTaskPayloads(teamName, cwd);
        assert.equal(
          taskPayloads.some((payload) => payload.includes('Implement approved follow-up')),
          false,
        );
        assert.equal(
          existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'identity.json')),
          false,
        );
        assert.equal(
          existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'inbox.md')),
          false,
        );
        assert.deepEqual(await readScaleUpTmuxLogCommands(tmuxLogPath), ['-V']);
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  }


  it('uses project-scoped CODEX_HOME for scaled worker reasoning and model defaults', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-project-reasoning-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-project-reasoning-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const previousStandardModel = process.env.OMX_DEFAULT_STANDARD_MODEL;
    const previousFrontierModel = process.env.OMX_DEFAULT_FRONTIER_MODEL;
    const previousCodeHome = process.env.CODEX_HOME;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%31"',
          tmuxCreatedPaneMarkerLine('%31'),
          '    ;;',
          ...tmuxAuthorityListPanesCase(['%11', '%21']),
          '  send-keys)',
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      delete process.env.CODEX_HOME;
      delete process.env.OMX_DEFAULT_STANDARD_MODEL;
      delete process.env.OMX_DEFAULT_FRONTIER_MODEL;

      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await mkdir(join(cwd, '.codex'), { recursive: true });
      await writeFile(join(cwd, '.codex', '.omx-config.json'), JSON.stringify({
        env: {
          OMX_DEFAULT_STANDARD_MODEL: 'project-standard-model',
        },
        agentReasoning: {
          writer: 'xhigh',
        },
      }));
      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'scale-up-project-reasoning'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'scale-up-project-reasoning', 'worker-agents.md'), '# Base worker instructions\n');

      await initTeamState('scale-up-project-reasoning', 'task', 'executor', 1, cwd);
      await createTask('scale-up-project-reasoning', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('scale-up-project-reasoning', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-scale-up-project-reasoning';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'scale-up-project-reasoning', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'scale-up-project-reasoning',
        1,
        'executor',
        [{ subject: 'document routing report only', description: 'document routing report only', owner: 'worker-2', role: 'writer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      const startupScript = await readFile(
        workerStartupScriptPath(cwd, 'scale-up-project-reasoning', 'worker-2'),
        'utf-8',
      );
      assert.match(tmuxLog, /worker-2-startup\.sh/);
      assert.match(startupScript, /CODEX_HOME=.*\.codex/);
      assert.match(startupScript, /model_reasoning_effort="xhigh"/);
      assert.match(startupScript, /--model/);
      assert.match(startupScript, /project-standard-model/);

      const workerAgents = await readFile(join(cwd, '.omx', 'state', 'team', 'scale-up-project-reasoning', 'workers', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(workerAgents, /You are operating as the \*\*writer\*\* role/);
      assert.match(workerAgents, /resolved_model: project-standard-model/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousStandardModel === 'string') process.env.OMX_DEFAULT_STANDARD_MODEL = previousStandardModel;
      else delete process.env.OMX_DEFAULT_STANDARD_MODEL;
      if (typeof previousFrontierModel === 'string') process.env.OMX_DEFAULT_FRONTIER_MODEL = previousFrontierModel;
      else delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
      if (typeof previousCodeHome === 'string') process.env.CODEX_HOME = previousCodeHome;
      else delete process.env.CODEX_HOME;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });


  it('removes generated worktree-root AGENTS when scale-up rolls back', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-rollback-worktree-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-rollback-worktree-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
	case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
${tmuxCreatedPaneMarkerLine('%31')}
    ;;
${tmuxAuthorityListPanesCase(['%11', '%21'], '42424', false, '', { atomicSendFailure: true }).join('\n')}
  send-keys)
    exit 1
    ;;
  kill-pane)
    : > "${fakeBinDir}/killed-$3"
    ;;
  capture-pane)
    echo ""
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await writeFile(join(cwd, 'AGENTS.md'), '# Root project instructions\n');
      await initCommittedGitRepo(cwd);
      await initTeamState('rollback-worktree', 'task', 'executor', 1, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const config = await readTeamConfig('rollback-worktree', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-rollback-worktree';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'rollback-worktree', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'rollback-worktree',
        1,
        'executor',
        [{ subject: 'write docs', description: 'write docs', owner: 'worker-2', role: 'writer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /scale_up_dispatch_failed:worker-2/);

      const workerRootAgents = join(cwd, '.omx', 'team', 'rollback-worktree', 'worktrees', 'worker-2', 'AGENTS.md');
      await assert.rejects(readFile(workerRootAgents, 'utf-8'), { code: 'ENOENT' });
      const backupPath = join(cwd, '.git', 'worktrees', 'worker-2', 'omx', 'root-agents-backup.json');
      assert.equal(existsSync(backupPath), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('uses canonical root AGENTS bootstrap for scaled worktree workers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-canonical-root-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-canonical-root-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
	case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
${tmuxCreatedPaneMarkerLine('%31')}
    ;;
${tmuxAuthorityListPanesCase(['%11', '%21']).join('\n')}
  capture-pane)
    echo ""
    ;;
  kill-pane)
    : > "${fakeBinDir}/canonical-root-killed-$3"
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await writeFile(join(cwd, 'AGENTS.md'), '# Root project instructions\n');
      await initCommittedGitRepo(cwd);
      await initTeamState('canonical-root', 'task', 'executor', 1, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const config = await readTeamConfig('canonical-root', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-canonical-root';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'canonical-root', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'canonical-root',
        1,
        'executor',
        [{ subject: 'write docs', description: 'write docs', owner: 'worker-2', role: 'writer' }],
        cwd,
        {
          OMX_TEAM_SCALING_ENABLED: '1',
          OMX_TEAM_SKIP_READY_WAIT: '1',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5.6-terra',
        },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(join(cwd, '.omx', 'state', 'team', 'canonical-root', 'workers', 'worker-2', 'inbox.md'), 'utf-8');
      assert.doesNotMatch(inbox, /## Your Specialization/);
      assert.match(inbox, /\*\*Role:\*\* writer/);

      const rootAgents = await readFile(join(cwd, '.omx', 'team', 'canonical-root', 'worktrees', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(rootAgents, /You are operating as the \*\*writer\*\* role/);
      assert.match(rootAgents, /<identity>You are Writer\.<\/identity>/);
      assert.match(rootAgents, /exact gpt-5\.6-terra model/);
      assert.match(rootAgents, /strict execution order: inspect -> plan -> act -> verify/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('does not apply mini guidance during scale-up when the final worker model is gpt-5.6-sol', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-frontier-role-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-frontier-role-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
${tmuxCreatedPaneMarkerLine('%31')}
    ;;
${tmuxAuthorityListPanesCase(['%11', '%21']).join('\n')}
  capture-pane)
    echo ""
    ;;
  kill-pane)
    : > "${fakeBinDir}/frontier-role-killed-$3"
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'test-engineer.md'), '<identity>Test Engineer</identity>');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'frontier-role'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'frontier-role', 'worker-agents.md'), '# Base worker instructions\n');

      await initTeamState('frontier-role', 'task', 'executor', 1, cwd);
      await createTask('frontier-role', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('frontier-role', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-frontier-role';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'frontier-role', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'frontier-role',
        1,
        'executor',
        [{ subject: 'test routing report only', description: 'test routing report only', owner: 'worker-2', role: 'test-engineer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const workerAgents = await readFile(join(cwd, '.omx', 'state', 'team', 'frontier-role', 'workers', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(workerAgents, /You are operating as the \*\*test-engineer\*\* role/);
      assert.match(workerAgents, /<identity>Test Engineer<\/identity>/);
      assert.doesNotMatch(workerAgents, /exact gpt-5\.6-terra model/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('does not apply mini guidance during scale-up for gpt-5.6-terra-tuned overrides', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-mini-tuned-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-mini-tuned-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
${tmuxCreatedPaneMarkerLine('%31')}
    ;;
${tmuxAuthorityListPanesCase(['%11', '%21']).join('\n')}
  capture-pane)
    echo ""
    ;;
  kill-pane)
    : > "${fakeBinDir}/mini-tuned-killed-$3"
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await writeFile(join(cwd, 'AGENTS.md'), '# Root project instructions\n');
      await initCommittedGitRepo(cwd);
      await initTeamState('mini-tuned-root', 'task', 'executor', 1, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const config = await readTeamConfig('mini-tuned-root', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-mini-tuned-root';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'mini-tuned-root', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'mini-tuned-root',
        1,
        'executor',
        [{ subject: 'write docs', description: 'write docs', owner: 'worker-2', role: 'writer' }],
        cwd,
        {
          OMX_TEAM_SCALING_ENABLED: '1',
          OMX_TEAM_SKIP_READY_WAIT: '1',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5.6-terra-tuned',
        },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const rootAgents = await readFile(join(cwd, '.omx', 'team', 'mini-tuned-root', 'worktrees', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(rootAgents, /You are operating as the \*\*writer\*\* role/);
      assert.match(rootAgents, /<identity>You are Writer\.<\/identity>/);
      assert.doesNotMatch(rootAgents, /exact gpt-5\.6-terra model/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('preserves leader/HUD layout by avoiding tiled relayout during scale-up', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-layout-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-layout-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
${tmuxCreatedPaneMarkerLine('%31')}
    ;;
${tmuxAuthorityListPanesCase(['%11', '%21']).join('\n')}
  capture-pane)
    echo ""
    ;;
  kill-pane)
    : > "${fakeBinDir}/layout-killed-$3"
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('scale-up-layout', 'task', 'executor', 1, cwd);

      const config = await readTeamConfig('scale-up-layout', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-scale-up-layout';
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'scale-up-layout', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'scale-up-layout',
        1,
        'executor',
        [],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      const splitWindowIndex = tmuxCommands.findIndex((command) => command.startsWith('split-window '));
      assert.ok(splitWindowIndex > 2);
      assert.match(tmuxCommands[splitWindowIndex - 3]!, /^list-panes -a -F #\{pane_id\}\t#\{pane_dead\}\t#\{pane_pid\}$/);
      assert.equal(tmuxCommands[splitWindowIndex - 2], 'show-option -qv -p -t %21 @omx_team_pane_owner_id');
      assert.match(tmuxCommands[splitWindowIndex - 1]!, /^list-panes -a -F #\{pane_id\}\t#\{pane_dead\}\t#\{pane_pid\}$/);
      assert.match(tmuxCommands[splitWindowIndex]!, /split-window -v -t %21/);
      assert.doesNotMatch(tmuxCommands.join('\n'), /select-layout .*tiled/);

    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  for (const [name, proofOutput, proofExitStatus, expectedReason] of [
    ['dead persisted worker pane', '%21\t1\t42421\n', 0, 'dead'],
    ['similar persisted worker pane ID', '%210\t0\t424210\n', 0, 'absent'],
    ['malformed global pane PID', '%21\t0\tnot-a-pid\n', 0, 'malformed_snapshot'],
    ['duplicate global pane proof rows', '%21\t0\t42421\n%21\t0\t42422\n', 0, 'malformed_snapshot'],
    ['unavailable global pane query', '', 1, 'query_failed'],
  ] as const) {
    it(`fails closed before split-window when exact proof has ${name}`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-split-proof-'));
      const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-split-proof-bin-'));
      const tmuxLogPath = join(fakeBinDir, 'tmux.log');
      const tmuxStubPath = join(fakeBinDir, 'tmux');
      const previousPath = process.env.PATH;

      try {
        await writeFile(
          tmuxStubPath,
          [
            '#!/bin/sh',
            'set -eu',
            `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
            'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
            '  -V)',
            '    echo "tmux 3.2a"',
            '    ;;',
            '  list-panes)',
            `    printf '%b' ${JSON.stringify(proofOutput)}`,
            proofExitStatus === 0 ? '    ;;' : '    exit 1',
            proofExitStatus === 0 ? '' : '    ;;',
            '  split-window)',
            '    echo "%31"',
            '    ;;',
            'esac',
            'exit 0',
            '',
          ].join('\n'),
        );
        await chmod(tmuxStubPath, 0o755);
        await writeFile(tmuxLogPath, '');
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

        const teamName = `split-proof-${expectedReason === 'malformed_snapshot' ? name.includes('duplicate') ? 'duplicate' : 'malformed' : expectedReason.replace('_', '-')}`;
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);

        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [],
          cwd,
          { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
        );
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error, `scale_up_split_target_proof_unavailable:%21:${expectedReason}`);
        }

        const config = await readTeamConfig(teamName, cwd);
        assert.equal(config?.workers.length, 1);
        const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ')), false);
        assert.equal(tmuxCommands.some((command) => command.startsWith('send-keys ')), false);
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  }

  it('migrates a legacy worker PID from an exact owner-bound proof before split-window', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-legacy-target-pid-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-legacy-target-pid-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      const stub = await readFile(tmuxStubPath, 'utf-8');
      const configPath = join(cwd, '.omx', 'state', 'team', 'legacy-target-pid', 'config.json');
      await writeFile(tmuxStubPath, stub.replace(
        '  split-window)',
        `  split-window)\n    grep -q '"pid": 42421' "${configPath}" || exit 23`,
      ));
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      const teamName = 'legacy-target-pid';
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const config = await readTeamConfig(teamName, cwd);
      assert.ok(config);
      if (!config) return;
      delete config.workers[0]!.pid;
      await saveTeamConfig(config, cwd);

      const result = await scaleUp(teamName, 1, 'executor', [], cwd, {
        OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1',
      });
      assert.equal(result.ok, true);
      assert.equal((await readTeamConfig(teamName, cwd))?.workers[0]?.pid, 42421);
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  for (const [name, proofOutput, owner, expectedError] of [
    ['malformed proof', '%21\\t0\\tnot-a-pid\\n', 'team:scale-up', 'scale_up_split_target_proof_unavailable:%21:malformed_snapshot'],
    ['foreign pane', '%210\\t0\\t424210\\n', 'team:scale-up', 'scale_up_split_target_proof_unavailable:%21:absent'],
    ['foreign owner tag', '%21\\t0\\t42421\\n', 'team:foreign', 'scale_up_split_target_owner_changed:%21'],
  ] as const) {
    it(`rejects legacy PID migration with ${name} before a scale effect`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-legacy-proof-reject-'));
      const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-legacy-proof-reject-bin-'));
      const tmuxLogPath = join(fakeBinDir, 'tmux.log');
      const tmuxStubPath = join(fakeBinDir, 'tmux');
      const previousPath = process.env.PATH;
      try {
        await writeFile(tmuxStubPath, [
          '#!/bin/sh', 'set -eu', `printf '%s\\n' "$*" >> "${tmuxLogPath}"`, 'case "${1:-}" in',
          '  -V) echo "tmux 3.2a" ;;',
          `  list-panes) printf '%b' ${JSON.stringify(proofOutput)} ;;`,
          `  show-option) echo ${JSON.stringify(owner)} ;;`,
          'esac', 'exit 0', '',
        ].join('\n'));
        await chmod(tmuxStubPath, 0o755);
        await writeFile(tmuxLogPath, '');
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
        const teamName = `legacy-proof-${name.replaceAll(' ', '-')}`;
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);
        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) return;
        delete config.workers[0]!.pid;
        await saveTeamConfig(config, cwd);

        assert.deepEqual(await scaleUp(teamName, 1, 'executor', [], cwd, {
          OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1',
        }), { ok: false, error: expectedError });
        assert.equal((await readTeamConfig(teamName, cwd))?.workers[0]?.pid, undefined);
        const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ') || command.startsWith('set-option ')), false);
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  }

  it('rejects a PID-reused explicit split target at the first proof before any split or owner tag', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-first-proof-reuse-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-first-proof-reuse-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, [
        '#!/bin/sh', 'set -eu', `printf '%s\\n' "$*" >> "${tmuxLogPath}"`, 'case "${1:-}" in', '  show-option) echo "team:scale-up" ;;',
          '  show-option) echo "team:scale-up" ;;',
        '  -V) echo "tmux 3.2a" ;;',
        "  list-panes) printf '%s\\t%s\\t%s\\n' '%21' '0' '52421' ;;",
        'esac', 'exit 0', '',
      ].join('\n'));
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      const teamName = 'first-proof-reuse';
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const result = await scaleUp(teamName, 1, 'executor', [], cwd, { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' });
      assert.deepEqual(result, { ok: false, error: 'scale_up_split_target_pid_changed:%21:42421:52421' });
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ') || command.startsWith('set-option ')), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('rolls back all preparation when the split target proof is lost immediately before split-window', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-second-split-proof-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-second-split-proof-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const proofCountPath = join(fakeBinDir, 'proof-count');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  list-panes)',
          `    count=0; [ ! -f "${proofCountPath}" ] || count=$(cat "${proofCountPath}")`,
          '    count=$((count + 1))',
          `    printf '%s' "$count" > "${proofCountPath}"`,
          '    if [ "$count" -eq 1 ]; then',
          "      printf '%s\\t%s\\t%s\\n' '%21' '0' '42421'",
          '    else',
          '      exit 1',
          '    fi',
          '    ;;',
          '  split-window)',
          '    echo "%31"',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'second-split-proof';
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const teamStateDir = join(cwd, '.omx', 'state', 'team', teamName);
      const configPath = join(teamStateDir, 'config.json');
      const tasksDir = join(teamStateDir, 'tasks');
      const workersDir = join(teamStateDir, 'workers');
      const runtimeDir = join(teamStateDir, 'runtime');
      const configBefore = await readFile(configPath, 'utf-8');
      const taskEntriesBefore = (await readdir(tasksDir)).sort();
      const workerEntriesBefore = (await readdir(workersDir)).sort();
      const runtimeDirExistedBefore = existsSync(runtimeDir);

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'must not persist', description: 'proof loss rollback', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );

      assert.deepEqual(result, {
        ok: false,
        error: 'scale_up_split_target_proof_unavailable:%21:query_failed',
      });
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.deepEqual(
        tmuxCommands.filter((command) => command.startsWith('list-panes ')),
        [
          'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
          'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
        ],
      );
      assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ')), false);
      assert.equal(tmuxCommands.some((command) => command.startsWith('send-keys ')), false);
      assert.deepEqual(withoutConfigGeneration(await readFile(configPath, 'utf-8')), withoutConfigGeneration(configBefore));
      assert.deepEqual((await readdir(tasksDir)).sort(), taskEntriesBefore);
      assert.deepEqual((await readdir(workersDir)).sort(), workerEntriesBefore);
      assert.equal(existsSync(join(workersDir, 'worker-2')), false);
      assert.equal(existsSync(join(cwd, '.omx', 'team', teamName, 'worktrees', 'worker-2')), false);
      assert.equal(existsSync(runtimeDir), runtimeDirExistedBefore);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('rejects a split target ID replacement that occurs during owner authorization', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-split-target-pid-reuse-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-split-target-pid-reuse-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const proofCountPath = join(fakeBinDir, 'proof-count');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(tmuxStubPath, [
        '#!/bin/sh',
        'set -eu',
        `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
        'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
        '  -V)',
        '    echo "tmux 3.2a"',
        '    ;;',
        '  list-panes)',
        `    count=0; [ ! -f "${proofCountPath}" ] || count=$(cat "${proofCountPath}")`,
        '    count=$((count + 1))',
        `    printf '%s' "$count" > "${proofCountPath}"`,
        '    if [ "$count" -eq 1 ]; then',
        "      printf '%s\\t%s\\t%s\\n' '%21' '0' '42421'",
        '    else',
        "      printf '%s\\t%s\\t%s\\n' '%21' '0' '52421'",
        '    fi',
        '    ;;',
        '  split-window)',
        '    echo "%31"',
        '    ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'));
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'split-target-pid-reuse';
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const config = await readTeamConfig(teamName, cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[0]!.pid = 42421;
      await saveTeamConfig(config, cwd);

      const teamStateDir = join(cwd, '.omx', 'state', 'team', teamName);
      const configPath = join(teamStateDir, 'config.json');
      const tasksDir = join(teamStateDir, 'tasks');
      const workersDir = join(teamStateDir, 'workers');
      const runtimeDir = join(teamStateDir, 'runtime');

      const configBefore = await readFile(configPath, 'utf-8');
      const taskEntriesBefore = (await readdir(tasksDir)).sort();
      const workerEntriesBefore = (await readdir(workersDir)).sort();
      const runtimeDirExistedBefore = existsSync(runtimeDir);


      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'must not persist', description: 'PID reuse rollback', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );

      assert.deepEqual(result, {
        ok: false,
        error: 'scale_up_split_target_pid_changed:%21:42421:52421',
      });
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.equal(tmuxCommands.filter((command) => command.startsWith('list-panes ')).length, 2);
      assert.equal(tmuxCommands.some((command) => command.startsWith('split-window ')), false);
      assert.equal(tmuxCommands.some((command) => command.startsWith('send-keys ')), false);
      assert.deepEqual(withoutConfigGeneration(await readFile(configPath, 'utf-8')), withoutConfigGeneration(configBefore));
      assert.deepEqual((await readdir(tasksDir)).sort(), taskEntriesBefore);
      assert.deepEqual((await readdir(workersDir)).sort(), workerEntriesBefore);
      assert.equal(existsSync(join(workersDir, 'worker-2')), false);
      assert.equal(existsSync(runtimeDir), runtimeDirExistedBefore);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('provisions detached worktrees for scaled-up workers from persisted team worktree mode', async () => {
    const repo = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-detached-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%41"',
          tmuxCreatedPaneMarkerLine('%41'),
          '    ;;',
          ...tmuxAuthorityListPanesCase(['%11', '%21'], '45454'),
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'scale-up-detached-worktree';
      await mkdir(join(repo, '.omx', 'state', 'team', teamName), { recursive: true });
      await writeFile(join(repo, '.omx', 'state', 'team', teamName, 'worker-agents.md'), '# Base worker instructions\n');
      await initTeamState(
        teamName,
        'task',
        'executor',
        1,
        repo,
        DEFAULT_MAX_WORKERS,
        process.env,
        {
          leader_cwd: repo,
          team_state_root: join(repo, '.omx', 'state'),
          workspace_mode: 'worktree',
          worktree_mode: { enabled: true, detached: true, name: null },
        },
      );

      const config = await readTeamConfig(teamName, repo);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = `omx-team-${teamName}`;
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 45452;
      await saveTeamConfig(config, repo);

      const manifestPath = join(repo, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [],
        repo,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const updated = await readTeamConfig(teamName, repo);
      const worker = updated?.workers.find((entry) => entry.name === 'worker-2');
      assert.deepEqual(updated?.worktree_mode, { enabled: true, detached: true, name: null });
      assert.ok(worker?.worktree_path, 'scaled worker should have detached worktree path');
      assert.equal(worker?.working_dir, worker?.worktree_path);
      assert.equal(worker?.worktree_detached, true);
      assert.equal(worker?.worktree_created, true);
      assert.equal(existsSync(worker?.worktree_path as string), true);
      assert.throws(
        () => execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: worker?.worktree_path, stdio: 'pipe' }),
      );
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('provisions named worktrees for scaled-up workers from persisted team worktree mode', async () => {
    const repo = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-named-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  show-option) echo "team:scale-up" ;;',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%42"',
          tmuxCreatedPaneMarkerLine('%42'),
          '    ;;',
          ...tmuxAuthorityListPanesCase(['%11', '%21'], '46464'),
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'scale-up-named-worktree';
      const branchBase = 'feature/team-scale';
      await mkdir(join(repo, '.omx', 'state', 'team', teamName), { recursive: true });
      await writeFile(join(repo, '.omx', 'state', 'team', teamName, 'worker-agents.md'), '# Base worker instructions\n');
      await initTeamState(
        teamName,
        'task',
        'executor',
        1,
        repo,
        DEFAULT_MAX_WORKERS,
        process.env,
        {
          leader_cwd: repo,
          team_state_root: join(repo, '.omx', 'state'),
          workspace_mode: 'worktree',
          worktree_mode: { enabled: true, detached: false, name: branchBase },
        },
      );

      const config = await readTeamConfig(teamName, repo);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = `omx-team-${teamName}`;
      config.leader_pane_id = '%11';

      config.tmux_pane_owner_id = 'team:scale-up';
      config.workers[0]!.pane_id = '%21';
      config.workers[0]!.pid = 46462;
      await saveTeamConfig(config, repo);

      const manifestPath = join(repo, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [],
        repo,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const updated = await readTeamConfig(teamName, repo);
      const worker = updated?.workers.find((entry) => entry.name === 'worker-2');
      assert.deepEqual(updated?.worktree_mode, { enabled: true, detached: false, name: branchBase });
      assert.equal(worker?.worktree_branch, `${branchBase}/worker-2`);
      assert.equal(worker?.working_dir, worker?.worktree_path);
      assert.equal(worker?.worktree_detached, false);
      assert.equal(worker?.worktree_created, true);
      assert.equal(existsSync(worker?.worktree_path as string), true);
      assert.equal(
        execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: worker?.worktree_path, encoding: 'utf-8' }).trim(),
        `${branchBase}/worker-2`,
      );
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
  it('rolls back pre-split worker preparation when worktree-root instructions cannot materialize', async () => {
    const cwd = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-pre-split-root-failure-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    const teamName = 'pre-split-root-failure';
    const worktreePath = join(cwd, '.omx', 'team', teamName, 'worktrees', 'worker-2');
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V) echo 'tmux 3.2a' ;;
  list-panes) printf '%s\\t%s\\t%s\\n' '%21' '0' '42421' ;;
esac
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState(teamName, 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const config = await readTeamConfig(teamName, cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = `omx-team-${teamName}`;
      config.workers[0]!.pane_id = '%21';
      config.workspace_mode = 'worktree';
      config.worktree_mode = { enabled: true, detached: true, name: null };
      await saveTeamConfig(config, cwd);
      execFileSync('git', ['worktree', 'add', '--detach', worktreePath], { cwd, stdio: 'ignore' });
      await mkdir(join(worktreePath, 'AGENTS.md'));

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /^scale_up_worker_preparation_failed:worker-2:/);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2')), false);
      assert.equal(existsSync(workerStartupScriptPath(cwd, teamName, 'worker-2')), false);
      assert.equal(existsSync(join(worktreePath, 'AGENTS.md')), true);
      assert.deepEqual(await readScaleUpTmuxLogCommands(tmuxLogPath), [
        '-V',
        'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}',
      ]);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
  it('retains only unresolved rollback workers and deletes never-created tasks after an explicit proof-loss phase', async () => {
    const cwd = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-rollback-kill-fail-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const proofLossUsedPath = join(fakeBinDir, 'proof-loss-used');
    const splitCountPath = join(fakeBinDir, 'split-count');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option) echo 'team:scale-up' ;;
  -V) echo 'tmux 3.2a' ;;
  list-panes)
    split_count=0; [ ! -f "${splitCountPath}" ] || split_count=$(cat "${splitCountPath}")
    if [ "$split_count" -ge 2 ] && [ ! -f "${proofLossUsedPath}" ]; then
      : > "${proofLossUsedPath}"
      exit 1
    fi
    if [ "$split_count" -ge 2 ]; then
      printf '%s\t%s\t%s\n' '%21' '0' '42421'
      printf '%s\t%s\t%s\n' '%31' '0' '42431'
      printf '%s\t%s\t%s\n' '%32' '0' '42432'
    elif [ "$split_count" -eq 1 ]; then
      printf '%s\t%s\t%s\n' '%21' '0' '42421'
      printf '%s\t%s\t%s\n' '%31' '0' '42431'
    else
      printf '%s\t%s\t%s\n' '%21' '0' '42421'
    fi
    ;;
  split-window)
    split_count=0; [ ! -f "${splitCountPath}" ] || split_count=$(cat "${splitCountPath}")
    split_count=$((split_count + 1)); printf '%s' "$split_count" > "${splitCountPath}"
    if [ "$split_count" -eq 1 ]; then
      echo '%31'
    else
      echo '%32'
    fi
    ;;
  kill-pane)
    case "$3" in
      %31|%32) exit 0 ;;
      *) exit 1 ;;
    esac
    ;;
esac
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('rollback-kill-fail', 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch('rollback-kill-fail', cwd);
      const rollbackConfig = await readTeamConfig('rollback-kill-fail', cwd);
      assert.ok(rollbackConfig);
      if (!rollbackConfig) return;
      rollbackConfig.workspace_mode = 'worktree';
      rollbackConfig.worktree_mode = { enabled: true, detached: true, name: null };
      await saveTeamConfig(rollbackConfig, cwd);

      const result = await scaleUp(
        'rollback-kill-fail',
        3,
        'executor',
        [
          { subject: 'first', description: 'created before mixed rollback', owner: 'worker-2' },
          { subject: 'second', description: 'created before mixed rollback', owner: 'worker-3' },
          { subject: 'third', description: 'never created after proof loss', owner: 'worker-4' },
        ],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );

      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /^scale_up_rollback_cleanup_debt:.*pane_teardown_failed:%31.*pane_teardown_unresolved:%32/);
      assert.equal(await readFile(splitCountPath, 'utf-8'), '2');
      const config = await readTeamConfig('rollback-kill-fail', cwd);
      assert.deepEqual(config?.workers.map((worker) => worker.name), ['worker-1', 'worker-2', 'worker-3']);
      assert.equal(config?.worker_count, 3);
      assert.equal(config?.next_worker_index, 4);
      assert.equal((await readTask('rollback-kill-fail', '1', cwd))?.owner, 'worker-2');
      assert.equal((await readTask('rollback-kill-fail', '2', cwd))?.owner, 'worker-3');
      assert.equal(await readTask('rollback-kill-fail', '3', cwd), null);
      for (const workerName of ['worker-2', 'worker-3']) {
        const workerDir = join(cwd, '.omx', 'state', 'team', 'rollback-kill-fail', 'workers', workerName);
        assert.equal(existsSync(workerStartupScriptPath(cwd, 'rollback-kill-fail', workerName)), true, `${workerName} startup script must remain`);
        assert.equal(existsSync(join(cwd, '.omx', 'team', 'rollback-kill-fail', 'worktrees', workerName)), true, `${workerName} worktree must remain`);
        if (workerName === 'worker-2') {
          assert.equal(existsSync(workerDir), true, 'worker-2 materialized state must remain retryable');
          assert.equal(existsSync(join(workerDir, 'identity.json')), true, 'worker-2 identity must remain');
          assert.equal(existsSync(join(workerDir, 'inbox.md')), true, 'worker-2 inbox must remain');
        } else {
          assert.equal(existsSync(join(workerDir, 'identity.json')), false, 'worker-3 proof failed before identity materialization');
          assert.equal(existsSync(join(workerDir, 'inbox.md')), false, 'worker-3 proof failed before inbox materialization');
        }
      }
      // P2: retry execution of recorded cleanup debt is intentionally a follow-up surface.
      const tmuxCommands: string[] = await readScaleUpTmuxLogCommands(tmuxLogPath);
      const mutationCommands = tmuxCommands
        .filter((command) => command.startsWith('split-window ') || command.startsWith('kill-pane '))
        .map((command) => command.startsWith('split-window ') ? command.split(' -c ')[0]! : command);
      assert.deepEqual(mutationCommands, [
        'split-window -v -t %21 -d -P -F #{pane_id}',
        'split-window -v -t %31 -d -P -F #{pane_id}',
        'kill-pane -t %31',
      ]);
      for (const mutationCommand of mutationCommands) {
        const mutationIndex = tmuxCommands.findIndex((command) => (
          command === mutationCommand || command.startsWith(`${mutationCommand} -c `)
        ));
        if (mutationCommand.startsWith('split-window ')) {
          assert.ok(mutationIndex > 2);
          assert.equal(tmuxCommands[mutationIndex - 3], 'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}');
          assert.match(tmuxCommands[mutationIndex - 2]!, /^show-option -qv -p -t %(?:21|31) @omx_team_pane_owner_id$/);
          assert.equal(tmuxCommands[mutationIndex - 1], 'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}');
        } else {
          assert.ok(mutationIndex > 2);
          assert.equal(tmuxCommands[mutationIndex - 3], 'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}');
          assert.equal(tmuxCommands[mutationIndex - 2], 'show-option -qv -p -t %31 @omx_team_pane_owner_id');
          assert.equal(tmuxCommands[mutationIndex - 1], 'list-panes -a -F #{pane_id}\t#{pane_dead}\t#{pane_pid}');
        }
      }
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window -v -t %21 ')));
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window -v -t %31 ')));
      assert.ok(tmuxCommands.some((command) => command === 'kill-pane -t %31'));
      assert.equal(tmuxCommands.some((command) => command === 'kill-pane -t %32'), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  for (const rollbackFailurePhase of ['rollback-membership-config-persistence', 'rollback-membership-manifest-persistence'] as const) {
    it(`recovers and raw-verifies original membership after public scaleUp ${rollbackFailurePhase}`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `omx-scale-up-${rollbackFailurePhase}-`));
      const fakeBinDir = await mkdtemp(join(tmpdir(), `omx-scale-up-${rollbackFailurePhase}-bin-`));
      const tmuxLogPath = join(fakeBinDir, 'tmux.log');
      const previousPath = process.env.PATH;
      const teamName = `scale-up-${rollbackFailurePhase.replace('rollback-membership-', '').replace('-persistence', '')}`;
      try {
        await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);
        const teamDir = join(cwd, '.omx', 'state', 'team', teamName);
        const configPath = join(teamDir, 'config.json');
        const manifestPath = join(teamDir, 'manifest.v2.json');
        const originalConfigBytes = await readFile(configPath, 'utf8');
        const originalManifestBytes = await readFile(manifestPath, 'utf8');

        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: 'public rollback recovery', description: 'must be removed', owner: 'worker-2' }],
          cwd,
          {
            OMX_TEAM_SCALING_ENABLED: '1',
            OMX_TEAM_SKIP_READY_WAIT: '1',
            OMX_TEAM_SCALE_UP_INJECT_FAILURE: `finalization,${rollbackFailurePhase}`,
          },
        );

        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, /scale_up_rollback_membership_persistence_failed:.*rollback-persistence-failure/);
        await readTeamConfig(teamName, cwd);
        assert.deepEqual(withoutConfigGeneration(await readFile(configPath, 'utf8')), withoutConfigGeneration(originalConfigBytes));
        assert.deepEqual(withoutConfigGeneration(await readFile(manifestPath, 'utf8')), withoutConfigGeneration(originalManifestBytes));
        assert.equal(existsSync(join(teamDir, '.membership-task-transaction.json')), false);
        assert.equal(await readTask(teamName, '1', cwd), null);
        assert.deepEqual(await listDispatchRequests(teamName, cwd), []);
        assert.equal(existsSync(join(teamDir, 'workers', 'worker-2')), true);
        assert.equal(existsSync(workerStartupScriptPath(cwd, teamName, 'worker-2')), true);
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  }
  for (const phase of ['identity', 'inbox', 'config'] as const) {
    it(`rolls back live pane and materialized state when ${phase} materialization fails`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `omx-scale-up-${phase}-failure-`));
      const fakeBinDir = await mkdtemp(join(tmpdir(), `omx-scale-up-${phase}-failure-bin-`));
      const tmuxLogPath = join(fakeBinDir, 'tmux.log');
      const previousPath = process.env.PATH;
      try {
        await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
        const teamName = `scale-up-${phase}-failure`;
        await initTeamState(teamName, 'task', 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);
        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: `${phase} rollback`, description: 'must be removed', owner: 'worker-2' }],
          cwd,
          {
            OMX_TEAM_SCALING_ENABLED: '1',
            OMX_TEAM_SKIP_READY_WAIT: '1',
            OMX_TEAM_SCALE_UP_INJECT_FAILURE: phase,
          },
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.error, new RegExp(`scale_up_worker_materialization_failed:worker-2:.*${phase}`));
        assert.equal((await readTeamConfig(teamName, cwd))?.workers.length, 1);
        assert.equal(await readTask(teamName, '1', cwd), null);
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2')), false);
        assert.equal(existsSync(workerStartupScriptPath(cwd, teamName, 'worker-2')), false);
        const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
        assert.ok(tmuxCommands.includes('kill-pane -t %31'));
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  }
  it('rolls back a named worktree created before injected ensure bookkeeping fails', async () => {
    const repo = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-named-post-create-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    const teamName = 'named-post-create-failure';
    const branchName = 'feature/named-post-create/worker-2';
    const worktreePath = join(repo, '.omx', 'team', teamName, 'worktrees', 'worker-2');
    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState(teamName, 'task', 'executor', 1, repo, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: repo,
        team_state_root: join(repo, '.omx', 'state'),
        worktree_mode: { enabled: true, detached: false, name: 'feature/named-post-create' },
      });
      await configureScaleUpTeamForDirectDispatch(teamName, repo);
      const result = await scaleUp(teamName, 1, 'executor', [], repo, {
        OMX_TEAM_SCALING_ENABLED: '1',
        OMX_TEAM_SKIP_READY_WAIT: '1',
        OMX_TEAM_SCALE_UP_INJECT_FAILURE: 'worktree-ensure-post-create',
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /scale_up_worker_preparation_failed:worker-2:.*worktree-ensure-post-create/);
      assert.equal(existsSync(worktreePath), false);
      assert.throws(() => execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd: repo }));
      assert.equal((await readTeamConfig(teamName, repo))?.workers.length, 1);
      assert.equal(existsSync(join(repo, '.omx', 'state', 'team', teamName, 'workers', 'worker-2')), false);
      assert.deepEqual((await readScaleUpTmuxLogCommands(tmuxLogPath)).filter((command) => command.startsWith('split-window ')), []);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});

describe('scaleDown', () => {
  it('rejects when scaling is disabled', async () => {
    await assert.rejects(
      scaleDown('test', '/tmp', {}, {}),
      /Dynamic scaling is disabled/,
    );
  });

  it('returns error when team not found', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-nf-'));
    try {
      const result = await scaleDown(
        'nonexistent', cwd, {},
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /not found/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error when trying to remove all workers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-all-'));
    try {
      await initTeamState('all-test', 'task', 'executor', 1, cwd);
      const result = await scaleDown(
        'all-test', cwd,
        { workerNames: ['worker-1'] },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /at least 1 must remain/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error for worker not in team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-miss-'));
    try {
      await initTeamState('miss-test', 'task', 'executor', 2, cwd);
      const result = await scaleDown(
        'miss-test', cwd,
        { workerNames: ['worker-99'] },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /Worker worker-99 not found/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error when not enough idle workers and force=false', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-busy-'));
    try {
      await initTeamState('busy-test', 'task', 'executor', 2, cwd);
      // Write working status for both workers
      await writeWorkerStatus('busy-test', 'worker-1', {
        state: 'working',
        current_task_id: 't-1',
        updated_at: new Date().toISOString(),
      }, cwd);
      await writeWorkerStatus('busy-test', 'worker-2', {
        state: 'working',
        current_task_id: 't-2',
        updated_at: new Date().toISOString(),
      }, cwd);
      const result = await scaleDown(
        'busy-test', cwd,
        { count: 1 },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /Not enough idle workers/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('serializes a concurrent claim across the canonical scale-down boundary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-claim-boundary-'));
    try {
      await initTeamState('claim-boundary', 'task', 'executor', 2, cwd);
      const task = await createTask('claim-boundary', {
        subject: 'boundary task', description: 'must not be claimed by a removed worker', status: 'pending', owner: 'worker-2',
      }, cwd);
      const down = scaleDown('claim-boundary', cwd, { workerNames: ['worker-2'], force: true }, {
        OMX_TEAM_SCALING_ENABLED: '1',
        OMX_TEAM_SCALE_DOWN_BOUNDARY_HOLD_MS: '100',
      });
      const lockPath = join(cwd, '.omx', 'state', 'team', 'claim-boundary', 'claims', `task-${task.id}.lock`);
      for (let attempt = 0; attempt < 50 && !existsSync(lockPath); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(existsSync(lockPath), true);
      const claim = claimTask('claim-boundary', task.id, 'worker-2', task.version ?? 1, cwd);
      assert.deepEqual(await down, { ok: true, removedWorkers: ['worker-2'], newWorkerCount: 1 });
      assert.deepEqual(await claim, { ok: false, error: 'claim_conflict' });
      const reconciled = await readTask('claim-boundary', task.id, cwd);
      assert.equal(reconciled?.owner, undefined);
      assert.equal(reconciled?.claim, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('blocks post-snapshot task creation and null-version claims until removed membership is committed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-create-claim-boundary-'));
    try {
      await initTeamState('create-claim-boundary', 'task', 'executor', 2, cwd);
      const seed = await createTask('create-claim-boundary', {
        subject: 'snapshot marker', description: 'holds the canonical task lock', status: 'pending', owner: 'worker-2',
      }, cwd);
      const postSnapshotMarker = join(cwd, 'post-snapshot-held');
      const down = scaleDown('create-claim-boundary', cwd, { workerNames: ['worker-2'], force: true }, {
        OMX_TEAM_SCALING_ENABLED: '1',
        OMX_TEAM_SCALE_DOWN_BOUNDARY_HOLD_MS: '250',
        OMX_TEAM_SCALE_DOWN_POST_SNAPSHOT_MARKER: postSnapshotMarker,
      });
      for (let attempt = 0; attempt < 50 && !existsSync(postSnapshotMarker); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(existsSync(postSnapshotMarker), true);
      let createSettled = false;
      let claimSettled = false;
      const created = createTask('create-claim-boundary', {
        subject: 'created after snapshot', description: 'must not restore removed membership', status: 'pending', owner: 'worker-2',
      }, cwd).finally(() => { createSettled = true; });
      const claim = claimTask('create-claim-boundary', seed.id, 'worker-2', null, cwd)
        .finally(() => { claimSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(createSettled, false);
      assert.equal(claimSettled, false);
      assert.deepEqual(await down, { ok: true, removedWorkers: ['worker-2'], newWorkerCount: 1 });
      assert.deepEqual(await claim, { ok: false, error: 'worker_not_found' });
      const task = await created;
      assert.equal(task.owner, 'worker-2');
      assert.deepEqual((await readTeamConfig('create-claim-boundary', cwd))?.workers.map((worker) => worker.name), ['worker-1']);
      assert.equal((await readTask('create-claim-boundary', task.id, cwd))?.owner, 'worker-2');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});


describe('scaleDown worktree AGENTS cleanup', () => {
  it('removes generated worktree-root AGENTS during scale-down', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-worktree-agents-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-worktree-agents-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'case "${1:-}" in',
          '  list-panes)',
          '    case "${2:-}" in',
          "      -a) case \"\${4:-}\" in '#{pane_id}') printf '%%11\\n%%21\\n%%22\\n' ;; '#{pane_id} #{pane_dead} #{pane_pid}') printf '%%11 0 42421\\n%%21 0 42422\\n%%22 0 42423\\n' ;; '#{pane_id}\\t#{pane_start_command}') printf '%%11\\tbash\\n%%21\\tbash\\n%%22\\tbash\\n' ;; *) exit 1 ;; esac ;;",
          "      -t) case \"\${5:-}\" in '#{pane_id}') printf '%%11\\n%%21\\n%%22\\n' ;; '#{pane_id} #{pane_dead} #{pane_pid}') printf '%%11 0 42421\\n%%21 0 42422\\n%%22 0 42423\\n' ;; '#{pane_id}\\t#{pane_current_command}\\t#{pane_start_command}') printf '%%11\\tbash\\tbash\\n%%21\\tbash\\tbash\\n%%22\\tbash\\tbash\\n' ;; '#{pane_dead} #{pane_pid}') printf '0 42423\\n' ;; *) printf '%%11\\tteam:scale-down-worktree\\n%%21\\tteam:scale-down-worktree\\n%%22\\tteam:scale-down-worktree\\n' ;; esac ;;",
          '    esac',
          '    ;;',
          "  display-message) printf '$1\\n' ;;",
          '  kill-pane) exit 0 ;;',
          "  show-options) printf 'team:scale-down-worktree\\n' ;;",
          "  show-option) printf 'team:scale-down-worktree\\n' ;;",
          "  if-shell) success=\"\${6:-}\"; receipt=\"\${success##*display-message -p }\"; receipt=\"\${receipt%% *}\"; case \"$receipt\" in __OMX_PANE_MUTATION_[a-f0-9]*__) printf '%s\\n' \"$receipt\" ;; esac ;;",
          'esac',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('scale-down-worktree', 'task', 'executor', 2, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const worktree = join(cwd, '.omx', 'team', 'scale-down-worktree', 'worktrees', 'worker-2');
      await mkdir(worktree, { recursive: true });
      await writeFile(join(worktree, 'AGENTS.md'), '# Tracked root instructions\n', 'utf8');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'scale-down-worktree', 'workers', 'worker-2'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'scale-down-worktree', 'workers', 'worker-2', 'root-agents-backup.json'),
        JSON.stringify({ existed: true, tracked: false, previousContent: '# Tracked root instructions\n' }, null, 2),
        'utf8',
      );
      await writeFile(join(worktree, 'AGENTS.md'), '# Generated runtime instructions\n', 'utf8');

      const config = await readTeamConfig('scale-down-worktree', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.worktree_path = worktree;
      config.tmux_session = 'omx-team-scale-down-worktree';
      config.tmux_pane_owner_id = 'team:scale-down-worktree';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      config.workers[1]!.pane_id = '%22';
      config.workers[0]!.pid = 42422;
      config.workers[1]!.pid = 42423;
      await saveTeamConfig(config, cwd);
      const manifestPath = join(cwd, '.omx', 'state', 'team', 'scale-down-worktree', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
      manifest.tmux_session = config.tmux_session;
      manifest.tmux_pane_owner_id = config.tmux_pane_owner_id;
      manifest.leader_pane_id = config.leader_pane_id;
      manifest.hud_pane_id = config.hud_pane_id;
      manifest.workers = config.workers;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleDown(
        'scale-down-worktree',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) return;

      assert.equal(await readFile(join(worktree, 'AGENTS.md'), 'utf-8'), '# Tracked root instructions\n');
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'scale-down-worktree', 'workers', 'worker-2', 'root-agents-backup.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});

describe('scaleDown teardown hardening', () => {
  it('fails closed when a persisted scale-down pane is no longer globally live', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-stale-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-stale-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(tmuxStubPath, `#!/bin/sh
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  list-panes) printf '%%11\n%%21\n' ;;
esac
`);
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      await initTeamState('stale-pane', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('stale-pane', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%405';
      config.workers[1]!.pid = 424405;
      config.tmux_pane_owner_id = 'team:scale-down';
      await saveTeamConfig(config, cwd);
      const result = await scaleDown(
        'stale-pane',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.deepEqual(result, { ok: false, error: 'failed_to_validate_team_tmux_pane_authority' });
      const updated = await readTeamConfig('stale-pane', cwd);
      assert.equal(updated?.workers.some((worker) => worker.name === 'worker-2'), true);
      assert.equal((await readFile(tmuxLogPath, 'utf-8')).includes('kill-pane'), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('fails closed before scale-down drain or kill for unowned, mismatched, wrong-session, or recycled panes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-pane-authority-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-pane-authority-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      const cases: Array<{
        name: string;
        workerPaneId: string;
        globalPaneIds: string[];
        sessionRows: Array<[string, 'expected' | 'missing' | 'other']>;
      }> = [
        {
          name: 'missing owner option',
          workerPaneId: '%22',
          globalPaneIds: ['%11', '%21', '%22'],
          sessionRows: [['%11', 'expected'], ['%21', 'expected'], ['%22', 'missing']],
        },
        {
          name: 'mismatched owner option',
          workerPaneId: '%22',
          globalPaneIds: ['%11', '%21', '%22'],
          sessionRows: [['%11', 'expected'], ['%21', 'expected'], ['%22', 'other']],
        },
        {
          name: 'wrong session membership',
          workerPaneId: '%22',
          globalPaneIds: ['%11', '%21', '%22'],
          sessionRows: [['%11', 'expected'], ['%21', 'expected']],
        },
        {
          name: 'recycled unrelated pane',
          workerPaneId: '%30',
          globalPaneIds: ['%11', '%21', '%22', '%30'],
          sessionRows: [['%11', 'expected'], ['%21', 'expected'], ['%22', 'expected']],
        },
      ];
      for (const [index, testCase] of cases.entries()) {
        const globalPaneFormat = testCase.globalPaneIds
          .map((paneId) => `${paneId.replace('%', '%%')} 0 42424\\n`)
          .join('');
        const sessionCommands = testCase.sessionRows.map(([paneId, owner]) => {
          const formatPaneId = paneId.replace('%', '%%');
          if (owner === 'expected') return `        printf '${formatPaneId}\\t%s\\n' "$owner"`;
          if (owner === 'missing') return `        printf '${formatPaneId}\\t\\n'`;
          return `        printf '${formatPaneId}\\tteam:other\\n'`;
        });
        await writeFile(
          tmuxStubPath,
          [
            '#!/bin/sh',
            `printf '%s\\n' "$*" >> "${tmuxLogPath}"`,
            'case "${1:-}" in',
            '  list-panes)',
            '    case "${2:-}" in',
            `      -a) printf "${globalPaneFormat}" ;;`,
            '      -t)',
            '        session="${3:-}"',
            '        owner="team:${session#omx-team-}"',
            ...sessionCommands,
            '        ;;',
            '    esac',
            '    ;;',
            'esac',
            '',
          ].join('\n'),
        );
        await chmod(tmuxStubPath, 0o755);
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

        const teamName = `scale-down-pane-authority-${index + 1}`;
        await initTeamState(teamName, 'task', 'executor', 2, cwd);
        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) throw new Error(`missing team config for ${teamName}`);
        config.tmux_session = `omx-team-${teamName}`;
        config.leader_pane_id = '%11';
        config.workers[0]!.pane_id = '%21';
        config.workers[1]!.pane_id = testCase.workerPaneId;
        await saveTeamConfig(config, cwd);
        await writeFile(tmuxLogPath, '');

        const result = await scaleDown(
          teamName,
          cwd,
          { workerNames: ['worker-2'], force: true },
          { OMX_TEAM_SCALING_ENABLED: '1' },
        );
        assert.deepEqual(result, { ok: false, error: 'failed_to_validate_team_tmux_pane_authority' }, testCase.name);
        assert.equal((await readTeamConfig(teamName, cwd))?.workers.length, 2, testCase.name);
        const commands = await readScaleUpTmuxLogCommands(tmuxLogPath);
        assert.ok(commands.includes('list-panes -a -F #{pane_id} #{pane_dead} #{pane_pid}'), testCase.name);
        assert.ok(commands.some((command) => command.startsWith('list-panes -t omx-team-')), testCase.name);
        assert.equal(commands.some((command) => /^(kill-pane|send-keys|set-option)\b/.test(command)), false, testCase.name);
      }
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('scaleDown never targets leader or hud panes during teardown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-exclusions-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-fake-tmux-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  list-panes)
    case "\${2:-}" in
      -a) case "\${4:-}" in
        '#{pane_id}') printf '%%11\n%%12\n%%13\n%%14\n%%15\n%%16\n' ;;
        '#{pane_id} #{pane_dead} #{pane_pid}') printf '%%11 0 10011\n%%12 0 10012\n%%13 0 10013\n%%14 0 10014\n%%15 0 10015\n%%16 0 10016\n' ;;
        '#{pane_id}\t#{pane_start_command}') printf '%%11\tbash\n%%12\tbash\n%%13\tbash\n%%14\tbash\n%%15\tbash\n%%16\tbash\n' ;;
        *) exit 1 ;;
      esac ;;
      -t) case "\${5:-}" in
        '#{pane_id}') printf '%%11\n%%12\n%%13\n%%14\n%%15\n%%16\n' ;;
        '#{pane_id} #{pane_dead} #{pane_pid}') printf '%%11 0 10011\n%%12 0 10012\n%%13 0 10013\n%%14 0 10014\n%%15 0 10015\n%%16 0 10016\n' ;;
        '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}') printf '%%11\tbash\tbash\n%%12\tbash\tbash\n%%13\tbash\tbash\n%%14\tbash\tbash\n%%15\tbash\tbash\n%%16\tbash\tbash\n' ;;
        '#{pane_dead} #{pane_pid}') printf '0 10015\n' ;;
        *) printf '%%11\tteam:exclusions\n%%12\tteam:exclusions\n%%13\tteam:exclusions\n%%14\tteam:exclusions\n%%15\tteam:exclusions\n%%16\tteam:exclusions\n' ;;
      esac ;;
    esac
    ;;
  display-message) printf '$1\n' ;;
  show-options) printf 'team:exclusions\n' ;;
  show-option) printf 'team:exclusions\n' ;;
  if-shell) success="\${6:-}"; receipt="\${success##*display-message -p }"; receipt="\${receipt%% *}"; case "$receipt" in __OMX_PANE_MUTATION_[a-f0-9]*__) printf '%s\n' "$receipt" ;; esac ;;
esac
`,
      );
      await writeFile(tmuxLogPath, '');
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('exclusions', 'task', 'executor', 4, cwd);
      const config = await readTeamConfig('exclusions', cwd);
      assert.ok(config);
      if (!config) return;
      config.leader_pane_id = '%11';
      config.hud_pane_id = '%12';
      config.workers[0]!.pane_id = '%13';
      config.workers[1]!.pane_id = '%14';
      config.workers[2]!.pane_id = '%15';
      config.workers[3]!.pane_id = '%16';
      config.tmux_pane_owner_id = 'team:exclusions';
      config.workers[0]!.pid = 10013;
      config.workers[1]!.pid = 10014;
      config.workers[2]!.pid = 10015;
      config.workers[3]!.pid = 10016;
      await saveTeamConfig(config, cwd);
      const manifestPath = join(cwd, '.omx', 'state', 'team', 'exclusions', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
      manifest.tmux_session = config.tmux_session;
      manifest.tmux_pane_owner_id = config.tmux_pane_owner_id;
      manifest.leader_pane_id = config.leader_pane_id;
      manifest.hud_pane_id = config.hud_pane_id;
      manifest.workers = config.workers;
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleDown(
        'exclusions',
        cwd,
        { workerNames: ['worker-1', 'worker-2', 'worker-3'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, true, JSON.stringify(result));

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
      assert.doesNotMatch(tmuxLog, /kill-pane -t %12/);
      assert.match(tmuxLog, /kill-pane -t %15/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});
