// @ts-nocheck
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertInstalledPluginSurface,
  assertInstalledReasoningDeclarationContract,
  assertInstalledReasoningRuntimeContract,
  assertInstalledRootReasoningHelp,
  assertInstalledRootReasoningRejection,
  assertInstalledTeamSkillContract,
  assertPackedInstallFileMetadata,
  buildNativeHookSmokePayload,
  ensureRepoDependencies,
  hasUsableNodeModules,
  isForbiddenPackedInstallArtifact,
  PACKED_INSTALL_FORBIDDEN_ARTIFACT_PATHS,
  PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS,
  PACKED_INSTALL_REQUIRED_ARTIFACT_PATHS,
  PACKED_INSTALL_SMOKE_CORE_COMMANDS,
  PACKED_INSTALL_PLUGIN_MCP_TARGETS,
  parseNpmPackJsonOutput,
  parseFakeCodexLaunches,
  resolveGitCommonDir,
  resolveReusableNodeModulesSource,
  validateHookStdout,
} from '../smoke-packed-install.js';

test('packed install smoke stays limited to boot + core commands', () => {
  assert.deepEqual(PACKED_INSTALL_SMOKE_CORE_COMMANDS, [
    ['--help'],
    ['version'],
    ['api', '--help'],
    ['sparkshell', '--help'],
  ]);
  assert.equal(
    PACKED_INSTALL_SMOKE_CORE_COMMANDS.some((argv) => argv.includes('api')),
    true,
  );
  assert.equal(
    PACKED_INSTALL_SMOKE_CORE_COMMANDS.some((argv) => argv.includes('sparkshell')),
    true,
  );
});

test('packed install smoke probes every advertised plugin MCP target', () => {
  assert.deepEqual(PACKED_INSTALL_PLUGIN_MCP_TARGETS, [
    ['omx_state', 'state', 'omx-state'],
    ['omx_memory', 'memory', 'omx-memory'],
    ['omx_code_intel', 'code-intel', 'omx-code-intel'],
    ['omx_trace', 'trace', 'omx-trace'],
    ['omx_wiki', 'wiki', 'omx-wiki'],
    ['omx_hermes', 'hermes', 'omx-hermes'],
  ]);
});

test('packed install smoke covers every installed native hook event with minimal payloads', () => {
  assert.deepEqual(PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS, [
    'SessionStart',
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'PreCompact',
    'PostCompact',
    'Stop',
  ]);

  for (const eventName of PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS) {
    const payload = buildNativeHookSmokePayload(eventName, '/tmp/omx-packed-hook-smoke');
    assert.equal(payload.hook_event_name, eventName);
    assert.equal(typeof payload.session_id, 'string');
    assert.equal(payload.cwd, '/tmp/omx-packed-hook-smoke');
  }
});

test('packed install native hook stdout validation allows empty or JSON output only', () => {
  assert.doesNotThrow(() => validateHookStdout('PostCompact', ''));
  assert.doesNotThrow(() => validateHookStdout('Stop', '{}\n'));
  assert.throws(
    () => validateHookStdout('UserPromptSubmit', '{not json'),
    /native hook UserPromptSubmit emitted invalid JSON stdout/,
  );
});

test('fake Codex launch capture preserves argv and runtime side-effect evidence', () => {
  const capture = `${JSON.stringify({
    argv: ['--', '--spark'],
    cwd: '/tmp/omx-packed-launch',
    hasResumeSqlite: true,
    OMX_NOTIFY_TEMP_CONTRACT: null,
    OMX_TEAM_WORKER_LAUNCH_ARGS: null,
  })}\n`;
  assert.deepEqual(parseFakeCodexLaunches(capture), [{
    argv: ['--', '--spark'],
    cwd: '/tmp/omx-packed-launch',
    hasResumeSqlite: true,
    OMX_NOTIFY_TEMP_CONTRACT: null,
    OMX_TEAM_WORKER_LAUNCH_ARGS: null,
  }]);
  assert.throws(
    () => parseFakeCodexLaunches(`${JSON.stringify({
      argv: ['--spark'],
      cwd: '/tmp/omx-packed-launch',
      OMX_NOTIFY_TEMP_CONTRACT: null,
    })}\n`),
    /fake Codex capture did not contain a valid launch record/,
  );
});

test('parseNpmPackJsonOutput ignores prepack logs before npm pack JSON', () => {
  const parsed = parseNpmPackJsonOutput([
    '[sync-plugin-mirror] synced 29 canonical skill directories and plugin metadata',
    '[',
    '  {',
    '    "filename": "oh-my-codex-0.15.0.tgz"',
    '  }',
    ']',
    '',
  ].join('\n'));

  assert.deepEqual(parsed, [{ filename: 'oh-my-codex-0.15.0.tgz' }]);
});

test('packed install metadata requires runtime, declarations, Team skills, and plugin assets only', () => {
  const files = PACKED_INSTALL_REQUIRED_ARTIFACT_PATHS.map((path) => ({ path }));
  assert.doesNotThrow(() => assertPackedInstallFileMetadata(files));
  assert.equal(
    PACKED_INSTALL_REQUIRED_ARTIFACT_PATHS.some((path) => path.startsWith('docs/')),
    false,
    'repository documentation must not become an npm package requirement',
  );
  assert.throws(
    () => assertPackedInstallFileMetadata(files.slice(1)),
    /npm pack is missing required artifact: dist\/config\/models\.js/,
  );
  assert.throws(
    () => assertPackedInstallFileMetadata([...files, { path: 'docs/reference/omx-config-schema-routing.md' }]),
    /npm pack includes forbidden workspace artifact: docs\/reference\/omx-config-schema-routing\.md/,
  );

  for (const path of [
    '.gjc/session/plan.md',
    'docs/reference/page.md',
    '.omx/state/team.json',
    'artifact.tgz',
    'tmp/smoke-output.txt',
    'temp/smoke-output.json',
    'scratch.tmp',
  ]) {
    assert.equal(isForbiddenPackedInstallArtifact(path), true, `expected ${path} to be rejected`);
  }
  for (const prefix of PACKED_INSTALL_FORBIDDEN_ARTIFACT_PATHS) {
    assert.equal(isForbiddenPackedInstallArtifact(`${prefix}probe`), true);
  }
  assert.equal(isForbiddenPackedInstallArtifact('templates/AGENTS.md'), false);
  assert.equal(isForbiddenPackedInstallArtifact('dist/notifications/__tests__/temp-mode.test.d.ts'), false);
});

test('packed install helpers enforce root rejection and no config mutation', () => {
  const help = 'Usage: omx reasoning <low|medium|high|xhigh>\n  --xhigh\n';
  assert.doesNotThrow(() => assertInstalledRootReasoningHelp(help));
  assert.throws(() => assertInstalledRootReasoningHelp(`${help}  --max\n`), /must not advertise --max/);

  const maxStderr = [
    'Reasoning mode "max" is not supported by "omx reasoning".',
    'Per-agent "max" is configured with agentReasoning; direct -c model_reasoning_effort=... is passed to Codex and remains capability-dependent.',
    'Invalid reasoning mode "max". Expected one of: low, medium, high, xhigh.',
    'Usage: omx reasoning <low|medium|high|xhigh>',
  ].join('\n');
  assert.doesNotThrow(() => assertInstalledRootReasoningRejection(
    'max',
    { status: 1, stdout: '', stderr: maxStderr },
    undefined,
    undefined,
  ));
  assert.throws(
    () => assertInstalledRootReasoningRejection('max', { status: 1, stdout: '', stderr: maxStderr }, undefined, 'created'),
    /must not create or mutate config\.toml/,
  );

  const ultraStderr = [
    'Reasoning mode "ultra" is not supported by OMX root or per-agent reasoning and is not an alias for "max".',
    'Direct -c model_reasoning_effort=... remains opaque Codex passthrough.',
    'Invalid reasoning mode "ultra". Expected one of: low, medium, high, xhigh.',
    'Usage: omx reasoning <low|medium|high|xhigh>',
  ].join('\n');
  assert.doesNotThrow(() => assertInstalledRootReasoningRejection(
    'ultra',
    { status: 1, stdout: '', stderr: ultraStderr },
    'model = "preserve"\n',
    'model = "preserve"\n',
  ));
});

test('packed install helpers freeze installed runtime and declaration reasoning contracts', () => {
  const models = {
    CANONICAL_REASONING_EFFORTS: ['low', 'medium', 'high', 'xhigh'],
    AMBIGUOUS_UNSUPPORTED_REASONING_EFFORTS: ['max', 'ultra'],
    PER_AGENT_REASONING_EFFORTS: ['low', 'medium', 'high', 'xhigh', 'max'],
    ROOT_REASONING_EFFORTS: ['low', 'medium', 'high', 'xhigh'],
    ROOT_UNSUPPORTED_REASONING_EFFORTS: ['max', 'ultra'],
    isAmbiguousUnsupportedReasoningEffort: (value: string) => value.toLowerCase() === 'max' || value.toLowerCase() === 'ultra',
    isUnsupportedRootReasoningEffort: (value: string) => value.toLowerCase() === 'max' || value.toLowerCase() === 'ultra',
    normalizeUnsupportedRootReasoningEffort: (value: string) => {
      const normalized = value.trim().toLowerCase();
      return normalized === 'max' || normalized === 'ultra' ? normalized : undefined;
    },
  };
  assert.doesNotThrow(() => assertInstalledReasoningRuntimeContract(models));

  const modelsDeclaration = [
    'export declare const CANONICAL_REASONING_EFFORTS: readonly ["low", "medium", "high", "xhigh"];',
    'export type ConfiguredAgentReasoningEffort = (typeof CANONICAL_REASONING_EFFORTS)[number];',
    'export declare const AMBIGUOUS_UNSUPPORTED_REASONING_EFFORTS: readonly ["max", "ultra"];',
    'export declare const PER_AGENT_REASONING_EFFORTS: readonly ["low", "medium", "high", "xhigh", "max"];',
    'export type PerAgentReasoningEffort = (typeof PER_AGENT_REASONING_EFFORTS)[number];',
    'export declare const ROOT_REASONING_EFFORTS: readonly ["low", "medium", "high", "xhigh"];',
    'export type RootReasoningEffort = (typeof ROOT_REASONING_EFFORTS)[number];',
    'export declare const ROOT_UNSUPPORTED_REASONING_EFFORTS: readonly ["max", "ultra"];',
    'export declare function isUnsupportedRootReasoningEffort(value: string): boolean;',
    'export declare function normalizeUnsupportedRootReasoningEffort(value: string): RootUnsupportedReasoningEffort | undefined;',
  ].join('\n');
  const definitionsDeclaration = [
    'export interface AgentDefinition {',
    "  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';",
    '}',
  ].join('\n');
  assert.doesNotThrow(() => assertInstalledReasoningDeclarationContract({
    models: modelsDeclaration,
    definitions: definitionsDeclaration,
    nativeConfig: 'export interface GeneratedNativeAgentConfig {\n  reasoningEffort?: PerAgentReasoningEffort;\n}',
    team: 'export type TeamReasoningEffort = PerAgentReasoningEffort;',
  }));
  assert.throws(
    () => assertInstalledReasoningDeclarationContract({
      models: modelsDeclaration.replace(': boolean;', ': value is RootUnsupportedReasoningEffort;'),
      definitions: definitionsDeclaration,
      nativeConfig: 'reasoningEffort?: PerAgentReasoningEffort;',
      team: 'export type TeamReasoningEffort = PerAgentReasoningEffort;',
    }),
    /plain boolean, not a type predicate/,
  );
});

test('packed install contract requires canonical/plugin Team skill parity and text', async () => {
  const canonical = await readFile(join(process.cwd(), 'skills/team/SKILL.md'));
  const pluginMirror = await readFile(join(process.cwd(), 'plugins/oh-my-codex/skills/team/SKILL.md'));
  assert.doesNotThrow(() => assertInstalledTeamSkillContract(canonical, pluginMirror));
});

test('packed install plugin assertions enforce the packaged plugin contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-packed-plugin-surface-'));
  try {
    const pluginRoot = join(root, 'plugins/oh-my-codex');
    const pluginManifestPath = join(pluginRoot, '.codex-plugin/plugin.json');
    const mcpManifestPath = join(pluginRoot, '.mcp.json');
    const appManifestPath = join(pluginRoot, '.app.json');
    const hooksManifestPath = join(pluginRoot, 'hooks/hooks.json');
    const hookLauncherPath = join(pluginRoot, 'hooks/codex-native-hook.mjs');
    const hookCommand = 'node "${PLUGIN_ROOT}/hooks/codex-native-hook.mjs"';
    await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true });
    await mkdir(join(pluginRoot, 'hooks'), { recursive: true });

    const writeValidPluginSurface = async (): Promise<void> => {
      await writeFile(pluginManifestPath, JSON.stringify({
        name: 'oh-my-codex',
        version: '0.0.0-test',
        skills: './skills/',
        mcpServers: './.mcp.json',
        apps: './.app.json',
        hooks: './hooks/hooks.json',
        interface: {
          displayName: 'OMX',
          shortDescription: 'Test plugin',
          longDescription: 'Structurally valid plugin test fixture.',
          developerName: 'Test',
          category: 'Developer Tools',
        },
      }));
      await writeFile(mcpManifestPath, JSON.stringify({
        mcpServers: Object.fromEntries([
          ['omx_state', 'state'],
          ['omx_memory', 'memory'],
          ['omx_code_intel', 'code-intel'],
          ['omx_trace', 'trace'],
          ['omx_wiki', 'wiki'],
          ['omx_hermes', 'hermes'],
        ].map(([name, service]) => [name, {
          command: 'omx',
          args: ['mcp-serve', service],
          enabled: false,
        }])),
      }));
      await writeFile(appManifestPath, JSON.stringify({ apps: {} }));
      await writeFile(hooksManifestPath, JSON.stringify({
        hooks: Object.fromEntries(PACKED_INSTALL_NATIVE_HOOK_SMOKE_EVENTS.map((eventName) => [eventName, [{
          hooks: [{ type: 'command', command: hookCommand }],
        }]])),
      }));
      await writeFile(hookLauncherPath, [
        '#!/usr/bin/env node',
        "import { spawn } from 'node:child_process';",
        "import { join } from 'node:path';",
        "const OMX_PLUGIN_HOOK_LAUNCHER_CONTRACT_MARKER = 'omx-plugin-hook-launcher:v1';",
        "const hookDir = new URL('.', import.meta.url).pathname;",
        'function readPinnedLauncher() {',
        "  const launcherPath = join(hookDir, 'omx-command.json');",
        '  return { command: process.execPath, argsPrefix: [], launcherPath };',
        '}',
        'const input = Buffer.from(\'\');',
        'const { command, argsPrefix } = readPinnedLauncher();',
        "const child = spawn(command, [...argsPrefix, 'codex-native-hook']);",
        'child.stdin.end(input);',
        '',
      ].join('\n'));
    };

    await writeValidPluginSurface();
    assert.doesNotThrow(() => assertInstalledPluginSurface(root));

    await writeValidPluginSurface();
    await writeFile(hookLauncherPath, [
      '#!/usr/bin/env node',
      "const OMX_PLUGIN_HOOK_LAUNCHER_CONTRACT_MARKER = 'omx-plugin-hook-launcher:v1';",
      'process.stdout.write(OMX_PLUGIN_HOOK_LAUNCHER_CONTRACT_MARKER);',
      '',
    ].join('\n'));
    assert.throws(
      () => assertInstalledPluginSurface(root),
      /must read its pinned omx-command\.json delegate configuration/,
    );

    await writeFile(pluginManifestPath, '{}');
    assert.throws(() => assertInstalledPluginSurface(root), /plugin\.json\.name/);

    await writeValidPluginSurface();
    await writeFile(mcpManifestPath, JSON.stringify({ mcpServers: {} }));
    assert.throws(() => assertInstalledPluginSurface(root), /omx_state/);

    await writeValidPluginSurface();
    await writeFile(appManifestPath, JSON.stringify({ apps: [] }));
    assert.throws(() => assertInstalledPluginSurface(root), /\.app\.json\.apps/);

    await writeValidPluginSurface();
    await writeFile(hooksManifestPath, JSON.stringify({ hooks: {} }));
    assert.throws(() => assertInstalledPluginSurface(root), /hook event is missing: SessionStart/);

    await writeValidPluginSurface();
    await writeFile(hookLauncherPath, 'export {};\n');
    assert.throws(() => assertInstalledPluginSurface(root), /must start with a Node shebang/);

    await writeValidPluginSurface();
    await writeFile(mcpManifestPath, '{not-json');
    assert.throws(() => assertInstalledPluginSurface(root), /plugin manifest is not parseable JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveGitCommonDir resolves relative git common dir output against the repo root', () => {
  const commonDir = resolveGitCommonDir('/tmp/worktree', () => ({
    status: 0,
    stdout: '../primary/.git\n',
    stderr: '',
  }) as ReturnType<typeof import('node:child_process').spawnSync>);
  assert.equal(commonDir, '/tmp/primary/.git');
});

test('hasUsableNodeModules requires the packaged build dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-node-modules-'));
  try {
    const nodeModules = join(root, 'node_modules');
    await mkdir(join(nodeModules, 'typescript'), { recursive: true });
    await mkdir(join(nodeModules, '@iarna', 'toml'), { recursive: true });
    await mkdir(join(nodeModules, '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(nodeModules, 'zod'), { recursive: true });
    await writeFile(join(nodeModules, 'typescript', 'package.json'), '{}');
    await writeFile(join(nodeModules, '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(nodeModules, '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(nodeModules, 'zod', 'package.json'), '{}');

    assert.equal(hasUsableNodeModules(root), true);

    await rm(join(nodeModules, 'zod', 'package.json'));
    assert.equal(hasUsableNodeModules(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveReusableNodeModulesSource reuses primary worktree node_modules when available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-reuse-node-modules-'));
  try {
    const primaryRepo = join(root, 'primary');
    const worktreeRepo = join(root, 'worktree');
    await mkdir(join(primaryRepo, 'node_modules', 'typescript'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@iarna', 'toml'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', 'zod'), { recursive: true });
    await writeFile(join(primaryRepo, 'node_modules', 'typescript', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', 'zod', 'package.json'), '{}');
    await mkdir(worktreeRepo, { recursive: true });

    const reusable = resolveReusableNodeModulesSource(worktreeRepo, () => ({
      status: 0,
      stdout: `${join(primaryRepo, '.git')}\n`,
      stderr: '',
    }) as ReturnType<typeof import('node:child_process').spawnSync>);

    assert.equal(reusable, join(primaryRepo, 'node_modules'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureRepoDependencies symlinks a reusable primary worktree node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-symlink-node-modules-'));
  try {
    const primaryRepo = join(root, 'primary');
    const worktreeRepo = join(root, 'worktree');
    await mkdir(join(primaryRepo, 'node_modules', 'typescript'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@iarna', 'toml'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
    await mkdir(join(primaryRepo, 'node_modules', 'zod'), { recursive: true });
    await writeFile(join(primaryRepo, 'node_modules', 'typescript', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@iarna', 'toml', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
    await writeFile(join(primaryRepo, 'node_modules', 'zod', 'package.json'), '{}');
    await mkdir(worktreeRepo, { recursive: true });

    const events: string[] = [];
    const result = ensureRepoDependencies(worktreeRepo, {
      gitRunner: () => ({
        status: 0,
        stdout: `${join(primaryRepo, '.git')}\n`,
        stderr: '',
      }) as ReturnType<typeof import('node:child_process').spawnSync>,
      install: () => {
        throw new Error('install should not be called when a reusable node_modules source exists');
      },
      log: (message: string) => events.push(message),
    });

    assert.equal(result.strategy, 'symlink');
    assert.equal(result.sourceNodeModulesPath, join(primaryRepo, 'node_modules'));
    assert.equal(events[0], `[smoke:packed-install] Reusing node_modules from ${join(primaryRepo, 'node_modules')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureRepoDependencies falls back to npm ci when no reusable node_modules source exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omx-smoke-install-node-modules-'));
  try {
    const installs: string[] = [];
    const result = ensureRepoDependencies(root, {
      gitRunner: () => ({
        status: 1,
        stdout: '',
        stderr: 'not a worktree',
      }) as ReturnType<typeof import('node:child_process').spawnSync>,
      install: (cwd: string) => {
        installs.push(cwd);
      },
    });

    assert.equal(result.strategy, 'installed');
    assert.deepEqual(installs, [root]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
