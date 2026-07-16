import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


function isolatedChildEnv(fakeBinDir: string): NodeJS.ProcessEnv {
  const tmuxBin = join(fakeBinDir, 'tmux');
  return {
    PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    OMX_TEST_TMUX_BIN: tmuxBin,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
  };
}

function buildFakeTmux(tmuxLogPath: string): string {
  const bufferPath = `${tmuxLogPath}.buffer`;
  return `#!/usr/bin/env bash
set -eu
if [[ "$1" != "display-message" && "$1" != "if-shell" ]]; then
  printf '[%s]' "$@" >> "${tmuxLogPath}"
  printf '\n' >> "${tmuxLogPath}"
fi
if [[ "$1" == "if-shell" ]]; then
  printf '[%s]' "$@" >> "${tmuxLogPath}"
  printf '\n' >> "${tmuxLogPath}"
  printf '__OMX_PANE_MUTATION_OK__\n'
  exit 0
fi


cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  printf '%%42\t0\t4242\n'
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${bufferPath}"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${bufferPath}" ]]; then
    cat "${bufferPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${bufferPath}"
fi
exit 0
`;
}

function buildPidRecyclingFakeTmux(tmuxLogPath: string, stableAuthorityChecks: number): string {
  const bufferPath = `${tmuxLogPath}.buffer`;
  const authorityCountPath = `${tmuxLogPath}.authority-count`;
  return `#!/usr/bin/env bash
set -eu
cmd="$1"
shift || true
if [[ "$cmd" == "if-shell" ]]; then
  count=0
  if [[ -f "${authorityCountPath}" ]]; then count=$(<"${authorityCountPath}"); fi
  count=$((count + 1))
  printf '%s' "$count" > "${authorityCountPath}"
  printf '[%s]' "$cmd" >> "${tmuxLogPath}"
  printf '[%s]' "$@" >> "${tmuxLogPath}"
  printf '\n' >> "${tmuxLogPath}"
  if [[ "$count" -le ${stableAuthorityChecks} ]]; then printf '__OMX_PANE_MUTATION_OK__\n'; fi
  exit 0
fi
if [[ "$cmd" == "display-message" ]]; then
  count=0
  if [[ -f "${authorityCountPath}" ]]; then count=$(<"${authorityCountPath}"); fi
  count=$((count + 1))
  printf '%s' "$count" > "${authorityCountPath}"
  if [[ "$count" -le ${stableAuthorityChecks} ]]; then printf '%%42\\t0\\t4242\\n'; else printf '%%42\\t0\\t5252\\n'; fi
  exit 0
fi
printf '[%s]' "$cmd" >> "${tmuxLogPath}"
printf '[%s]' "$@" >> "${tmuxLogPath}"
printf '\\n' >> "${tmuxLogPath}"
if [[ "$cmd" == "set-buffer" ]]; then printf '%s' "\${@: -1}" > "${bufferPath}"; fi
if [[ "$cmd" == "show-buffer" && -f "${bufferPath}" ]]; then cat "${bufferPath}"; fi
if [[ "$cmd" == "delete-buffer" ]]; then rm -f "${bufferPath}"; fi
`;
}

function runSendPaneInputInChild(params: {
  fakeBinDir: string;
  moduleUrl: string;
  paneTarget: string;
  prompt: string;
  submitKeyPresses: number;
  typePrompt: boolean;
  queueFirstSubmit?: boolean;
  authorityResults?: boolean[];
  queueOnly?: boolean;
}) {
  const payload = JSON.stringify({
    paneTarget: params.paneTarget,
    prompt: params.prompt,
    submitKeyPresses: params.submitKeyPresses,
    tmuxBin: join(params.fakeBinDir, 'tmux'),
    typePrompt: params.typePrompt,
    queueFirstSubmit: params.queueFirstSubmit,
    authorityResults: params.authorityResults,
    queueOnly: params.queueOnly,
  });
  const script = `
    const input = ${payload};
    process.env.OMX_TEST_TMUX_BIN = input.tmuxBin;
    process.env.PATH = ${JSON.stringify('__CHILD_PATH__')};
    const { sendPaneInput, queuePaneInput } = await import(${JSON.stringify(params.moduleUrl)});
    let authorityIndex = 0;
    input.assertPaneAuthority = input.authorityResults
      ? async () => input.authorityResults[authorityIndex++] === true
      : undefined;
    const result = await (input.queueOnly ? queuePaneInput : sendPaneInput)(input);
    process.stdout.write(JSON.stringify(result));
  `.replace('__CHILD_PATH__', `${params.fakeBinDir}:${process.env.PATH ?? ''}`);
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    env: isolatedChildEnv(params.fakeBinDir),
  });
}

function runEvaluatePaneInjectionReadinessInChild(params: {
  fakeBinDir: string;
  moduleUrl: string;
  paneTarget: string;
  options?: Record<string, unknown>;
}) {
  const payload = JSON.stringify({
    paneTarget: params.paneTarget,
    options: params.options ?? {},
    tmuxBin: join(params.fakeBinDir, 'tmux'),
  });
  const script = `
    const input = ${payload};
    process.env.OMX_TEST_TMUX_BIN = input.tmuxBin;
    process.env.PATH = ${JSON.stringify('__CHILD_PATH__')};
    const { evaluatePaneInjectionReadiness } = await import(${JSON.stringify(params.moduleUrl)});
    const result = await evaluatePaneInjectionReadiness(input.paneTarget, input.options);
    process.stdout.write(JSON.stringify(result));
  `.replace('__CHILD_PATH__', `${params.fakeBinDir}:${process.env.PATH ?? ''}`);
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    env: isolatedChildEnv(params.fakeBinDir),
  });
}

describe('notify-hook team tmux guard bridge', () => {
  it('submits without typing when typePrompt=false', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'hello bridge',
        submitKeyPresses: 2,
        typePrompt: false,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      assert.match(result.stdout, /"ok":true/);

      const log = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(log, /paste-buffer/);
      assert.doesNotMatch(log, /hello bridge/);
      const lines = log.trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 3);
      assert.match(lines[0], /\[if-shell\].*send-keys.*C-m/);
      assert.match(lines[1], /\[if-shell\].*send-keys.*C-m/);

    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('queue-first submits with Tab before C-m when requested', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'Read /tmp/team/mailbox/leader-fixed.json; new msg from worker-1. Review it; decide next step.',
        submitKeyPresses: 2,
        typePrompt: true,
        queueFirstSubmit: true,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      assert.match(result.stdout, /"ok":true/);

      const lines = (await readFile(tmuxLogPath, 'utf-8')).trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 9);
      assert.match(lines[0], /\[set-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[1], /\[show-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[2], /\[if-shell\].*send-keys.*C-u/);
      assert.match(lines[3], /\[if-shell\].*paste-buffer.*omx-pane-input-/);
      assert.match(lines[4], /\[if-shell\].*send-keys.*Tab/);
      assert.match(lines[5], /\[if-shell\].*send-keys.*C-m/);
      assert.match(lines[6], /\[if-shell\].*send-keys.*C-m/);
      assert.match(lines[8], /\[delete-buffer\]\[-b\]\[omx-pane-input-/);


    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('types then submits when typePrompt=true', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'hello bridge',
        submitKeyPresses: 1,
        typePrompt: true,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      assert.match(result.stdout, /"ok":true/);

      const log = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(log, /load-buffer/);
      assert.match(log, /\[set-buffer\]\[-b\]\[omx-pane-input-.*\]\[--\]\[hello bridge\]/);
      assert.match(log, /\[show-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(log, /\[if-shell\].*send-keys.*C-u/);
      assert.match(log, /\[if-shell\].*paste-buffer.*omx-pane-input-/);
      const lines = log.trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 7);

      assert.match(lines[4], /\[if-shell\].*send-keys.*C-m/);
      assert.match(lines[6], /\[delete-buffer\]\[-b\]\[omx-pane-input-/);



    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('aborts before paste when buffer setup fails so stale tmux content is not reused', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'tmux'),
        `#!/usr/bin/env bash
set -eu
printf '[%s]' "$@" >> "${tmuxLogPath}"
printf '\n' >> "${tmuxLogPath}"
cmd="$1"
if [[ "$cmd" == "display-message" ]]; then printf '%%42\t0\t4242\n'; exit 0; fi

if [[ "$cmd" == "set-buffer" ]]; then
  echo "invalid buffer load" >&2
  exit 1
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  echo "would have pasted stale buffer" >&2
  exit 2
fi
exit 0
`,
      );
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'intended supervisor handoff',
        authorityResults: [true],
        submitKeyPresses: 1,
        typePrompt: true,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.sent, false);
      assert.equal(parsed.reason, 'buffer_set_failed');

      const log = await readFile(tmuxLogPath, 'utf-8');
      assert.match(log, /\[set-buffer\]\[-b\]\[omx-pane-input-/);
      assert.doesNotMatch(log, /show-buffer/);
      assert.doesNotMatch(log, /paste-buffer/);
      assert.doesNotMatch(log, /\[send-keys\]\[-t\]\[%42\]\[C-m\]/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('deletes the named buffer when verification fails after setup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'tmux'),
        `#!/usr/bin/env bash
set -eu
printf '[%s]' "$@" >> "${tmuxLogPath}"
printf '\n' >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then printf '%%42\t0\t4242\n'; exit 0; fi

if [[ "$cmd" == "set-buffer" ]]; then
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  echo "cannot read buffer" >&2
  exit 1
fi
exit 0
`,
      );
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'supervisor handoff after setup',
        authorityResults: [true],
        submitKeyPresses: 1,
        typePrompt: true,
      });

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'buffer_show_failed');

      const lines = (await readFile(tmuxLogPath, 'utf-8')).trim().split('\n').filter(Boolean);
      assert.match(lines[1] ?? '', /\[set-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[2] ?? '', /\[show-buffer\]\[-b\]\[omx-pane-input-/);
      assert.match(lines[3] ?? '', /\[delete-buffer\]\[-b\]\[omx-pane-input-/);
      assert.equal(lines.length, 4);

    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('deletes the named buffer when paste fails after verification', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    const bufferPath = `${tmuxLogPath}.buffer`;

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'tmux'),
        `#!/usr/bin/env bash
set -eu
printf '[%s]' "$@" >> "${tmuxLogPath}"
printf '\n' >> "${tmuxLogPath}"
if [[ "$1" == "display-message" ]]; then echo -e '%42\t0\t4242'; exit 0; fi

cmd="$1"
shift || true
if [[ "$cmd" == "if-shell" ]]; then
  if [[ "$*" == *"paste-buffer"* ]]; then exit 1; fi

  printf '__OMX_PANE_MUTATION_OK__\n'
  exit 0
fi


if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${bufferPath}"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  cat "${bufferPath}"
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  echo "paste failed" >&2
  exit 1
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${bufferPath}"
fi
exit 0
`,
      );
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'supervisor handoff after verify',
        authorityResults: [true, true],
        submitKeyPresses: 1,
        typePrompt: true,
      });

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'buffer_paste_failed');

      const lines = (await readFile(tmuxLogPath, 'utf-8')).trim().split('\n').filter(Boolean);
      assert.match(lines[0] ?? '', /\[display-message\].*pane_id/);
      assert.ok(lines.length >= 1);

    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports pane_not_ready with capture context when the pane is not input-ready', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'tmux'),
        `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  format="\${@: -1}"
  if [[ "$format" == "#{pane_current_command}" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" ]]; then
    echo "0"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "loading workspace state...\\n"
  exit 0
fi
exit 0
`,
      );
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runEvaluatePaneInjectionReadinessInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'pane_not_ready');
      assert.equal(parsed.paneCurrentCommand, 'codex');
      assert.match(parsed.paneCapture, /loading workspace state/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats capture-pane failure as non-blocking for a live codex pane', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');

    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(
        join(fakeBinDir, 'tmux'),
        `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  format="\${@: -1}"
  if [[ "$format" == "#{pane_current_command}" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{pane_in_mode}" ]]; then
    echo "0"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  echo "capture failed" >&2
  exit 1
fi
exit 0
`,
      );
      await chmod(join(fakeBinDir, 'tmux'), 0o755);

      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runEvaluatePaneInjectionReadinessInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        options: { skipIfScrolling: true },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.reason, 'ok');
      assert.equal(parsed.paneCurrentCommand, 'codex');
      assert.equal(parsed.paneCapture, '');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('aborts before a recycled pane receives paste or submit input', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildFakeTmux(tmuxLogPath));
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'must not reach recycled pane',
        submitKeyPresses: 2,
        typePrompt: true,
        authorityResults: [true, false],
      });
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'pane_authority_invalid');
      const log = await readFile(tmuxLogPath, 'utf-8');
      assert.match(log, /\[if-shell\].*send-keys.*C-u/);
      assert.doesNotMatch(log, /\[if-shell\].*paste-buffer/);
      assert.doesNotMatch(log, /\[if-shell\].*send-keys.*C-m/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('rejects a PID recycle immediately before every non-Team injection sink', async () => {
    const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
    const cases = [
      { stableChecks: 1, expected: [] },
      { stableChecks: 2, expected: ['C-u'] },
      { stableChecks: 3, expected: ['C-u'] },
      { stableChecks: 4, expected: ['C-u', 'paste-buffer'] },


    ];
    for (const testCase of cases) {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-recycle-'));
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      try {
        await mkdir(fakeBinDir, { recursive: true });
        await writeFile(join(fakeBinDir, 'tmux'), buildPidRecyclingFakeTmux(tmuxLogPath, testCase.stableChecks));
        await chmod(join(fakeBinDir, 'tmux'), 0o755);
        const result = runSendPaneInputInChild({
          fakeBinDir,
          moduleUrl,
          paneTarget: '%42',
          prompt: 'must not reach a recycled pane',
          submitKeyPresses: 2,
          typePrompt: true,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).reason, 'pane_authority_invalid');
        const log = await readFile(tmuxLogPath, 'utf-8').catch(() => '');
        for (const sink of testCase.expected) assert.match(log, new RegExp(`\\[if-shell\\].*${sink}`));
        const sinkCount = log.split('\n').filter((line) => /\[if-shell\].*(?:C-u|paste-buffer|C-m)/.test(line)).length;
        assert.equal(sinkCount, testCase.expected.length, log);

      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('rejects a PID recycle between queued Tab and C-m', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-queue-recycle-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), buildPidRecyclingFakeTmux(tmuxLogPath, 5));


      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({
        fakeBinDir,
        moduleUrl,
        paneTarget: '%42',
        prompt: 'must not submit to a recycled pane',
        submitKeyPresses: 0,
        typePrompt: true,
        queueOnly: true,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).reason, 'pane_authority_invalid');
      const log = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(log, /\[if-shell\].*Tab/);
      assert.doesNotMatch(log, /\[if-shell\].*C-m/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('fails closed on malformed authority and capture-pane LF framing', async () => {
    const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
    const authorityCases = [
      ['missing LF', '%42\t0\t4242', 'pane_authority_invalid'],
      ['CRLF', '%42\t0\t4242\r\n', 'pane_authority_invalid'],
      ['bare CR', '%42\t0\t4242\r', 'pane_authority_invalid'],
      ['noncanonical alias', '%00\t0\t4242\n', 'pane_authority_invalid'],
      ['canonical pane ID', '%0\t0\t4242\n', 'pane_authority_invalid'],
    ] as const;
    for (const [, authorityOutput, expectedReason] of authorityCases) {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-frame-'));
      const fakeBinDir = join(cwd, 'fake-bin');
      try {
        await mkdir(fakeBinDir, { recursive: true });
        await writeFile(join(fakeBinDir, 'tmux'), `#!/usr/bin/env bash
set -eu
if [[ "$1" == "display-message" ]]; then printf '%s' ${JSON.stringify(authorityOutput)}; exit 0; fi
if [[ "$1" == "if-shell" ]]; then printf '__OMX_PANE_MUTATION_OK__\\n'; fi
`);
        await chmod(join(fakeBinDir, 'tmux'), 0o755);
        const result = runSendPaneInputInChild({ fakeBinDir, moduleUrl, paneTarget: '%0', prompt: '', submitKeyPresses: 0, typePrompt: false });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).reason, expectedReason);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }

    for (const captureOutput of ['evidence', 'evidence\r\n', 'evidence\r']) {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-capture-frame-'));
      const fakeBinDir = join(cwd, 'fake-bin');
      try {
        await mkdir(fakeBinDir, { recursive: true });
        await writeFile(join(fakeBinDir, 'tmux'), `#!/usr/bin/env bash
set -eu
if [[ "$1" == "display-message" ]]; then
  case "${'${@: -1}'}" in '#{pane_current_command}') printf 'codex\\n' ;; '#{pane_in_mode}') printf '0\\n' ;; esac
  exit 0
fi
if [[ "$1" == "capture-pane" ]]; then printf '%s' ${JSON.stringify(captureOutput)}; fi
`);
        await chmod(join(fakeBinDir, 'tmux'), 0o755);
        const result = runEvaluatePaneInjectionReadinessInChild({ fakeBinDir, moduleUrl, paneTarget: '%42', options: { skipIfScrolling: true } });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).reason, 'capture_evidence_invalid');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });
  it('rejects psmux aliases, overflows, and missing targets before any tmux target or input sink', async () => {
    const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
    for (const paneTarget of ['%00', '%4294967296', '']) {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-invalid-target-'));
      const fakeBinDir = join(cwd, 'fake-bin');
      const tmuxLogPath = join(cwd, 'tmux.log');
      try {
        await mkdir(fakeBinDir, { recursive: true });
        await writeFile(join(fakeBinDir, 'tmux'), `#!/usr/bin/env bash
printf '[%s]' "$@" >> "${tmuxLogPath}"
printf '\n' >> "${tmuxLogPath}"
`);
        await chmod(join(fakeBinDir, 'tmux'), 0o755);
        const result = runSendPaneInputInChild({ fakeBinDir, moduleUrl, paneTarget, prompt: 'must not sink', submitKeyPresses: 1, typePrompt: true });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).sent, false);
        assert.equal((await readFile(tmuxLogPath, 'utf-8').catch(() => '')), '', paneTarget);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('rejects an observed pane alias before an input sink', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-tmux-guard-observed-alias-'));
    const fakeBinDir = join(cwd, 'fake-bin');
    const tmuxLogPath = join(cwd, 'tmux.log');
    try {
      await mkdir(fakeBinDir, { recursive: true });
      await writeFile(join(fakeBinDir, 'tmux'), `#!/usr/bin/env bash
printf '[%s]' "$@" >> "${tmuxLogPath}"
printf '\n' >> "${tmuxLogPath}"
if [[ "$1" == "display-message" ]]; then printf '%%00\\t0\\t4242\\n'; fi
`);
      await chmod(join(fakeBinDir, 'tmux'), 0o755);
      const moduleUrl = new URL('../../../dist/scripts/notify-hook/team-tmux-guard.js', import.meta.url).href;
      const result = runSendPaneInputInChild({ fakeBinDir, moduleUrl, paneTarget: '%42', prompt: 'must not sink', submitKeyPresses: 1, typePrompt: true });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).reason, 'pane_authority_invalid');
      const log = await readFile(tmuxLogPath, 'utf-8');
      assert.match(log, /\[display-message\]/);
      assert.doesNotMatch(log, /(?:set-buffer|paste-buffer|send-keys|if-shell)/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
