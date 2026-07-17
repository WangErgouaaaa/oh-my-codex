import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

import TOML from '@iarna/toml';
import { isManagedCodexHookCommand, planManagedCodexHooksRemoval } from '../config/codex-hooks.js';
import {
  spawnPlatformCommand,
  spawnPlatformCommandSync,
} from '../utils/platform-command.js';

import {
  ensureReusableNodeModules,
} from '../utils/repo-deps.js';


export {
  hasUsableNodeModules,
  resolveGitCommonDir,
  resolveReusableNodeModulesSource,
} from '../utils/repo-deps.js';

export const PACKED_INSTALL_SMOKE_CORE_COMMANDS = [
  ['--help'],
  ['version'],
  ['api', '--help'],
  ['sparkshell', '--help'],
] as const;

export const MANAGED_CODEX_HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'Stop',
] as const;

export const PACKED_INSTALL_NATIVE_HOOK_REGRESSION_PROMPTS = [
  { name: 'directive-use-ralplan', prompt: 'use $ralplan plan this', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'directive-please-use-ralplan', prompt: 'please use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'directive-run-ralplan', prompt: 'run $ralplan plan this', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'directive-list-use-ralplan', prompt: '- use $ralplan plan this', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'directive-documentation-then-command', prompt: 'use $ralplan is the consensus-planning command\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'directive-documentation-then-implicit-command', prompt: 'use $ralplan is the consensus-planning command\nUse autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'directive-documentation-trailing-prose-then-command', prompt: 'use $ralplan is the workflow command for planning\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'directive-documentation-implicit-prose', prompt: 'use $ralplan is the workflow command for autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'directive-documentation-alias-prose', prompt: 'use $ralplan is the consensus-planning command\nAutopilot mode is its alias.', expectedSkill: null, expectedStopBlock: false },
  { name: 'directive-coordinated-documentation-then-command', prompt: '- use $ralplan and $autopilot are workflow commands\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'directive-documentation-semicolon-directive', prompt: 'use $ralplan is the consensus-planning command; use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'directive-two-documentation-blocks', prompt: 'use $ralplan is the consensus-planning command\nuse $autopilot is the autonomous workflow command\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'directive-documentation-embedded-token-then-command', prompt: 'use $ralplan is the workflow command for $team\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-task-noun', prompt: 'use $ralplan is the workflow command; use $autopilot update the documentation', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-implicit-followup', prompt: 'use $ralplan is the consensus-planning command; use autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-transition-followup', prompt: 'use $ralplan is the consensus-planning command; then use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-explicit-alias', prompt: 'use $ralplan is the consensus-planning command; $team is its alias', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-implicit-chain', prompt: 'use $ralplan is the consensus-planning command\nAutopilot mode is its alias.\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'doc-fullwidth-separator', prompt: 'use $ralplan，$autopilot are workflow commands', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-compact-slash', prompt: 'use $ralplan/$autopilot are workflow commands\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'reference-prompts-followup', prompt: '[docs]: /target "title\nUse /prompts:architect"\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'doc-period-implicit', prompt: 'use $ralplan is the consensus-planning command. Use autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-bare-implicit', prompt: 'use $ralplan is the consensus-planning command; autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-fullwidth-semicolon', prompt: 'use $ralplan is the consensus-planning command； use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-but-followup', prompt: 'use $ralplan is the workflow command; but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-fullwidth-oxford', prompt: 'use $ralplan， $autopilot， and $team are workflow commands', expectedSkill: null, expectedStopBlock: false },
  { name: 'reference-zero-title', prompt: '[docs]: ./target\n(autopilot mode)', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-also-alias-explicit', prompt: 'use $ralplan is the consensus-planning command; $team is also its alias', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-also-alias-implicit', prompt: 'use $ralplan is the consensus-planning command\nAutopilot mode is also its alias.', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-embedded-mention', prompt: 'use $ralplan is the workflow command; $team appears in the documentation.', expectedSkill: null, expectedStopBlock: false },
  { name: 'chained-negation', prompt: '$ralplan; $autopilot is prohibited', expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
  { name: 'long-negation', prompt: `$ralplan; $autopilot${' '.repeat(193)}is prohibited`, expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
  { name: 'doc-arabic-comma', prompt: 'use $ralplan، $autopilot are workflow commands', expectedSkill: null, expectedStopBlock: false },
  { name: 'arabic-negation', prompt: '$ralplan، $autopilot are prohibited', expectedSkill: null, expectedStopBlock: false },
  { name: 'implicit-arabic-negation', prompt: 'Autopilot mode، deep interview are prohibited.', expectedSkill: null, expectedStopBlock: false },
  { name: 'fullwidth-frame-reset', prompt: 'For instance: manual mode is slower。 Use autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-abbreviation', prompt: 'use $ralplan is the workflow command, e.g. use $autopilot in examples.', expectedSkill: null, expectedStopBlock: false },
  { name: 'implicit-doc-mention', prompt: 'use $ralplan is the workflow command; autopilot mode appears in the documentation.', expectedSkill: null, expectedStopBlock: false },
  { name: 'implicit-doc-chain', prompt: 'use $ralplan is the workflow command; autopilot mode is its alias; $ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'long-command-gap', prompt: `use $ralplan is the workflow command; use${' '.repeat(161)}$autopilot build it`, expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'ideographic-negation', prompt: '$ralplan、 $autopilot are prohibited', expectedSkill: null, expectedStopBlock: false },
  { name: 'implicit-ideo-negation', prompt: 'Autopilot mode、 deep interview are prohibited.', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-exclamation', prompt: 'use $ralplan is the consensus-planning command! run $autopilot', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-fullwidth-question', prompt: 'use $ralplan is the consensus-planning command？ run $autopilot', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'implicit-doc-predecessor', prompt: 'Autopilot mode is workflow documentation.\n$ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'confusable-use-verb', prompt: 'uſe $ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'confusable-please', prompt: 'pleaſe use $ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'confusable-prompts-token-then-command', prompt: '/promptſ:architect; use autopilot mode.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'reserved-em-dash-boundary', prompt: '/prompts:architect— use autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'reserved-fullwidth-comma-boundary', prompt: '/prompts:architect， use autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'confusable-implicit-verb', prompt: 'Do not use deep interview but uſe autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'frame-fullwidth-colon', prompt: 'For instance： use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'frame-fullwidth-comma', prompt: 'For instance， use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'frame-arabic-comma', prompt: 'For instance، use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'frame-ideo-comma', prompt: 'For instance、 use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-explicit-documented', prompt: 'use $ralplan is the workflow command; $autopilot is documented in the guide.', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-explicit-described', prompt: '$autopilot is described in the manual.', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-comma-followup', prompt: 'use $ralplan is the workflow command, but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-fw-comma-followup', prompt: 'use $ralplan is the workflow command， but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-arabic-followup', prompt: 'use $ralplan is the workflow command، but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-ideo-followup', prompt: 'use $ralplan is the workflow command、 but use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'neg-arabic-followup', prompt: 'Do not run $ralplan، use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'neg-ideo-followup', prompt: 'Do not run $ralplan、 use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'implicit-doc-prefix-next', prompt: 'The docs mention autopilot mode.\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'implicit-doc-prefix-line', prompt: 'The docs mention autopilot mode; use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'implicit-doc-subject-line', prompt: 'Autopilot mode is workflow documentation; use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'compact-explicit-negation', prompt: '$ralplan,$autopilot are prohibited', expectedSkill: null, expectedStopBlock: false },
  { name: 'compact-implicit-negation', prompt: 'Autopilot mode،deep interview are prohibited.', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-clause-local-prefix', prompt: '$ralplan; $autopilot is documented in the guide.', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'doc-chain-described', prompt: 'use $ralplan is the workflow command; autopilot mode is documented in the guide; $team execute it', expectedSkill: 'team', expectedStopBlock: false, insideTmux: true },
  { name: 'doc-chain-workflow', prompt: 'use $ralplan is the workflow command; autopilot mode is workflow documentation; use $ralph execute it', expectedSkill: 'ralph', expectedStopBlock: true },
  { name: 'ref-inline-explicit', prompt: '[docs]: $ralplan\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'ref-inline-prompts', prompt: '[docs]: /prompts:architect\n$autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'list-fullwidth-explicit-doc', prompt: '- $ralplan： consensus-planning workflow', expectedSkill: null, expectedStopBlock: false },
  { name: 'list-fullwidth-implicit-doc', prompt: '- autopilot mode： autonomous workflow command', expectedSkill: null, expectedStopBlock: false },
  { name: 'possessive-straight', prompt: "$ralplan's workflow is documented", expectedSkill: null, expectedStopBlock: false },
  { name: 'possessive-curly', prompt: '$ralplan’s workflow is documented', expectedSkill: null, expectedStopBlock: false },
  { name: 'possessive-fullwidth', prompt: '$ralplan＇s workflow is documented', expectedSkill: null, expectedStopBlock: false },
  { name: 'possessive-prompts', prompt: "/prompts:architect's syntax is documented", expectedSkill: null, expectedStopBlock: false },
  { name: 'malformed-prefix-kata', prompt: '$・autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'malformed-prefix-half', prompt: '$･autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'malformed-prefix-arabic', prompt: '$٪autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'malformed-prefix-division', prompt: '$∕autopilot mode', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-but-directive', prompt: 'use $autopilot is documented but use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'list-directive-fw-colon', prompt: '- use $ralplan： consensus-planning workflow', expectedSkill: null, expectedStopBlock: false },
  { name: 'doc-arabic-question', prompt: 'use $ralplan is the workflow command؟ run $autopilot', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'arabic-semicolon-negation', prompt: '$ralplan؛ $autopilot is prohibited', expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
  { name: 'confusable-postposed-transition', prompt: '$ralplan is prohibited but uſe autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'mixed-negation', prompt: 'Autopilot mode and $ralplan are prohibited.', expectedSkill: null, expectedStopBlock: false },
  { name: 'both-mixed-negation', prompt: 'Both autopilot mode and $ralplan are prohibited.', expectedSkill: null, expectedStopBlock: false },
  { name: 'mixed-documentation', prompt: 'use $ralplan and autopilot mode are workflow commands', expectedSkill: null, expectedStopBlock: false },
  { name: 'prose-doc-no-reopen', prompt: '$ralplan is prohibited because docs use $autopilot.', expectedSkill: null, expectedStopBlock: false },
  { name: 'neg-fw-dot-reopen', prompt: 'Do not run $ralplan． use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'neg-greek-q-reopen', prompt: 'Do not run $ralplan; use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'unicode-attached-contrast', prompt: 'Do not use deep interview яbut use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'prefix-list-followup', prompt: 'Do not run $ralplan, $autopilot; use $team execute it', expectedSkill: 'team', expectedStopBlock: false, insideTmux: true },
  { name: 'mixed-postposed-chain', prompt: '$ralplan, autopilot mode, $team are prohibited.', expectedSkill: null, expectedStopBlock: false },
  { name: 'implicit-first-doc-chain', prompt: 'Autopilot mode and $ralplan are workflow commands; use $team execute it', expectedSkill: 'team', expectedStopBlock: false, insideTmux: true },
  { name: 'both-mixed-doc-followup', prompt: 'Both autopilot mode and $ralplan are workflow commands; use $team execute it', expectedSkill: 'team', expectedStopBlock: false, insideTmux: true },
  { name: 'doc-semicolon-preserves-earlier', prompt: 'Use autopilot mode; use $ralplan is the workflow command.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-independent-comma', prompt: 'Use autopilot mode, and $ralplan is documented in the guide.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'reference-unclosed-quote-destination', prompt: '[docs]: "target\n$autopilot build it', expectedSkill: null, expectedStopBlock: false },
  { name: 'reference-unclosed-inline-destination', prompt: '[docs]: `target\n$autopilot build it', expectedSkill: null, expectedStopBlock: false },
  { name: 'mixed-prefix-negation-implicit', prompt: 'Do not run $ralplan and use autopilot mode.', expectedSkill: null, expectedStopBlock: false },
  { name: 'repeated-postposed-followup', prompt: '$team is prohibited and is forbidden; use $ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'doc-preserves-earlier', prompt: 'Use autopilot mode; "note"; use $ralplan is the workflow command.', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'doc-colon-followup', prompt: 'use $ralplan is the workflow command: use $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'table-followup', prompt: 'Mode | Meaning\n--- | ---\nmanual | documentation\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'neg-advance-reopen', prompt: 'Do not run $ralplan but advance to $ultragoal', expectedSkill: 'ultragoal', expectedStopBlock: false },
  { name: 'neg-jump-reopen', prompt: 'Do not run $ralplan but jump straight to $ultragoal', expectedSkill: 'ultragoal', expectedStopBlock: false },
  { name: 'reference-plain-title', prompt: '[docs]: /target "title\nplain text"\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'reference-plain-destination', prompt: '[docs]: ./target\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'directive-use-the', prompt: 'Do not run $ralplan; use the $autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true },
  { name: 'directive-continue-after-quote', prompt: '"quoted"\ncontinue with $ralplan', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'doc-advance-followup', prompt: 'use $ralplan is the workflow command; advance to $ultragoal', expectedSkill: 'ultragoal', expectedStopBlock: false },
  { name: 'directive-run-code-review', prompt: 'run $code-review', expectedSkill: 'code-review', expectedStopBlock: false },
  { name: 'directive-documentation', prompt: 'use $ralplan is the consensus-planning command', expectedSkill: null, expectedStopBlock: false },
  { name: 'nested-bounded-child-unbounded-parent', prompt: '"`x`\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'first-contiguous-block-terminal', prompt: '$ralplan plan it\n"x"\n$autopilot build it', expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
  { name: 'leading-reserved-dominance', prompt: '/prompts:architect\n"x"\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'list-fence-root-opener', prompt: '- ```\n  sample\n```\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'list-fence-relative-closer', prompt: '- ```\n  sample\n    ```\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'reference-multiline-title-explicit', prompt: '[docs]: /target "title\nuse /prompts:architect\n$ralplan plan it"', expectedSkill: null, expectedStopBlock: false },
  { name: 'reference-multiline-title-implicit', prompt: '[docs]: /target "title\nuse autopilot mode"', expectedSkill: null, expectedStopBlock: false },
  { name: 'reference-next-line-title', prompt: '[docs]: ./target\n  (autopilot mode)', expectedSkill: null, expectedStopBlock: false },
  { name: 'reference-next-line-destination-title', prompt: '[docs]:\n  ./target\n  (autopilot mode)', expectedSkill: null, expectedStopBlock: false },
  { name: 'kelvin-case-fold-suffix', prompt: '$ultraworK execute', expectedSkill: null, expectedStopBlock: false },
  { name: 'katakana-middle-dot-suffix', prompt: '$ralplan・suffix plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'halfwidth-middle-dot-suffix', prompt: '$ralplan･suffix plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'arabic-percent-suffix', prompt: '$ralplan٪docs', expectedSkill: null, expectedStopBlock: false },
  { name: 'division-slash-suffix', prompt: '$ralplan∕config', expectedSkill: null, expectedStopBlock: false },
  { name: 'unclosed-prompts-quote', prompt: '"Use /prompts:architect\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'malformed-prompts-suffix', prompt: '/prompts:architect한글\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'stale-predecessor-prose-directive', prompt: '> quoted context\nProse\n$ralplan implement this', expectedSkill: null, expectedStopBlock: false },
  { name: 'stale-predecessor-reserved-directive', prompt: '> quoted context\n/prompts:architect\n$ralplan plan this', expectedSkill: null, expectedStopBlock: false },
  { name: 'stale-predecessor-first-block-terminal', prompt: '> quoted context\n$ralplan plan it\nLater discussion.\n$autopilot build it', expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: [] },
  { name: 'stale-predecessor-unclosed-after-negation', prompt: 'Do not run $ralplan.\n"unclosed context\n$autopilot build it', expectedSkill: null, expectedStopBlock: false },
  { name: 'stale-predecessor-reference-unclosed', prompt: '[$ralplan]: ./docs\n"unclosed context\n$autopilot build it', expectedSkill: null, expectedStopBlock: false },
  { name: 'stale-directive-clause-prefix', prompt: '> quoted context\nProse\nUse $ralplan plan this', expectedSkill: null, expectedStopBlock: false },
  { name: 'nested-reserved-predecessor-successor', prompt: '- Use /prompts:architect.\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'nested-fence-predecessor-successor', prompt: '- - ```\n    quoted context\n    ```\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'reference-multiline-destination-implicit', prompt: '[docs]:\nautopilot', expectedSkill: null, expectedStopBlock: false },
  { name: 'middle-dot-suffix', prompt: '$ralplan·suffix plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'percent-suffix', prompt: '$ralplan%docs', expectedSkill: null, expectedStopBlock: false },
  { name: 'fullwidth-percent-suffix', prompt: '$ralplan％docs', expectedSkill: null, expectedStopBlock: false },
  { name: 'g1a-ordered-multi-skill', prompt: '$ralplan, $autopilot; $team', expectedSkill: 'ralplan', expectedStopBlock: true, expectedDeferredSkills: ['autopilot', 'team'], expectedActiveSkills: ['ralplan'], insideTmux: true },
  { name: 'g1c-duplicate-alias', prompt: '$autopilot $oh-my-codex:autopilot build it', expectedSkill: 'autopilot', expectedStopBlock: true, expectedDeferredSkills: [], expectedActiveSkills: ['autopilot'] },
  { name: 'b3-longer-valid-fence', prompt: '```text\n$autopilot build it\n````\n$ralplan plan it', expectedSkill: 'ralplan', expectedStopBlock: true },
  { name: 'b4-shorter-invalid-fence', prompt: '````text\n$autopilot build it\n```\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
  { name: 'b5-different-marker-invalid-fence', prompt: '```text\n$autopilot build it\n~~~\n$ralplan plan it', expectedSkill: null, expectedStopBlock: false },
] as const;

export function buildPackedRegressionEnvironment(
  testCase: { readonly name: string; readonly insideTmux?: boolean },
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const insideTmux = testCase.insideTmux === true;
  return {
    ...baseEnv,
    OMX_ROOT: '',
    OMX_STATE_ROOT: '',
    OMX_TEAM_STATE_ROOT: '',
    OMX_SESSION_ID: '',
    CODEX_SESSION_ID: '',
    SESSION_ID: '',
    OMX_TEAM_WORKER: '',
    OMX_TEAM_INTERNAL_WORKER: '',
    OMX_TEAM_LEADER_CWD: '',
    OMX_TEAM_MODE: insideTmux ? 'enabled' : '',
    OMX_QUESTION_RETURN_PANE: '',
    OMX_LEADER_PANE_ID: '',
    OMX_TMUX_HUD_OWNER: '',
    TMUX: insideTmux ? '/tmp/tmux-pr3140-regression' : '',
    TMUX_PANE: insideTmux ? '%3140' : '',
  };
}

export const PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS = MANAGED_CODEX_HOOK_EVENTS;

export type ManagedCodexHookEvent = typeof MANAGED_CODEX_HOOK_EVENTS[number];

export const CODEX_APP_SERVER_TIMEOUTS = {
  versionProbeMs: 2_000,
  initializeMs: 15_000,
  requestMs: 10_000,
  shutdownMs: 5_000,
} as const;

const CODEX_TRUST_STATUSES = new Set([
  'managed',
  'untrusted',
  'trusted',
  'modified',
]);

const CODEX_EVENT_LABELS: Readonly<Record<string, string>> = {
  preToolUse: 'PreToolUse',
  permissionRequest: 'PermissionRequest',
  postToolUse: 'PostToolUse',
  preCompact: 'PreCompact',
  postCompact: 'PostCompact',
  sessionStart: 'SessionStart',
  userPromptSubmit: 'UserPromptSubmit',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  stop: 'Stop',
};

const PINNED_CODEX_VERSION = '0.142.5';
const PINNED_CODEX_VERSION_OUTPUT = `codex-cli ${PINNED_CODEX_VERSION}`;

/** Sanitized Codex 0.144.5 PreToolUse shape: documented fields only, with no pointer or tracker state. */
export const PACKED_CODEX_01445_NO_POINTER_NO_TRACKER_FIXTURE = Object.freeze({
  hook_event_name: 'PreToolUse',
  session_id: 'packed-01445-session',
  turn_id: 'packed-01445-turn',
  tool_name: 'Bash',
  tool_use_id: 'packed-01445-tool',
  tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
} as const);
const CODEX_APP_SERVER_MAX_STDOUT_FRAME_LENGTH = 1_048_576;

type JsonRecord = Record<string, unknown>;

type JsonRpcEnvelope = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type JsonRpcRequestEnvelope = JsonRpcEnvelope & {
  id: number;
  method: string;
};


type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

export interface CodexHookMetadata {
  event: ManagedCodexHookEvent | string;
  command: string;
  sourcePath: string;
  key: string;
  currentHash: string;
  displayOrder: number;
  trustStatus: 'managed' | 'untrusted' | 'trusted' | 'modified';
}

export interface CodexHooksListEntry {
  cwd: string;
  hooks: CodexHookMetadata[];
  warnings: unknown[];
  errors: unknown[];
}

export class CodexExecutableNotFoundError extends Error {
  constructor() {
    super('codex executable was not found');
    this.name = 'CodexExecutableNotFoundError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(value: unknown, code: string): boolean {
  return value instanceof Error
    && isRecord(value)
    && value.code === code;
}

function compactDiagnostic(value: string, limit = 4_000): string {
  return value.length <= limit ? value : value.slice(-limit);
}

function protocolError(message: string, stderr = ''): Error {
  return new Error(`${message}${stderr.trim() ? `\nCodex stderr:\n${compactDiagnostic(stderr)}` : ''}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Codex hooks/list response is missing ${label}`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`Codex response has malformed ${label}`);
  return value;
}

function hasExactPinnedCodexVersionStdout(stdout: string): boolean {
  return stdout === PINNED_CODEX_VERSION_OUTPUT
    || stdout === `${PINNED_CODEX_VERSION_OUTPUT}\n`
    || stdout === `${PINNED_CODEX_VERSION_OUTPUT}\r\n`;
}

function hasOnlyBenignCodexVersionStderr(stderr: string): boolean {
  const diagnostics = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  return diagnostics.every((line) => /^(?:warning|note): /i.test(line));
}

function formatVersionProbeOutput(stdout: string, stderr: string): string {
  return [
    `stdout=${JSON.stringify(compactDiagnostic(stdout))}`,
    ...(stderr.length === 0 ? [] : [`stderr=${JSON.stringify(compactDiagnostic(stderr))}`]),
  ].join(' ');
}

const CODEX_VERSION_PROBE_CANDIDATE_BUDGET = 32;
const CODEX_VERSION_PROBE_DEADLINE_MS = 5_000;

type CodexCandidateInspection =
  | { kind: 'absent' }
  | { kind: 'present' }
  | { kind: 'dangling' }
  | { kind: 'uninspectable'; error: Error };

function inspectCodexCandidate(executable: string): CodexCandidateInspection {
  try {
    lstatSync(executable);
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return { kind: 'absent' };
    return {
      kind: 'uninspectable',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  try {
    statSync(executable);
    return { kind: 'present' };
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return { kind: 'dangling' };
    return {
      kind: 'uninspectable',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function versionProbeDeadlineError(): Error {
  return new Error(
    `Codex version resolution exceeded the ${CODEX_VERSION_PROBE_DEADLINE_MS}ms global deadline`,
  );
}

export interface CodexCommandSpawnSeam {
  platform?: NodeJS.Platform;
  spawnSyncImpl?: typeof spawnSync;
  spawnImpl?: typeof spawn;
}

function* streamPathEntries(pathValue: string, deadline: number, platform: NodeJS.Platform): Iterable<string> {
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  let start = 0;
  for (let index = 0; index < pathValue.length; index += 1) {
    if ((index & 0x3ff) === 0 && Date.now() >= deadline) throw versionProbeDeadlineError();
    if (pathValue[index] !== pathDelimiter) continue;
    yield pathValue.slice(start, index);
    start = index + 1;
  }
  if (Date.now() >= deadline) throw versionProbeDeadlineError();
  yield pathValue.slice(start);
}

function codexCandidatePaths(pathEntry: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [join(pathEntry, 'codex')];
  const pathext = String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.PS1')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...pathext.map((extension) => join(pathEntry, `codex${extension}`)), join(pathEntry, 'codex')])];
}

function resolvePinnedCodexExecutable(
  cwd: string,
  env: NodeJS.ProcessEnv,
  seam: CodexCommandSpawnSeam = {},
): { executable: string; version: string } {
  const platform = seam.platform ?? process.platform;
  const deadline = Date.now() + CODEX_VERSION_PROBE_DEADLINE_MS;
  const pathValue = env.PATH ?? env.Path ?? '';
  const observed: string[] = [];
  const seenPathEntries = new Set<string>();

  for (const entry of streamPathEntries(pathValue, deadline, platform)) {
    if (Date.now() >= deadline) throw versionProbeDeadlineError();
    const pathEntry = resolve(cwd, entry || '.');
    if (seenPathEntries.has(pathEntry)) continue;
    if (seenPathEntries.size === CODEX_VERSION_PROBE_CANDIDATE_BUDGET) {
      throw new Error(
        `Codex version resolution exceeded the ${CODEX_VERSION_PROBE_CANDIDATE_BUDGET}-candidate PATH budget`,
      );
    }
    seenPathEntries.add(pathEntry);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw versionProbeDeadlineError();

    let pathEntryState = inspectCodexCandidate(pathEntry);
    if (pathEntryState.kind === 'absent') {
      pathEntryState = inspectCodexCandidate(pathEntry);
      if (pathEntryState.kind === 'absent') continue;
    }
    if (pathEntryState.kind === 'dangling') {
      observed.push(`${pathEntry}: PATH entry exists but its target is unavailable (dangling or changed during probe)`);
      continue;
    }
    if (pathEntryState.kind === 'uninspectable') {
      observed.push(`${pathEntry}: PATH entry cannot be inspected (${pathEntryState.error.message})`);
      continue;
    }

    let selected: { executable: string; before: CodexCandidateInspection } | null = null;
    for (const executable of codexCandidatePaths(pathEntry, env, platform)) {
      if (Date.now() >= deadline) throw versionProbeDeadlineError();
      let before = inspectCodexCandidate(executable);
      if (before.kind === 'absent') {
        before = inspectCodexCandidate(executable);
        if (before.kind === 'absent') continue;
      }
      selected = { executable, before };
      break;
    }
    if (!selected) continue;

    const { executable, before } = selected;
    if (before.kind === 'dangling') {
      observed.push(`${executable}: candidate exists but its target is unavailable (dangling or changed during probe)`);
      continue;
    }
    if (before.kind === 'uninspectable') {
      observed.push(`${executable}: candidate cannot be inspected (${before.error.message})`);
      continue;
    }

    const { result } = spawnPlatformCommandSync(executable, ['--version'], {
      cwd,
      env,
      encoding: 'utf-8',
      timeout: Math.max(1, Math.min(CODEX_APP_SERVER_TIMEOUTS.versionProbeMs, remainingMs)),
      killSignal: 'SIGKILL',
    }, platform, env, undefined, seam.spawnSyncImpl ?? spawnSync);
    if (Date.now() >= deadline) throw versionProbeDeadlineError();
    if (isNodeErrorWithCode(result.error, 'ENOENT')) {
      const after = inspectCodexCandidate(executable);
      observed.push(
        `${executable}: launch returned ENOENT after an existing candidate was observed (${after.kind})`,
      );
      continue;
    }
    if (isNodeErrorWithCode(result.error, 'ETIMEDOUT')) {
      observed.push(`${executable}: version probe timed out after ${CODEX_APP_SERVER_TIMEOUTS.versionProbeMs}ms and was force-terminated`);
      continue;
    }
    if (result.error) {
      observed.push(`${executable}: version probe failed (${result.error.message})`);
      continue;
    }
    if (result.status !== 0) {
      observed.push(`${executable}: exit ${String(result.status)}`);
      continue;
    }

    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    if (hasExactPinnedCodexVersionStdout(stdout) && hasOnlyBenignCodexVersionStderr(stderr)) {
      return { executable, version: PINNED_CODEX_VERSION_OUTPUT };
    }
    observed.push(`${executable}: ${formatVersionProbeOutput(stdout, stderr)}`);
  }

  if (Date.now() >= deadline) throw versionProbeDeadlineError();
  if (observed.length === 0) throw new CodexExecutableNotFoundError();
  throw new Error(
    `Unsupported installed Codex version for the ${PINNED_CODEX_VERSION} boundary:\n${observed.join('\n')}`,
  );
}


/**
 * Newline-delimited JSON-RPC client for the installed Codex app-server boundary.
 * It accepts no protocol fallback: malformed messages, request errors, unexpected
 * exits, and cleanup failures are test failures.
 */
export class CodexAppServer {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly stdoutDecoder = new TextDecoder('utf-8', { fatal: true });
  private stderr = '';
  private stdoutBuffer = '';
  private failure: Error | null = null;
  private closing = false;
  private spawned = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.closePromise = new Promise((resolveClose) => {
      child.once('close', (code, signal) => {
        const exit = { code, signal };
        this.flushStdoutDecoder();
        if (this.stdoutBuffer.length > 0) {
          this.fail(protocolError(
            `codex app-server closed with unterminated JSON-RPC stdout: ${JSON.stringify(compactDiagnostic(this.stdoutBuffer))}`,
            this.stderr,
          ));
        }
        if (!this.closing) {
          this.fail(protocolError(
            `codex app-server exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
            this.stderr,
          ));
        }
        resolveClose(exit);
      });
    });

    child.once('spawn', () => {
      this.spawned = true;
    });
    child.once('error', (error) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = compactDiagnostic(this.stderr + chunk);
    });
  }


  static async start(options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    commandSeam?: CodexCommandSpawnSeam;
  }): Promise<CodexAppServer> {
    const seam = options.commandSeam;
    const platform = seam?.platform ?? process.platform;
    const { executable } = resolvePinnedCodexExecutable(options.cwd, options.env, seam);
    const { child } = spawnPlatformCommand(executable, ['app-server', '--stdio'], {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
    }, platform, options.env, undefined, seam?.spawnImpl ?? spawn);

    const server = new CodexAppServer(child as ChildProcessWithoutNullStreams);
    try {
      await server.waitForStartup();
    } catch (error) {
      try {
        await server.close();
      } catch {
        // Preserve the startup failure as the primary diagnostic.
      }
      throw error;
    }
    return server;
  }

  private async waitForStartup(): Promise<void> {
    const started = new Promise<void>((resolveStarted, rejectStarted) => {
      if (this.spawned) {
        resolveStarted();
        return;
      }
      this.child.once('spawn', resolveStarted);
      this.child.once('error', rejectStarted);
    });
    await this.withTimeout(started, CODEX_APP_SERVER_TIMEOUTS.initializeMs, 'codex app-server did not start');
  }

  private onStdout(chunk: Buffer): void {
    let decoded: string;
    try {
      decoded = this.stdoutDecoder.decode(chunk, { stream: true });
    } catch {
      this.fail(protocolError('codex app-server emitted invalid UTF-8 stdout', this.stderr));
      return;
    }
    this.onStdoutText(decoded);
  }

  private flushStdoutDecoder(): void {
    try {
      const decoded = this.stdoutDecoder.decode();
      if (decoded) this.onStdoutText(decoded);
    } catch {
      this.fail(protocolError('codex app-server emitted invalid UTF-8 stdout', this.stderr));
    }
  }

  private onStdoutText(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      const frameLength = Buffer.byteLength(
        newline < 0 ? this.stdoutBuffer : this.stdoutBuffer.slice(0, newline),
        'utf-8',
      );
      if (frameLength > CODEX_APP_SERVER_MAX_STDOUT_FRAME_LENGTH) {
        this.fail(protocolError('codex app-server emitted an oversized JSON-RPC stdout frame', this.stderr));
        return;
      }
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let envelope: unknown;
      try {
        envelope = JSON.parse(line);
      } catch {
        this.fail(protocolError(`codex app-server emitted malformed JSON-RPC stdout: ${line}`, this.stderr));
        return;
      }
      if (!isRecord(envelope)) {
        this.fail(protocolError('codex app-server emitted a non-object JSON-RPC envelope', this.stderr));
        return;
      }
      this.onEnvelope(envelope);
    }
  }

  private isMethodBearingNotification(envelope: JsonRecord): boolean {
    return !Object.hasOwn(envelope, 'id')
      && typeof envelope.method === 'string'
      && envelope.method.trim().length > 0
      && !Object.hasOwn(envelope, 'result')
      && !Object.hasOwn(envelope, 'error');
  }

  private validateResponseEnvelope(envelope: JsonRecord): string | null {
    if (Object.hasOwn(envelope, 'method') || Object.hasOwn(envelope, 'params')) {
      return 'codex app-server response mixed request or notification fields with an id';
    }
    const hasResult = Object.hasOwn(envelope, 'result');
    const hasError = Object.hasOwn(envelope, 'error');
    if (hasResult === hasError) {
      return 'codex app-server response must contain exactly one of result or error';
    }
    if (hasError) {
      const error = envelope.error;
      if (!isRecord(error)
        || typeof error.code !== 'number'
        || !Number.isFinite(error.code)
        || typeof error.message !== 'string') {
        return 'codex app-server response has malformed JSON-RPC error';
      }
    }
    return null;
  }

  private onEnvelope(envelope: JsonRecord): void {
    if (!Object.hasOwn(envelope, 'id')) {
      if (!this.isMethodBearingNotification(envelope)) {
        this.fail(protocolError('codex app-server emitted an invalid idless JSON-RPC envelope', this.stderr));
      }
      return;
    }
    if (typeof envelope.id !== 'number') {
      this.fail(protocolError('codex app-server response had a non-numeric id', this.stderr));
      return;
    }
    const validationError = this.validateResponseEnvelope(envelope);
    if (validationError) {
      this.fail(protocolError(validationError, this.stderr));
      return;
    }
    const pending = this.pending.get(envelope.id);
    if (!pending) {
      this.fail(protocolError(`codex app-server returned an unexpected response id ${envelope.id}`, this.stderr));
      return;
    }
    this.pending.delete(envelope.id);
    clearTimeout(pending.timeout);
    if (Object.hasOwn(envelope, 'error')) {
      pending.reject(protocolError(
        `codex app-server ${pending.method} returned JSON-RPC error ${JSON.stringify(envelope.error)}`,
        this.stderr,
      ));
      return;
    }
    pending.resolve(envelope.result);
  }


  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(protocolError(message, this.stderr)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timeout);
          resolvePromise(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          rejectPromise(error);
        },
      );
    });
  }

  async request<T = unknown>(envelope: Required<Pick<JsonRpcEnvelope, 'id' | 'method'>> & JsonRpcEnvelope, timeoutMs: number): Promise<T> {
    if (this.failure) throw this.failure;
    if (!Number.isInteger(envelope.id) || envelope.id <= 0 || !envelope.method) {
      throw new Error('Codex JSON-RPC request requires a positive numeric id and method');
    }
    if (this.pending.has(envelope.id)) {
      throw new Error(`duplicate Codex JSON-RPC request id ${envelope.id}`);
    }
    const response = new Promise<unknown>((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => {
        this.pending.delete(envelope.id);
        rejectResponse(protocolError(
          `codex app-server ${envelope.method} request ${envelope.id} timed out after ${timeoutMs}ms`,
          this.stderr,
        ));
      }, timeoutMs);
      this.pending.set(envelope.id, {
        method: envelope.method,
        resolve: resolveResponse,
        reject: rejectResponse,
        timeout,
      });
    });
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`, 'utf-8', (error) => {
      if (error) this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    return await response as T;
  }

  notify(envelope: Omit<JsonRpcEnvelope, 'id'>): void {
    if (this.failure) throw this.failure;
    if (!envelope.method) throw new Error('Codex JSON-RPC notification requires a method');
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`, 'utf-8', (error) => {
      if (error) this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.child.stdin.end();
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      exit = await this.withTimeout(
        this.closePromise,
        CODEX_APP_SERVER_TIMEOUTS.shutdownMs,
        'codex app-server did not exit after stdin closed',
      );
    } catch (error) {
      this.child.kill('SIGKILL');
      try {
        await this.withTimeout(
          this.closePromise,
          CODEX_APP_SERVER_TIMEOUTS.shutdownMs,
          'codex app-server did not exit after SIGKILL',
        );
      } catch {
        // Preserve the original graceful-cleanup failure, which has better diagnostics.
      }
      throw error;
    }
    if (exit.code !== 0 || exit.signal !== null) {
      throw protocolError(
        `codex app-server exited abnormally during cleanup (code ${String(exit.code)}, signal ${String(exit.signal)})`,
        this.stderr,
      );
    }
    if (this.failure) throw this.failure;
  }
}

export function createCodexInitializeEnvelope(clientName: string): JsonRpcRequestEnvelope {
  return {
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: clientName, version: '1.0.0' },
      capabilities: null,
    },
  };
}

export const CODEX_INITIALIZED_ENVELOPE: JsonRpcEnvelope = { method: 'initialized' };

export function createCodexHooksListEnvelope(projectCwd: string): JsonRpcRequestEnvelope {
  return {
    id: 2,
    method: 'hooks/list',
    params: { cwds: [projectCwd] },
  };
}

export function createCodexBatchWriteEnvelope(trustByKey: Record<string, string>): JsonRpcRequestEnvelope {
  return {
    id: 3,
    method: 'config/batchWrite',
    params: {
      edits: [{
        keyPath: 'hooks.state',
        value: Object.fromEntries(
          Object.entries(trustByKey).map(([key, currentHash]) => [key, { trusted_hash: currentHash }]),
        ),
        mergeStrategy: 'upsert',
      }],
      filePath: null,
      expectedVersion: null,
      reloadUserConfig: true,
    },
  };
}

export async function initializeCodexAppServer(server: CodexAppServer, clientName: string): Promise<void> {
  await server.request(createCodexInitializeEnvelope(clientName), CODEX_APP_SERVER_TIMEOUTS.initializeMs);
  server.notify(CODEX_INITIALIZED_ENVELOPE);
}

export async function listCodexHooks(
  server: CodexAppServer,
  projectCwd: string,
  hooksPath: string,
): Promise<CodexHooksListEntry> {
  const result = await server.request<unknown>(
    createCodexHooksListEnvelope(projectCwd),
    CODEX_APP_SERVER_TIMEOUTS.requestMs,
  );
  return parseCodexHooksListResult(result, projectCwd, hooksPath);
}

export function parseCodexHooksListResult(
  result: unknown,
  projectCwd: string,
  hooksPath: string,
): CodexHooksListEntry {
  const resultRecord = requireRecord(result, 'hooks/list result');
  if (!Array.isArray(resultRecord.data) || resultRecord.data.length !== 1) {
    throw new Error('Codex hooks/list response must contain exactly one data entry');
  }
  const entry = requireRecord(resultRecord.data[0], 'hooks/list data entry');
  if (entry.cwd !== projectCwd) {
    throw new Error(`Codex hooks/list response cwd mismatch: expected ${projectCwd}, got ${String(entry.cwd)}`);
  }
  if (!Array.isArray(entry.hooks) || !Array.isArray(entry.warnings) || !Array.isArray(entry.errors)) {
    throw new Error('Codex hooks/list response must contain hooks, warnings, and errors arrays');
  }
  if (entry.warnings.length !== 0 || entry.errors.length !== 0) {
    throw new Error(`Codex hooks/list reported warnings/errors: ${JSON.stringify({ warnings: entry.warnings, errors: entry.errors })}`);
  }

  const hooks = entry.hooks.map((value, index) => {
    const hook = requireRecord(value, `hooks/list hook ${index}`);
    const rawEvent = requireString(hook.eventName, `hooks[${index}].eventName`);
    const event = CODEX_EVENT_LABELS[rawEvent] ?? rawEvent;
    const command = requireString(hook.command, `hooks[${index}].command`);
    const enabled = hook.enabled === undefined ? true : hook.enabled;
    if (enabled !== true) {
      throw new Error(`Codex hooks/list hook ${index} is not an enabled command handler`);
    }
    const sourcePath = requireString(hook.sourcePath, `hooks[${index}].sourcePath`);
    const key = requireString(hook.key, `hooks[${index}].key`);
    const currentHash = requireString(hook.currentHash, `hooks[${index}].currentHash`);
    const displayOrder = hook.displayOrder;
    if (typeof displayOrder !== 'number' || !Number.isSafeInteger(displayOrder) || displayOrder < 0) {
      throw new Error(`Codex hooks/list response has invalid hooks[${index}].displayOrder`);
    }
    const trustStatus = requireString(hook.trustStatus, `hooks[${index}].trustStatus`);
    if (!CODEX_TRUST_STATUSES.has(trustStatus)) {
      throw new Error(`Codex hooks/list response has unsupported trustStatus ${trustStatus}`);
    }


    if (sourcePath !== hooksPath) {
      throw new Error(`Codex hooks/list sourcePath mismatch: expected ${hooksPath}, got ${sourcePath}`);
    }
    return {
      event,
      command,
      sourcePath,
      key,
      currentHash,
      displayOrder,
      trustStatus: trustStatus as CodexHookMetadata['trustStatus'],
    };
  });

  return {
    cwd: projectCwd,
    hooks,
    warnings: entry.warnings,
    errors: entry.errors,
  };
}



export function managedCodexHooksByEvent(hooks: readonly CodexHookMetadata[]): Record<ManagedCodexHookEvent, CodexHookMetadata> {
  const result = {} as Record<ManagedCodexHookEvent, CodexHookMetadata>;
  for (const event of MANAGED_CODEX_HOOK_EVENTS) {
    const matching = hooks.filter((hook) => hook.event === event && isManagedCodexHookCommand(hook.command));
    if (matching.length !== 1) {
      throw new Error(`Expected exactly one OMX ${event} hook from Codex, received ${matching.length}`);
    }
    result[event] = matching[0]!;
  }
  return result;
}

export function generatedHookTrustState(configToml: string): Record<string, string> {
  const parsed = TOML.parse(configToml) as { hooks?: { state?: Record<string, unknown> } };
  const state = parsed.hooks?.state;
  if (!isRecord(state)) throw new Error('setup config.toml is missing hooks.state');
  const trust = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(state)) {
    if (!isRecord(value)) {
      throw new Error(`setup config.toml has invalid hooks.state entry ${key}: expected an object`);
    }
    const entryKeys = Object.keys(value);
    if (entryKeys.length !== 1 || entryKeys[0] !== 'trusted_hash') {
      throw new Error(`setup config.toml has invalid hooks.state entry ${key}: expected only trusted_hash`);
    }
    if (typeof value.trusted_hash !== 'string' || value.trusted_hash.trim().length === 0) {
      throw new Error(`setup config.toml has invalid hooks.state entry ${key}: trusted_hash must be non-empty`);
    }
    trust[key] = value.trusted_hash;
  }
  return trust;
}

export function managedTrustByKey(hooks: readonly CodexHookMetadata[]): Record<string, string> {
  return Object.fromEntries(
    Object.values(managedCodexHooksByEvent(hooks)).map((hook) => [hook.key, hook.currentHash]),
  );
}

export function assertGeneratedTrustMatchesCodex(
  generatedTrust: Record<string, string>,
  hooks: readonly CodexHookMetadata[],
): void {
  const expected = managedTrustByKey(hooks);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(generatedTrust).sort();
  if (actualKeys.length !== MANAGED_CODEX_HOOK_EVENTS.length
    || actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(
      `Generated trust must contain exactly the ${MANAGED_CODEX_HOOK_EVENTS.length} current OMX hooks with no stale keys`,
    );
  }
  for (const [key, currentHash] of Object.entries(expected)) {
    if (generatedTrust[key] !== currentHash) {
      throw new Error(`Generated hook trust does not equal Codex hooks/list metadata for ${key}`);
    }
  }
}

export async function approveManagedHooksInCodex(
  server: CodexAppServer,
  hooks: readonly CodexHookMetadata[],
  expectedConfigPath: string,
): Promise<void> {
  const result = await server.request<unknown>(
    createCodexBatchWriteEnvelope(managedTrustByKey(hooks)),
    CODEX_APP_SERVER_TIMEOUTS.requestMs,
  );
  assertCodexBatchWriteResult(result, expectedConfigPath);
}

export function assertCodexBatchWriteResult(result: unknown, expectedConfigPath: string): void {
  const response = requireRecord(result, 'config/batchWrite result');
  if (response.filePath !== expectedConfigPath) {
    throw new Error(
      `Codex config/batchWrite wrote ${String(response.filePath)}, expected isolated user config ${expectedConfigPath}`,
    );
  }
  if (response.status !== 'ok' && response.status !== 'okOverridden') {
    throw new Error(`Codex config/batchWrite returned unsupported status ${String(response.status)}`);
  }
  if (!Object.hasOwn(response, 'version')) {
    throw new Error('Codex config/batchWrite result is missing version');
  }
}

export function hookMetadataSnapshot(hooks: readonly CodexHookMetadata[]): Array<Pick<CodexHookMetadata, 'event' | 'command' | 'key' | 'currentHash' | 'displayOrder' | 'trustStatus'>> {
  return hooks
    .map(({ event, command, key, currentHash, displayOrder, trustStatus }) => ({
      event,
      command,
      key,
      currentHash,
      displayOrder,
      trustStatus,
    }))
    .sort((left, right) => left.displayOrder - right.displayOrder);
}

export function appendForeignHookGroups(
  hooksContent: string,
  marker: string,
  options: { appendGroups: boolean },
): string {
  const parsed = JSON.parse(hooksContent) as { hooks?: Record<string, unknown> };
  if (!isRecord(parsed.hooks)) throw new Error('hooks.json is missing hooks object');
  const hooks = parsed.hooks as Record<string, unknown>;
  const foreignCommand = (event: string, suffix = '') =>
    `${JSON.stringify(process.execPath)} ${JSON.stringify(`${marker}-${event}${suffix}.js`)}`;
  const foreignGroup = (event: string) => ({
    ...(event === 'PreToolUse' ? { matcher: 'Bash' } : {}),
    foreign_group_metadata: {
      marker,
      nested: { keep: ['foreign', event], depth: { value: 7 } },
    },
    hooks: [{
      type: 'command',
      command: foreignCommand(event),
      statusMessage: `${marker} ${event}`,
      foreign_handler_metadata: { marker, event, values: [1, { two: true }] },
    }],
  });
  for (const event of ['PreToolUse', 'PostToolUse'] as const) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`hooks.${event} is not an array`);
    }
    const entries = (existing ?? []) as unknown[];
    if (options.appendGroups) {
      entries.push(foreignGroup(event));
    } else {
      const group = entries.find((entry): entry is JsonRecord => isRecord(entry)
        && Array.isArray(entry.hooks)
        && entry.hooks.some((hook) => isRecord(hook) && typeof hook.command === 'string' && hook.command.includes(marker)));
      if (!group) {
        throw new Error(`missing pre-seeded foreign ${event} group`);
      }
      const groupHooks = group.hooks;
      if (!Array.isArray(groupHooks)) {
        throw new Error(`missing pre-seeded foreign ${event} handler array`);
      }
      groupHooks.push({
        type: 'command',
        command: foreignCommand(event, '-inserted'),
        statusMessage: `${marker} inserted ${event}`,
        foreign_handler_metadata: { marker, inserted: true, nested: { event } },
      });
    }
    hooks[event] = entries;
  }
  return JSON.stringify(parsed, null, 2) + '\n';
}

export function appendDisplayOrderStableForeignHookGroups(
  hooksContent: string,
  marker: string,
  options: { appendGroups: boolean },
): string {
  const parsed = JSON.parse(hooksContent) as { hooks?: Record<string, unknown> };
  if (!isRecord(parsed.hooks)) throw new Error('hooks.json is missing hooks object');
  const hooks = parsed.hooks as Record<string, unknown>;
  const event = 'PreToolUse';
  const existing = hooks[event];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error(`hooks.${event} is not an array`);
  }
  const entries = (existing ?? []) as unknown[];
  const foreignCommand = (groupLabel: string, suffix = '') =>
    `${JSON.stringify(process.execPath)} ${JSON.stringify(`${marker}-${event}-${groupLabel}${suffix}.js`)}`;
  if (options.appendGroups) {
    for (const groupLabel of ['first', 'second']) {
      entries.push({
        ...(groupLabel === 'first' ? { matcher: 'Bash' } : {}),
        foreign_group_metadata: {
          marker,
          groupLabel,
          nested: { keep: ['foreign', event, groupLabel], depth: { value: 7 } },
        },
        hooks: [{
          type: 'command',
          command: foreignCommand(groupLabel),
          statusMessage: `${marker} ${event} ${groupLabel}`,
          foreign_handler_metadata: { marker, event, groupLabel, values: [1, { two: true }] },
        }],
      });
    }
  } else {
    const groupLabel = 'second';
    const group = entries.find((entry): entry is JsonRecord => isRecord(entry)
      && Array.isArray(entry.hooks)
      && entry.hooks.some((hook) => isRecord(hook)
        && hook.command === foreignCommand(groupLabel)));
    if (!group || !Array.isArray(group.hooks)) {
      throw new Error(`missing pre-seeded foreign ${event} ${groupLabel} group`);
    }
    for (const insertionLabel of ['one', 'two']) {
      group.hooks.push({
        type: 'command',
        command: foreignCommand(groupLabel, `-${insertionLabel}-inserted`),
        statusMessage: `${marker} inserted ${event} ${insertionLabel}`,
        foreign_handler_metadata: { marker, inserted: true, insertionLabel, nested: { event } },
      });
    }
  }
  hooks[event] = entries;
  return JSON.stringify(parsed, null, 2) + '\n';
}


export function foreignHookGroupSnapshot(hooksContent: string, marker: string): unknown[] {
  const parsed = JSON.parse(hooksContent) as { hooks?: Record<string, unknown> };
  if (!isRecord(parsed.hooks)) throw new Error('hooks.json is missing hooks object');
  const result: unknown[] = [];
  for (const [event, entries] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, groupIndex) => {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) return;
      entry.hooks.forEach((hook, handlerIndex) => {
        if (isRecord(hook) && typeof hook.command === 'string' && hook.command.includes(marker)) {
          result.push({ event, groupIndex, handlerIndex, group: structuredClone(entry), handler: structuredClone(hook) });
        }
      });
    });
  }
  return result;
}

export function assertForeignHookGroupsPreserved(
  expected: unknown[],
  actualContent: string,
  marker: string,
): void {
  const actual = foreignHookGroupSnapshot(actualContent, marker);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Foreign hook groups or metadata changed: ${JSON.stringify({ expected, actual })}`);
  }
}


export function probeCodexVersion(
  cwd: string,
  env: NodeJS.ProcessEnv,
  seam?: CodexCommandSpawnSeam,
): string {
  return resolvePinnedCodexExecutable(cwd, env, seam).version;
}
function usage(): string {
  return [
    'Usage: node scripts/smoke-packed-install.mjs',
    '',
    'Creates an npm tarball, installs it into an isolated prefix, and smoke tests the installed omx CLI.',
    'Release smoke validates installed CLI boot, native-hook dispatch, and the isolated setup/rerun/uninstall lifecycle; Codex trust checks run when the pinned CLI is present.',
  ].join('\n');
}

interface EnsureRepoDepsOptions {
  gitRunner?: typeof spawnSync;
  install?: (cwd: string) => void;
  log?: (message: string) => void;
}

interface EnsureRepoDepsResult {
  strategy: string;
  nodeModulesPath: string;
  sourceNodeModulesPath?: string;
}

function formatCommandFailure(cmd: string, args: string[], result: { stdout?: string; stderr?: string }): string {
  return [
    `Command failed: ${cmd} ${args.join(' ')}`,
    result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
    result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

export function ensureRepoDependencies(repoRoot: string, options: EnsureRepoDepsOptions = {}): EnsureRepoDepsResult {
  const {
    gitRunner = spawnSync,
    install = (cwd: string) => {
      const result = spawnSync('npm', ['ci'], {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (result.status !== 0) {
        throw new Error(formatCommandFailure('npm', ['ci'], result));
      }
    },
    log = () => {},
  } = options;

  const reusable = ensureReusableNodeModules(repoRoot, { gitRunner });
  if (reusable.strategy === 'existing') {
    return reusable;
  }
  if (reusable.strategy === 'symlink') {
    log(`[smoke:packed-install] Reusing node_modules from ${reusable.sourceNodeModulesPath}`);
    return reusable;
  }

  log('[smoke:packed-install] Installing repo dependencies with npm ci');
  install(repoRoot);
  return {
    strategy: 'installed',
    nodeModulesPath: join(repoRoot, 'node_modules'),
  };
}

function parseArgs(argv: string[]): void {
  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${token}\n${usage()}`);
  }
}

function run(cmd: string, args: readonly string[], options: Record<string, unknown> = {}): ReturnType<typeof spawnSync> {
  const result = spawnSync(cmd, [...args], {
    encoding: 'utf-8',
    stdio: 'pipe',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(cmd, [...args], result));
  }
  return result;
}

function npmBinName(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function resolveGlobalNodeModules(prefixDir: string): string {
  const result = run('npm', ['root', '-g', '--prefix', prefixDir], { cwd: prefixDir });
  const root = String(result.stdout || '').trim();
  if (!root) throw new Error('npm root -g did not return a node_modules directory');
  return root;
}

export function validateHookStdout(eventName: string, stdout: string): void {
  if (eventName === 'PostCompact') {
    if (stdout.length === 0) return;
    throw new Error('native hook PostCompact must emit empty stdout');
  }
  const trimmed = stdout.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `native hook ${eventName} emitted invalid JSON stdout: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`native hook ${eventName} emitted a non-object JSON stdout payload`);
  }
}

export function buildNativeHookSmokePayload(
  eventName: typeof PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS[number],
  smokeCwd: string,
): Record<string, unknown> {
  const base = {
    hook_event_name: eventName,
    session_id: `packed-install-smoke-${eventName}`,
    cwd: smokeCwd,
  };
  switch (eventName) {
    case 'SessionStart':
      return {
        ...base,
        transcript_path: join(smokeCwd, 'nonexistent-transcript.jsonl'),
      };
    case 'PreToolUse':
      return {
        ...base,
        tool_name: 'Bash',
        tool_use_id: 'packed-install-smoke-tool',
        tool_input: { command: 'echo packed install smoke' },
      };
    case 'PostToolUse':
      return {
        ...base,
        tool_name: 'Bash',
        tool_use_id: 'packed-install-smoke-tool',
        tool_input: { command: 'echo packed install smoke' },
        tool_response: {
          exit_code: 0,
          stdout: 'packed install smoke\n',
          stderr: '',
        },
      };
    case 'UserPromptSubmit':
      return {
        ...base,
        transcript_path: join(smokeCwd, 'nonexistent-transcript.jsonl'),
        prompt: 'packed install native hook smoke test',
      };
    case 'PreCompact':
    case 'PostCompact':
    case 'Stop':
      return base;
  }
}

function smokeInstalledNativeHookDist(prefixDir: string): void {
function runPackedTransportRegressions(hookScript: string, smokeCwd: string): void {
  const invoke = (cwd: string, environment: NodeJS.ProcessEnv, payload: Record<string, unknown>) => run(process.execPath, [realpathSync(hookScript)], {
    cwd, env: environment, input: JSON.stringify(payload),
  });
  const stopDecision = (cwd: string, environment: NodeJS.ProcessEnv, payload: Record<string, unknown>) => (
    JSON.parse(String(invoke(cwd, environment, { ...payload, hook_event_name: 'Stop' }).stdout || '{}')) as { decision?: string }
  ).decision;

  const g1bCwd = join(smokeCwd, 'g1bu');
  const g1bSession = 'g1bu';
  const g1bThread = 'g1bu-thread';
  const g1bPriorTurn = 'g1bu-turn-old';
  const g1bTurn = 'g1bu-turn-new';
  const g1bStateDir = join(g1bCwd, '.omx', 'state');
  const g1bSessionDir = join(g1bStateDir, 'sessions', g1bSession);
  mkdirSync(g1bSessionDir, { recursive: true });
  for (const [path, marker] of [
    [join(g1bStateDir, 'skill-active-state.json'), 'root-skill'],
    [join(g1bSessionDir, 'skill-active-state.json'), 'session-skill'],
  ] as const) {
    writeFileSync(path, JSON.stringify({ active: true, skill: 'autopilot', phase: 'completing', session_id: g1bSession, thread_id: g1bThread, turn_id: g1bPriorTurn, marker, active_skills: [{ skill: 'autopilot', phase: 'completing', active: true, session_id: g1bSession, thread_id: g1bThread, turn_id: g1bPriorTurn }] }));
  }
  for (const [path, marker] of [
    [join(g1bStateDir, 'autopilot-state.json'), 'root-autopilot'],
    [join(g1bSessionDir, 'autopilot-state.json'), 'session-autopilot'],
  ] as const) {
    writeFileSync(path, JSON.stringify({ active: false, mode: 'autopilot', current_phase: 'complete', session_id: g1bSession, thread_id: g1bThread, turn_id: g1bPriorTurn, marker }));
  }
  const g1bEnv = { ...buildPackedRegressionEnvironment({ name: 'g1bu' }), OMX_TEAM_MODE: 'disabled' };
  const g1bPrompt = '$team $autopilot restart — café';
  const g1bPayload = { hook_event_name: 'UserPromptSubmit', cwd: g1bCwd, session_id: g1bSession, thread_id: g1bThread, turn_id: g1bTurn, prompt: g1bPrompt };
  validateHookStdout('UserPromptSubmit', String(invoke(g1bCwd, g1bEnv, g1bPayload).stdout || ''));
  const g1bState = JSON.parse(readFileSync(join(g1bSessionDir, 'skill-active-state.json'), 'utf-8')) as { active?: boolean; skill?: string; session_id?: string; thread_id?: string; turn_id?: string; active_skills?: Array<{ active?: boolean; skill?: string; session_id?: string; thread_id?: string; turn_id?: string }> };
  const [g1bActiveSkill] = g1bState.active_skills ?? [];
  if (!g1bState.active || g1bState.skill !== 'autopilot' || g1bState.session_id !== g1bSession || g1bState.thread_id !== g1bThread || g1bState.turn_id !== g1bTurn || g1bState.active_skills?.length !== 1 || !g1bActiveSkill?.active || g1bActiveSkill.skill !== 'autopilot' || g1bActiveSkill.session_id !== g1bSession || g1bActiveSkill.thread_id !== g1bThread || g1bActiveSkill.turn_id !== g1bTurn) throw new Error('packed G1b-U did not persist singleton Autopilot ownership for the new turn');
  const g1bAutopilotState = JSON.parse(readFileSync(join(g1bSessionDir, 'autopilot-state.json'), 'utf-8')) as { active?: boolean; current_phase?: string; session_id?: string; thread_id?: string; turn_id?: string; state?: { handoff_artifacts?: { context_snapshot?: { path?: string } } } };
  const g1bContextSnapshot = g1bAutopilotState.state?.handoff_artifacts?.context_snapshot?.path;
  if (!g1bAutopilotState.active || g1bAutopilotState.current_phase !== 'deep-interview' || g1bAutopilotState.session_id !== g1bSession || g1bAutopilotState.thread_id !== g1bThread || g1bAutopilotState.turn_id !== g1bTurn || !g1bContextSnapshot || !readFileSync(resolve(g1bCwd, g1bContextSnapshot)).includes(Buffer.from(g1bPrompt, 'utf-8'))) throw new Error('packed G1b-U did not restart Autopilot with its UTF-8 context snapshot');
  if (existsSync(join(g1bStateDir, 'team-state.json')) || existsSync(join(g1bSessionDir, 'team-state.json'))) throw new Error('packed G1b-U created Team state');
  if (stopDecision(g1bCwd, g1bEnv, g1bPayload) !== 'block') throw new Error('packed G1b-U did not block Stop');

  const g2aCwd = join(smokeCwd, 'g2a');
  const g2aSession = 'g2a-stale-predecessor';
  const g2aStateDir = join(g2aCwd, '.omx', 'state');
  const g2aSessionDir = join(g2aStateDir, 'sessions', g2aSession);
  const g2aFiles = [join(g2aStateDir, 'skill-active-state.json'), join(g2aStateDir, 'ralplan-state.json'), join(g2aSessionDir, 'skill-active-state.json'), join(g2aSessionDir, 'ralplan-state.json'), join(g2aStateDir, 'session.json')];
  mkdirSync(g2aCwd, { recursive: true });
  if (g2aFiles.some((file) => existsSync(file))) throw new Error('packed G2a fixture unexpectedly contains state');
  const g2aEnv = buildPackedRegressionEnvironment({ name: 'g2a' });
  const g2aPayload = { hook_event_name: 'UserPromptSubmit', cwd: g2aCwd, session_id: g2aSession, thread_id: 'g2a-thread', turn_id: 'g2a-turn', prompt: 'use $ralplan is the consensus-planning command' };
  validateHookStdout('UserPromptSubmit', String(invoke(g2aCwd, g2aEnv, g2aPayload).stdout || ''));
  if (g2aFiles.some((file) => existsSync(file))) throw new Error('packed G2a stale predecessor created skill/detail state');
  if (stopDecision(g2aCwd, g2aEnv, g2aPayload) === 'block') throw new Error('packed G2a stale predecessor blocked Stop');
  if (g2aFiles.some((file) => existsSync(file))) throw new Error('packed G2a stale predecessor created skill/detail state after Stop');

  const g2bCwd = join(smokeCwd, 'g2b');
  const g2bSession = 'g2b-terminal-session';
  const g2bStateDir = join(g2bCwd, '.omx', 'state');
  const g2bSessionDir = join(g2bStateDir, 'sessions', g2bSession);
  const g2bFiles = [join(g2bStateDir, 'skill-active-state.json'), join(g2bStateDir, 'autopilot-state.json'), join(g2bSessionDir, 'skill-active-state.json'), join(g2bSessionDir, 'autopilot-state.json'), join(g2bStateDir, 'session.json')];
  mkdirSync(g2bSessionDir, { recursive: true });
  writeFileSync(g2bFiles[0]!, JSON.stringify({ version: 1, active: false, skill: 'autopilot', phase: 'complete', completed_at: '2026-06-01T00:00:01.001Z', session_id: 'g2b-root-session', thread_id: 'g2b-root-thread', turn_id: 'g2b-root-skill-turn', marker: 'g2b-root-skill' }));
  writeFileSync(g2bFiles[1]!, JSON.stringify({ mode: 'autopilot', active: false, current_phase: 'complete', completed_at: '2026-06-01T00:00:02.002Z', session_id: 'g2b-root-session', thread_id: 'g2b-root-thread', turn_id: 'g2b-root-detail-turn', marker: 'g2b-root-detail' }));
  writeFileSync(g2bFiles[2]!, JSON.stringify({ version: 1, active: false, skill: 'autopilot', phase: 'complete', completed_at: '2026-06-01T00:00:03.003Z', session_id: g2bSession, thread_id: 'g2b-session-thread', turn_id: 'g2b-session-skill-turn', marker: 'g2b-session-skill' }));
  writeFileSync(g2bFiles[3]!, JSON.stringify({ mode: 'autopilot', active: false, current_phase: 'complete', completed_at: '2026-06-01T00:00:04.004Z', session_id: g2bSession, thread_id: 'g2b-session-thread', turn_id: 'g2b-session-detail-turn', marker: 'g2b-session-detail' }));
  writeFileSync(g2bFiles[4]!, JSON.stringify({ session_id: g2bSession, cwd: g2bCwd, created_at: '2026-06-01T00:00:05.005Z', updated_at: '2026-06-01T00:00:06.006Z', last_turn_id: 'g2b-session-json-turn', marker: 'g2b-session-json' }));
  const g2bBefore: Buffer[] = g2bFiles.map((file) => readFileSync(file));
  const g2bEnv = buildPackedRegressionEnvironment({ name: 'g2b' });
  const g2bPayload = { hook_event_name: 'UserPromptSubmit', cwd: g2bCwd, session_id: g2bSession, thread_id: 'g2b-prompt-thread', turn_id: 'g2b-prompt-turn', prompt: 'do not start $autopilot — café' };
  validateHookStdout('UserPromptSubmit', String(invoke(g2bCwd, g2bEnv, g2bPayload).stdout || ''));
  for (const [index, file] of g2bFiles.entries()) if (Buffer.compare(readFileSync(file), g2bBefore[index]!) !== 0) throw new Error(`packed G2b negated prompt mutated terminal state ${file}`);
  if (stopDecision(g2bCwd, g2bEnv, g2bPayload) === 'block') throw new Error('packed G2b negated prompt blocked Stop');
  for (const [index, file] of g2bFiles.entries()) if (Buffer.compare(readFileSync(file), g2bBefore[index]!) !== 0) throw new Error(`packed G2b negated prompt mutated terminal state after Stop ${file}`);

  const g2cCwd = join(smokeCwd, 'g2c-01445');
  mkdirSync(g2cCwd, { recursive: true });
  const g2cPayload = { ...PACKED_CODEX_01445_NO_POINTER_NO_TRACKER_FIXTURE, cwd: g2cCwd };
  const g2cResult = invoke(g2cCwd, buildPackedRegressionEnvironment({ name: 'g2c-01445' }), g2cPayload);
  const g2cStdout = String(g2cResult.stdout || '');
  const g2cExpected = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan."}}\n';
  if (g2cStdout !== g2cExpected) throw new Error('packed Codex 0.144.5 fixture returned unexpected PreToolUse bytes');
  if (existsSync(join(g2cCwd, '.omx', 'state'))) throw new Error('packed Codex 0.144.5 fixture created pointer or tracker state');
}

  const globalNodeModules = resolveGlobalNodeModules(prefixDir);
  const packageRoot = join(globalNodeModules, 'oh-my-codex');
  const hookScript = join(packageRoot, 'dist', 'scripts', 'codex-native-hook.js');
  const smokeCwd = mkdtempSync(join(tmpdir(), 'omx-packed-hook-smoke-'));
  try {
    for (const eventName of PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS) {
      const payload = buildNativeHookSmokePayload(eventName, smokeCwd);
      const result = run(process.execPath, [realpathSync(hookScript)], {
        cwd: smokeCwd,
        env: {
          ...process.env,
          OMX_NATIVE_HOOK_DOCTOR_SMOKE: '1',
          OMX_ROOT: join(smokeCwd, '.omx-packed-hook-root'),
          OMX_SESSION_ID: `packed-install-smoke-${eventName}`,
          OMX_SOURCE_CWD: smokeCwd,
          OMX_STARTUP_CWD: smokeCwd,
        },
        input: JSON.stringify(payload),
      });
      validateHookStdout(eventName, result.stdout as string);
    }

    // #3194: the installed Codex 0.144.5 documented surface fails closed before
    // authority state or an adapted role intent can be created.
    const roleIntentCwd = join(smokeCwd, 'issue-3194-role-intent');
    const roleIntentHome = join(roleIntentCwd, 'home');
    const roleIntentCodexHome = join(roleIntentCwd, 'codex-home');
    const roleIntentNativeSessionId = 'synthetic-3194-session';
    mkdirSync(roleIntentHome, { recursive: true });
    mkdirSync(roleIntentCodexHome, { recursive: true });
    const roleIntentEnvironment = {
      ...buildPackedRegressionEnvironment({ name: 'issue-3194-role-intent' }),
      HOME: roleIntentHome,
      CODEX_HOME: roleIntentCodexHome,
    };
    const sessionStartResult = run(process.execPath, [realpathSync(hookScript)], {
      cwd: roleIntentCwd,
      env: roleIntentEnvironment,
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: roleIntentCwd, session_id: roleIntentNativeSessionId }),
    });
    validateHookStdout('SessionStart', String(sessionStartResult.stdout || ''));
    const trackingPath = join(roleIntentCwd, '.omx', 'state', 'subagent-tracking.json');
    if (existsSync(trackingPath)) throw new Error('installed #3194 SessionStart unexpectedly created tracker authority');

    const preToolUseResult = run(process.execPath, [realpathSync(hookScript)], {
      cwd: roleIntentCwd,
      env: roleIntentEnvironment,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        cwd: roleIntentCwd,
        session_id: roleIntentNativeSessionId,
        turn_id: 'synthetic-3194-turn',
        tool_name: 'Bash',
        tool_use_id: 'synthetic-3194-tool',
        tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
      }),
    });
    const preToolUseExpected = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan."}}\n';
    if (String(preToolUseResult.stdout || '') !== preToolUseExpected) {
      throw new Error('installed #3194 PreToolUse did not emit the exact unsupported denial');
    }
    if (existsSync(trackingPath)) throw new Error('installed #3194 PreToolUse unexpectedly created tracker authority');

    const roleIntentCliResult = spawnSync(process.execPath, [realpathSync(join(packageRoot, 'dist', 'cli', 'omx.js')), 'ralplan', 'role-intent', 'write', '--role', 'architect', '--parent-thread', roleIntentNativeSessionId, '--json'], {
      cwd: roleIntentCwd,
      env: roleIntentEnvironment,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    if (roleIntentCliResult.status === 0) throw new Error('installed #3194 role-intent CLI unexpectedly authorized an Architect receipt');
    if (String(roleIntentCliResult.stdout || '') !== '{"ok":false,"reason":"unsupported_documented_leader_proof"}\n') {
      throw new Error('installed #3194 role-intent CLI returned an unexpected denial');
    }
    if (existsSync(trackingPath)) throw new Error('installed #3194 role-intent CLI unexpectedly created tracker authority');

    for (const [caseIndex, testCase] of PACKED_INSTALL_NATIVE_HOOK_REGRESSION_PROMPTS.entries()) {
      const caseCwd = join(smokeCwd, testCase.name);
      const sessionId = `packed-regression-${caseIndex}`;
      mkdirSync(caseCwd, { recursive: true });
      const environment = buildPackedRegressionEnvironment(testCase);
      const promptPayload = {
        hook_event_name: 'UserPromptSubmit',
        cwd: caseCwd,
        source: 'codex-app',
        session_id: sessionId,
        thread_id: `thread-${caseIndex}`,
        turn_id: `turn-${caseIndex}`,
        prompt: testCase.prompt,
      };
      const promptResult = run(process.execPath, [realpathSync(hookScript)], {
        cwd: caseCwd,
        env: environment,
        input: JSON.stringify(promptPayload),
      });
      validateHookStdout('UserPromptSubmit', promptResult.stdout as string);
      const skillStatePath = join(caseCwd, '.omx', 'state', 'sessions', sessionId, 'skill-active-state.json');
      if (testCase.expectedSkill === null) {
        if (existsSync(skillStatePath)) throw new Error(`packed regression ${testCase.name} created workflow state`);
      } else {
        if (!existsSync(skillStatePath)) throw new Error(`packed regression ${testCase.name} did not create workflow state`);
        const skillState = JSON.parse(readFileSync(skillStatePath, 'utf-8')) as { active?: boolean; skill?: string; deferred_skills?: string[]; active_skills?: Array<{ skill?: string }> };
        if (!skillState.active || skillState.skill !== testCase.expectedSkill) {
          throw new Error(`packed regression ${testCase.name} persisted unexpected workflow state`);
        }
        if ('expectedDeferredSkills' in testCase && JSON.stringify(skillState.deferred_skills ?? []) !== JSON.stringify(testCase.expectedDeferredSkills)) {
          throw new Error(`packed regression ${testCase.name} persisted unexpected deferred workflows`);
        }
        if ('expectedActiveSkills' in testCase && JSON.stringify(skillState.active_skills?.map((entry) => entry.skill) ?? []) !== JSON.stringify(testCase.expectedActiveSkills)) {
          throw new Error(`packed regression ${testCase.name} persisted unexpected active workflows`);
        }
      }

      const stopResult = run(process.execPath, [realpathSync(hookScript)], {
        cwd: caseCwd,
        env: environment,
        input: JSON.stringify({ ...promptPayload, hook_event_name: 'Stop', turn_id: `stop-${caseIndex}` }),
      });
      const stopOutput = JSON.parse(String(stopResult.stdout || '{}')) as { decision?: string };
      if (testCase.expectedStopBlock && stopOutput.decision !== 'block') {
        throw new Error(`packed regression ${testCase.name} did not block Stop`);
      }
      if (!testCase.expectedStopBlock && stopOutput.decision === 'block') {
        throw new Error(`packed regression ${testCase.name} blocked Stop: ${JSON.stringify(stopOutput)}`);
      }
    }
    runPackedTransportRegressions(hookScript, smokeCwd);
  } finally {
    rmSync(smokeCwd, { recursive: true, force: true });
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isolatedSmokeEnv(home: string, codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  for (const key of [
    'OMX_SESSION_ID',
    'OMX_RUN_ID',
    'OMX_ROOT',
    'OMX_STATE_ROOT',
    'OMX_ACTIVE_SESSION_PID',
    'CODEX_SESSION_ID',
    'TMUX',
    'TMUX_PANE',
  ]) {
    delete env[key];
  }
  return env;
}

function trustedProjectConfig(projectDir: string): string {
  const escapedProjectDir = projectDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[projects."${escapedProjectDir}"]\ntrust_level = "trusted"\n`;
}


function rawManagedHookCount(hooksContent: string): number {
  const parsed = JSON.parse(hooksContent) as { hooks?: Record<string, unknown> };
  if (!isRecord(parsed.hooks)) throw new Error('hooks.json is missing hooks object');
  return Object.values(parsed.hooks).flatMap((entries) => Array.isArray(entries) ? entries : [])
    .flatMap((entry) => isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : [])
    .filter((hook) => isRecord(hook)
      && typeof hook.command === 'string'
      && isManagedCodexHookCommand(hook.command)).length;
}

function assertNoEmptyManagedEventGroups(hooksContent: string): void {
  const parsed = JSON.parse(hooksContent) as { hooks?: Record<string, unknown> };
  if (!isRecord(parsed.hooks)) throw new Error('hooks.json is missing hooks object');
  for (const event of MANAGED_CODEX_HOOK_EVENTS) {
    const entries = parsed.hooks[event];
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, groupIndex) => {
      if (isRecord(entry) && (!Array.isArray(entry.hooks) || entry.hooks.length === 0)) {
        throw new Error(`packed uninstall left an empty ${event} group at coordinate ${groupIndex}`);
      }
    });
  }
}

function assertNoSetupOwnedTrustKeys(configToml: string, setupTrust: Record<string, string>): void {
  const parsed = TOML.parse(configToml) as { hooks?: { state?: Record<string, unknown> } };
  const state = parsed.hooks?.state;
  if (!isRecord(state)) return;
  const retained = Object.keys(setupTrust).filter((key) => Object.hasOwn(state, key));
  if (retained.length > 0) {
    throw new Error(`packed uninstall retained setup-owned OMX hook trust keys: ${retained.join(', ')}`);
  }
}

function assertNativeHooksEnabledForForeignGroups(configToml: string): void {
  const parsed = TOML.parse(configToml) as { features?: Record<string, unknown> };
  const features = parsed.features;
  if (!isRecord(features) || (features.hooks !== true && features.codex_hooks !== true)) {
    throw new Error('packed uninstall disabled native hooks despite preserved foreign hook groups');
  }
}

function assertNoUninstallTransactionArtifacts(codexDir: string): void {
  const artifacts = readdirSync(codexDir).filter((entry) => entry.includes('.omx-uninstall-'));
  if (artifacts.length > 0) {
    throw new Error(`unsafe packed uninstall left replacement, staged, or tombstone paths: ${artifacts.join(', ')}`);
  }
}

function preToolUseGroupIndices(hooksContent: string, marker: string): {
  foreignIndices: number[];
  managedIndices: number[];
} {
  const parsed = JSON.parse(hooksContent) as { hooks?: Record<string, unknown> };
  if (!isRecord(parsed.hooks)) throw new Error('hooks.json is missing hooks object');
  const entries = parsed.hooks.PreToolUse;
  if (!Array.isArray(entries)) throw new Error('hooks.PreToolUse is missing');
  const foreignIndices: number[] = [];
  const managedIndices: number[] = [];
  entries.forEach((entry, index) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) return;
    if (entry.hooks.some((hook) => isRecord(hook)
      && typeof hook.command === 'string'
      && hook.command.includes(marker))) {
      foreignIndices.push(index);
    }
    if (entry.hooks.some((hook) => isRecord(hook)
      && typeof hook.command === 'string'
      && isManagedCodexHookCommand(hook.command))) {
      managedIndices.push(index);
    }
  });
  return { foreignIndices, managedIndices };
}

function assertManagedHooksAppendAfterForeign(hooksContent: string, marker: string): void {
  const { foreignIndices, managedIndices } = preToolUseGroupIndices(hooksContent, marker);
  if (
    foreignIndices.length !== 2 ||
    managedIndices.length !== 1 ||
    managedIndices[0]! <= Math.max(...foreignIndices)
  ) {
    throw new Error('packed first install did not append the OMX PreToolUse group after both foreign groups');
  }
}

function assertManagedHooksRemainBeforeForeign(hooksContent: string, marker: string): void {
  const { foreignIndices, managedIndices } = preToolUseGroupIndices(hooksContent, marker);
  if (
    foreignIndices.length !== 2 ||
    managedIndices.length !== 1 ||
    managedIndices[0]! >= Math.min(...foreignIndices)
  ) {
    throw new Error('packed setup rerun reordered the managed-first PreToolUse topology');
  }
}



function assertTrustedManagedHooks(hooks: readonly CodexHookMetadata[]): void {
  for (const [event, hook] of Object.entries(managedCodexHooksByEvent(hooks))) {
    if (hook.trustStatus !== 'trusted') {
      throw new Error(`Codex did not trust OMX ${event}; received ${hook.trustStatus}`);
    }
  }
}

function assertManagedHooksNotAlreadyTrusted(hooks: readonly CodexHookMetadata[]): void {
  for (const [event, hook] of Object.entries(managedCodexHooksByEvent(hooks))) {
    if (hook.trustStatus === 'trusted') {
      throw new Error(`setup-generated project trust unexpectedly pre-approved OMX ${event}`);
    }
  }
}
function preseededForeignHookMetadata(
  hooks: readonly CodexHookMetadata[],
  marker: string,
): Array<Pick<CodexHookMetadata, 'event' | 'command' | 'key' | 'currentHash' | 'displayOrder' | 'trustStatus'>> {
  return hookMetadataSnapshot(
    hooks.filter((hook) => hook.command.includes(marker) && !hook.command.includes('-inserted.js')),
  );
}

function assertPreseededForeignHookEvidence(
  expected: readonly Pick<CodexHookMetadata, 'event' | 'command' | 'key' | 'currentHash' | 'displayOrder' | 'trustStatus'>[],
  actualHooks: readonly CodexHookMetadata[],
  codexUserConfig: string,
  marker: string,
  phase: string,
): void {
  const actual = preseededForeignHookMetadata(actualHooks, marker);
  if (actual.length !== 2) {
    throw new Error(`Codex ${phase} did not report exactly two pre-seeded foreign hooks; received ${actual.length}`);
  }
  if (!sameJson(actual, expected)) {
    const changes = expected.flatMap((expectedHook, index) =>
      Object.entries(expectedHook).flatMap(([field, expectedValue]) => {
        const actualValue = actual[index]?.[field as keyof typeof expectedHook];
        return actualValue === expectedValue
          ? []
          : [`${expectedHook.event}.${field}: ${JSON.stringify(expectedValue)} -> ${JSON.stringify(actualValue)}`];
      }));
    throw new Error(
      `Codex ${phase} changed pre-seeded foreign hook key, hash, coordinate, or display order: ${changes.join('; ')}`,
    );
  }
  if (actual.some((hook) => hook.trustStatus !== 'trusted')) {
    throw new Error(`Codex ${phase} did not retain trusted status for every pre-seeded foreign hook`);
  }
  const trust = generatedHookTrustState(codexUserConfig);
  for (const hook of actual) {
    if (trust[hook.key] !== hook.currentHash) {
      throw new Error(`Codex ${phase} did not retain the foreign trust entry for ${hook.key}`);
    }
  }
}

async function observeInstalledCodexHooks(
  projectDir: string,
  hooksPath: string,
  env: NodeJS.ProcessEnv,
): Promise<CodexHooksListEntry> {
  const server = await CodexAppServer.start({ cwd: projectDir, env });
  try {
    await initializeCodexAppServer(server, 'omx-packed-install-smoke');
    return await listCodexHooks(server, projectDir, hooksPath);
  } finally {
    await server.close();
  }
}

export interface PackedHookTrustLifecycleResult {
  codexVersion: string | null;
}

/**
 * Exercise setup and removal against the installed package. The deterministic
 * filesystem lifecycle always runs; the installed-Codex trust leg is skipped
 * only when the `codex` executable is absent.
 */
export async function smokePackedHookTrustLifecycle(
  omxPath: string,
): Promise<PackedHookTrustLifecycleResult> {
  const lifecycleRoot = mkdtempSync(join(tmpdir(), 'omx-packed-hook-trust-'));
  const projectDir = resolve(lifecycleRoot, 'project');
  const home = join(lifecycleRoot, 'home');
  const codexHome = join(lifecycleRoot, 'codex-home');
  const hooksPath = join(projectDir, '.codex', 'hooks.json');
  const configPath = join(projectDir, '.codex', 'config.toml');
  const marker = 'omx-packed-foreign';
  const agentsPath = join(projectDir, 'AGENTS.md');
  const foreignAgentsContent = '# User project instructions\n\nPreserve this packed lifecycle guidance.\n';
  const env = isolatedSmokeEnv(home, codexHome);

  try {
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(join(projectDir, '.codex'), { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), trustedProjectConfig(projectDir), 'utf-8');
    writeFileSync(agentsPath, foreignAgentsContent, 'utf-8');

    // Pre-seed foreign groups so uninstall may safely remove OMX's appended suffix.
    writeFileSync(
      hooksPath,
      appendDisplayOrderStableForeignHookGroups('{"hooks":{}}', marker, { appendGroups: true }),
      'utf-8',
    );
    const preSetupForeignSnapshot = foreignHookGroupSnapshot(readFileSync(hooksPath, 'utf-8'), marker);
    if (preSetupForeignSnapshot.length !== 2) {
      throw new Error(`expected two pre-seeded foreign hook coordinates, received ${preSetupForeignSnapshot.length}`);
    }

    let codexVersion: string | null;
    try {
      codexVersion = probeCodexVersion(projectDir, env);
    } catch (error) {
      if (!(error instanceof CodexExecutableNotFoundError)) throw error;
      codexVersion = null;
    }

    const codexUserConfigPath = join(codexHome, 'config.toml');
    let approvedPreSetupForeignMetadata: Array<Pick<CodexHookMetadata, 'event' | 'command' | 'key' | 'currentHash' | 'displayOrder' | 'trustStatus'>> | null = null;
    if (codexVersion !== null) {
      const server = await CodexAppServer.start({ cwd: projectDir, env });
      try {
        await initializeCodexAppServer(server, 'omx-packed-install-smoke');
        const preSetupCodexHooks = await listCodexHooks(server, projectDir, hooksPath);
        const preSetupForeignHooks = preSetupCodexHooks.hooks.filter((hook) =>
          hook.command.includes(marker) && !hook.command.includes('-inserted.js'));
        if (preSetupForeignHooks.length !== 2) {
          throw new Error(`Codex hooks/list did not report exactly two pre-seeded foreign hooks; received ${preSetupForeignHooks.length}`);
        }
        if (preSetupForeignHooks.some((hook) => hook.trustStatus === 'trusted')) {
          throw new Error('isolated Codex approval state unexpectedly pre-approved a foreign hook before setup');
        }
        const approval = await server.request<unknown>(
          createCodexBatchWriteEnvelope(Object.fromEntries(
            preSetupForeignHooks.map((hook) => [hook.key, hook.currentHash]),
          )),
          CODEX_APP_SERVER_TIMEOUTS.requestMs,
        );
        assertCodexBatchWriteResult(approval, codexUserConfigPath);
      } finally {
        await server.close();
      }
      const approved = await observeInstalledCodexHooks(projectDir, hooksPath, env);
      approvedPreSetupForeignMetadata = preseededForeignHookMetadata(approved.hooks, marker);
      assertPreseededForeignHookEvidence(
        approvedPreSetupForeignMetadata,
        approved.hooks,
        readFileSync(codexUserConfigPath, 'utf-8'),
        marker,
        'pre-setup approval',
      );
    }

    const setupResult = run(omxPath, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], {
      cwd: projectDir,
      env,
    });
    if (!existsSync(agentsPath) || !readFileSync(agentsPath, 'utf-8').includes(foreignAgentsContent.trim())) {
      throw new Error(
        `packed setup --merge-agents did not preserve pre-existing user AGENTS.md guidance; stdout=${JSON.stringify(String(setupResult.stdout || ''))} stderr=${JSON.stringify(String(setupResult.stderr || ''))}`,
      );
    }

    const initialHooksContent = readFileSync(hooksPath, 'utf-8');
    assertForeignHookGroupsPreserved(preSetupForeignSnapshot, initialHooksContent, marker);
    if (rawManagedHookCount(initialHooksContent) !== MANAGED_CODEX_HOOK_EVENTS.length) {
      throw new Error('packed setup did not install exactly seven managed native hooks');
    }
    assertManagedHooksAppendAfterForeign(initialHooksContent, marker);
    const generatedTrust = generatedHookTrustState(readFileSync(configPath, 'utf-8'));

    let postForeignCodexHooks: CodexHookMetadata[] | null = null;
    if (codexVersion !== null) {
      const server = await CodexAppServer.start({ cwd: projectDir, env });
      try {
        await initializeCodexAppServer(server, 'omx-packed-install-smoke');
        const initialCodexHooks = await listCodexHooks(server, projectDir, hooksPath);
        assertGeneratedTrustMatchesCodex(generatedTrust, initialCodexHooks.hooks);
        assertManagedHooksNotAlreadyTrusted(initialCodexHooks.hooks);
        await approveManagedHooksInCodex(server, initialCodexHooks.hooks, codexUserConfigPath);
      } finally {
        await server.close();
      }
      const afterSetup = await observeInstalledCodexHooks(projectDir, hooksPath, env);
      assertTrustedManagedHooks(afterSetup.hooks);
      assertPreseededForeignHookEvidence(
        approvedPreSetupForeignMetadata!,
        afterSetup.hooks,
        readFileSync(codexUserConfigPath, 'utf-8'),
        marker,
        'setup',
      );
    }

    writeFileSync(
      hooksPath,
      appendDisplayOrderStableForeignHookGroups(readFileSync(hooksPath, 'utf-8'), marker, { appendGroups: false }),
      'utf-8',
    );
    const postForeignHooksContent = readFileSync(hooksPath, 'utf-8');
    const postForeignConfigContent = readFileSync(configPath, 'utf-8');

    const foreignSnapshot = foreignHookGroupSnapshot(postForeignHooksContent, marker);
    if (foreignSnapshot.length !== 4) {
      throw new Error(`expected four foreign hook coordinates after insertion, received ${foreignSnapshot.length}`);
    }
    if (codexVersion !== null) {
      const inspected = await observeInstalledCodexHooks(projectDir, hooksPath, env);
      assertTrustedManagedHooks(inspected.hooks);
      postForeignCodexHooks = inspected.hooks;
      assertPreseededForeignHookEvidence(
        approvedPreSetupForeignMetadata!,
        inspected.hooks,
        readFileSync(codexUserConfigPath, 'utf-8'),
        marker,
        'foreign insertion before setup rerun',
      );
    }

    run(omxPath, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], {
      cwd: projectDir,
      env,
    });
    const afterRerunHooksContent = readFileSync(hooksPath, 'utf-8');
    if (afterRerunHooksContent !== postForeignHooksContent) {
      throw new Error('packed setup rerun changed hooks.json after foreign insertion');
    }
    if (readFileSync(configPath, 'utf-8') !== postForeignConfigContent) {
      throw new Error('packed setup rerun changed config.toml after foreign insertion');
    }

    assertForeignHookGroupsPreserved(foreignSnapshot, afterRerunHooksContent, marker);
    if (postForeignCodexHooks !== null) {
      const afterRerun = await observeInstalledCodexHooks(projectDir, hooksPath, env);
      assertTrustedManagedHooks(afterRerun.hooks);
      assertPreseededForeignHookEvidence(
        approvedPreSetupForeignMetadata!,
        afterRerun.hooks,
        readFileSync(codexUserConfigPath, 'utf-8'),
        marker,
        'setup rerun',
      );
      if (!sameJson(hookMetadataSnapshot(afterRerun.hooks), hookMetadataSnapshot(postForeignCodexHooks))) {
        throw new Error('packed setup rerun changed Codex hook metadata or display order');
      }
    }

    run(omxPath, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], {
      cwd: projectDir,
      env,
    });
    const afterNoopHooksContent = readFileSync(hooksPath, 'utf-8');
    if (afterNoopHooksContent !== postForeignHooksContent) {
      throw new Error('third packed setup was not a hooks.json byte no-op');
    }
    if (readFileSync(configPath, 'utf-8') !== postForeignConfigContent) {
      throw new Error('third packed setup was not a config.toml byte no-op');
    }
    assertForeignHookGroupsPreserved(foreignSnapshot, afterNoopHooksContent, marker);
    if (postForeignCodexHooks !== null) {
      const afterNoop = await observeInstalledCodexHooks(projectDir, hooksPath, env);
      assertTrustedManagedHooks(afterNoop.hooks);
      assertPreseededForeignHookEvidence(
        approvedPreSetupForeignMetadata!,
        afterNoop.hooks,
        readFileSync(codexUserConfigPath, 'utf-8'),
        marker,
        'third setup',
      );
      if (!sameJson(hookMetadataSnapshot(afterNoop.hooks), hookMetadataSnapshot(postForeignCodexHooks))) {
        throw new Error('third packed setup changed Codex hook metadata or display order');
      }
    }
    run(omxPath, ['doctor', '--verbose'], { cwd: projectDir, env });
    if (!existsSync(agentsPath) || !readFileSync(agentsPath, 'utf-8').includes(foreignAgentsContent.trim())) {
      throw new Error('packed doctor lifecycle did not preserve pre-existing user AGENTS.md guidance');
    }

    run(omxPath, ['uninstall'], { cwd: projectDir, env });
    const afterUninstallHooksContent = readFileSync(hooksPath, 'utf-8');
    if (rawManagedHookCount(afterUninstallHooksContent) !== 0) {
      throw new Error('packed uninstall retained an OMX-managed native hook');
    }
    assertNoEmptyManagedEventGroups(afterUninstallHooksContent);
    assertForeignHookGroupsPreserved(foreignSnapshot, afterUninstallHooksContent, marker);
    if (!existsSync(agentsPath) || !readFileSync(agentsPath, 'utf-8').includes(foreignAgentsContent.trim())) {
      throw new Error('packed uninstall removed pre-existing user AGENTS.md guidance');
    }
    const afterUninstallConfig = readFileSync(configPath, 'utf-8');
    assertNoSetupOwnedTrustKeys(afterUninstallConfig, generatedTrust);
    assertNativeHooksEnabledForForeignGroups(afterUninstallConfig);
    if (postForeignCodexHooks !== null) {
      const afterUninstall = await observeInstalledCodexHooks(projectDir, hooksPath, env);
      const foreignIdentity = (hooks: readonly CodexHookMetadata[]) =>
        hookMetadataSnapshot(hooks.filter((hook) => hook.command.includes(marker)));
      const foreignBefore = foreignIdentity(postForeignCodexHooks);
      const foreignAfter = foreignIdentity(afterUninstall.hooks);
      if (!sameJson(foreignAfter, foreignBefore)) {
        throw new Error('packed uninstall changed foreign Codex hook metadata or display order');
      }
    }

    const managedFirstProjectDir = resolve(lifecycleRoot, 'managed-first-project');
    const managedFirstHooksPath = join(managedFirstProjectDir, '.codex', 'hooks.json');
    const managedFirstConfigPath = join(managedFirstProjectDir, '.codex', 'config.toml');
    const managedFirstMarker = 'omx-packed-managed-first-foreign';
    mkdirSync(join(managedFirstProjectDir, '.codex'), { recursive: true });
    run(omxPath, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], {
      cwd: managedFirstProjectDir,
      env,
    });
    writeFileSync(
      managedFirstHooksPath,
      appendDisplayOrderStableForeignHookGroups(
        readFileSync(managedFirstHooksPath, 'utf-8'),
        managedFirstMarker,
        { appendGroups: true },
      ),
      'utf-8',
    );
    const managedFirstBeforeRerunHooks = readFileSync(managedFirstHooksPath, 'utf-8');
    const managedFirstBeforeRerunConfig = readFileSync(managedFirstConfigPath, 'utf-8');
    const managedFirstForeignSnapshot = foreignHookGroupSnapshot(managedFirstBeforeRerunHooks, managedFirstMarker);
    if (managedFirstForeignSnapshot.length !== 2) {
      throw new Error('packed managed-first fixture did not append both foreign hook groups');
    }
    assertManagedHooksRemainBeforeForeign(managedFirstBeforeRerunHooks, managedFirstMarker);

    run(omxPath, ['setup', '--scope', 'project', '--merge-agents', '--legacy'], {
      cwd: managedFirstProjectDir,
      env,
    });
    if (readFileSync(managedFirstHooksPath, 'utf-8') !== managedFirstBeforeRerunHooks) {
      throw new Error('packed setup rerun reordered managed-first foreign hook groups');
    }
    if (readFileSync(managedFirstConfigPath, 'utf-8') !== managedFirstBeforeRerunConfig) {
      throw new Error('packed setup rerun changed managed-first config.toml');
    }
    assertForeignHookGroupsPreserved(
      managedFirstForeignSnapshot,
      readFileSync(managedFirstHooksPath, 'utf-8'),
      managedFirstMarker,
    );
    const managedFirstBeforeUninstallHooksBytes = readFileSync(managedFirstHooksPath);
    const managedFirstBeforeUninstallConfigBytes = readFileSync(managedFirstConfigPath);

    const expectedUnsafeManagedRemovalDiagnostic =
      'Removing OMX hooks would shift a foreign coordinate or discard opaque metadata.';
    const unsafeRemoval = planManagedCodexHooksRemoval(managedFirstBeforeRerunHooks, managedFirstHooksPath);
    if (
      unsafeRemoval.ok ||
      unsafeRemoval.error.code !== 'unsafe_managed_removal' ||
      unsafeRemoval.error.message !== expectedUnsafeManagedRemovalDiagnostic
    ) {
      throw new Error('packed managed-first fixture did not return the exact unsafe_managed_removal diagnostic');
    }
    const failedUninstall = spawnSync(omxPath, ['uninstall'], {
      cwd: managedFirstProjectDir,
      env,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    if (failedUninstall.error) throw failedUninstall.error;
    if (failedUninstall.status !== 1) {
      throw new Error(
        `packed unsafe uninstall exited ${String(failedUninstall.status)}, expected 1\nstdout:\n${failedUninstall.stdout || ''}\nstderr:\n${failedUninstall.stderr || ''}`,
      );
    }
    if (failedUninstall.stderr !== `Error: ${expectedUnsafeManagedRemovalDiagnostic}\n`) {
      throw new Error(`packed unsafe uninstall returned an unexpected diagnostic: ${failedUninstall.stderr || ''}`);
    }
    if (!readFileSync(managedFirstHooksPath).equals(managedFirstBeforeUninstallHooksBytes)) {
      throw new Error('unsafe packed uninstall changed raw hooks.json bytes');
    }
    if (!readFileSync(managedFirstConfigPath).equals(managedFirstBeforeUninstallConfigBytes)) {
      throw new Error('unsafe packed uninstall changed raw config.toml bytes');
    }
    assertNoUninstallTransactionArtifacts(join(managedFirstProjectDir, '.codex'));

    return { codexVersion };
  } finally {
    rmSync(lifecycleRoot, { recursive: true, force: true });
  }
}

export function parseNpmPackJsonOutput(stdout: string): Array<{ filename: string }> {
  const start = stdout.lastIndexOf('\n[');
  const jsonText = (start >= 0 ? stdout.slice(start + 1) : stdout).trim();
  if (!jsonText.startsWith('[')) {
    throw new Error(`npm pack did not return JSON output: ${stdout.trim()}`);
  }
  return JSON.parse(jsonText) as Array<{ filename: string }>;
}

async function main(): Promise<void> {
  parseArgs(process.argv.slice(2));

  const repoRoot = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), 'omx-packed-install-'));
  const prefixDir = join(tempRoot, 'prefix');
  mkdirSync(prefixDir, { recursive: true });

  let tarballPath: string | undefined;
  try {
    ensureRepoDependencies(repoRoot, {
      log: (message: string) => console.log(message),
    });

    const pack = run('npm', ['pack', '--json'], { cwd: repoRoot });
    const packOutput = parseNpmPackJsonOutput(pack.stdout as string);
    const tarballName = packOutput[0]?.filename;
    if (!tarballName) throw new Error('npm pack did not return a tarball filename');
    tarballPath = join(repoRoot, tarballName);

    run('npm', ['install', '-g', tarballPath, '--prefix', prefixDir], { cwd: repoRoot });

    const omxPath = join(prefixDir, process.platform === 'win32' ? '' : 'bin', npmBinName('omx'));
    for (const argv of PACKED_INSTALL_SMOKE_CORE_COMMANDS) {
      run(omxPath, argv, { cwd: repoRoot });
    }
    smokeInstalledNativeHookDist(prefixDir);
    const lifecycle = await smokePackedHookTrustLifecycle(omxPath);
    console.log(
      lifecycle.codexVersion !== null
        ? `packed install smoke: installed Codex 0.142.5 lifecycle passed (${lifecycle.codexVersion})`
        : 'packed install smoke: Codex executable absent; installed-Codex trust leg skipped after deterministic lifecycle',
    );

    console.log('packed install smoke: PASS');
  } finally {
    if (tarballPath) rmSync(tarballPath, { force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`packed install smoke: FAIL\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
