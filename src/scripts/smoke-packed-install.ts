import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseToml } from '@iarna/toml';
import {
  ensureReusableNodeModules,
} from '../utils/repo-deps.js';
import { escapeTomlString } from '../utils/toml.js';

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

export const PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'Stop',
] as const;

export const PACKED_INSTALL_PLUGIN_MCP_TARGETS = [
  ['omx_state', 'state', 'omx-state'],
  ['omx_memory', 'memory', 'omx-memory'],
  ['omx_code_intel', 'code-intel', 'omx-code-intel'],
  ['omx_trace', 'trace', 'omx-trace'],
  ['omx_wiki', 'wiki', 'omx-wiki'],
  ['omx_hermes', 'hermes', 'omx-hermes'],
] as const;

const PACKED_INSTALL_OPERATIONAL_PROBE_TIMEOUT_MS = 5_000;

function buildPackedProbeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper === 'NODE_OPTIONS' || upper.startsWith('OMX_') || upper.startsWith('CODEX_')) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

export interface PackedInstallNpmFile {
  path: string;
}

export interface PackedInstallNpmPackResult {
  filename: string;
  files?: PackedInstallNpmFile[];
}

export interface PackedInstallCommandResult {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

export const PACKED_INSTALL_REQUIRED_ARTIFACT_PATHS = [
  'dist/config/models.js',
  'dist/config/models.d.ts',
  'dist/agents/definitions.js',
  'dist/agents/definitions.d.ts',
  'dist/agents/native-config.js',
  'dist/agents/native-config.d.ts',
  'dist/team/model-contract.js',
  'dist/team/model-contract.d.ts',
  'dist/cli/index.js',
  'dist/cli/index.d.ts',
  'dist/cli/omx.js',
  'dist/cli/omx.d.ts',
  'skills/team/SKILL.md',
  'plugins/oh-my-codex/skills/team/SKILL.md',
  'plugins/oh-my-codex/.codex-plugin/plugin.json',
  'plugins/oh-my-codex/.mcp.json',
  'plugins/oh-my-codex/.app.json',
  'plugins/oh-my-codex/hooks/hooks.json',
  'plugins/oh-my-codex/hooks/codex-native-hook.mjs',
] as const;

export const PACKED_INSTALL_FORBIDDEN_ARTIFACT_PATHS = [
  '.gjc/',
  'docs/',
  '.omx/',
] as const;

function normalizedPackPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isForbiddenPackedInstallArtifact(path: string): boolean {
  const normalized = normalizedPackPath(path);
  return PACKED_INSTALL_FORBIDDEN_ARTIFACT_PATHS.some((prefix) => normalized.startsWith(prefix))
    || normalized.endsWith('.tgz')
    || normalized.endsWith('.tmp')
    || normalized.endsWith('.temp')
    || /(^|\/)(?:tmp|temp)\//.test(normalized);
}

export function assertPackedInstallFileMetadata(files: readonly PackedInstallNpmFile[]): void {
  const paths = new Set(files.map((file) => normalizedPackPath(file.path)));
  for (const requiredPath of PACKED_INSTALL_REQUIRED_ARTIFACT_PATHS) {
    if (!paths.has(requiredPath)) {
      throw new Error(`npm pack is missing required artifact: ${requiredPath}`);
    }
  }

  for (const path of paths) {
    if (isForbiddenPackedInstallArtifact(path)) {
      throw new Error(`npm pack includes forbidden workspace artifact: ${path}`);
    }
  }
}

function assertTextIncludes(text: string, expected: string, surface: string): void {
  if (!text.includes(expected)) {
    throw new Error(`${surface} is missing required text: ${expected}`);
  }
}

function assertTextMatches(text: string, pattern: RegExp, surface: string): void {
  if (!pattern.test(text)) {
    throw new Error(`${surface} does not satisfy required pattern: ${pattern}`);
  }
}

export function assertInstalledRootReasoningHelp(help: string): void {
  assertTextIncludes(help, 'Usage: omx reasoning <low|medium|high|xhigh>', 'installed omx help');
  for (const unsupportedOption of ['--max', '--ultra']) {
    if (help.includes(unsupportedOption)) {
      throw new Error(`installed omx help must not advertise ${unsupportedOption}`);
    }
  }
}

export function assertInstalledRootReasoningRejection(
  mode: 'max' | 'ultra',
  result: PackedInstallCommandResult,
  configBefore: string | undefined,
  configAfter: string | undefined,
): void {
  if (result.status !== 1) {
    throw new Error(`omx reasoning ${mode} must exit 1, received ${String(result.status)}`);
  }
  if (String(result.stdout ?? '').trim() !== '') {
    throw new Error(`omx reasoning ${mode} must not emit success stdout`);
  }
  if (configBefore !== configAfter) {
    throw new Error(`omx reasoning ${mode} must not create or mutate config.toml`);
  }

  const stderr = String(result.stderr ?? '');
  const fragments = mode === 'max'
    ? [
      'Reasoning mode "max" is not supported by "omx reasoning".',
      'Per-agent "max" is configured with agentReasoning; direct -c model_reasoning_effort=... is passed to Codex and remains capability-dependent.',
      'Invalid reasoning mode "max". Expected one of: low, medium, high, xhigh.',
      'Usage: omx reasoning <low|medium|high|xhigh>',
    ]
    : [
      'Reasoning mode "ultra" is not supported by OMX root or per-agent reasoning and is not an alias for "max".',
      'Direct -c model_reasoning_effort=... remains opaque Codex passthrough.',
      'Invalid reasoning mode "ultra". Expected one of: low, medium, high, xhigh.',
      'Usage: omx reasoning <low|medium|high|xhigh>',
    ];
  for (const fragment of fragments) {
    assertTextIncludes(stderr, fragment, `omx reasoning ${mode} stderr`);
  }
}

export function assertInstalledReasoningRuntimeContract(models: Record<string, unknown>): void {
  const expected = ['low', 'medium', 'high', 'xhigh'];
  const equalTuple = (name: string, actual: unknown, values: string[]): void => {
    if (!Array.isArray(actual) || actual.length !== values.length || actual.some((value, index) => value !== values[index])) {
      throw new Error(`${name} must be exactly ${JSON.stringify(values)}`);
    }
  };

  equalTuple('CANONICAL_REASONING_EFFORTS', models.CANONICAL_REASONING_EFFORTS, expected);
  equalTuple('AMBIGUOUS_UNSUPPORTED_REASONING_EFFORTS', models.AMBIGUOUS_UNSUPPORTED_REASONING_EFFORTS, ['max', 'ultra']);
  equalTuple('PER_AGENT_REASONING_EFFORTS', models.PER_AGENT_REASONING_EFFORTS, [...expected, 'max']);
  equalTuple('ROOT_REASONING_EFFORTS', models.ROOT_REASONING_EFFORTS, expected);
  equalTuple('ROOT_UNSUPPORTED_REASONING_EFFORTS', models.ROOT_UNSUPPORTED_REASONING_EFFORTS, ['max', 'ultra']);

  const isLegacyUnsupported = models.isAmbiguousUnsupportedReasoningEffort;
  const isRootUnsupported = models.isUnsupportedRootReasoningEffort;
  const normalizeRootUnsupported = models.normalizeUnsupportedRootReasoningEffort;
  if (typeof isLegacyUnsupported !== 'function' || isLegacyUnsupported('MAX') !== true) {
    throw new Error('legacy unsupported reasoning helper must remain case-insensitive');
  }
  if (typeof isRootUnsupported !== 'function'
    || isRootUnsupported('MAX') !== true
    || isRootUnsupported('ultra') !== true
    || isRootUnsupported('xhigh') !== false) {
    throw new Error('root unsupported reasoning helper must be a case-insensitive max/ultra classifier');
  }
  if (typeof normalizeRootUnsupported !== 'function'
    || normalizeRootUnsupported(' MAX ') !== 'max'
    || normalizeRootUnsupported('Ultra') !== 'ultra'
    || normalizeRootUnsupported('xhigh') !== undefined) {
    throw new Error('root unsupported reasoning normalizer must canonicalize only max and ultra');
  }
}

export function assertInstalledReasoningDeclarationContract(declarations: {
  models: string;
  definitions: string;
  nativeConfig: string;
  team: string;
}): void {
  const { models, definitions, nativeConfig, team } = declarations;
  const fourValueTuple = 'readonly ["low", "medium", "high", "xhigh"]';
  assertTextIncludes(models, `export declare const CANONICAL_REASONING_EFFORTS: ${fourValueTuple};`, 'models declaration');
  assertTextIncludes(models, 'export type ConfiguredAgentReasoningEffort = (typeof CANONICAL_REASONING_EFFORTS)[number];', 'models declaration');
  assertTextIncludes(models, 'export declare const AMBIGUOUS_UNSUPPORTED_REASONING_EFFORTS: readonly ["max", "ultra"];', 'models declaration');
  assertTextIncludes(models, 'export declare const PER_AGENT_REASONING_EFFORTS: readonly ["low", "medium", "high", "xhigh", "max"];', 'models declaration');
  assertTextIncludes(models, 'export type PerAgentReasoningEffort = (typeof PER_AGENT_REASONING_EFFORTS)[number];', 'models declaration');
  assertTextIncludes(models, `export declare const ROOT_REASONING_EFFORTS: ${fourValueTuple};`, 'models declaration');
  assertTextIncludes(models, 'export type RootReasoningEffort = (typeof ROOT_REASONING_EFFORTS)[number];', 'models declaration');
  assertTextIncludes(models, 'export declare const ROOT_UNSUPPORTED_REASONING_EFFORTS: readonly ["max", "ultra"];', 'models declaration');
  if (/isUnsupportedRootReasoningEffort\(value: string\): value is/.test(models)) {
    throw new Error('isUnsupportedRootReasoningEffort must be declared as a plain boolean, not a type predicate');
  }
  assertTextIncludes(models, 'export declare function isUnsupportedRootReasoningEffort(value: string): boolean;', 'models declaration');
  assertTextIncludes(models, 'export declare function normalizeUnsupportedRootReasoningEffort(value: string): RootUnsupportedReasoningEffort | undefined;', 'models declaration');

  const definitionMatch = /export interface AgentDefinition\s*\{([\s\S]*?)\n\}/.exec(definitions);
  if (!definitionMatch) throw new Error('AgentDefinition declaration is missing');
  const reasoningField = /\breasoningEffort(\?)?:\s*([^;]+);/.exec(definitionMatch[1]);
  if (!reasoningField || reasoningField[1] === '?') {
    throw new Error('AgentDefinition.reasoningEffort must remain required');
  }
  if (reasoningField[2] !== "'low' | 'medium' | 'high' | 'xhigh'") {
    throw new Error(`AgentDefinition.reasoningEffort widened unexpectedly: ${reasoningField[2] ?? 'missing'}`);
  }
  if (/\b(?:undefined|max|ultra)\b/.test(reasoningField[2])) {
    throw new Error('AgentDefinition.reasoningEffort must not allow undefined, max, or ultra');
  }

  assertTextIncludes(nativeConfig, 'reasoningEffort?: PerAgentReasoningEffort;', 'native config declaration');
  assertTextIncludes(team, 'export type TeamReasoningEffort = PerAgentReasoningEffort;', 'Team declaration');
  if (/\bultra\b/.test(team)) {
    throw new Error('Team declaration must not recognize ultra');
  }
}

export function assertInstalledTeamSkillContract(canonical: Buffer, pluginMirror: Buffer): void {
  if (!canonical.equals(pluginMirror)) {
    throw new Error('canonical and plugin Team skills must be byte-identical');
  }

  const skill = canonical.toString('utf-8');
  assertTextMatches(skill, /agentReasoning[\s\S]{0,240}`low`, `medium`, `high`, `xhigh`,(?: and)? `max`/, 'Team skill');
  assertTextMatches(skill, /`max`[\s\S]{0,240}passed[\s\S]{0,80}unchanged/i, 'Team skill');
  assertTextMatches(skill, /`max`[\s\S]{0,240}capability-dependent/i, 'Team skill');
  assertTextMatches(skill, /`ultra`[\s\S]{0,180}unsupported[\s\S]{0,180}not an alias for[\s\S]{0,100}`max`/i, 'Team skill');
  assertTextMatches(skill, /invalid configured values[\s\S]{0,180}built-in role-default fallback/i, 'Team skill');
  assertTextMatches(skill, /explicit raw `-c model_reasoning_effort=\.\.\.`[\s\S]{0,240}opaque[\s\S]{0,240}wins/i, 'Team skill');
  assertTextMatches(skill, /both sources[\s\S]{0,160}explicit raw reasoning[\s\S]{0,160}inherited Team reasoning[\s\S]{0,160}environment reasoning/i, 'Team skill');
  assertTextMatches(skill, /do not downgrade or retry `max` as `xhigh`[\s\S]{0,160}built-in role defaults remain unchanged/i, 'Team skill');
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readInstalledPluginManifest(packageRoot: string, relativePath: string): Record<string, unknown> {
  const path = join(packageRoot, relativePath);
  if (!existsSync(path)) throw new Error(`installed plugin manifest is missing: ${relativePath}`);

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`installed plugin manifest is not parseable JSON: ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isJsonRecord(manifest)) {
    throw new Error(`installed plugin manifest must be a JSON object: ${relativePath}`);
  }
  return manifest;
}

function assertInstalledPluginString(value: unknown, path: string, expected?: string): void {
  if (typeof value !== 'string' || value.trim() === '' || (expected !== undefined && value !== expected)) {
    throw new Error(`installed plugin manifest field is invalid: ${path}`);
  }
}

function assertInstalledPluginHookLauncherContract(hookSource: string): void {
  const requiredShape: Array<[RegExp, string]> = [
    [
      /['"]omx-command\.json['"]/,
      'read its pinned omx-command.json delegate configuration',
    ],
    [
      /\bspawn\s*\(\s*command\s*,\s*\[\s*\.\.\.\s*argsPrefix\s*,\s*['"]codex-native-hook['"]\s*\]/s,
      'spawn the configured delegate with the codex-native-hook argument',
    ],
    [
      /\.stdin\s*\.end\s*\(\s*input\s*\)/,
      'forward the hook input to the delegate stdin',
    ],
  ];
  for (const [pattern, requirement] of requiredShape) {
    if (!pattern.test(hookSource)) {
      throw new Error(`installed plugin native hook launcher must ${requirement}`);
    }
  }
}

export function assertInstalledPluginSurface(packageRoot: string): void {
  const pluginManifest = readInstalledPluginManifest(packageRoot, 'plugins/oh-my-codex/.codex-plugin/plugin.json');
  assertInstalledPluginString(pluginManifest.name, 'plugin.json.name', 'oh-my-codex');
  assertInstalledPluginString(pluginManifest.version, 'plugin.json.version');
  assertInstalledPluginString(pluginManifest.skills, 'plugin.json.skills', './skills/');
  assertInstalledPluginString(pluginManifest.mcpServers, 'plugin.json.mcpServers', './.mcp.json');
  assertInstalledPluginString(pluginManifest.apps, 'plugin.json.apps', './.app.json');
  assertInstalledPluginString(pluginManifest.hooks, 'plugin.json.hooks', './hooks/hooks.json');

  if (!isJsonRecord(pluginManifest.interface)) {
    throw new Error('installed plugin manifest field is invalid: plugin.json.interface');
  }
  for (const key of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category']) {
    assertInstalledPluginString(pluginManifest.interface[key], `plugin.json.interface.${key}`);
  }

  const mcpManifest = readInstalledPluginManifest(packageRoot, 'plugins/oh-my-codex/.mcp.json');
  if (!isJsonRecord(mcpManifest.mcpServers)) {
    throw new Error('installed plugin manifest field is invalid: .mcp.json.mcpServers');
  }
  const mcpServers = mcpManifest.mcpServers;
  for (const [serverName, server] of Object.entries(mcpServers)) {
    if (!isJsonRecord(server)
      || typeof server.command !== 'string'
      || server.command.trim() === ''
      || !Array.isArray(server.args)
      || server.args.some((arg) => typeof arg !== 'string')
      || typeof server.enabled !== 'boolean') {
      throw new Error(`installed MCP server is invalid: ${serverName}`);
    }
  }
  for (const [serverName, service] of PACKED_INSTALL_PLUGIN_MCP_TARGETS) {
    const server = mcpServers[serverName];
    if (!isJsonRecord(server)
      || server.command !== 'omx'
      || !Array.isArray(server.args)
      || server.args.length !== 2
      || server.args[0] !== 'mcp-serve'
      || server.args[1] !== service
      || server.enabled !== false) {
      throw new Error(`installed MCP server does not match the packaged contract: ${serverName}`);
    }
  }

  const appManifest = readInstalledPluginManifest(packageRoot, 'plugins/oh-my-codex/.app.json');
  if (!isJsonRecord(appManifest.apps)) {
    throw new Error('installed plugin manifest field is invalid: .app.json.apps');
  }

  const hooksManifest = readInstalledPluginManifest(packageRoot, 'plugins/oh-my-codex/hooks/hooks.json');
  if (!isJsonRecord(hooksManifest.hooks)) {
    throw new Error('installed plugin manifest field is invalid: hooks.json.hooks');
  }
  const expectedHookCommand = 'node "${PLUGIN_ROOT}/hooks/codex-native-hook.mjs"';
  for (const eventName of PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS) {
    const entries = hooksManifest.hooks[eventName];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`installed plugin hook event is missing: ${eventName}`);
    }
    for (const entry of entries) {
      if (!isJsonRecord(entry) || !Array.isArray(entry.hooks) || entry.hooks.length === 0) {
        throw new Error(`installed plugin hook entry is invalid: ${eventName}`);
      }
      for (const hook of entry.hooks) {
        if (!isJsonRecord(hook) || hook.type !== 'command' || hook.command !== expectedHookCommand) {
          throw new Error(`installed plugin hook command must target the native launcher: ${eventName}`);
        }
      }
    }
  }

  const hookPath = join(packageRoot, 'plugins/oh-my-codex/hooks/codex-native-hook.mjs');
  if (!existsSync(hookPath)) {
    throw new Error('installed plugin native hook launcher is missing');
  }
  const hookSource = readFileSync(hookPath, 'utf-8');
  if (!hookSource.startsWith('#!/usr/bin/env node')) {
    throw new Error('installed plugin native hook launcher must start with a Node shebang');
  }
  if (!/\bconst\s+OMX_PLUGIN_HOOK_LAUNCHER_CONTRACT_MARKER\s*=\s*['"]omx-plugin-hook-launcher:v1['"]/.test(hookSource)) {
    throw new Error('installed plugin native hook launcher is missing its stable contract marker');
  }
  assertInstalledPluginHookLauncherContract(hookSource);
  const syntaxCheck = spawnSync(process.execPath, ['--check', hookPath], { encoding: 'utf-8' });
  if (syntaxCheck.error || syntaxCheck.status !== 0) {
    const detail = String(syntaxCheck.stderr || syntaxCheck.error?.message || 'unknown syntax error').trim();
    throw new Error(`installed plugin native hook launcher fails Node syntax check: ${detail}`);
  }
}

function assertInstalledRequiredArtifacts(packageRoot: string): void {
  for (const relativePath of PACKED_INSTALL_REQUIRED_ARTIFACT_PATHS) {
    if (!existsSync(join(packageRoot, relativePath))) {
      throw new Error(`installed package is missing required artifact: ${relativePath}`);
    }
  }
}

async function assertInstalledReasoningArtifacts(packageRoot: string): Promise<void> {
  const models = await import(pathToFileURL(join(packageRoot, 'dist/config/models.js')).href) as Record<string, unknown>;
  const nativeConfig = await import(pathToFileURL(join(packageRoot, 'dist/agents/native-config.js')).href) as Record<string, unknown>;
  const definitions = await import(pathToFileURL(join(packageRoot, 'dist/agents/definitions.js')).href) as Record<string, unknown>;
  const team = await import(pathToFileURL(join(packageRoot, 'dist/team/model-contract.js')).href) as Record<string, unknown>;

  assertInstalledReasoningRuntimeContract(models);
  assertInstalledReasoningDeclarationContract({
    models: readFileSync(join(packageRoot, 'dist/config/models.d.ts'), 'utf-8'),
    definitions: readFileSync(join(packageRoot, 'dist/agents/definitions.d.ts'), 'utf-8'),
    nativeConfig: readFileSync(join(packageRoot, 'dist/agents/native-config.d.ts'), 'utf-8'),
    team: readFileSync(join(packageRoot, 'dist/team/model-contract.d.ts'), 'utf-8'),
  });

  const codexHome = mkdtempSync(join(tmpdir(), 'omx-packed-max-native-'));
  try {
    writeFileSync(join(codexHome, '.omx-config.json'), JSON.stringify({
      agentReasoning: { architect: ' MAX ' },
    }));
    const generateAgentToml = nativeConfig.generateAgentToml as (
      agent: unknown,
      prompt: string,
      options: { codexHomeOverride: string },
    ) => string;
    const agentDefinitions = definitions.AGENT_DEFINITIONS as Record<string, unknown>;
    const maxToml = generateAgentToml(agentDefinitions.architect, 'installed native max contract', { codexHomeOverride: codexHome });
    assertTextIncludes(maxToml, 'model_reasoning_effort = "max"', 'installed native TOML');
    if (maxToml.includes('model_reasoning_effort = "xhigh"')) {
      throw new Error('installed native TOML must not downgrade max to xhigh');
    }
    if ((parseToml(maxToml) as { model_reasoning_effort?: unknown }).model_reasoning_effort !== 'max') {
      throw new Error('installed native TOML must parse back to exact max');
    }
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }

  const resolveTeamWorkerLaunchArgs = team.resolveTeamWorkerLaunchArgs as (options: {
    existingRaw?: string;
    preferredReasoning?: string;
  }) => string[];
  const resolveTeamWorkerLaunchDiagnostics = team.resolveTeamWorkerLaunchDiagnostics as (options: {
    existingRaw?: string;
    preferredReasoning?: string;
  }) => { actualReasoning?: string; reasoningSource?: string };
  const maxArgs = resolveTeamWorkerLaunchArgs({ preferredReasoning: 'max' });
  if (maxArgs.join('\u0000') !== ['-c', 'model_reasoning_effort="max"'].join('\u0000')) {
    throw new Error(`Team must transport configured max exactly, received ${JSON.stringify(maxArgs)}`);
  }
  if (maxArgs.includes('model_reasoning_effort="xhigh"')) {
    throw new Error('Team must not downgrade max to xhigh');
  }
  const opaqueUltra = resolveTeamWorkerLaunchDiagnostics({
    existingRaw: '-c model_reasoning_effort="ultra"',
    preferredReasoning: 'max',
  });
  if (opaqueUltra.reasoningSource !== 'explicit' || opaqueUltra.actualReasoning !== undefined) {
    throw new Error('Team must preserve opaque explicit ultra without recognizing it');
  }

  assertInstalledTeamSkillContract(
    readFileSync(join(packageRoot, 'skills/team/SKILL.md')),
    readFileSync(join(packageRoot, 'plugins/oh-my-codex/skills/team/SKILL.md')),
  );
  assertInstalledPluginSurface(packageRoot);
}

function smokeInstalledRootReasoningRejections(omxPath: string, cwd: string): void {
  const codexHome = mkdtempSync(join(tmpdir(), 'omx-packed-root-reasoning-'));
  try {
    const env = buildPackedProbeEnv({ CODEX_HOME: codexHome });
    const configPath = join(codexHome, 'config.toml');
    const usageResult = spawnSync(omxPath, ['reasoning'], { cwd, encoding: 'utf-8', env });
    if (usageResult.status !== 0) {
      throw new Error(`omx reasoning usage must exit 0, received ${String(usageResult.status)}`);
    }
    assertInstalledRootReasoningHelp(String(usageResult.stdout ?? ''));
    const maxResult = spawnSync(omxPath, ['reasoning', 'max'], { cwd, encoding: 'utf-8', env });
    assertInstalledRootReasoningRejection('max', maxResult, undefined, existsSync(configPath) ? readFileSync(configPath, 'utf-8') : undefined);

    const originalConfig = 'model = "unchanged-root-model"\n';
    writeFileSync(configPath, originalConfig);
    const ultraResult = spawnSync(omxPath, ['reasoning', 'ultra'], { cwd, encoding: 'utf-8', env });
    assertInstalledRootReasoningRejection('ultra', ultraResult, originalConfig, readFileSync(configPath, 'utf-8'));
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}

export interface FakeCodexLaunch {
  argv: string[];
  cwd: string;
  hasResumeSqlite: boolean;
  OMX_NOTIFY_TEMP_CONTRACT: string | null;
  OMX_TEAM_WORKER_LAUNCH_ARGS: string | null;
}

export function parseFakeCodexLaunches(capture: string): FakeCodexLaunch[] {
  const trimmed = capture.trim();
  if (!trimmed) return [];
  return trimmed.split('\n').map((line) => {
    const launch: unknown = JSON.parse(line);
    if (!isJsonRecord(launch)
      || !Array.isArray(launch.argv)
      || launch.argv.some((arg) => typeof arg !== 'string')
      || typeof launch.cwd !== 'string'
      || typeof launch.hasResumeSqlite !== 'boolean'
      || (launch.OMX_NOTIFY_TEMP_CONTRACT !== null && typeof launch.OMX_NOTIFY_TEMP_CONTRACT !== 'string')
      || (launch.OMX_TEAM_WORKER_LAUNCH_ARGS !== null && typeof launch.OMX_TEAM_WORKER_LAUNCH_ARGS !== 'string')) {
      throw new Error('fake Codex capture did not contain a valid launch record');
    }
    return {
      argv: launch.argv,
      cwd: launch.cwd,
      hasResumeSqlite: launch.hasResumeSqlite,
      OMX_NOTIFY_TEMP_CONTRACT: launch.OMX_NOTIFY_TEMP_CONTRACT,
      OMX_TEAM_WORKER_LAUNCH_ARGS: launch.OMX_TEAM_WORKER_LAUNCH_ARGS,
    };
  });
}

function readFakeCodexLaunches(capturePath: string): FakeCodexLaunch[] {
  if (!existsSync(capturePath)) return [];
  return parseFakeCodexLaunches(readFileSync(capturePath, 'utf-8'));
}

function smokeInstalledLaunchArgumentBoundary(omxPath: string): void {
  const smokeRoot = mkdtempSync(join(tmpdir(), 'omx-packed-launch-boundary-'));
  const modelInstructionsPath = join(smokeRoot, 'model-instructions.md');
  try {
    const fakeBinDir = join(smokeRoot, 'bin');
    const launchCwd = join(smokeRoot, 'cwd');
    const codexHome = join(smokeRoot, 'codex-home');
    const isolatedHome = join(smokeRoot, 'home');
    const capturePath = join(smokeRoot, 'fake-codex-argv.jsonl');
    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(launchCwd, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });

    const fakeCodexSource = [
      'const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");',
      'const capturePath = process.env.OMX_PACKED_FAKE_CODEX_CAPTURE_PATH;',
      'if (!capturePath) process.exit(2);',
      'const priorLaunchCount = existsSync(capturePath) ? readFileSync(capturePath, "utf8").trim().split("\\n").filter(Boolean).length : 0;',
      'appendFileSync(capturePath, `${JSON.stringify({',
      '  argv: process.argv.slice(2),',
      '  cwd: process.cwd(),',
      '  OMX_NOTIFY_TEMP_CONTRACT: process.env.OMX_NOTIFY_TEMP_CONTRACT ?? null,',
      '  hasResumeSqlite: existsSync(require("node:path").join(process.env.CODEX_HOME ?? "", "state_5.sqlite")),',
      '  OMX_TEAM_WORKER_LAUNCH_ARGS: process.env.OMX_TEAM_WORKER_LAUNCH_ARGS ?? null,',
      '})}\\n`);',
      'if (process.env.OMX_PACKED_FAKE_CODEX_QUOTA_ON_FIRST === "1" && priorLaunchCount === 0) {',
      '  const sessionDir = require("node:path").join(process.env.CODEX_HOME ?? "", "sessions", "2026", "07", "13");',
      '  mkdirSync(sessionDir, { recursive: true });',
      '  writeFileSync(require("node:path").join(sessionDir, "rollout-packed-session-123.jsonl"), "{}\\n");',
      '  process.stderr.write("HTTP 429 quota exceeded\\n");',
      '  process.exit(1);',
      '}',
    ].join('\n');
    if (process.platform === 'win32') {
      const fakeCodexScript = join(fakeBinDir, 'codex.cjs');
      writeFileSync(fakeCodexScript, fakeCodexSource);
      writeFileSync(join(fakeBinDir, 'codex.cmd'), [
        '@echo off',
        `"${process.execPath}" "${fakeCodexScript}" %*`,
      ].join('\r\n'));
    } else {
      const fakeCodexPath = join(fakeBinDir, 'codex');
      writeFileSync(fakeCodexPath, `#!/usr/bin/env node\n${fakeCodexSource}\n`);
      chmodSync(fakeCodexPath, 0o755);
    }

    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const env = buildPackedProbeEnv({
      [pathKey]: `${fakeBinDir}${delimiter}${process.env[pathKey] ?? ''}`,
      CODEX_HOME: codexHome,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      OMX_BYPASS_DEFAULT_SYSTEM_PROMPT: '1',
      OMX_MODEL_INSTRUCTIONS_FILE: modelInstructionsPath,
      OMX_LAUNCH_POLICY: 'direct',
      OMX_PACKED_FAKE_CODEX_CAPTURE_PATH: capturePath,
    });
    delete env.OMX_NOTIFY_TEMP_CONTRACT;
    delete env.OMX_TEAM_WORKER_LAUNCH_ARGS;
    writeFileSync(modelInstructionsPath, '# Packed launch boundary instructions\n');

    for (const shorthand of ['--max', '--ultra'] as const) {
      const result = spawnSync(omxPath, [shorthand], { cwd: launchCwd, encoding: 'utf-8', env });
      if (result.status !== 1) {
        throw new Error(`omx ${shorthand} must reject before launching Codex, received ${String(result.status)}`);
      }
      assertTextIncludes(String(result.stderr ?? ''), `Unsupported OMX launch shorthand "${shorthand}".`, `omx ${shorthand} stderr`);
      if (readFakeCodexLaunches(capturePath).length !== 0) {
        throw new Error(`omx ${shorthand} must not launch Codex before the end-of-options marker`);
      }
    }

    for (const expectedArgs of [
      ['--', '--max'],
      ['--', '--ultra'],
      ['--', '-c', 'model_reasoning_effort=opaque-packed-smoke'],
      ['--', '--worktree', 'post-marker-branch'],
      ['--', '--notify-temp'],
      ['--', '--discord'],
      ['--', '--spark'],
      ['--', '--hotswap'],
      ['--', 'resume', '--project', '--codex-home', 'literal-codex-home', '--version'],
    ]) {
      writeFileSync(capturePath, '');
      const result = spawnSync(omxPath, expectedArgs, {
        cwd: launchCwd,
        encoding: 'utf-8',
        env,
        timeout: PACKED_INSTALL_OPERATIONAL_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      if (result.status !== 0) {
        throw new Error(formatCommandFailure(omxPath, expectedArgs, result));
      }
      const launches = readFakeCodexLaunches(capturePath);
      const launch = launches[0];
      const expectedCodexArgs = [
        '-c',
        `model_instructions_file="${escapeTomlString(modelInstructionsPath)}"`,
        ...expectedArgs,
      ];
      if (launches.length !== 1 || !launch) {
        throw new Error(`omx must launch exactly one fake Codex process: ${JSON.stringify(launches)}`);
      }
      assert.deepStrictEqual(
        launch.argv,
        expectedCodexArgs,
        'omx must inject model instructions before -- and preserve exact post-marker argument boundaries',
      );
      if (launch.cwd !== launchCwd) {
        throw new Error(`omx must not change cwd for post-marker arguments: expected ${launchCwd}, received ${launch.cwd}`);
      }
      if (launch.OMX_NOTIFY_TEMP_CONTRACT !== null) {
        throw new Error(`omx must not activate temporary notification routing for post-marker arguments: ${JSON.stringify(launch)}`);
      }
      if (launch.OMX_TEAM_WORKER_LAUNCH_ARGS !== null) {
        throw new Error(`omx must not enable spark worker routing for post-marker arguments: ${JSON.stringify(launch)}`);
      }
    }

    const projectOmxDir = join(launchCwd, '.omx');
    const projectCodexHome = join(launchCwd, '.codex');
    mkdirSync(projectOmxDir, { recursive: true });
    mkdirSync(projectCodexHome, { recursive: true });
    writeFileSync(join(projectOmxDir, 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
    writeFileSync(join(projectCodexHome, 'state_5.sqlite'), 'resume-only-sentinel');
    const imageResumeEnv = { ...env };
    delete imageResumeEnv.CODEX_HOME;
    const imageResumeCases: Array<{ args: string[]; resumes: boolean }> = [
      { args: ['-i', 'resume'], resumes: false },
      { args: ['--image', 'resume'], resumes: false },
      { args: ['--image=resume'], resumes: false },
      { args: ['-iresume'], resumes: false },
      { args: ['-i=resume'], resumes: false },
      { args: ['-i', 'screenshot.png', 'resume'], resumes: false },
      { args: ['--image', 'screenshot.png', 'resume'], resumes: false },
      { args: ['--image=screenshot.png', 'resume'], resumes: true },
      { args: ['-iscreenshot.png', 'resume'], resumes: true },
      { args: ['-i=screenshot.png', 'resume'], resumes: true },
      { args: ['-i', 'one.png', '-i', 'two.png', 'resume'], resumes: false },
      { args: ['--image', 'one.png', '--image', 'two.png', 'resume'], resumes: false },
      { args: ['-i', 'one.png,two.png', 'resume'], resumes: false },
      { args: ['--image', 'one.png,two.png', 'resume'], resumes: false },
      { args: ['--image', 'one.png', '--model', 'gpt-review', 'resume'], resumes: true },
      { args: ['--image=one.png', '--model=gpt-review', 'resume'], resumes: true },
    ];
    for (const testCase of imageResumeCases) {
      writeFileSync(capturePath, '');
      const result = spawnSync(omxPath, ['--direct', ...testCase.args], {
        cwd: launchCwd,
        encoding: 'utf-8',
        env: imageResumeEnv,
        timeout: PACKED_INSTALL_OPERATIONAL_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      assertBoundedProbeExit(`installed image resume arity ${JSON.stringify(testCase.args)}`, result, 0);
      const launches = readFakeCodexLaunches(capturePath);
      const launch = launches[0];
      if (launches.length !== 1 || !launch) {
        throw new Error(`installed image resume arity must invoke fake Codex exactly once: ${JSON.stringify(launches)}`);
      }
      const modelInstructionsArgs = ['-c', `model_instructions_file="${escapeTomlString(modelInstructionsPath)}"`];
      assert.deepStrictEqual(
        launch.argv,
        [...testCase.args, ...modelInstructionsArgs],
        'installed image resume arity must preserve exact Codex argv',
      );
      if (launch.hasResumeSqlite !== testCase.resumes) {
        throw new Error(`installed image resume arity mismatch for ${JSON.stringify(testCase.args)}: ${JSON.stringify(launch)}`);
      }
    }

    const packedAuthDir = join(isolatedHome, '.omx', 'auth');
    mkdirSync(packedAuthDir, { recursive: true });
    writeFileSync(join(packedAuthDir, 'first.json'), '{"access_token":"first-secret"}\n');
    writeFileSync(join(packedAuthDir, 'second.json'), '{"access_token":"second-secret"}\n');
    writeFileSync(join(packedAuthDir, 'slots.json'), JSON.stringify({
      version: 1,
      currentSlot: 'first',
      slots: [
        { slot: 'first', createdAt: 'now', updatedAt: 'now' },
        { slot: 'second', createdAt: 'now', updatedAt: 'now' },
      ],
    }, null, 2));
    writeFileSync(capturePath, '');
    const quotaSelectors = ['--last', '--all', '--include-non-interactive'];
    const quotaSuffix = ['--', ...quotaSelectors, '--model', 'opaque-model', 'opaque suffix'];
    const quotaResult = spawnSync(omxPath, [
      '--hotswap', '--direct', 'resume', ...quotaSelectors,
      '--model', 'gpt-review', '--remote', 'ws://127.0.0.1:4500', ...quotaSuffix,
    ], {
      cwd: launchCwd,
      encoding: 'utf-8',
      env: { ...env, OMX_PACKED_FAKE_CODEX_QUOTA_ON_FIRST: '1' },
      timeout: PACKED_INSTALL_OPERATIONAL_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    assertBoundedProbeExit('installed quota hotswap explicit-session retry', quotaResult, 0);
    const quotaLaunches = readFakeCodexLaunches(capturePath);
    const generatedInstructions = ['-c', `model_instructions_file="${escapeTomlString(modelInstructionsPath)}"`];
    assert.deepStrictEqual(quotaLaunches.map((launch) => launch.argv), [
      [
        'resume', ...quotaSelectors,
        '--model', 'gpt-review', '--remote', 'ws://127.0.0.1:4500',
        ...generatedInstructions, ...quotaSuffix,
      ],
      [
        'resume', 'packed-session-123',
        '--model', 'gpt-review', '--remote', 'ws://127.0.0.1:4500',
        ...generatedInstructions, ...quotaSuffix,
      ],
    ], 'installed quota retry must remove resume selectors only before the marker');

    const twoMarkerArgs = [
      '--direct',
      '--',
      '--notify-temp',
      '--spark',
      '--worktree',
      'post-marker-worktree',
      '--hotswap',
      '--xhigh',
      '--',
      '--madmax',
      '--notify-temp',
      '--spark',
      'trailing argument with spaces',
      '',
    ];
    writeFileSync(capturePath, '');
    const twoMarkerResult = spawnSync(omxPath, twoMarkerArgs, {
      cwd: launchCwd,
      encoding: 'utf-8',
      env,
      timeout: PACKED_INSTALL_OPERATIONAL_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    assertBoundedProbeExit('installed first-marker boundary launch', twoMarkerResult, 0);
    const twoMarkerLaunches = readFakeCodexLaunches(capturePath);
    if (twoMarkerLaunches.length !== 1 || !twoMarkerLaunches[0]) {
      throw new Error(`installed first-marker boundary launch must invoke fake Codex exactly once: ${JSON.stringify(twoMarkerLaunches)}`);
    }
    const twoMarkerLaunch = twoMarkerLaunches[0];
    assert.deepStrictEqual(twoMarkerLaunch.argv, [
      '-c',
      `model_instructions_file="${escapeTomlString(modelInstructionsPath)}"`,
      ...twoMarkerArgs.slice(1),
    ], 'the first literal -- must terminate OMX parsing and preserve every later argv element');
    if (twoMarkerLaunch.cwd !== launchCwd) {
      throw new Error(`the first literal -- must preserve launch cwd: expected ${launchCwd}, received ${twoMarkerLaunch.cwd}`);
    }
    if (twoMarkerLaunch.OMX_NOTIFY_TEMP_CONTRACT !== null) {
      throw new Error(`the first literal -- must not activate notification routing: ${JSON.stringify(twoMarkerLaunch)}`);
    }
    if (twoMarkerLaunch.OMX_TEAM_WORKER_LAUNCH_ARGS !== null) {
      throw new Error(`the first literal -- must not activate Team worker routing: ${JSON.stringify(twoMarkerLaunch)}`);
    }
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

function usage(): string {
  return [
    'Usage: node scripts/smoke-packed-install.mjs',
    '',
    'Creates an npm tarball, installs it into an isolated prefix, and smoke tests the installed omx CLI.',
    'Release smoke verifies packaged artifacts, installed reasoning boundaries, native hooks, and core CLI commands.',
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
  const trimmed = stdout.trim();
  if (!trimmed) return;
  try {
    JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `native hook ${eventName} emitted invalid JSON stdout: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  const globalNodeModules = resolveGlobalNodeModules(prefixDir);
  const packageRoot = join(globalNodeModules, 'oh-my-codex');
  const hookScript = join(packageRoot, 'dist', 'scripts', 'codex-native-hook.js');
  const smokeCwd = mkdtempSync(join(tmpdir(), 'omx-packed-hook-smoke-'));
  try {
    for (const eventName of PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS) {
      const payload = buildNativeHookSmokePayload(eventName, smokeCwd);
      const result = run(process.execPath, [realpathSync(hookScript)], {
        cwd: smokeCwd,
        env: buildPackedProbeEnv({
          OMX_NATIVE_HOOK_DOCTOR_SMOKE: '1',
          OMX_ROOT: join(smokeCwd, '.omx-packed-hook-root'),
          OMX_SESSION_ID: `packed-install-smoke-${eventName}`,
          OMX_SOURCE_CWD: smokeCwd,
          OMX_STARTUP_CWD: smokeCwd,
        }),
        input: JSON.stringify(payload),
      });
      validateHookStdout(eventName, result.stdout as string);
    }
  } finally {
    rmSync(smokeCwd, { recursive: true, force: true });
  }
}

function assertBoundedProbeExit(
  label: string,
  result: ReturnType<typeof spawnSync>,
  expectedStatus: number,
): void {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new Error(`${label} exceeded ${PACKED_INSTALL_OPERATIONAL_PROBE_TIMEOUT_MS}ms`);
  }
  if (result.status !== expectedStatus) {
    const detail = String(result.stderr ?? result.error?.message ?? '').trim();
    throw new Error(`${label} must exit ${expectedStatus}, received ${String(result.status)}${detail ? `: ${detail}` : ''}`);
  }
}

interface PackedPluginHookDelegateCall {
  argv: string[];
  stdin: string;
  cwd: string;
}

function readPackedPluginHookDelegateCalls(capturePath: string): PackedPluginHookDelegateCall[] {
  const capture = existsSync(capturePath) ? readFileSync(capturePath, 'utf-8').trim() : '';
  if (!capture) return [];
  return capture.split('\n').map((line) => {
    const record: unknown = JSON.parse(line);
    if (!isJsonRecord(record)
      || !Array.isArray(record.argv)
      || record.argv.some((arg) => typeof arg !== 'string')
      || typeof record.stdin !== 'string'
      || typeof record.cwd !== 'string') {
      throw new Error('pinned fake plugin hook delegate did not record a valid invocation');
    }
    return { argv: record.argv, stdin: record.stdin, cwd: record.cwd };
  });
}

function smokeInstalledPluginHookLauncher(packageRoot: string, omxPath: string): void {
  const smokeRoot = mkdtempSync(join(tmpdir(), 'omx-packed-plugin-hook-smoke-'));
  const hookDir = join(packageRoot, 'plugins', 'oh-my-codex', 'hooks');
  const hookLauncherPath = join(hookDir, 'codex-native-hook.mjs');
  const pinnedLauncherPath = join(hookDir, 'omx-command.json');
  const originalPinnedLauncher = existsSync(pinnedLauncherPath) ? readFileSync(pinnedLauncherPath) : undefined;
  const delegatePath = join(smokeRoot, 'pinned-fake-delegate.cjs');
  const capturePath = join(smokeRoot, 'pinned-fake-delegate.jsonl');
  const hookCwd = join(smokeRoot, 'cwd');
  const home = join(smokeRoot, 'home');
  const codexHome = join(smokeRoot, 'codex-home');
  const sessionId = 'packed-plugin-hook-session';
  try {
    mkdirSync(hookCwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(delegatePath, [
      'const { appendFileSync } = require("node:fs");',
      '(async () => {',
      'const chunks = [];',
      'for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));',
      'const stdin = Buffer.concat(chunks).toString("utf8");',
      'const payload = JSON.parse(stdin);',
      'appendFileSync(process.env.OMX_PACKED_PLUGIN_HOOK_CAPTURE_PATH, `${JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() })}\\n`);',
      'if (payload.delegate_mode === "non-stop-failure") {',
      '  process.stdout.write("delegate-failure\\n");',
      '  process.exitCode = 23;',
      '} else if (payload.delegate_mode === "stop-failure") {',
      '  process.exitCode = 23;',
      '} else if (payload.hook_event_name === "Stop") {',
      '  process.stdout.write("{\\\"decision\\\":\\\"block\\\",\\\"reason\\\":\\\"pinned stop delegate\\\"}\\n");',
      '} else {',
      '  process.stdout.write("{\\\"hookSpecificOutput\\\":{\\\"additionalContext\\\":\\\"pinned non-stop delegate\\\"}}\\n");',
      '}',
      '})().catch((error) => { console.error(error); process.exitCode = 1; });',
      '',
    ].join('\n'));
    writeFileSync(pinnedLauncherPath, JSON.stringify({
      command: process.execPath,
      argsPrefix: [delegatePath],
    }));

    const env = buildPackedProbeEnv({
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      OMX_AUTO_UPDATE: '0',
      OMX_NOTIFY_FALLBACK: '0',
      OMX_HOOK_DERIVED_SIGNALS: '0',
      OMX_ROOT: join(smokeRoot, '.omx-root'),
      OMX_STATE_ROOT: '',
      OMX_TEAM_STATE_ROOT: '',
      OMX_TEAM_WORKER: '',
      OMX_TEAM_WORKER_LAUNCH_ARGS: '',
      OMX_NOTIFY_TEMP_CONTRACT: '',
      OMX_ENTRY_PATH: omxPath,
      OMX_CODEX_LAUNCH_ID: 'packed-plugin-hook-launch',
      OMX_PACKED_PLUGIN_HOOK_CAPTURE_PATH: capturePath,
    });
    const runProbe = (
      name: string,
      payload: Record<string, unknown>,
      expectedStatus: number,
      expectedStdout: string,
    ): void => {
      writeFileSync(capturePath, '');
      const stdin = JSON.stringify(payload);
      const result = spawnSync(process.execPath, [hookLauncherPath], {
        cwd: hookCwd,
        encoding: 'utf-8',
        env,
        input: stdin,
        timeout: PACKED_INSTALL_OPERATIONAL_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      assertBoundedProbeExit(`installed plugin hook ${name}`, result, expectedStatus);
      if (String(result.stdout ?? '') !== expectedStdout) {
        throw new Error(`installed plugin hook ${name} stdout changed: expected ${JSON.stringify(expectedStdout)}, received ${JSON.stringify(String(result.stdout ?? ''))}`);
      }
      assert.deepStrictEqual(readPackedPluginHookDelegateCalls(capturePath), [{
        argv: ['codex-native-hook'],
        stdin,
        cwd: hookCwd,
      }], `installed plugin hook ${name} must forward exact delegate argv and stdin`);
    };

    runProbe('non-Stop', {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      cwd: hookCwd,
      prompt: 'packed plugin non-Stop probe',
    }, 0, '{"hookSpecificOutput":{"additionalContext":"pinned non-stop delegate"}}\n');
    runProbe('Stop', {
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: hookCwd,
    }, 0, '{"decision":"block","reason":"pinned stop delegate"}\n');
    runProbe('non-Stop delegate failure', {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      cwd: hookCwd,
      delegate_mode: 'non-stop-failure',
    }, 23, 'delegate-failure\n');

    writeFileSync(capturePath, '');
    const failedStopInput = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: hookCwd,
      delegate_mode: 'stop-failure',
    });
    const failedStop = spawnSync(process.execPath, [hookLauncherPath], {
      cwd: hookCwd,
      encoding: 'utf-8',
      env,
      input: failedStopInput,
      timeout: PACKED_INSTALL_OPERATIONAL_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    assertBoundedProbeExit('installed plugin hook Stop delegate failure', failedStop, 0);
    const failedStopOutput: unknown = JSON.parse(String(failedStop.stdout ?? ''));
    if (!isJsonRecord(failedStopOutput)) {
      throw new Error('installed plugin hook Stop delegate failure must emit JSON fallback output');
    }
    assert.deepStrictEqual({
      decision: failedStopOutput.decision,
      stopReason: failedStopOutput.stopReason,
    }, {
      decision: 'block',
      stopReason: 'plugin_stop_hook_launcher_exit',
    });
    assertTextMatches(
      String(failedStopOutput.systemMessage ?? ''),
      /codex-native-hook exited with code 23/,
      'installed plugin hook Stop delegate failure',
    );
    assert.deepStrictEqual(readPackedPluginHookDelegateCalls(capturePath), [{
      argv: ['codex-native-hook'],
      stdin: failedStopInput,
      cwd: hookCwd,
    }], 'installed plugin hook Stop failure must still delegate exact argv and stdin');
  } finally {
    if (originalPinnedLauncher === undefined) {
      rmSync(pinnedLauncherPath, { force: true });
    } else {
      writeFileSync(pinnedLauncherPath, originalPinnedLauncher);
    }
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

function smokeInstalledMcpTargets(omxPath: string): void {
  const smokeRoot = mkdtempSync(join(tmpdir(), 'omx-packed-mcp-smoke-'));
  const home = join(smokeRoot, 'home');
  const codexHome = join(smokeRoot, 'codex-home');
  const mcpInitialize = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'packed-install-smoke', version: '1' },
    },
  })}\n`;
  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    const env = buildPackedProbeEnv({
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      OMX_AUTO_UPDATE: '0',
      OMX_NOTIFY_FALLBACK: '0',
      OMX_HOOK_DERIVED_SIGNALS: '0',
      OMX_ROOT: join(smokeRoot, '.omx-root'),
      OMX_STATE_ROOT: '',
      OMX_TEAM_STATE_ROOT: '',
      OMX_TEAM_WORKER: '',
      OMX_TEAM_WORKER_LAUNCH_ARGS: '',
      OMX_NOTIFY_TEMP_CONTRACT: '',
    });
    for (const [serverName, target, expectedServerName] of PACKED_INSTALL_PLUGIN_MCP_TARGETS) {
      const result = spawnSync(omxPath, ['mcp-serve', target], {
        cwd: smokeRoot,
        encoding: 'utf-8',
        env,
        input: mcpInitialize,
        timeout: PACKED_INSTALL_OPERATIONAL_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      assertBoundedProbeExit(`installed MCP target ${serverName}`, result, 0);
      const responseText = String(result.stdout ?? '').trim();
      if (!responseText) {
        throw new Error(`installed MCP target ${serverName} did not respond before EOF`);
      }
      const responses = responseText.split('\n').map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch (error) {
          throw new Error(`installed MCP target ${serverName} emitted non-JSON stdout: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      const initializeResponse = responses.find((response) => isJsonRecord(response) && response.id === 1);
      if (!isJsonRecord(initializeResponse)
        || !isJsonRecord(initializeResponse.result)
        || !isJsonRecord(initializeResponse.result.serverInfo)
        || initializeResponse.result.serverInfo.name !== expectedServerName) {
        throw new Error(`installed MCP target ${serverName} must initialize ${expectedServerName}, received ${JSON.stringify(initializeResponse)}`);
      }
    }
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

export function parseNpmPackJsonOutput(stdout: string): PackedInstallNpmPackResult[] {
  const start = stdout.lastIndexOf('\n[');
  const jsonText = (start >= 0 ? stdout.slice(start + 1) : stdout).trim();
  if (!jsonText.startsWith('[')) {
    throw new Error(`npm pack did not return JSON output: ${stdout.trim()}`);
  }
  return JSON.parse(jsonText) as PackedInstallNpmPackResult[];
}

async function main(): Promise<void> {
  parseArgs(process.argv.slice(2));

  const repoRoot = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), 'omx-packed-install-'));
  const prefixDir = join(tempRoot, 'prefix');
  mkdirSync(prefixDir, { recursive: true });
  const installHome = join(tempRoot, 'home');
  const installCodexHome = join(tempRoot, 'codex-home');
  const installNpmCache = join(tempRoot, 'npm-cache');
  mkdirSync(installHome, { recursive: true });
  mkdirSync(installCodexHome, { recursive: true });
  mkdirSync(installNpmCache, { recursive: true });
  const installEnv = buildPackedProbeEnv({
    HOME: installHome,
    USERPROFILE: installHome,
    CODEX_HOME: installCodexHome,
    npm_config_cache: installNpmCache,
    NPM_CONFIG_CACHE: installNpmCache,
  });

  let tarballPath: string | undefined;
  try {
    ensureRepoDependencies(repoRoot, {
      log: (message: string) => console.log(message),
    });

    const pack = run('npm', ['pack', '--json'], { cwd: repoRoot });
    const packOutput = parseNpmPackJsonOutput(pack.stdout as string);
    const packedPackage = packOutput[0];
    const tarballName = packedPackage?.filename;
    if (!tarballName) throw new Error('npm pack did not return a tarball filename');
    if (!packedPackage.files) throw new Error('npm pack did not return file metadata');
    assertPackedInstallFileMetadata(packedPackage.files);
    tarballPath = join(repoRoot, tarballName);

    run('npm', ['install', '-g', tarballPath, '--prefix', prefixDir], { cwd: repoRoot, env: installEnv });

    const globalNodeModules = resolveGlobalNodeModules(prefixDir);
    const packageRoot = join(globalNodeModules, 'oh-my-codex');
    assertInstalledRequiredArtifacts(packageRoot);
    await assertInstalledReasoningArtifacts(packageRoot);

    const omxPath = join(prefixDir, process.platform === 'win32' ? '' : 'bin', npmBinName('omx'));
    smokeInstalledRootReasoningRejections(omxPath, repoRoot);
    smokeInstalledLaunchArgumentBoundary(omxPath);
    smokeInstalledPluginHookLauncher(packageRoot, omxPath);
    smokeInstalledMcpTargets(omxPath);
    for (const argv of PACKED_INSTALL_SMOKE_CORE_COMMANDS) {
      run(omxPath, argv, { cwd: repoRoot, env: installEnv });
    }
    smokeInstalledNativeHookDist(prefixDir);

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
