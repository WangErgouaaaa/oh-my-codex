import { randomUUID } from 'node:crypto';
import { safeString } from './utils.js';
import { runProcess } from './process-runner.js';
import { parseCanonicalTmuxPaneId, parseExactTmuxAuthorityScalar } from '../../hud/tmux.js';
import {
  buildCapturePaneArgv,
  buildPaneInModeArgv,
  buildPaneCurrentCommandArgv,
  buildSendKeysArgv,
  isPaneRunningShell,
  paneHasActiveTask,
  paneLooksReady,
} from '../tmux-hook-engine.js';

export const PANE_READINESS_UNVERIFIED_REASON = 'pane_readiness_unverified';
let nextTmuxBufferId = 0;

function buildSafePasteArgv(target: string, prompt: string): {
  bufferName: string;
  setBufferArgv: string[];
  showBufferArgv: string[];
  clearComposerArgv: string[];
  pasteBufferArgv: string[];
  deleteBufferArgv: string[];
} {
  nextTmuxBufferId += 1;
  const bufferName = `omx-pane-input-${process.pid}-${Date.now()}-${nextTmuxBufferId}`;
  return {
    bufferName,
    setBufferArgv: ['set-buffer', '-b', bufferName, '--', prompt],
    showBufferArgv: ['show-buffer', '-b', bufferName],
    clearComposerArgv: ['send-keys', '-t', target, 'C-u'],
    pasteBufferArgv: ['paste-buffer', '-t', target, '-b', bufferName, '-p', '-d'],
    deleteBufferArgv: ['delete-buffer', '-b', bufferName],
  };
}


export function mapPaneInjectionReadinessReason(reason: any): any {
  return reason === 'pane_running_shell' ? 'agent_not_running' : reason;
}

export async function evaluatePaneInjectionReadiness(paneTarget: any, {
  skipIfScrolling = false,
  captureLines = 80,
  requireRunningAgent = true,
  requireReady = true,
  requireIdle = true,
  requireObservableState = false,
  requireCaptureEvidence = undefined,
} = {}): Promise<any> {
  const normalizedRequireObservableState = typeof requireCaptureEvidence === 'boolean' ? requireCaptureEvidence : requireObservableState;
  const requestedTarget = safeString(paneTarget);
  const target = parseCanonicalTmuxPaneId(requestedTarget);
  if (!target || target !== requestedTarget) {
    return {
      ok: false,
      sent: false,
      reason: 'missing_pane_target',
      paneTarget: '',
      paneCurrentCommand: '',
      paneCapture: '',
    };
  }
  if (skipIfScrolling) {
    try {
      const modeResult = await runProcess('tmux', buildPaneInModeArgv(target), 3000);
      if (safeString(modeResult.stdout).trim() === '1') {
        return {
          ok: false,
          sent: false,
          reason: 'scroll_active',
          paneTarget: target,
          paneCurrentCommand: '',
          paneCapture: '',
        };
      }
    } catch {
      // Non-fatal: continue with remaining preflight checks.
    }
  }

  let paneCurrentCommand = '';
  let paneRunningShell = false;
  const buildReadinessResult = (ok: boolean, reason: string, paneCapture: string, readinessEvidence: string) => ({
    ok,
    sent: false,
    reason,
    paneTarget: target,
    paneCurrentCommand,
    paneCapture,
    readinessEvidence,
  });
  try {
    const result = await runProcess('tmux', buildPaneCurrentCommandArgv(target), 3000);
    paneCurrentCommand = safeString(result.stdout).trim();
    paneRunningShell = requireRunningAgent && isPaneRunningShell(paneCurrentCommand);
  } catch {
    paneCurrentCommand = '';
  }

  try {
    const capture = await runProcess('tmux', buildCapturePaneArgv(target, captureLines), 3000);
    const paneCapture = safeString(capture.stdout);
    if (!paneCapture || paneCapture.includes('\r') || !paneCapture.endsWith('\n') || paneCapture.endsWith('\n\n')) {
      return buildReadinessResult(false, 'capture_evidence_invalid', '', 'capture_invalid');
    }
    const hasCaptureEvidence = paneCapture.slice(0, -1).trim() !== '';
    if (hasCaptureEvidence) {
      const paneShowsLiveAgent = paneLooksReady(paneCapture) || paneHasActiveTask(paneCapture);
      if (paneRunningShell && !paneShowsLiveAgent) {
        return buildReadinessResult(false, 'pane_running_shell', paneCapture, 'captured');
      }
      if (requireIdle && paneHasActiveTask(paneCapture)) {
        return buildReadinessResult(false, 'pane_has_active_task', paneCapture, 'captured');
      }
      if (requireReady && !paneLooksReady(paneCapture)) {
        return buildReadinessResult(false, 'pane_not_ready', paneCapture, 'captured');
      }
      if (normalizedRequireObservableState && !paneShowsLiveAgent) {
        return buildReadinessResult(false, PANE_READINESS_UNVERIFIED_REASON, paneCapture, 'captured_unverified');
      }
      if (requireObservableState && !paneShowsLiveAgent) {
        return {
          ok: false,
          sent: false,
          reason: 'pane_state_unverified',
          paneTarget: target,
          paneCurrentCommand,
          paneCapture,
        };
      }
    }
    if (paneRunningShell && !hasCaptureEvidence) {
      return {
        ok: false,
        sent: false,
        reason: 'pane_running_shell',
        paneTarget: target,
        paneCurrentCommand,
        paneCapture,
      };
    }
    if (normalizedRequireObservableState && !hasCaptureEvidence && !paneCurrentCommand) {
      return buildReadinessResult(false, PANE_READINESS_UNVERIFIED_REASON, paneCapture, 'capture_empty');
    }
    return buildReadinessResult(true, 'ok', paneCapture, hasCaptureEvidence ? 'captured' : (paneCurrentCommand ? 'command_only' : 'none'));
  } catch {
    if (paneRunningShell) {
      return buildReadinessResult(false, 'pane_running_shell', '', 'capture_failed');
    }
    if (normalizedRequireObservableState) {
      return buildReadinessResult(false, PANE_READINESS_UNVERIFIED_REASON, '', 'capture_failed');
    }
    return buildReadinessResult(true, 'ok', '', paneCurrentCommand ? 'command_only' : 'none');
  }
}

function parseExactPaneAuthoritySnapshot(value: any): { paneId: string; panePid: string } | null {
  const raw = safeString(value);
  if (!raw || raw.includes('\r') || !raw.endsWith('\n') || raw.endsWith('\n\n')) return null;
  const [rawPaneId, paneDead, panePid, ...extra] = raw.slice(0, -1).split('\t');
  const paneId = parseCanonicalTmuxPaneId(rawPaneId);
  if (extra.length > 0 || !paneId || paneDead !== '0' || !/^[1-9][0-9]*$/.test(panePid)) return null;
  return { paneId, panePid };
}

function paneAuthorityFormat(paneId: string, panePid: string): string {
  return `#{&&:#{==:#{pane_id},${paneId}},#{&&:#{==:#{pane_dead},0},#{==:#{pane_pid},${panePid}}}}`;
}

async function runPaneMutationAtomically(paneId: string, panePid: string, command: string[]): Promise<boolean> {
  const receipt = randomUUID().replace(/-/g, '');
  if (!/^[a-f0-9]{32}$/.test(receipt)) return false;
  const quoted = `${command.map((arg) => `'${arg.replace(/'/g, "\\'")}'`).join(' ')} ; display-message -p ${receipt}`;

  const result = await runProcess('tmux', [
    'if-shell', '-t', paneId, '-F', paneAuthorityFormat(paneId, panePid), quoted, '',
  ], 3000);
  return parseExactTmuxAuthorityScalar(result.stdout) === receipt;
}

async function confirmPaneAuthorityAtomically(paneId: string, panePid: string): Promise<boolean> {
  const receipt = randomUUID().replace(/-/g, '');
  if (!/^[a-f0-9]{32}$/.test(receipt)) return false;
  const result = await runProcess('tmux', [
    'if-shell', '-t', paneId, '-F', paneAuthorityFormat(paneId, panePid), `display-message -p ${receipt}`, '',
  ], 3000);
  return parseExactTmuxAuthorityScalar(result.stdout) === receipt;
}


export async function capturePaneInputAuthority(paneTarget: any): Promise<{ paneTarget: string; panePid: string; assertPaneAuthority: () => Promise<boolean> } | null> {
  const requestedTarget = safeString(paneTarget);
  const canonicalTarget = parseCanonicalTmuxPaneId(requestedTarget);
  if (!canonicalTarget || canonicalTarget !== requestedTarget) return null;
  try {
    const initial = parseExactPaneAuthoritySnapshot((await runProcess('tmux', ['display-message', '-p', '-t', canonicalTarget, '#{pane_id}\t#{pane_dead}\t#{pane_pid}'], 3000)).stdout);
    if (!initial || initial.paneId !== canonicalTarget) return null;
    return {
      panePid: initial.panePid,

      paneTarget: initial.paneId,
      assertPaneAuthority: async () => {
        try {
          const current = parseExactPaneAuthoritySnapshot((await runProcess('tmux', ['display-message', '-p', '-t', initial.paneId, '#{pane_id}\t#{pane_dead}\t#{pane_pid}'], 3000)).stdout);
          return current?.paneId === initial.paneId && current.panePid === initial.panePid;
        } catch {
          return false;
        }
      },

    };
  } catch {
    return null;
  }
}

export async function sendPaneInput({
  paneTarget,
  prompt,
  submitKeyPresses = 2,
  submitDelayMs = 0,
  typePrompt = true,
  queueFirstSubmit = false,
  assertPaneAuthority,
}: any): Promise<any> {
  const requestedTarget = safeString(paneTarget);
  const target = parseCanonicalTmuxPaneId(requestedTarget);
  if (!target || target !== requestedTarget) {
    return { ok: false, sent: false, reason: 'missing_pane_target', paneTarget: '' };
  }
  const capturedAuthority = await capturePaneInputAuthority(target);
  if (!capturedAuthority) {
    return { ok: false, sent: false, reason: 'pane_authority_invalid', paneTarget: target };
  }
  const authoritativeTarget = capturedAuthority.paneTarget;

  const requirePaneAuthority = async () => {
    try {
      if (!(await capturedAuthority.assertPaneAuthority())) return false;
      return typeof assertPaneAuthority !== 'function' || (await assertPaneAuthority()) === true;
    } catch {
      return false;
    }
  };
  const authorityFailure = () => ({ ok: false, sent: false, reason: 'pane_authority_invalid', paneTarget: authoritativeTarget });

  const normalizedSubmitKeyPresses = Number.isFinite(submitKeyPresses)
    ? Math.max(0, Math.floor(submitKeyPresses))
    : 2;
  const literalPrompt = safeString(prompt);
  const submitArgv = normalizedSubmitKeyPresses === 0
    ? [] as string[][]
    : buildSendKeysArgv({
      paneTarget: authoritativeTarget,
      prompt: literalPrompt,
      dryRun: false,
      submitKeyPresses: normalizedSubmitKeyPresses,
    })?.submitArgv;
  if (!submitArgv) {
    return { ok: false, sent: false, reason: 'send_failed', paneTarget: authoritativeTarget };
  }
  const pasteArgv = buildSafePasteArgv(authoritativeTarget, literalPrompt);
  const argv = {
    typeArgv: pasteArgv.pasteBufferArgv,
    submitArgv,
    bufferName: pasteArgv.bufferName,
    setBufferArgv: pasteArgv.setBufferArgv,
    showBufferArgv: pasteArgv.showBufferArgv,
    clearComposerArgv: pasteArgv.clearComposerArgv,
    pasteBufferArgv: pasteArgv.pasteBufferArgv,
    deleteBufferArgv: pasteArgv.deleteBufferArgv,
  };

  let bufferSet = false;
  try {
    if (typePrompt) {
      try {
        await runProcess('tmux', pasteArgv.setBufferArgv, 3000);
        bufferSet = true;
      } catch (error) {
        return { ok: false, sent: false, reason: 'buffer_set_failed', paneTarget: target, argv, error: error instanceof Error ? error.message : safeString(error) };
      }
      let verifiedBuffer;
      try {
        verifiedBuffer = await runProcess('tmux', pasteArgv.showBufferArgv, 3000);
      } catch (error) {
        return { ok: false, sent: false, reason: 'buffer_show_failed', paneTarget: target, argv, error: error instanceof Error ? error.message : safeString(error) };
      }
      if (verifiedBuffer.stdout !== literalPrompt) {
        return { ok: false, sent: false, reason: 'buffer_verify_failed', paneTarget: target, argv, expectedBytes: literalPrompt.length, actualBytes: verifiedBuffer.stdout.length };
      }
      if (!(await requirePaneAuthority())) return authorityFailure();
      try {
        if (!(await runPaneMutationAtomically(authoritativeTarget, capturedAuthority.panePid, pasteArgv.clearComposerArgv))) return authorityFailure();

        if (!(await requirePaneAuthority())) return authorityFailure();
        if (!(await runPaneMutationAtomically(authoritativeTarget, capturedAuthority.panePid, pasteArgv.pasteBufferArgv))) return authorityFailure();


      } catch (error) {
        return { ok: false, sent: false, reason: 'buffer_paste_failed', paneTarget: target, argv, error: error instanceof Error ? error.message : safeString(error) };
      }
    }
    if (queueFirstSubmit && argv.submitArgv.length > 0) {
      if (!(await requirePaneAuthority())) return authorityFailure();
      if (!(await runPaneMutationAtomically(authoritativeTarget, capturedAuthority.panePid, ['send-keys', '-t', authoritativeTarget, 'Tab']))) return authorityFailure();


      if (submitDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
    }
    for (const submit of argv.submitArgv) {
      if (submitDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
      if (!(await requirePaneAuthority())) return authorityFailure();
      if (!(await runPaneMutationAtomically(authoritativeTarget, capturedAuthority.panePid, submit))) return authorityFailure();


    }
    if (!(await confirmPaneAuthorityAtomically(authoritativeTarget, capturedAuthority.panePid))) return authorityFailure();

    return { ok: true, sent: true, reason: 'sent', paneTarget: authoritativeTarget, argv };
  } catch (error) {
    return { ok: false, sent: false, reason: 'send_failed', paneTarget: authoritativeTarget, argv, error: error instanceof Error ? error.message : safeString(error) };
  } finally {
    if (bufferSet) await runProcess('tmux', pasteArgv.deleteBufferArgv, 3000).catch(() => {});
  }
}

export async function queuePaneInput({
  paneTarget,
  prompt,
  submitDelayMs = 80,
  assertPaneAuthority,
}: any): Promise<any> {
  const requestedTarget = safeString(paneTarget);
  const canonicalTarget = parseCanonicalTmuxPaneId(requestedTarget);
  if (!canonicalTarget || canonicalTarget !== requestedTarget) {
    return { ok: false, sent: false, reason: 'pane_authority_invalid', paneTarget: '' };
  }
  const capturedAuthority = await capturePaneInputAuthority(canonicalTarget);
  const paneAuthority = assertPaneAuthority || capturedAuthority?.assertPaneAuthority;
  if (!capturedAuthority || !paneAuthority) return { ok: false, sent: false, reason: 'pane_authority_invalid', paneTarget: canonicalTarget };
  const authoritativeTarget = capturedAuthority.paneTarget;

  const sendResult = await sendPaneInput({
    paneTarget: authoritativeTarget,
    prompt,
    submitKeyPresses: 0,
    assertPaneAuthority: paneAuthority,
  });
  if (!sendResult.ok) return sendResult;

  const target = authoritativeTarget;
  const submitArgv = [
    ['send-keys', '-t', target, 'Tab'],
    ['send-keys', '-t', target, 'C-m'],
  ];
  try {
    if (!(await paneAuthority()) || !(await capturedAuthority.assertPaneAuthority())) return { ok: false, sent: false, reason: 'pane_authority_invalid', paneTarget: target, argv: { typeArgv: sendResult.argv?.typeArgv || null, submitArgv } };
    if (!(await runPaneMutationAtomically(target, capturedAuthority.panePid, submitArgv[0]))) return { ok: false, sent: false, reason: 'pane_authority_invalid', paneTarget: target, argv: { typeArgv: sendResult.argv?.typeArgv || null, submitArgv } };


    if (submitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
    }
    if (!(await paneAuthority()) || !(await capturedAuthority.assertPaneAuthority())) return { ok: false, sent: false, reason: 'pane_authority_invalid', paneTarget: target, argv: { typeArgv: sendResult.argv?.typeArgv || null, submitArgv } };
    if (!(await runPaneMutationAtomically(target, capturedAuthority.panePid, submitArgv[1]))) return { ok: false, sent: false, reason: 'pane_authority_invalid', paneTarget: target, argv: { typeArgv: sendResult.argv?.typeArgv || null, submitArgv } };
    if (!(await confirmPaneAuthorityAtomically(target, capturedAuthority.panePid))) return { ok: false, sent: false, reason: 'pane_authority_invalid', paneTarget: target, argv: { typeArgv: sendResult.argv?.typeArgv || null, submitArgv } };
    return {
      ok: true,
      sent: true,
      reason: 'queued',
      paneTarget: target,
      argv: { typeArgv: sendResult.argv?.typeArgv || null, submitArgv },
    };
  } catch (error) {
    return {
      ok: false,
      sent: false,
      reason: 'queue_failed',
      paneTarget: target,
      argv: { typeArgv: sendResult.argv?.typeArgv || null, submitArgv },
      error: error instanceof Error ? error.message : safeString(error),
    };
  }
}

export async function checkPaneReadyForTeamSendKeys(paneTarget: any): Promise<any> {
  return evaluatePaneInjectionReadiness(paneTarget);
}
