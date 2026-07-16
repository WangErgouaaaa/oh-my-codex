import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHudLayoutHookSlot,
  buildHudResizeHookName,
  buildHudResizeHookSlot,
  buildHudRuntimeEnv,
  buildHudWatchCommand,
  createHudWatchPane,
  findLegacyFocusedHudWatchPaneIds,
  findHudWatchPaneIds,
  hudPaneMatchesOwner,
  killTmuxPane,
  listCurrentWindowHudPaneIds,
  OMX_TMUX_HUD_LEADER_PANE_ENV,
  TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE,
  parseTmuxPaneSnapshot,
  parseCanonicalTmuxPaneId,
  parseExactTmuxAuthorityLines,
  parseExactTmuxAuthorityScalar,
  parsePaneIdFromTmuxOutput,
  readActiveTmuxPaneId,
  readHudPaneOwner,
  readCurrentWindowSize,
  reapDeadHudPanes,
  resizeTmuxPane,
  parseHudResizeHookContext,
  registerHudResizeHook,
  unregisterHudResizeHook,
  verifyHudWatchPaneAuthority,
} from '../tmux.js';
import { buildHudStartupCommand } from '../index.js';
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS } from '../constants.js';

describe('HUD pane identity boundaries', () => {
  const unsafePaneIds = ['%01', '%4294967296', '%18446744073709551616'];

  it('accepts only the bounded canonical psmux pane-id subset', () => {
    assert.equal(parseCanonicalTmuxPaneId('%0'), '%0');
    assert.equal(parseCanonicalTmuxPaneId('%1'), '%1');
    assert.equal(parseCanonicalTmuxPaneId('%4294967295'), '%4294967295');
    for (const paneId of unsafePaneIds) assert.equal(parseCanonicalTmuxPaneId(paneId), null);
  });

  it('requires exact LF authority frames and rejects truncation, CR, and extra terminators', () => {
    assert.deepEqual(parseExactTmuxAuthorityLines('%1\n%2\n'), ['%1', '%2']);
    assert.equal(parseExactTmuxAuthorityScalar('%1\n'), '%1');
    for (const malformed of ['%1', '%1\r\n', '%1\r', '%1\n\n', '%1\n%2']) {
      assert.equal(parseExactTmuxAuthorityLines(malformed), null, JSON.stringify(malformed));
      assert.equal(parseExactTmuxAuthorityScalar(malformed), null, JSON.stringify(malformed));
    }
  });

  it('rejects whitespace, blank rows, and duplicate rows without partially accepting snapshots', () => {
    for (const paneId of [' %1', '%1 ', '\t%1', '%1\r']) {
      assert.equal(parseCanonicalTmuxPaneId(paneId), null);
      assert.equal(parsePaneIdFromTmuxOutput(`${paneId}\n`), null);
    }
    assert.deepEqual(parseTmuxPaneSnapshot('%1\tcodex\tcodex\n\n%2\tnode\tnode omx.js hud --watch'), []);
    assert.deepEqual(parseTmuxPaneSnapshot('%1\tcodex\tcodex\n%1\tnode\tnode omx.js hud --watch'), []);
    assert.equal(parsePaneIdFromTmuxOutput('%1\n\n'), null);
  });

  it('rejects unsafe or ambiguous fresh pane observations atomically', () => {
    for (const paneId of unsafePaneIds) {
      assert.deepEqual(parseTmuxPaneSnapshot(`%1\tcodex\tcodex\n${paneId}\tnode\tnode omx.js hud --watch`), []);
      assert.equal(parsePaneIdFromTmuxOutput(`${paneId}\n`), null);
    }
    assert.deepEqual(parseTmuxPaneSnapshot('%1\tcodex\tcodex\n%1\tnode\tnode omx.js hud --watch'), []);
    assert.equal(parsePaneIdFromTmuxOutput('%2\n%3\n'), null);
  });

  it('rejects a HUD pane that becomes dead during delayed authority stabilization', () => {
    const options = new Map<string, string>();
    let split = false;
    let strictProbeCount = 0;
    let splitStartCommand = '';
    const execTmuxSync = (args: string[]) => {
      const format = args.at(-1);
      if (args[0] === 'set-option') {
        options.set(args[2]!, args[3]!);
        return '';
      }
      if (args[0] === 'show-options') return `${options.get(args.at(-1)!) ?? ''}\n`;
      if (args[0] === 'split-window') {
        split = true;
        splitStartCommand = args.at(-1)!;
        return '%2\n';
      }
      if (args[0] === 'list-panes' && format === '#{pane_id}\t#{pane_start_command}') {
        return split ? `%1\tcodex\n%2\t${splitStartCommand}\n` : '%1\tcodex\n';
      }
      if (args[0] === 'list-panes' && format === '#{pane_id} #{pane_dead} #{pane_pid}') {
        strictProbeCount += 1;
        return strictProbeCount > 9 ? '%1 0 101\n%2 1 202\n' : '%1 0 101\n%2 0 202\n';
      }
      if (args[0] === 'list-panes' && format === '#{pane_id}') return split ? '%1\n%2\n' : '%1\n';
      throw new Error(`unexpected tmux argv: ${args.join(' ')}`);
    };

    const paneId = createHudWatchPane('/repo', 'node omx.js hud --watch', { targetPaneId: '%1' }, execTmuxSync);
    assert.equal(paneId, '%2');
    assert.equal(verifyHudWatchPaneAuthority('%2', execTmuxSync), false);
  });

  it('does not adopt or roll back a same-id HUD pane whose operation marker disappeared after recovery', () => {
    const options = new Map<string, string>();
    const calls: string[][] = [];
    let split = false;
    let markerProbeCount = 0;
    let splitStartCommand = '';
    const execTmuxSync = (args: string[]) => {
      calls.push(args);
      const format = args.at(-1);
      if (args[0] === 'set-option') {
        options.set(args[2]!, args[3]!);
        return '';
      }
      if (args[0] === 'show-options') return `${options.get(args.at(-1)!) ?? ''}\n`;
      if (args[0] === 'split-window') {
        split = true;
        splitStartCommand = args.at(-1)!;
        return '%2\n';
      }
      if (args[0] === 'list-panes' && format === '#{pane_id}') return split ? '%1\n%2\n' : '%1\n';
      if (args[0] === 'list-panes' && format === '#{pane_id}\t#{pane_start_command}') {
        markerProbeCount += 1;
        return markerProbeCount === 1
          ? `%1\tcodex\n%2\t${splitStartCommand}\n`
          : '%1\tcodex\n%2\tforeign-command\n';
      }
      throw new Error(`unexpected tmux argv: ${args.join(' ')}`);
    };

    assert.equal(createHudWatchPane('/repo', 'node omx.js hud --watch', { targetPaneId: '%1' }, execTmuxSync), null);
    assert.equal(calls.some((args) => args[0] === 'kill-pane' || args[0] === 'resize-pane' || args[0] === 'set-hook'), false);
  });

  it('rejects unsafe targets before kill, resize, hook, list, or split commands', () => {
    const calls: string[][] = [];
    const execTmuxSync = (args: string[]) => {
      calls.push(args);
      return '%2\n';
    };
    for (const paneId of unsafePaneIds) {
      assert.equal(killTmuxPane(paneId, execTmuxSync), false);
      assert.equal(resizeTmuxPane(paneId, 3, execTmuxSync), false);
      assert.equal(registerHudResizeHook(paneId, '%1', 3, execTmuxSync), false);
      assert.equal(registerHudResizeHook('%2', paneId, 3, execTmuxSync), false);
      assert.deepEqual(listCurrentWindowHudPaneIds(paneId, execTmuxSync), []);
      assert.equal(createHudWatchPane('/repo', 'node omx.js hud --watch', { targetPaneId: paneId }, execTmuxSync), null);
    }
    assert.deepEqual(calls, []);
    assert.equal(
      createHudWatchPane('/repo', 'node omx.js hud --watch', { targetPaneId: '%1' }, () => '%01\n'),
      null,
    );
  });

  it('rejects newline-injected HUD metadata rows absent from the authoritative pane-id snapshot', () => {
    const calls: string[][] = [];
    const paneIds = listCurrentWindowHudPaneIds(undefined, (args) => {
      calls.push(args);
      if (args.at(-1) === '#{pane_id}') return '%1\n';
      return [
        ['%1', 'codex', 'codex'].join('\x1f'),
        ['%30', 'node', 'node omx.js hud --watch'].join('\x1f'),
      ].join('\n');
    });

    assert.deepEqual(paneIds, []);
    assert.equal(calls.length, 2);
  });

  it('invalidates unsafe owner leaders and preserves an unsafe reaper batch without kills', () => {
    for (const paneId of unsafePaneIds) {
      const [pane] = parseTmuxPaneSnapshot(
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='${paneId}' node omx.js hud --watch`,
      );
      assert.deepEqual(readHudPaneOwner(pane!), { sessionId: undefined, leaderPaneId: undefined });
      assert.equal(hudPaneMatchesOwner(pane!, { sessionId: 'sess-a', leaderPaneId: '%1' }), false);
      assert.deepEqual(buildHudRuntimeEnv({ sessionId: 'sess-a', leaderPaneId: paneId }).owner, { sessionId: 'sess-a' });
    }

    const killed: string[] = [];
    const result = reapDeadHudPanes([{
      paneId: '%01',
      currentCommand: 'node',
      startCommand: `exec env OMX_TMUX_HUD_OWNER=1 ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' node omx.js hud --watch`,
    }], {
      isLivePane: () => false,
      killPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
    });
    assert.deepEqual(killed, []);
    assert.deepEqual(result, { reaped: [], preserved: ['%01'] });
  });
});

describe('HUD resize hook helpers', () => {
  it('builds a deterministic hook name from the tmux session, window, and leader identity', () => {
    assert.equal(buildHudResizeHookName('$7', '@3', '%1'), 'omx_hud_resize_7_3_1');
  });

  it('builds a bounded numeric client-resized slot', () => {
    const slot = buildHudResizeHookSlot('omx_hud_resize_7_3_1');
    assert.match(slot, /^client-resized\[\d+\]$/);

    const index = Number.parseInt(slot.replace(/^client-resized\[|\]$/g, ''), 10);
    assert.ok(index >= 0);
    assert.ok(index < 2147483647);
  });

  it('builds a bounded numeric window-layout-changed slot', () => {
    const slot = buildHudLayoutHookSlot('omx_hud_resize_7_3_1');
    assert.match(slot, /^window-layout-changed\[\d+\]$/);

    const index = Number.parseInt(slot.replace(/^window-layout-changed\[|\]$/g, ''), 10);
    assert.ok(index >= 0);
    assert.ok(index < 2147483647);
  });

  it('parses hook context from tmux display-message output', () => {
    const context = parseHudResizeHookContext('$7\t@3\n', '%1');

    assert.deepEqual(context, {
      sessionId: '$7',
      windowId: '@3',
      leaderPaneId: '%1',
      leaderPanePid: '1',
      hudPaneId: '%1',
      hudPanePid: '1',
      hookName: 'omx_hud_resize_7_3_1',
      hookSlot: buildHudResizeHookSlot('omx_hud_resize_7_3_1'),
      layoutHookSlot: buildHudLayoutHookSlot('omx_hud_resize_7_3_1'),
    });
  });

  it('rejects malformed tmux ids in hook context output', () => {
    assert.equal(parseHudResizeHookContext('$7; touch /tmp/owned\t@3\n', '%1'), null);
    assert.equal(parseHudResizeHookContext('$7\t@3$(touch /tmp/owned)\n', '%1'), null);
    assert.equal(parseHudResizeHookContext('$7\t@3\n', '%1; touch /tmp/owned'), null);
  });

  it('registers client-resized and layout-change hooks at session scope with exact HUD pane targeting', () => {
    const calls: string[][] = [];

    const result = registerHudResizeHook(
      '%9',
      '%1',
      3,
      { cwd: '/repo', env: { TMUX: '/tmp/tmux', OMX_SESSION_ID: 'sess-a' } },
      (args) => {
        calls.push(args);
        if (args[0] === 'display-message') return '$7\t@3\n';
        if (args[0] === 'list-panes') return '%1 0 101\n%9 0 909\n';
        return '';
      },
    );

    const hookSlot = buildHudResizeHookSlot('omx_hud_resize_7_3_1');
    const layoutHookSlot = buildHudLayoutHookSlot('omx_hud_resize_7_3_1');
    assert.equal(result, true);
    assert.deepEqual(calls[0], ['list-panes', '-a', '-F', '#{pane_id} #{pane_dead} #{pane_pid}']);
    assert.deepEqual(calls[1], ['display-message', '-p', '-t', '%1', '#{session_id}\t#{window_id}']);
    assert.equal(calls[2]?.[0], 'set-hook');
    assert.equal(calls[2]?.[1], '-t');
    assert.equal(calls[2]?.[2], '$7');
    assert.equal(calls[2]?.[3], hookSlot);
    const resizeHook = calls[2]?.[4] ?? '';
    assert.match(resizeHook, /^run-shell -b /);
    // Each delayed resize is one tmux server transaction: the outer if-shell
    // is argv-framed, while the HUD conditional is its quoted true branch.
    assert.equal((resizeHook.match(/'\\''if-shell'\\'' '\\''-F'\\'' '\\''-t'\\'' '\\''%1'\\''/g) ?? []).length, 2);
    assert.equal((resizeHook.match(/'\\''if-shell -F -t %9 /g) ?? []).length, 2);
    assert.match(resizeHook, /'\\''#\{&&:#\{==:#\{pane_id\},%1\},#\{&&:#\{==:#\{pane_dead\},0\},#\{==:#\{pane_pid\},101\}\}\}'\\''/);
    assert.match(resizeHook, /'\\''if-shell -F -t %9 /);
    assert.match(resizeHook, /#\{pane_dead\}/);
    assert.match(resizeHook, /%1.*101/);
    assert.match(resizeHook, /%9.*909/);
    assert.match(resizeHook, /resize-pane/);
    assert.match(resizeHook, /set-hook/);
    assert.doesNotMatch(resizeHook, /list-panes|awk/);
    assert.match(resizeHook, /env TMUX=/);
    assert.doesNotMatch(resizeHook, /'-w'/);
    assert.match(resizeHook, new RegExp(`sleep ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}`));
    assert.match(resizeHook, new RegExp(hookSlot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(calls[3]?.[0], 'set-hook');
    assert.equal(calls[3]?.[1], '-t');
    assert.equal(calls[3]?.[2], '$7');
    assert.equal(calls[3]?.[3], layoutHookSlot);
    const layoutHook = calls[3]?.[4] ?? '';
    assert.match(layoutHook, /^run-shell -b /);
    assert.equal((layoutHook.match(/'\\''if-shell'\\'' '\\''-F'\\'' '\\''-t'\\'' '\\''%1'\\''/g) ?? []).length, 1);
    assert.equal((layoutHook.match(/'\\''if-shell -F -t %9 /g) ?? []).length, 1);
    assert.match(layoutHook, /#\{&&:#\{==:#\{pane_id\},%1\}/);
    assert.doesNotMatch(layoutHook, /list-panes/);
    assert.match(layoutHook, /--reconcile-tmux/);
    assert.match(layoutHook, /TMUX/);
    assert.match(layoutHook, /TMUX_PANE/);
    assert.match(layoutHook, /OMX_TMUX_HUD_OWNER/);
    assert.doesNotMatch(layoutHook, /wait-for/);
  });

  it('reports partial failure but keeps the resize hook when layout-change hook install fails', () => {
    const calls: string[][] = [];
    const hookSlot = buildHudResizeHookSlot('omx_hud_resize_7_3_1');
    const layoutHookSlot = buildHudLayoutHookSlot('omx_hud_resize_7_3_1');

    const result = registerHudResizeHook(
      '%9',
      '%1',
      3,
      { cwd: '/repo', env: { TMUX: '/tmp/tmux', OMX_SESSION_ID: 'sess-a' } },
      (args) => {
        calls.push(args);
        if (args[0] === 'display-message') return '$7\t@3\n';
        if (args[0] === 'list-panes') return '%1 0 101\n%9 0 909\n';
        if (args[0] === 'set-hook' && args[3] === layoutHookSlot) {
          throw new Error('layout hook rejected');
        }
        return '';
      },
    );

    assert.equal(result, false);
    assert.deepEqual(calls[2]?.slice(0, 4), ['set-hook', '-t', '$7', hookSlot]);
    assert.deepEqual(calls[3]?.slice(0, 4), ['set-hook', '-t', '$7', layoutHookSlot]);
  });

  it('unregisters the same per-window hook slot', () => {
    const calls: string[][] = [];

    const result = unregisterHudResizeHook('%1', (args) => {
      calls.push(args);
      if (args[0] === 'display-message') return '$7\t@3\n';
      return '';
    });

    assert.equal(result, true);
    assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%1', '#{session_id}\t#{window_id}']);
    for (const call of calls.slice(1)) {
      assert.deepEqual(call.slice(0, 4), ['if-shell', '-F', '-t', '$7']);
      assert.match(call[4] ?? '', /^#\{==:@omx_hook_identity_(client_resized|window_layout_changed)_\d+,omx-[0-9a-f]+\}$/);
      assert.match(call[5] ?? '', /^set-hook -u -t \$7 /);
    }
  });

  it('attempts to unregister the layout hook even when resize hook unregister fails', () => {
    const calls: string[][] = [];

    const result = unregisterHudResizeHook('%1', (args) => {
      calls.push(args);
      if (args[0] === 'display-message') return '$7\t@3\n';
      if (args[0] === 'if-shell' && args[5]?.includes(buildHudResizeHookSlot('omx_hud_resize_7_3_1'))) {
        throw new Error('resize hook unregister rejected');
      }
      return '';
    });

    assert.equal(result, false);
    assert.deepEqual(calls[1]?.slice(0, 4), ['if-shell', '-F', '-t', '$7']);
    assert.match(calls[1]?.[4] ?? '', /^#\{==:@omx_hook_identity_client_resized_\d+,omx-[0-9a-f]+\}$/);
    assert.match(calls[1]?.[5] ?? '', /^set-hook -u -t \$7 client-resized\[\d+\]/);
    assert.deepEqual(calls[2]?.slice(0, 4), ['if-shell', '-F', '-t', '$7']);
    assert.match(calls[2]?.[4] ?? '', /^#\{==:@omx_hook_identity_window_layout_changed_\d+,omx-[0-9a-f]+\}$/);
    assert.match(calls[2]?.[5] ?? '', /^set-hook -u -t \$7 window-layout-changed\[\d+\]/);
  });

  it('uses distinct hook slots for different windows in the same session', () => {
    const registered: string[][] = [];

    const execFor = (windowId: string) => (args: string[]) => {
      if (args[0] === 'display-message') return `$7\t${windowId}\n`;
      if (args[0] === 'list-panes') return '%1 0 101\n%2 0 102\n%9 0 909\n%10 0 910\n';
      registered.push(args);
      return '';
    };

    assert.equal(registerHudResizeHook('%9', '%1', 3, execFor('@3')), true);
    assert.equal(registerHudResizeHook('%10', '%2', 3, execFor('@4')), true);

    const firstSlot = registered[0]?.[3];
    const secondSlot = registered[2]?.[3];
    assert.match(firstSlot ?? '', /^client-resized\[\d+\]$/);
    assert.match(secondSlot ?? '', /^client-resized\[\d+\]$/);
    assert.notEqual(firstSlot, secondSlot);
  });

  it('uses distinct hook slots for different leaders in the same session window', () => {
    const registered: string[][] = [];
    const execTmuxSync = (args: string[]) => {
      if (args[0] === 'display-message') return '$7\t@3\n';
      if (args[0] === 'list-panes') return '%1 0 101\n%2 0 102\n%9 0 909\n%10 0 910\n';
      registered.push(args);
      return '';
    };

    assert.equal(registerHudResizeHook('%9', '%1', 3, execTmuxSync), true);
    assert.equal(registerHudResizeHook('%10', '%2', 3, execTmuxSync), true);

    const firstSlot = registered[0]?.[3];
    const secondSlot = registered[2]?.[3];
    assert.match(firstSlot ?? '', /^client-resized\[\d+\]$/);
    assert.match(secondSlot ?? '', /^client-resized\[\d+\]$/);
    assert.notEqual(firstSlot, secondSlot);
  });

  it('reuses the same hook slot when a HUD pane is recreated for the same leader', () => {
    const registered: string[][] = [];
    const execTmuxSync = (args: string[]) => {
      if (args[0] === 'display-message') return '$7\t@3\n';
      if (args[0] === 'list-panes') return '%1 0 101\n%9 0 909\n%10 0 910\n';
      registered.push(args);
      return '';
    };

    assert.equal(registerHudResizeHook('%9', '%1', 3, execTmuxSync), true);
    assert.equal(registerHudResizeHook('%10', '%1', 3, execTmuxSync), true);

    assert.equal(registered[0]?.[3], registered[2]?.[3]);
  });

  it('does not unregister the legacy hook when installing the leader-scoped hook fails', () => {
    const calls: string[][] = [];

    const result = registerHudResizeHook('%9', '%1', 3, (args) => {
      calls.push(args);
      if (args[0] === 'display-message') return '$7\t@3\n';
      if (args[0] === 'list-panes') return '%1 0 101\n%9 0 909\n';
      if (args[0] === 'set-hook' && args[1] === '-t') throw new Error('transient tmux failure');
      return '';
    });

    assert.equal(result, false);
    assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
      ['list-panes', '-a'],
      ['display-message', '-p'],
      ['set-hook', '-t'],
    ]);
  });

  it('keeps registration successful when legacy cleanup fails after installing the leader-scoped hook', () => {
    const calls: string[][] = [];

    const result = registerHudResizeHook('%9', '%1', 3, (args) => {
      calls.push(args);
      if (args[0] === 'display-message') return '$7\t@3\n';
      if (args[0] === 'list-panes') return '%1 0 101\n%9 0 909\n';
      if (args[0] === 'set-hook' && args[1] === '-u') throw new Error('stale legacy cleanup failure');
      return '';
    });

    assert.equal(result, true);
    assert.equal(calls[2]?.[0], 'set-hook');
    assert.equal(calls[2]?.[1], '-t');
    assert.equal(calls[3]?.[0], 'set-hook');
    assert.equal(calls[3]?.[1], '-t');
  });

  it('unregisters only the leader-scoped hook slot for the selected leader', () => {
    const unregistered: string[][] = [];
    const execTmuxSync = (args: string[]) => {
      if (args[0] === 'display-message') return '$7\t@3\n';
      unregistered.push(args);
      return '';
    };

    assert.equal(unregisterHudResizeHook('%2', execTmuxSync), true);

    for (const call of unregistered) {
      assert.deepEqual(call.slice(0, 4), ['if-shell', '-F', '-t', '$7']);
      assert.match(call[4] ?? '', /^#\{==:@omx_hook_identity_(client_resized|window_layout_changed)_\d+,omx-[0-9a-f]+\}$/);
      assert.match(call[5] ?? '', /^set-hook -u -t \$7 /);
    }
  });
});

describe('HUD pane ownership helpers', () => {
  it('parses pane geometry from tmux pane snapshots without corrupting the start command or cwd', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%2\tnode\t0\t47\t160\t3\t49\t160\t50\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch\t/tmp/repo`,
    );

    assert.deepEqual(pane, {
      paneId: '%2',
      currentCommand: 'node',
      paneLeft: 0,
      paneTop: 47,
      paneWidth: 160,
      paneHeight: 3,
      paneBottom: 49,
      windowWidth: 160,
      windowHeight: 50,
      startCommand: `exec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx hud --watch`,
      currentPath: '/tmp/repo',
    });
  });

  it('rejects noncanonical, signed, exponent, and out-of-range HUD geometry fields', () => {
    for (const value of ['160px', '+160', '-1', '1e2', ' 160', '160 ', '4294967296']) {
      const panes = parseTmuxPaneSnapshot(
        `%2\tnode\t0\t47\t${value}\t3\t49\t160\t50\tnode omx hud --watch\t/tmp/repo`,
      );
      assert.deepEqual(panes, [], value);
    }
  });

  it('parses independently valid current-window geometry fields without numeric prefixes', () => {
    for (const [output, expected] of [
      ['160px\t50\n', { width: null, height: 50 }],
      ['+160\t50\n', { width: null, height: 50 }],
      ['1e2\t50\n', { width: null, height: 50 }],
      ['160\t4294967296\n', { width: 160, height: null }],
    ] satisfies Array<[string, { width: number | null; height: number | null }]>) {
      assert.deepEqual(readCurrentWindowSize(() => output), expected, output);
    }
  });

  it('reads session and leader ownership from env-prefixed HUD commands', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%9\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
    );

    assert.deepEqual(readHudPaneOwner(pane!), {
      sessionId: 'sess-a',
      leaderPaneId: '%1',
    });
    assert.equal(hudPaneMatchesOwner(pane!, { sessionId: 'sess-a', leaderPaneId: '%1' }), true);
    assert.equal(hudPaneMatchesOwner(pane!, { sessionId: 'sess-b', leaderPaneId: '%2' }), false);
  });

  it('reads ownership from quoted tmux shell env arguments used by inside-tmux launch', () => {
    const [pane] = parseTmuxPaneSnapshot(
      `%9\tnode\t/bin/zsh -c 'exec '\\''env'\\'' '\\''OMX_SESSION_ID=sess-a'\\'' '\\''${OMX_TMUX_HUD_LEADER_PANE_ENV}=%1'\\'' '\\''node'\\'' '\\''/omx.js'\\'' '\\''hud'\\'' '\\''--watch'\\'''`,
    );

    assert.deepEqual(readHudPaneOwner(pane!), {
      sessionId: 'sess-a',
      leaderPaneId: '%1',
    });
  });

  it('fails closed on POSIX owner text that is not an unambiguous assignment word', () => {
    const commands = [
      "node omx.js hud --watch --preset=focused 'OMX_SESSION_ID=session-a'",
      "# OMX_SESSION_ID=session-a\nnode omx.js hud --watch --preset=focused",
      'exec env OMX_SESSION_ID=session-a; node omx.js hud --watch',
      'exec env OMX_SESSION_ID=session-a|node omx.js hud --watch',
      'exec env OMX_SESSION_ID=session-a OMX_SESSION_ID=session-b node omx.js hud --watch',
    ];
    for (const startCommand of commands) {
      const pane = { paneId: '%9', currentCommand: 'node', startCommand };
      assert.deepEqual(readHudPaneOwner(pane), { sessionId: undefined, leaderPaneId: undefined });
      assert.deepEqual(findLegacyFocusedHudWatchPaneIds([pane], '%1'), []);
    }
  });

  it('does not case-fold POSIX owner assignment keys', () => {
    const pane = {
      paneId: '%9',
      currentCommand: 'node',
      startCommand: "exec env omx_session_id='session-a' omx_tmux_hud_owner='1' omx_tmux_hud_leader_pane='%1' node omx.js hud --watch",
    };
    assert.deepEqual(readHudPaneOwner(pane), { sessionId: undefined, leaderPaneId: undefined });
    assert.equal(hudPaneMatchesOwner(pane, { sessionId: 'session-a', leaderPaneId: '%1' }), false);
  });

  it('reads and matches PowerShell HUD owner assignments with case-insensitive keys and literal quote decoding', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\t$env:omx_session_id = 'session ''quoted'''; $ENV:omx_tmux_hud_owner = '1'; $eNv:omx_tmux_hud_leader_pane = '%1'; & 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Program Files\\OMX\\omx.js' hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(readHudPaneOwner(panes[1]!), {
      sessionId: "session 'quoted'",
      leaderPaneId: '%1',
    });
    assert.equal(hudPaneMatchesOwner(panes[1]!, { sessionId: "session 'quoted'", leaderPaneId: '%1' }), true);
    assert.deepEqual(
      findHudWatchPaneIds(panes, '%1', { sessionId: "session 'quoted'", leaderPaneId: '%1' }),
      ['%2'],
    );
  });

  it('round-trips native-Windows generated ownership through the shared parser', () => {
    const command = buildHudStartupCommand('/opt/omx.js', {
      OMX_TMUX_HUD_OWNER: '1',
      OMX_SESSION_ID: "session 'quoted'",
      [OMX_TMUX_HUD_LEADER_PANE_ENV]: '%1',
    }, undefined, 'win32');
    const pane = { paneId: '%2', currentCommand: 'node.exe', startCommand: command };
    assert.deepEqual(readHudPaneOwner(pane), {
      sessionId: "session 'quoted'",
      leaderPaneId: '%1',
    });
    assert.equal(hudPaneMatchesOwner(pane, { sessionId: "session 'quoted'", leaderPaneId: '%1' }), true);
  });

  it('treats PowerShell owner-marker-only HUD commands as owned metadata instead of legacy fallback', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\t$env:OMX_TMUX_HUD_OWNER = '1'; & node omx.js hud --watch --preset=focused`,
      ].join('\n'),
    );

    assert.deepEqual(readHudPaneOwner(panes[1]!), { sessionId: undefined, leaderPaneId: undefined });
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'session-a', leaderPaneId: '%1' }), []);
    assert.deepEqual(findLegacyFocusedHudWatchPaneIds(panes, '%1'), []);
  });

  it('rejects duplicate or mixed PowerShell ownership assignments instead of trusting the first value', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\t$env:OMX_SESSION_ID = 'session-a'; $env:OMX_SESSION_ID = 'session-b'; $env:OMX_TMUX_HUD_OWNER = '1'; $env:OMX_TMUX_HUD_LEADER_PANE = '%1'; & node omx.js hud --watch --preset=focused`,
        `%3\tnode\tOMX_SESSION_ID='session-a'; $env:OMX_SESSION_ID = 'session-b'; $env:OMX_TMUX_HUD_OWNER = '1'; & node omx.js hud --watch --preset=focused`,
        `%4\tnode\t$env:OMX_TMUX_HUD_OWNER = '1'; $env:OMX_TMUX_HUD_LEADER_PANE = '%1'; $env:OMX_TMUX_HUD_LEADER_PANE = '%9'; & node omx.js hud --watch --preset=focused`,
        `%5\tnode\t$env:OMX_SESSION_ID = 'session-a'; $env:OMX_TMUX_HUD_OWNER = '1'; $env:OMX_TMUX_HUD_LEADER_PANE = '%1'; & Write-Output x; $env:omx_session_id = 'session-b'; & node omx.js hud --watch --preset=focused`,
      ].join('\n'),
    );

    for (const pane of panes.slice(1)) {
      assert.deepEqual(readHudPaneOwner(pane), { sessionId: undefined, leaderPaneId: undefined });
      assert.equal(hudPaneMatchesOwner(pane, { sessionId: 'session-a', leaderPaneId: '%1' }), false);
      assert.equal(hudPaneMatchesOwner(pane, { leaderPaneId: '%1' }), false);
    }
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'session-a', leaderPaneId: '%1' }), []);
    assert.deepEqual(findLegacyFocusedHudWatchPaneIds(panes, '%1'), []);
  });

  it('fails closed on duplicate POSIX owner keys, including quoted tmux-shell assignments', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='session-a' OMX_SESSION_ID='session-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' node omx.js hud --watch --preset=focused`,
        `%3\tnode\texec env OMX_SESSION_ID='session-a' '${OMX_TMUX_HUD_LEADER_PANE_ENV}=%1' '${OMX_TMUX_HUD_LEADER_PANE_ENV}=%9' node omx.js hud --watch --preset=focused`,
        `%4\tnode\t/bin/zsh -c 'exec '\\''env'\\'' '\\''OMX_TMUX_HUD_OWNER=1'\\'' '\\''OMX_TMUX_HUD_OWNER=1'\\'' '\\''node'\\'' '\\''omx.js'\\'' '\\''hud'\\'' '\\''--watch'\\'' '\\''--preset=focused'\\'''`,
      ].join('\n'),
    );

    for (const pane of panes.slice(1)) {
      assert.deepEqual(readHudPaneOwner(pane), { sessionId: undefined, leaderPaneId: undefined });
      assert.equal(hudPaneMatchesOwner(pane, { sessionId: 'session-a', leaderPaneId: '%1' }), false);
    }
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'session-a', leaderPaneId: '%1' }), []);
    assert.deepEqual(findLegacyFocusedHudWatchPaneIds(panes, '%1'), []);
  });

  it('does not treat unrelated PowerShell environment prefixes as OMX owner metadata', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\t$env:PATH = 'C:\\Tools'; & node omx.js hud --watch --preset=focused`,
      ].join('\n'),
    );

    assert.deepEqual(readHudPaneOwner(panes[1]!), { sessionId: undefined, leaderPaneId: undefined });
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'session-a', leaderPaneId: '%1' }), []);
    assert.deepEqual(findLegacyFocusedHudWatchPaneIds(panes, '%1'), ['%2']);
  });

  it('rejects empty, malformed, and near-miss PowerShell owner assignments', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\t$env:OMX_SESSION_ID = ''; & node omx.js hud --watch`,
        `%3\tnode\tprefix$env:OMX_SESSION_ID = 'session-a'; & node omx.js hud --watch`,
        `%4\tnode\t$env:OMX_SESSION_ID = "session-a"; & node omx.js hud --watch`,
        `%5\tnode\t$env:OMX_SESSION_ID = 'session-a'near; & node omx.js hud --watch`,
        `%6\tnode\t<# $env:OMX_SESSION_ID = 'comment-owner'; #>; node omx.js hud --watch --preset=focused`,
        `%7\tnode\tWrite-Output "; $env:OMX_SESSION_ID = 'string-owner'; $env:OMX_TMUX_HUD_LEADER_PANE = '%1';"; node omx.js hud --watch --preset=focused`,
      ].join('\n'),
    );

    for (const pane of panes.slice(1)) {
      assert.deepEqual(readHudPaneOwner(pane), { sessionId: undefined, leaderPaneId: undefined });
      assert.equal(hudPaneMatchesOwner(pane, { sessionId: 'session-a', leaderPaneId: '%1' }), false);
    }
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'session-a', leaderPaneId: '%1' }), []);
    assert.deepEqual(findLegacyFocusedHudWatchPaneIds(panes, '%1'), []);
  });

  it('splits tmux octal-escaped control separators from live list-panes output', () => {
    const escapedSeparator = TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE;
    const panes = parseTmuxPaneSnapshot(
      [
        ['%140', 'node', '', '/home/tools/oh-my-codex'].join(escapedSeparator),
        [
          '%202',
          'node',
          `exec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%140' OMX_ROOT='/tmp/run' '/usr/bin/node' '/repo/dist/cli/omx.js' hud --watch --preset=focused`,
          '/home/tools/oh-my-codex.omx-worktrees/launch-fix-default-subagent-fix',
        ].join(escapedSeparator),
      ].join('\n'),
    );

    assert.equal(panes.length, 2);
    assert.equal(panes[0]?.paneId, '%140');
    assert.equal(panes[0]?.currentCommand, 'node');
    assert.equal(panes[0]?.startCommand, '');
    assert.equal(panes[0]?.currentPath, '/home/tools/oh-my-codex');
    assert.equal(panes[1]?.paneId, '%202');
    assert.equal(panes[1]?.currentCommand, 'node');
    assert.equal(
      panes[1]?.currentPath,
      '/home/tools/oh-my-codex.omx-worktrees/launch-fix-default-subagent-fix',
    );
    assert.deepEqual(readHudPaneOwner(panes[1]!), {
      sessionId: 'sess-a',
      leaderPaneId: '%140',
    });
    assert.deepEqual(
      findHudWatchPaneIds(panes, '%140', { sessionId: 'sess-a', leaderPaneId: '%140' }),
      ['%202'],
    );
  });

  it('preserves tab-containing start commands when reading the optional cwd column', () => {
    const [pane] = parseTmuxPaneSnapshot('%9\tnode\tnode\t/omx.js hud --watch\t/tmp/repo');

    assert.equal(pane?.startCommand, 'node\t/omx.js hud --watch');
    assert.equal(pane?.currentPath, '/tmp/repo');
  });

  it('keeps independent leaders in one tmux window from matching each other HUD panes', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        '%3\tcodex\tcodex',
        `%4\tnode\texec env OMX_SESSION_ID='sess-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%3', { sessionId: 'sess-b', leaderPaneId: '%3' }), ['%4']);
    assert.deepEqual(findHudWatchPaneIds(panes, '%3', { sessionId: 'sess-a', leaderPaneId: '%1' }), ['%2']);
  });

  it('matches same-session HUD panes only within the requested leader ownership scope', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3' /node /omx.js hud --watch`,
        "%4\tnode\texec env OMX_SESSION_ID='sess-a' /node /omx.js hud --watch",
        `%5\tnode\texec env OMX_SESSION_ID='sess-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );
    
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), ['%2', '%4']);
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%3' }), ['%3', '%4']);
    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { leaderPaneId: '%1' }), ['%2', '%5']);
  });

  it('does not match session-owned HUD panes when only leader ownership is requested', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_SESSION_ID='sess-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { leaderPaneId: '%1' }), ['%2', '%3']);
  });

  it('does not match leader-only legacy HUD panes when a session owner is requested', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-canonical', leaderPaneId: '%1' }), []);
  });

  it('does not owner-match a different live leader just because the session id matches', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%3\tcodex\tcodex',
        `%4\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), []);
  });

  it('does not owner-match untagged HUD panes when an owner scope is requested', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%2\tnode\tnode /tmp/bin/omx.js hud --watch',
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), []);
    assert.deepEqual(findHudWatchPaneIds(panes, '%1'), ['%2']);
  });

  it('separately detects legacy focused watch panes for automatic reconciliation only', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%2\tnode\tnode /tmp/bin/omx.js hud --watch --preset=focused',
        '%3\tnode\tnode /tmp/bin/omx.js hud --watch --preset=minimal',
        `%4\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch --preset=focused`,
        '%5\tnode\tnode /tmp/bin/omx.js hud --tmux --preset=focused',
        `%6\tnode\t/bin/zsh -c 'exec '\\''node'\\'' '\\''/tmp/bin/omx.js'\\'' '\\''hud'\\'' '\\''--watch'\\'' '\\''--preset=focused'\\'''`,
        '%7\tnode\tnode /tmp/bin/custom-hud.js hud --watch --preset=focused',
        '%8\tnode\tnode /tmp/omx-pr2664/custom-hud.js hud --watch --preset=focused',
        '%9\tnode\tnode /tmp/bin/omx.js hud --tmux --watch --preset=focused',
      ].join('\n'),
    );

    assert.deepEqual(findLegacyFocusedHudWatchPaneIds(panes, '%1'), ['%2', '%6']);
  });

  it('matches session-owned legacy HUD panes without leader tags for same-session cleanup', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        "%2\tnode\texec env OMX_SESSION_ID='sess-a' /node /omx.js hud --watch",
        "%3\tnode\texec env OMX_SESSION_ID='sess-b' /node /omx.js hud --watch",
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), ['%2']);
  });

  it('matches equivalent owner and canonical session ids for the same leader', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='omx-owner-abc' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_SESSION_ID='codex-native-uuid' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%4\tnode\texec env OMX_SESSION_ID='other-session' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%5\tnode\texec env OMX_SESSION_ID='codex-native-uuid' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%5' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(
      findHudWatchPaneIds(panes, '%1', {
        sessionId: 'omx-owner-abc',
        sessionIds: ['omx-owner-abc', 'codex-native-uuid'],
        leaderPaneId: '%1',
      }),
      ['%2', '%3'],
    );
  });

  it('rejects a truncated HUD pane authority snapshot when TMUX_PANE is unavailable', () => {
    const calls: string[][] = [];
    const execTmuxSync = (args: string[]) => {
      calls.push(args);
      if (args.at(-1) === '#{pane_id}') return '%1\n%2';
      return [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n');
    };

    assert.deepEqual(listCurrentWindowHudPaneIds(undefined, execTmuxSync, { sessionId: 'sess-a' }), []);
    assert.deepEqual(calls, [
      ['list-panes', '-F', '#{pane_id}'],
    ]);
  });

  it('keeps active-pane fallback isolated from a different same-session leader HUD', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%3\tcodex\tcodex',
        `%4\tnode\texec env OMX_SESSION_ID='sess-a' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%3' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    assert.deepEqual(findHudWatchPaneIds(panes, '%1', { sessionId: 'sess-a', leaderPaneId: '%1' }), []);
  });

  it('resolves the active tmux pane as a TMUX_PANE fallback', () => {
    const calls: string[][] = [];
    const paneId = readActiveTmuxPaneId((args) => {
      calls.push(args);
      return '%7\n';
    });

    assert.equal(paneId, '%7');
    assert.deepEqual(calls, [['display-message', '-p', '#{pane_id}']]);
  });

  it('tags reconciled HUD watch commands with the leader pane owner', () => {
    const cmd = buildHudWatchCommand('/usr/bin/omx.js', undefined, 'sess-a', undefined, '%1');

    assert.match(cmd, /OMX_SESSION_ID='sess-a'/);
    assert.match(cmd, /OMX_TMUX_HUD_OWNER='1'/);
    assert.match(cmd, new RegExp(`${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1'`));
  });

  it('tags reconciled HUD watch commands as OMX-owned even without a session id', () => {
    const cmd = buildHudWatchCommand('/usr/bin/omx.js', undefined, '', undefined, '%1');

    assert.doesNotMatch(cmd, /OMX_SESSION_ID=/);
    assert.match(cmd, /OMX_TMUX_HUD_OWNER='1'/);
    assert.match(cmd, new RegExp(`${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1'`));
  });
});

describe('dead HUD pane reaper', () => {
  it('ignores team ACK commands that mention HUD preserve repro text', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        [
          '%2',
          'node',
          "node /repo/dist/cli/omx.js team api send-message --input '{\"body\":\"ACK: hud preserve repro just ack\"}' --json",
        ].join('\t'),
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killPane: () => {
        throw new Error('team ACK command should not be classified as a HUD watch pane');
      },
    });

    assert.deepEqual(findHudWatchPaneIds(panes), []);
    assert.deepEqual(result, { reaped: [], preserved: [] });
  });

  it('kills HUD panes whose leader pane is not present in the snapshot', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' /node /omx.js hud --watch`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      killPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
    });

    assert.deepEqual(killed, ['%2']);
    assert.deepEqual(result, { reaped: ['%2'], preserved: [] });
  });

  it('preserves HUD panes whose leader pane is alive', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killPane: () => {
        throw new Error('live leader HUD should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('preserves legacy HUD panes with no leader tag by default', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        '%2\tnode\tnode /tmp/bin/omx.js hud --watch',
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killPane: () => {
        throw new Error('legacy untagged HUD should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('kills untagged HUD panes whose tmux cwd has been deleted', () => {
    const deletedPath = join(tmpdir(), `omx-doctor-native-hook-dist-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' /tmp/bin/omx.js hud --watch\t${deletedPath}`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      killPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
    });

    assert.deepEqual(killed, ['%2']);
    assert.deepEqual(result, { reaped: ['%2'], preserved: [] });
  });

  it('kills deleted-cwd doctor-smoke HUD panes even when an old owner tag points at a live leader', () => {
    const deletedPath = join(tmpdir(), `omx-doctor-plugin-hook-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='doctor-smoke' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch\t${deletedPath}`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      killPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
    });

    assert.deepEqual(killed, ['%2']);
    assert.deepEqual(result, { reaped: ['%2'], preserved: [] });
  });

  it('kills doctor-smoke HUD panes even if a literal deleted-marker cwd was materialized', () => {
    const parent = mkdtempSync(join(tmpdir(), 'omx-doctor-plugin-hook-live-marker-'));
    const materializedDeletedPath = join(parent, 'smoke (deleted)');
    mkdirSync(materializedDeletedPath);
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='omx-doctor-plugin-hook-smoke' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch\t${materializedDeletedPath}`,
      ].join('\n'),
    );
    const killed: string[] = [];

    try {
      const result = reapDeadHudPanes(panes, {
        killPane: (paneId) => {
          killed.push(paneId);
          return true;
        },
      });

      assert.deepEqual(killed, ['%2']);
      assert.deepEqual(result, { reaped: ['%2'], preserved: [] });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('preserves non-doctor deleted-cwd HUD panes while their leader is still live', () => {
    const deletedPath = join(tmpdir(), `omx-live-leader-deleted-cwd-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='sess-live' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch\t${deletedPath}`,
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killPane: () => {
        throw new Error('live leader HUD with stale launch cwd should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('kills deleted-cwd HUD panes when their owner leader is no longer live', () => {
    const deletedPath = join(tmpdir(), `omx-dead-leader-deleted-cwd-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='sess-stale' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' /node /omx.js hud --watch\t${deletedPath}`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      killPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
    });

    assert.deepEqual(killed, ['%2']);
    assert.deepEqual(result, { reaped: ['%2'], preserved: [] });
  });

  it('preserves deleted-cwd HUD panes without unambiguous OMX owner metadata', () => {
    const deletedPath = join(tmpdir(), 'omx-hud-owner-metadata-regression (deleted)');
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\t$env:PATH = 'C:\\Tools'; & node omx.js hud --watch --preset=focused\t${deletedPath}`,
        `%3\tnode\texec env OMX_SESSION_ID='session-a' OMX_SESSION_ID='session-b' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' node omx.js hud --watch --preset=focused\t${deletedPath}`,
        `%4\tnode\texec env OMX_SESSION_ID='session-a' '${OMX_TMUX_HUD_LEADER_PANE_ENV}=%1' '${OMX_TMUX_HUD_LEADER_PANE_ENV}=%9' node omx.js hud --watch --preset=focused\t${deletedPath}`,
        `%5\tnode\t/bin/zsh -c 'exec '\\''env'\\'' '\\''OMX_TMUX_HUD_OWNER=1'\\'' '\\''OMX_TMUX_HUD_OWNER=1'\\'' '\\''node'\\'' '\\''omx.js'\\'' '\\''hud'\\'' '\\''--watch'\\'' '\\''--preset=focused'\\'''\t${deletedPath}`,
        `%6\tnode\texec env OMX_SESSION_ID='' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' node omx.js hud --watch --preset=focused\t${deletedPath}`,
        `%7\tnode\t$env:OMX_SESSION_ID = 'session-a'; & ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' node omx.js hud --watch --preset=focused\t${deletedPath}`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      killPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
    });

    assert.deepEqual(killed, []);
    assert.deepEqual(result, { reaped: [], preserved: ['%2', '%3', '%4', '%5', '%6', '%7'] });
    assert.deepEqual(findLegacyFocusedHudWatchPaneIds(panes, '%1'), ['%2']);
  });

  it('preserves HUD panes in an existing cwd whose name ends with the deleted marker text', () => {
    const parent = mkdtempSync(join(tmpdir(), 'omx-live-cwd-'));
    const liveDeletedSuffixPath = join(parent, 'live (deleted)');
    mkdirSync(liveDeletedSuffixPath);
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\texec env OMX_SESSION_ID='live' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch\t${liveDeletedSuffixPath}`,
      ].join('\n'),
    );

    try {
      const result = reapDeadHudPanes(panes, {
        killPane: () => {
          throw new Error('live cwd with literal marker suffix should not be killed');
        },
      });

      assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('preserves live deleted-marker cwd paths containing tabs from the tmux list separator', () => {
    const parent = mkdtempSync(join(tmpdir(), 'omx-tab-live-cwd-'));
    const liveDeletedSuffixPath = join(parent, 'left\tlive (deleted)');
    mkdirSync(liveDeletedSuffixPath);
    const separator = '\x1f';
    const panes = parseTmuxPaneSnapshot(
      [
        ['%1', 'codex', 'codex', '/repo'].join(separator),
        [
          '%2',
          'node',
          `exec env OMX_SESSION_ID='live' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
          liveDeletedSuffixPath,
        ].join(separator),
      ].join('\n'),
    );

    try {
      const result = reapDeadHudPanes(panes, {
        killPane: () => {
          throw new Error('live tab cwd with literal marker suffix should not be killed');
        },
      });

      assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('preserves deleted-cwd panes with misleading HUD text but no OMX owner metadata', () => {
    const deletedPath = join(tmpdir(), `omx-misleading-hud-text-${process.pid}-${Date.now()} (deleted)`);
    rmSync(deletedPath, { recursive: true, force: true });
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex\t/repo',
        `%2\tnode\tSUCCESS but not an OMX pane: hud --watch\t${deletedPath}`,
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killPane: () => {
        throw new Error('misleading non-OMX HUD text should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: ['%2'] });
  });

  it('does not touch non-HUD panes', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' /node /omx.js sidecar --watch`,
      ].join('\n'),
    );

    const result = reapDeadHudPanes(panes, {
      killPane: () => {
        throw new Error('non-HUD panes should not be killed');
      },
    });

    assert.deepEqual(result, { reaped: [], preserved: [] });
  });

  it('uses an explicit live-pane predicate for reaper decisions', () => {
    const panes = parseTmuxPaneSnapshot(
      [
        '%1\tcodex\tcodex',
        `%2\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%1' /node /omx.js hud --watch`,
        `%3\tnode\texec env OMX_TMUX_HUD_OWNER='1' ${OMX_TMUX_HUD_LEADER_PANE_ENV}='%9' /node /omx.js hud --watch`,
      ].join('\n'),
    );
    const killed: string[] = [];

    const result = reapDeadHudPanes(panes, {
      isLivePane: (paneId) => paneId === '%9',
      killPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
    });

    assert.deepEqual(killed, ['%2']);
    assert.deepEqual(result, { reaped: ['%2'], preserved: ['%3'] });
  });
});
