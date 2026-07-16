import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { createHookPluginSdk, clearHookPluginState } from '../sdk.js';
import type { HookEventEnvelope } from '../types.js';

function makeEvent(event = 'session-start'): HookEventEnvelope {
  return {
    schema_version: '1',
    event,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'native',
    context: {},
  };
}

async function writeOmxStateFile(cwd: string, fileName: string, value: unknown): Promise<void> {
  const stateDir = join(cwd, '.omx', 'state');
  const targetPath = join(stateDir, fileName);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(value, null, 2));
}

describe('createHookPluginSdk', () => {
  describe('state', () => {
    it('reads undefined for missing key', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        const val = await sdk.state.read('nonexistent');
        assert.equal(val, undefined);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('returns fallback for missing key', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        const val = await sdk.state.read('missing', 42);
        assert.equal(val, 42);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('writes and reads state', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await sdk.state.write('counter', 5);
        const val = await sdk.state.read('counter');
        assert.equal(val, 5);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('deletes state key', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await sdk.state.write('key', 'value');
        await sdk.state.delete('key');
        const val = await sdk.state.read('key');
        assert.equal(val, undefined);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('delete is a no-op for nonexistent key', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await sdk.state.write('keep', 'yes');
        await sdk.state.delete('nonexistent');
        const val = await sdk.state.read('keep');
        assert.equal(val, 'yes');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('reads all state', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await sdk.state.write('a', 1);
        await sdk.state.write('b', 'two');
        const all = await sdk.state.all();
        assert.deepEqual(all, { a: 1, b: 'two' });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('returns empty object for all() with no state', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        const all = await sdk.state.all();
        assert.deepEqual(all, {});
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('rejects empty state key', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await assert.rejects(() => sdk.state.read(''), /state key is required/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('rejects state key with path traversal', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await assert.rejects(() => sdk.state.read('../escape'), /invalid state key/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('rejects state key starting with /', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        await assert.rejects(() => sdk.state.write('/absolute', 1), /invalid state key/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('log', () => {
    it('exposes info, warn, error methods', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        // These should not throw
        await sdk.log.info('test info');
        await sdk.log.warn('test warn');
        await sdk.log.error('test error');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('tmux.sendKeys', () => {
    it('returns side_effects_disabled when sideEffectsEnabled is false', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({
          cwd,
          pluginName: 'test',
          event: makeEvent(),
          sideEffectsEnabled: false,
        });
        const result = await sdk.tmux.sendKeys({ text: 'hello' });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'side_effects_disabled');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('returns invalid_text for empty text', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({
          cwd,
          pluginName: 'test',
          event: makeEvent(),
          sideEffectsEnabled: true,
        });
        const result = await sdk.tmux.sendKeys({ text: '   ' });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'invalid_text');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('returns loop_guard_input_marker when text contains loop marker', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      const originalMarker = process.env.OMX_HOOK_PLUGIN_LOOP_MARKER;
      try {
        process.env.OMX_HOOK_PLUGIN_LOOP_MARKER = '[TESTMARK]';
        const sdk = createHookPluginSdk({
          cwd,
          pluginName: 'test',
          event: makeEvent(),
          sideEffectsEnabled: true,
        });
        const result = await sdk.tmux.sendKeys({ text: 'hello [TESTMARK] world' });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'loop_guard_input_marker');
      } finally {
        if (originalMarker === undefined) {
          delete process.env.OMX_HOOK_PLUGIN_LOOP_MARKER;
        } else {
          process.env.OMX_HOOK_PLUGIN_LOOP_MARKER = originalMarker;
        }
        await rm(cwd, { recursive: true, force: true });
      }
    });


    it('prefers non-HUD codex pane when targeting a tmux session', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-sdk-bin-'));
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const previousPath = process.env.PATH;
      try {
        await writeFile(fakeTmuxPath, `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  printf "devsess\n"
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  if [[ "$*" == *"#{pane_active}"* ]]; then
    printf "%%2\t0\t2002\t1\tnode /pkg/dist/cli/omx.js hud --watch\n%%42\t0\t4242\t0\tcodex --model gpt-5\n"
  elif [[ "$*" == *"#{pane_dead}"* ]]; then
    printf "%%2\t0\t2002\n%%42\t0\t4242\n"
  elif [[ "$*" == *"#{pane_id}"* ]]; then
    printf "%%2\n%%42\n"
  fi
  exit 0
fi
if [[ "$cmd" == "if-shell" ]]; then
  printf '__OMX_PANE_MUTATION_OK__\n'
  exit 0
fi

if [[ "$cmd" == "load-buffer" || "$cmd" == "delete-buffer" ]]; then
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
exit 1
`);
        await import('node:fs/promises').then((fs) => fs.chmod(fakeTmuxPath, 0o755));
        process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;

        const sdk = createHookPluginSdk({
          cwd,
          pluginName: 'test',
          event: makeEvent(),
          sideEffectsEnabled: true,
        });
        const result = await sdk.tmux.sendKeys({ text: 'hello', sessionName: 'devsess' });
        assert.equal(result.ok, true);
        assert.equal(result.target, '%42');

        const directResult = await sdk.tmux.sendKeys({ text: 'direct hello', paneId: '%42', cooldownMs: 0 });
        assert.equal(directResult.ok, true);
        assert.equal(directResult.target, '%42');
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
    it('transports hostile literal payloads without tmux command reparsing', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-sdk-bin-'));
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const payloadCapturePath = join(fakeBinDir, 'payload.capture');
      const commandLogPath = join(fakeBinDir, 'commands.log');
      const previousPath = process.env.PATH;
      const text = "apostrophe ' backslash \\\\ semicolon ; brackets [x] {y}\nUnicode 雪 🚀\nrun-shell 'touch /tmp/pwned'; split-window -h";
      try {
        await writeFile(fakeTmuxPath, `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
printf '%s\\n' "$cmd $*" >> "$OMX_TEST_TMUX_COMMAND_LOG"
case "$cmd" in
  display-message) printf 'devsess\\n' ;;
  list-panes)
    if [[ "$*" == *"#{pane_active}"* ]]; then
      printf "%%42\\t0\\t4242\\t1\\tcodex --model gpt-5\\n"
    elif [[ "$*" == *"#{pane_dead}"* ]]; then
      printf "%%42\\t0\\t4242\\n"
    else
      printf "%%42\\n"
    fi
    ;;
  load-buffer) cp "$3" "$OMX_TEST_PAYLOAD_CAPTURE" ;;
  if-shell) printf '__OMX_PANE_MUTATION_OK__\\n' ;;
  delete-buffer) ;;
  *) exit 1 ;;
esac
`);
        await import('node:fs/promises').then((fs) => fs.chmod(fakeTmuxPath, 0o755));
        process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
        process.env.OMX_TEST_PAYLOAD_CAPTURE = payloadCapturePath;
        process.env.OMX_TEST_TMUX_COMMAND_LOG = commandLogPath;

        const sdk = createHookPluginSdk({ cwd, pluginName: 'literal-payload', event: makeEvent(), sideEffectsEnabled: true });
        const result = await sdk.tmux.sendKeys({ text, paneId: '%42', cooldownMs: 0, submit: false });

        assert.equal(result.ok, true);
        assert.equal(await readFile(payloadCapturePath, 'utf8'), `${text} [OMX_TMUX_INJECT]`);
        const commandLog = await readFile(commandLogPath, 'utf8');
        assert.match(commandLog, /load-buffer -b omx_payload_[a-f0-9]{32} \/.*\/payload/);
        assert.match(commandLog, /if-shell .* paste-buffer -b omx_payload_[a-f0-9]{32} -t %42 -d -r -p ; display-message/);
        assert.doesNotMatch(commandLog, /apostrophe|touch \/tmp\/pwned|split-window -h|send-keys -t %42 -l/);
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        delete process.env.OMX_TEST_PAYLOAD_CAPTURE;
        delete process.env.OMX_TEST_TMUX_COMMAND_LOG;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
    it('returns target_missing when no pane is resolvable', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      const originalPane = process.env.TMUX_PANE;
      try {
        delete process.env.TMUX_PANE;
        const sdk = createHookPluginSdk({
          cwd,
          pluginName: 'test',
          event: makeEvent(),
          sideEffectsEnabled: true,
        });
        const result = await sdk.tmux.sendKeys({ text: 'hello' });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'target_missing');
      } finally {
        if (originalPane !== undefined) {
          process.env.TMUX_PANE = originalPane;
        }
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('rejects truncated session batches and PID-recycled targets before submit sinks', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-sdk-bin-'));
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const logPath = join(fakeBinDir, 'tmux.log');
      const countPath = join(fakeBinDir, 'snapshot-count');
      const previousPath = process.env.PATH;
      try {
        await writeFile(fakeTmuxPath, `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "list-panes" ]]; then
  if [[ "$*" == *"#{pane_active}"* ]]; then
    detailed_count=0
    [[ -f "$OMX_TEST_DETAILED_COUNT" ]] && detailed_count="$(<"$OMX_TEST_DETAILED_COUNT")"
    detailed_count=$((detailed_count + 1))
    printf '%s' "$detailed_count" > "$OMX_TEST_DETAILED_COUNT"
    if [[ "\${OMX_TEST_BAD_DETAILED:-}" == "1" || ( "\${OMX_TEST_LATE_BAD_DETAILED:-}" == "1" && "$detailed_count" -gt 1 ) ]]; then
      printf "%%42\t0\t4242\t1\tcodex --model gpt-5"
    elif [[ "\${OMX_TEST_CLASSIFICATION_DRIFT:-}" == "1" && "$detailed_count" -gt 1 ]]; then
      printf "%%42\t0\t4242\t1\tbash\n"
    else
      printf "%%42\t0\t4242\t1\tcodex --model gpt-5\n"
    fi
  elif [[ "$*" == *"#{pane_dead}"* ]]; then
    count=0
    [[ -f "$OMX_TEST_TMUX_COUNT" ]] && count="$(<"$OMX_TEST_TMUX_COUNT")"
    count=$((count + 1))
    printf '%s' "$count" > "$OMX_TEST_TMUX_COUNT"
    pid=4242
    if [[ "\${OMX_TEST_PID_RECYCLE:-}" == "1" && "$count" -gt 1 ]]; then pid=9999; fi
    printf "%%42\t0\t%s\n" "$pid"
  elif [[ "$*" == *"#{pane_id}"* ]]; then
    if [[ "\${OMX_TEST_SESSION_DRIFT:-}" == "1" && "$(<"$OMX_TEST_DETAILED_COUNT")" -gt 1 ]]; then
      printf "%%42\n%%99\n"
    else
      printf "%%42\n"
    fi
    [[ "\${OMX_TEST_EXTRA_ID:-}" == "1" ]] && printf "%%99\n"
  fi
  exit 0
fi
if [[ "$cmd" == "if-shell" ]]; then
  printf '%s\n' "$*" >> "$OMX_TEST_TMUX_LOG"
  if [[ "\${OMX_TEST_PID_RECYCLE:-}" == "1" ]]; then exit 0; fi
  printf '__OMX_PANE_MUTATION_OK__\n'
  exit 0
fi
if [[ "$cmd" == "load-buffer" || "$cmd" == "delete-buffer" ]]; then
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  printf '%s\\n' "$*" >> "$OMX_TEST_TMUX_LOG"
  exit 0
fi
exit 1
`);
        await import('node:fs/promises').then((fs) => fs.chmod(fakeTmuxPath, 0o755));
        process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;
        process.env.OMX_TEST_TMUX_LOG = logPath;
        process.env.OMX_TEST_TMUX_COUNT = countPath;
        process.env.OMX_TEST_DETAILED_COUNT = join(fakeBinDir, 'detailed-count');
        process.env.OMX_TEST_BAD_DETAILED = '1';

        const sdk = createHookPluginSdk({ cwd, pluginName: 'strict-target', event: makeEvent(), sideEffectsEnabled: true });
        const truncated = await sdk.tmux.sendKeys({ text: 'hello', sessionName: 'devsess', cooldownMs: 0 });
        assert.equal(truncated.ok, false);
        assert.equal(truncated.reason, 'target_missing');
        assert.equal(existsSync(logPath), false);

        delete process.env.OMX_TEST_BAD_DETAILED;
        process.env.OMX_TEST_EXTRA_ID = '1';
        const mismatched = await sdk.tmux.sendKeys({ text: 'hello mismatch', sessionName: 'devsess', cooldownMs: 0 });
        assert.equal(mismatched.ok, false);
        assert.equal(mismatched.reason, 'target_missing');
        assert.equal(existsSync(logPath), false);

        delete process.env.OMX_TEST_EXTRA_ID;
        process.env.OMX_TEST_PID_RECYCLE = '1';
        const recycled = await sdk.tmux.sendKeys({ text: 'hello again', sessionName: 'devsess', cooldownMs: 0 });
        assert.equal(recycled.ok, false);
        assert.equal(recycled.reason, 'target_missing');
        const sends = await readFile(logPath, 'utf8').catch(() => '');
        assert.doesNotMatch(sends, /hello again \[OMX_TMUX_INJECT\]/);
        delete process.env.OMX_TEST_PID_RECYCLE;
        await writeFile(process.env.OMX_TEST_DETAILED_COUNT, '0');
        process.env.OMX_TEST_CLASSIFICATION_DRIFT = '1';
        const classificationDrift = await sdk.tmux.sendKeys({ text: 'classification drift', sessionName: 'devsess', cooldownMs: 0 });
        assert.equal(classificationDrift.ok, false);
        assert.equal(classificationDrift.reason, 'target_missing');
        assert.doesNotMatch(await readFile(logPath, 'utf8'), /classification drift \[OMX_TMUX_INJECT\]/);
        delete process.env.OMX_TEST_CLASSIFICATION_DRIFT;
        await writeFile(process.env.OMX_TEST_DETAILED_COUNT, '0');

        process.env.OMX_TEST_SESSION_DRIFT = '1';
        const sessionDrift = await sdk.tmux.sendKeys({ text: 'session drift', sessionName: 'devsess', cooldownMs: 0 });
        assert.equal(sessionDrift.ok, false);
        assert.equal(sessionDrift.reason, 'target_missing');
        assert.doesNotMatch(await readFile(logPath, 'utf8'), /session drift \[OMX_TMUX_INJECT\]/);
        delete process.env.OMX_TEST_SESSION_DRIFT;
        await writeFile(process.env.OMX_TEST_DETAILED_COUNT, '0');

        process.env.OMX_TEST_LATE_BAD_DETAILED = '1';
        const lateTruncated = await sdk.tmux.sendKeys({ text: 'late truncated', sessionName: 'devsess', cooldownMs: 0 });
        assert.equal(lateTruncated.ok, false);
        assert.equal(lateTruncated.reason, 'target_missing');
        assert.doesNotMatch(await readFile(logPath, 'utf8'), /late truncated \[OMX_TMUX_INJECT\]/);
        delete process.env.OMX_TEST_LATE_BAD_DETAILED;
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        delete process.env.OMX_TEST_TMUX_LOG;
        delete process.env.OMX_TEST_TMUX_COUNT;
        delete process.env.OMX_TEST_EXTRA_ID;
        delete process.env.OMX_TEST_BAD_DETAILED;
        delete process.env.OMX_TEST_PID_RECYCLE;
        delete process.env.OMX_TEST_DETAILED_COUNT;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  });

  describe('omx', () => {
    it('exposes only the explicit read-only omx readers', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });

        assert.deepEqual(Object.keys(sdk.omx).sort(), ['hud', 'notifyFallback', 'session', 'updateCheck']);
        assert.equal(typeof sdk.omx.session.read, 'function');
        assert.equal(typeof sdk.omx.hud.read, 'function');
        assert.equal(typeof sdk.omx.notifyFallback.read, 'function');
        assert.equal(typeof sdk.omx.updateCheck.read, 'function');
        assert.equal('pluginState' in sdk, false);
        assert.equal('readJson' in sdk.omx, false);
        assert.equal('list' in sdk.omx, false);
        assert.equal('exists' in sdk.omx, false);
        assert.equal('write' in sdk.omx.session, false);
        assert.equal('delete' in sdk.omx.session, false);
        assert.equal('write' in sdk.omx.hud, false);
        assert.equal('delete' in sdk.omx.hud, false);
        assert.equal('write' in sdk.omx.notifyFallback, false);
        assert.equal('delete' in sdk.omx.notifyFallback, false);
        assert.equal('write' in sdk.omx.updateCheck, false);
        assert.equal('delete' in sdk.omx.updateCheck, false);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('reads session state from .omx/state/session.json', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        await writeOmxStateFile(cwd, 'session.json', {
          session_id: 'session-123',
          cwd,
          started_at: '2026-01-01T00:00:00.000Z',
        });

        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        const state = await sdk.omx.session.read();
        assert.deepEqual(state, {
          session_id: 'session-123',
          cwd,
          started_at: '2026-01-01T00:00:00.000Z',
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('returns null for invalid session state without session_id', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        await writeOmxStateFile(cwd, 'session.json', {
          started_at: '2026-01-01T00:00:00.000Z',
        });

        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        assert.equal(await sdk.omx.session.read(), null);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('reads hud, notifyFallback, and updateCheck state from root-scoped omx files', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        await writeOmxStateFile(cwd, 'hud-state.json', {
          last_turn_at: '2026-01-01T00:00:00.000Z',
          turn_count: 3,
        });
        await writeOmxStateFile(cwd, 'notify-fallback-state.json', {
          pid: 1234,
          stopping: false,
          tracked_files: 2,
        });
        await writeOmxStateFile(cwd, 'update-check.json', {
          last_checked_at: '2026-01-01T00:00:00.000Z',
          last_seen_latest: '0.11.0',
        });

        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        assert.deepEqual(await sdk.omx.hud.read(), {
          last_turn_at: '2026-01-01T00:00:00.000Z',
          turn_count: 3,
        });
        assert.deepEqual(await sdk.omx.notifyFallback.read(), {
          pid: 1234,
          stopping: false,
          tracked_files: 2,
        });
        assert.deepEqual(await sdk.omx.updateCheck.read(), {
          last_checked_at: '2026-01-01T00:00:00.000Z',
          last_seen_latest: '0.11.0',
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('reads hud state from the current session scope instead of stale root fallback', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-hud-session-'));
      try {
        await writeOmxStateFile(cwd, 'session.json', {
          session_id: 'sess-current',
          cwd,
          started_at: '2026-01-01T00:00:00.000Z',
        });
        await writeOmxStateFile(cwd, 'hud-state.json', {
          last_turn_at: 'root-stale',
          turn_count: 99,
          last_agent_output: 'Would you like me to continue?',
        });
        await writeOmxStateFile(cwd, join('sessions', 'sess-current', 'hud-state.json'), {
          last_turn_at: '2026-01-01T00:00:00.000Z',
          turn_count: 3,
          last_agent_output: 'Current session output',
        });

        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        assert.deepEqual(await sdk.omx.hud.read(), {
          last_turn_at: '2026-01-01T00:00:00.000Z',
          turn_count: 3,
          last_agent_output: 'Current session output',
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('returns null for missing omx reader files', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({ cwd, pluginName: 'test', event: makeEvent() });
        assert.equal(await sdk.omx.session.read(), null);
        assert.equal(await sdk.omx.hud.read(), null);
        assert.equal(await sdk.omx.notifyFallback.read(), null);
        assert.equal(await sdk.omx.updateCheck.read(), null);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('plugin name sanitization', () => {
    it('sanitizes special characters in plugin name', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-sdk-'));
      try {
        const sdk = createHookPluginSdk({
          cwd,
          pluginName: 'my plugin!@#',
          event: makeEvent(),
        });
        await sdk.state.write('test', 'value');
        const val = await sdk.state.read('test');
        assert.equal(val, 'value');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
});

describe('clearHookPluginState', () => {
  it('removes data.json and tmux.json for plugin', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-clear-'));
    try {
      const pluginDir = join(cwd, '.omx', 'state', 'hooks', 'plugins', 'my-plugin');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, 'data.json'), '{}');
      await writeFile(join(pluginDir, 'tmux.json'), '{}');

      await clearHookPluginState(cwd, 'my-plugin');

      assert.equal(existsSync(join(pluginDir, 'data.json')), false);
      assert.equal(existsSync(join(pluginDir, 'tmux.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not throw when files do not exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-clear-'));
    try {
      await clearHookPluginState(cwd, 'nonexistent');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
