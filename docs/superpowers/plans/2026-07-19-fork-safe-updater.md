# Fork-safe Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `omx update --fork-dev` so the user's fork `dev` branch is built and installed under `~/.local` without changing the official `--dev` channel.

**Architecture:** Extend the existing update-channel contract and parameterize the current dev clone/build/pack path instead of adding a second updater. Carry one optional install prefix through installation, global-root discovery, installed-version/revision lookup, and setup refresh so every post-install operation targets the same package.

**Tech Stack:** TypeScript, Node.js standard library, npm CLI, Git CLI, Node test runner.

---

## File map

- Modify `src/cli/index.ts`: parse `--fork-dev` and document it in CLI help.
- Modify `src/cli/update.ts`: define the fork channel, reuse the dev build path, install under `~/.local`, and keep post-install discovery on that prefix.
- Modify `src/cli/__tests__/index.test.ts`: lock argument parsing, exclusivity, and help text.
- Modify `src/cli/__tests__/update.test.ts`: lock fork routing, prefix propagation, stamps, and failure guidance.
- Modify `src/cli/__tests__/package-bin-contract.test.ts`: keep packaged CLI help aligned with source help.

No new source file, dependency, configuration layer, or arbitrary repository option is needed.

### Task 1: Add the explicit CLI and channel contract

**Files:**
- Modify: `src/cli/index.ts:242-250,741-766`
- Modify: `src/cli/update.ts:12-80`
- Test: `src/cli/__tests__/index.test.ts:1923-1990`
- Test: `src/cli/__tests__/update.test.ts:1-22`
- Test: `src/cli/__tests__/package-bin-contract.test.ts:163-168`

- [ ] **Step 1: Write failing CLI and channel-configuration tests**

In `src/cli/__tests__/index.test.ts`, replace the update-channel assertions with:

```ts
it("resolves update channel flags and rejects invalid combinations", () => {
  assert.equal(resolveUpdateChannelArg([]), "stable");
  assert.equal(resolveUpdateChannelArg(["--stable"]), "stable");
  assert.equal(resolveUpdateChannelArg(["--dev"]), "dev");
  assert.equal(resolveUpdateChannelArg(["--fork-dev"]), "fork-dev");

  for (const args of [
    ["--dev", "--stable"],
    ["--fork-dev", "--stable"],
    ["--fork-dev", "--dev"],
  ]) {
    assert.throws(
      () => resolveUpdateChannelArg(args),
      /mutually exclusive/,
    );
  }

  assert.throws(
    () => resolveUpdateChannelArg(["--beta"]),
    /Unknown omx update option: --beta/,
  );
});
```

Add this assertion to the existing top-level-help test:

```ts
assert.match(
  HELP,
  /omx update --fork-dev\s+Install WangErgouaaaa\/oh-my-codex#dev under ~\/\.local, then refresh setup/,
);
```

In `src/cli/__tests__/update.test.ts`, import `homedir` and
`resolveUpdateChannelConfig`:

```ts
import { homedir, tmpdir } from 'node:os';
```

```ts
import {
  isInstallVersionBump,
  isNewerVersion,
  maybeCheckAndPromptUpdate,
  readUserInstallStamp,
  resolveAutoUpdateMode,
  resolveGlobalInstallRoot,
  resolveInstalledCliEntry,
  resolveUpdateChannelConfig,
  formatDeferredSetupCommand,
  resolveSetupRefreshArgs,
  runDeferredGlobalUpdate,
  runGlobalUpdate,
  runImmediateUpdate,
  shouldCheckForUpdates,
  spawnInstalledSetupRefresh,
  writeUserInstallStamp,
} from '../update.js';
```

Add:

```ts
describe('update channel config', () => {
  it('keeps the custom fork explicit and rooted under the user prefix', () => {
    assert.deepEqual(resolveUpdateChannelConfig('fork-dev' as never), {
      channel: 'fork-dev',
      installSource: 'github:WangErgouaaaa/oh-my-codex#dev',
      installPrefix: join(homedir(), '.local'),
    });
  });
});
```

Add the same `--fork-dev` help assertion to
`src/cli/__tests__/package-bin-contract.test.ts`:

```ts
assert.match(
  compiledCliSource,
  /omx update --fork-dev\s+Install WangErgouaaaa\/oh-my-codex#dev under ~\/\.local, then refresh setup/,
);
```

- [ ] **Step 2: Run the focused tests and confirm the new contract fails**

Run:

```bash
npm run build && node --test \
  dist/cli/__tests__/index.test.js \
  dist/cli/__tests__/update.test.js \
  dist/cli/__tests__/package-bin-contract.test.js
```

Expected: FAIL because `--fork-dev` is unknown, the help line is absent, and
the channel config falls back to stable.

- [ ] **Step 3: Implement the smallest channel and parser extension**

In `src/cli/update.ts`, change the OS import and update-channel block to:

```ts
import { homedir, tmpdir } from 'os';
```

```ts
export type UpdateChannel = 'stable' | 'dev' | 'fork-dev';

export interface UpdateChannelConfig {
  channel: UpdateChannel;
  installSource: string;
  installPrefix?: string;
}

const PACKAGE_NAME = 'oh-my-codex';
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const STABLE_INSTALL_SOURCE = `${PACKAGE_NAME}@latest`;
const DEV_INSTALL_SOURCE = 'github:Yeachan-Heo/oh-my-codex#dev';
const FORK_DEV_INSTALL_SOURCE = 'github:WangErgouaaaa/oh-my-codex#dev';
const DEV_REPOSITORY_URL = 'https://github.com/Yeachan-Heo/oh-my-codex.git';
const FORK_DEV_REPOSITORY_URL = 'https://github.com/WangErgouaaaa/oh-my-codex.git';
const DEV_REPOSITORY_BRANCH = 'dev';
const FORK_DEV_INSTALL_PREFIX = join(homedir(), '.local');
const DEV_UPDATE_TIMEOUT_MS = 300000;
const SKIP_NATIVE_AGENT_REFRESH_ENV = 'OMX_SKIP_NATIVE_AGENT_REFRESH';

function isDevelopmentChannel(channel: UpdateChannel): boolean {
  return channel === 'dev' || channel === 'fork-dev';
}

export function resolveUpdateChannelConfig(channel: UpdateChannel = 'stable'): UpdateChannelConfig {
  if (channel === 'dev') {
    return { channel: 'dev', installSource: DEV_INSTALL_SOURCE };
  }
  if (channel === 'fork-dev') {
    return {
      channel: 'fork-dev',
      installSource: FORK_DEV_INSTALL_SOURCE,
      installPrefix: FORK_DEV_INSTALL_PREFIX,
    };
  }
  return { channel: 'stable', installSource: STABLE_INSTALL_SOURCE };
}
```

In `src/cli/index.ts`, replace `resolveUpdateChannelArg` with:

```ts
export function resolveUpdateChannelArg(args: string[]): UpdateChannel {
  let channel: UpdateChannel = 'stable';
  let sawStable = false;
  let sawDev = false;
  let sawForkDev = false;

  for (const arg of args) {
    if (arg === '--stable') {
      sawStable = true;
      channel = 'stable';
      continue;
    }
    if (arg === '--dev') {
      sawDev = true;
      channel = 'dev';
      continue;
    }
    if (arg === '--fork-dev') {
      sawForkDev = true;
      channel = 'fork-dev';
      continue;
    }
    throw new Error(
      `Unknown omx update option: ${arg}. Expected no flags, --stable, --dev, or --fork-dev.`,
    );
  }

  if ([sawStable, sawDev, sawForkDev].filter(Boolean).length > 1) {
    throw new Error('omx update --stable, --dev, and --fork-dev are mutually exclusive.');
  }

  return channel;
}
```

Add this help entry immediately after the official `--dev` entry:

```text
  omx update --fork-dev
                Install WangErgouaaaa/oh-my-codex#dev under ~/.local, then refresh setup
```

- [ ] **Step 4: Run the focused tests and confirm they pass**

Run the Step 2 command again.

Expected: PASS for all three files.

- [ ] **Step 5: Commit the CLI contract**

```bash
git add \
  src/cli/index.ts \
  src/cli/update.ts \
  src/cli/__tests__/index.test.ts \
  src/cli/__tests__/update.test.ts \
  src/cli/__tests__/package-bin-contract.test.ts
git commit \
  -m "Keep custom fork updates explicit at the CLI boundary" \
  -m "Add a dedicated fork-dev channel while preserving stable and official dev meanings." \
  -m "Constraint: The custom source and ~/.local prefix are fixed by the approved design" \
  -m "Rejected: Repoint --dev | would silently replace the official dev contract" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: focused index, updater, and package-bin contract tests"
```

### Task 2: Reuse the dev build path for the fork and prefix the final install

**Files:**
- Modify: `src/cli/update.ts:217-405`
- Test: `src/cli/__tests__/update.test.ts:600-810`

- [ ] **Step 1: Write a failing fork build/install routing test**

Add beside the existing “packs the dev branch” test:

```ts
it('packs the fork dev branch and installs its tarball only under ~/.local', () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const prefix = join(homedir(), '.local');

  const result = runGlobalUpdate(
    'github:WangErgouaaaa/oh-my-codex#dev',
    ((command: string, args: readonly string[], options?: { cwd?: string }) => {
      calls.push({ command, args: args as string[], cwd: options?.cwd });
      if (command === 'git' && args[0] === 'clone') {
        mkdirSync(String(args[args.length - 1]), { recursive: true });
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        return okResult('abcdef1234567890\n');
      }
      if (command === 'npm' && args[0] === 'pack') {
        writeFileSync(
          join(options?.cwd ?? process.cwd(), 'oh-my-codex-0.20.3.tgz'),
          'packed',
        );
        return okResult(JSON.stringify([{ filename: 'oh-my-codex-0.20.3.tgz' }]));
      }
      return okResult();
    }) as unknown as typeof import('node:child_process').spawnSync,
    'linux',
  );

  assert.equal(result.ok, true);
  const cloneCall = calls.find((call) => call.command === 'git' && call.args[0] === 'clone');
  assert.deepEqual(cloneCall?.args.slice(0, 6), [
    'clone',
    '--depth',
    '1',
    '--branch',
    'dev',
    'https://github.com/WangErgouaaaa/oh-my-codex.git',
  ]);

  const finalInstall = calls.at(-1);
  assert.equal(finalInstall?.command, 'npm');
  assert.deepEqual(finalInstall?.args.slice(0, 4), [
    'install',
    '-g',
    '--prefix',
    prefix,
  ]);
  assert.match(finalInstall?.args[4] ?? '', /oh-my-codex-0\.20\.3\.tgz$/);
  assert.equal(
    calls.some((call) => call.args.includes('https://github.com/Yeachan-Heo/oh-my-codex.git')),
    false,
  );
});
```

- [ ] **Step 2: Run the updater test and confirm it fails**

Run:

```bash
npm run build && node --test dist/cli/__tests__/update.test.js
```

Expected: FAIL because the fork install source still takes the generic npm
install path instead of cloning and packing.

- [ ] **Step 3: Parameterize the existing internal dev updater**

Change the internal signature:

```ts
function runDevGlobalUpdate(
  repositoryUrl: string,
  installPrefix: string | undefined,
  spawnProcess: SpawnSyncLike,
  platform: NodeJS.Platform,
): RunGlobalUpdateResult {
```

Change the clone arguments to use `repositoryUrl`:

```ts
['clone', '--depth', '1', '--branch', DEV_REPOSITORY_BRANCH, repositoryUrl, checkoutDir]
```

Replace the final tarball-install argument construction with:

```ts
const globalInstallArgs = ['install', '-g'];
if (installPrefix) {
  globalInstallArgs.push('--prefix', installPrefix);
}
globalInstallArgs.push(tarballPath);

const globalInstallResult = spawnNpmSync(
  globalInstallArgs,
  {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: DEV_UPDATE_TIMEOUT_MS,
    windowsHide: true,
  },
  spawnProcess,
  platform,
);
```

Replace the development-source dispatch in `runGlobalUpdate` with:

```ts
if (installSource === DEV_INSTALL_SOURCE) {
  return runDevGlobalUpdate(
    DEV_REPOSITORY_URL,
    undefined,
    spawnProcess,
    resolvedPlatform,
  );
}
if (installSource === FORK_DEV_INSTALL_SOURCE) {
  return runDevGlobalUpdate(
    FORK_DEV_REPOSITORY_URL,
    FORK_DEV_INSTALL_PREFIX,
    spawnProcess,
    resolvedPlatform,
  );
}
```

- [ ] **Step 4: Run the updater test and confirm both dev channels pass**

Run the Step 2 command again.

Expected: PASS, including the existing official-dev test and the new fork test.

- [ ] **Step 5: Commit the shared build-path change**

```bash
git add src/cli/update.ts src/cli/__tests__/update.test.ts
git commit \
  -m "Prevent fork updates from entering the default npm prefix" \
  -m "Route the fixed fork source through the existing dev build pipeline and add the ~/.local prefix only to its final tarball install." \
  -m "Constraint: Official --dev must keep its existing unprefixed install behavior" \
  -m "Rejected: Duplicate the dev updater | would create two build paths to maintain" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: focused updater tests"
```

### Task 3: Keep discovery, setup refresh, stamps, and failures on the fork prefix

**Files:**
- Modify: `src/cli/update.ts:548-604,690-990`
- Test: `src/cli/__tests__/update.test.ts:420-475,780-1210`

- [ ] **Step 1: Write failing prefix-discovery and fork lifecycle tests**

Add this global-root test:

```ts
it('passes the fork prefix to npm global-root lookup', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const prefix = join(homedir(), '.local');

  const root = resolveGlobalInstallRoot(
    ((command: string, args: readonly string[]) => {
      calls.push({ command, args: args as string[] });
      return okResult(join(prefix, 'lib', 'node_modules'));
    }) as unknown as typeof import('node:child_process').spawnSync,
    'linux',
    prefix,
  );

  assert.equal(root, join(prefix, 'lib', 'node_modules'));
  assert.deepEqual(calls[0].args, ['root', '-g', '--prefix', prefix]);
});
```

Replace the existing current-dev-baseline test with this two-channel form:

```ts
for (const [installChannel, installSource] of [
  ['dev', 'github:Yeachan-Heo/oh-my-codex#dev'],
  ['fork-dev', 'github:WangErgouaaaa/oh-my-codex#dev'],
] as const) {
  it(`treats a current ${installChannel} install dev_base_version as the launch update baseline`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), `omx-update-${installChannel}-baseline-`));
    let promptCalls = 0;
    let updateAttempts = 0;

    try {
      await withInteractiveTty(async () => {
        await maybeCheckAndPromptUpdate(cwd, {
          getCurrentVersion: async () => '0.18.10',
          fetchLatestVersion: async () => '0.18.11',
          readUserInstallStamp: async () => ({
            installed_version: '0.18.10',
            setup_completed_version: '0.18.10',
            install_channel: installChannel,
            install_source: installSource,
            install_revision: '8214377e3c1d',
            dev_base_version: '0.18.11',
            updated_at: '2026-06-09T20:21:24.070Z',
          }),
          askYesNo: async () => {
            promptCalls += 1;
            return true;
          },
          runDeferredGlobalUpdate: () => {
            updateAttempts += 1;
            return {
              ok: true,
              stderr: '',
              logPath: join(cwd, '.omx', 'logs', 'update-test.log'),
            };
          },
        });
      });

      assert.equal(promptCalls, 0);
      assert.equal(updateAttempts, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
```

Add this immediate-update test:

```ts
it('refreshes and stamps the fork installation under the same ~/.local prefix', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-update-now-fork-dev-'));
  const stampPath = join(cwd, '.codex', '.omx', 'install-state.json');
  const originalCodexHome = process.env.CODEX_HOME;
  const prefix = join(homedir(), '.local');
  const installSources: string[] = [];
  const setupPrefixes: Array<string | undefined> = [];
  const versionPrefixes: Array<string | undefined> = [];
  const revisionPrefixes: Array<string | undefined> = [];

  process.env.CODEX_HOME = join(cwd, '.codex');

  try {
    const result = await runImmediateUpdate(cwd, {
      getCurrentVersion: async () => '0.20.3',
      fetchLatestVersion: async () => '0.20.3',
      runGlobalUpdate: (installSource) => {
        installSources.push(installSource);
        return { ok: true, stderr: '', revision: 'abcdef123456' };
      },
      runSetupRefresh: async (_refreshCwd, installPrefix) => {
        setupPrefixes.push(installPrefix);
        return { ok: true, stderr: '' };
      },
      getInstalledVersionAfterUpdate: async (installPrefix) => {
        versionPrefixes.push(installPrefix);
        return '0.20.3';
      },
      getInstalledRevisionAfterUpdate: async (installPrefix) => {
        revisionPrefixes.push(installPrefix);
        return null;
      },
    }, { channel: 'fork-dev' });

    assert.equal(result.status, 'updated');
    assert.deepEqual(installSources, ['github:WangErgouaaaa/oh-my-codex#dev']);
    assert.deepEqual(setupPrefixes, [prefix]);
    assert.deepEqual(versionPrefixes, [prefix]);
    assert.deepEqual(revisionPrefixes, [prefix]);

    const stamp = JSON.parse(await readFile(stampPath, 'utf-8')) as {
      installed_version: string;
      setup_completed_version: string;
      install_channel: string;
      install_source: string;
      install_revision: string;
      dev_base_version: string;
    };
    assert.equal(stamp.installed_version, '0.20.3');
    assert.equal(stamp.setup_completed_version, '0.20.3');
    assert.equal(stamp.install_channel, 'fork-dev');
    assert.equal(stamp.install_source, 'github:WangErgouaaaa/oh-my-codex#dev');
    assert.equal(stamp.install_revision, 'abcdef123456');
    assert.equal(stamp.dev_base_version, '0.20.3');
  } finally {
    if (typeof originalCodexHome === 'string') {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});
```

Add this failure-guidance test under the existing failure-diagnostics
`describe`:

```ts
it('reports the fork source and fork-dev retry command when the fork update fails', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-update-now-fork-failure-'));
  const originalLog = console.log;
  const logs: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    const result = await runImmediateUpdate(cwd, {
      getCurrentVersion: async () => '0.20.3',
      fetchLatestVersion: async () => '0.20.3',
      runGlobalUpdate: () => ({ ok: false, stderr: 'git clone exited 128' }),
    }, { channel: 'fork-dev' });

    assert.equal(result.status, 'failed');
    assert.match(
      logs.join('\n'),
      /WangErgouaaaa\/oh-my-codex\.git#dev/,
    );
    assert.match(logs.join('\n'), /omx update --fork-dev/);
    assert.doesNotMatch(logs.join('\n'), /omx update --dev$/m);
  } finally {
    console.log = originalLog;
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the updater test and confirm the prefix lifecycle fails**

Run:

```bash
npm run build && node --test dist/cli/__tests__/update.test.js
```

Expected: FAIL because global-root lookup ignores the prefix, post-install
dependencies receive no prefix, fork stamps do not use the development
metadata path, and failure guidance is generic.

- [ ] **Step 3: Thread the optional prefix through existing post-install helpers**

Change `resolveGlobalInstallRoot` to preserve its existing call order while
adding an optional third argument:

```ts
export function resolveGlobalInstallRoot(
  spawnProcess: SpawnSyncLike = spawnSync,
  platform: NodeJS.Platform = process.platform,
  installPrefix?: string,
): string | null {
  const args = ['root', '-g'];
  if (installPrefix) {
    args.push('--prefix', installPrefix);
  }
  const result = spawnNpmSync(
    args,
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
      windowsHide: true,
    },
    spawnProcess,
    platform,
  );

  if (result.error || result.status !== 0) {
    return null;
  }

  const root = String(result.stdout || '').trim();
  return root === '' ? null : root;
}
```

Change the installed-package readers:

```ts
async function getInstalledVersionAfterUpdate(
  installPrefix?: string,
): Promise<string | null> {
  const globalInstallRoot = resolveGlobalInstallRoot(
    spawnSync,
    process.platform,
    installPrefix,
  );
  if (!globalInstallRoot) return null;

  try {
    const packageJsonPath = join(globalInstallRoot, PACKAGE_NAME, 'package.json');
    const content = await readFile(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content) as PackageManifest;
    return typeof pkg.version === 'string' && pkg.version.trim() !== ''
      ? pkg.version
      : null;
  } catch {
    return null;
  }
}

async function getInstalledRevisionAfterUpdate(
  installPrefix?: string,
): Promise<string | null> {
  const globalInstallRoot = resolveGlobalInstallRoot(
    spawnSync,
    process.platform,
    installPrefix,
  );
  if (!globalInstallRoot) return null;

  try {
    const packageJsonPath = join(globalInstallRoot, PACKAGE_NAME, 'package.json');
    const content = await readFile(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content) as { gitHead?: string };
    const revision = typeof pkg.gitHead === 'string' ? pkg.gitHead.trim() : '';
    return /^[0-9a-f]{7,40}$/i.test(revision) ? revision.slice(0, 12) : null;
  } catch {
    return null;
  }
}
```

Change the internal setup refresh:

```ts
async function runSetupRefresh(
  cwd: string,
  installPrefix?: string,
): Promise<RunSetupRefreshResult> {
  const globalInstallRoot = resolveGlobalInstallRoot(
    spawnSync,
    process.platform,
    installPrefix,
  );
  if (!globalInstallRoot) {
    return {
      ok: false,
      stderr: 'Unable to resolve the npm global install root after updating.',
    };
  }

  const cliEntry = await resolveInstalledCliEntry(globalInstallRoot);
  if (!cliEntry) {
    return {
      ok: false,
      stderr: `Unable to find the updated OMX CLI entry under ${join(globalInstallRoot, PACKAGE_NAME)}.`,
    };
  }

  return spawnInstalledSetupRefresh(cliEntry, cwd);
}
```

Update the dependency signatures:

```ts
interface UpdateDependencies {
  askYesNo: typeof askYesNo;
  fetchLatestVersion: typeof fetchLatestVersion;
  getCurrentVersion: typeof getCurrentVersion;
  getInstalledVersionAfterUpdate: (
    installPrefix?: string,
  ) => Promise<string | null>;
  getInstalledRevisionAfterUpdate: (
    installPrefix?: string,
  ) => Promise<string | null>;
  readUserInstallStamp: typeof readUserInstallStamp;
  runGlobalUpdate: (installSource: string) => RunGlobalUpdateResult;
  runDeferredGlobalUpdate: typeof runDeferredGlobalUpdate;
  runSetupRefresh: (
    cwd: string,
    installPrefix?: string,
  ) => Promise<RunSetupRefreshResult>;
  writeUpdateState: typeof writeUpdateState;
}
```

- [ ] **Step 4: Apply development-channel behavior consistently**

In `resolveUpdateCheckBaseline`, replace the channel comparison with:

```ts
isDevelopmentChannel(stamp?.install_channel ?? 'stable') &&
```

In `executeUpdate`, define:

```ts
const channelConfig = resolveUpdateChannelConfig(channel);
const developmentChannel = isDevelopmentChannel(channel);
```

Use `developmentChannel` wherever the current code checks
`channel === 'dev'` or `channelConfig.channel === 'dev'`.

Pass the prefix through the post-install calls:

```ts
const setupRefreshResult = await dependencies.runSetupRefresh(
  cwd,
  channelConfig.installPrefix,
);
```

```ts
const installedVersion = await dependencies.getInstalledVersionAfterUpdate(
  channelConfig.installPrefix,
);
const installedRevision = developmentChannel
  ? ((await dependencies.getInstalledRevisionAfterUpdate(
      channelConfig.installPrefix,
    )) ?? result.revision ?? null)
  : null;
```

Keep stable behavior unchanged:

```ts
const devBaseVersion = developmentChannel
  ? (latest && installedVersion
      ? (isNewerVersion(latest, installedVersion) ? installedVersion : latest)
      : latest)
  : null;
const stampVersion = channelConfig.channel === 'stable'
  ? (latest ?? installedVersion ?? current)
  : installedVersion;
```

Pass development revision metadata with:

```ts
revision: developmentChannel ? installedRevision : null,
```

Use `developmentChannel` for the dev-build log, missing-version warning, and
display-version guidance. The selected-channel log must continue to print the
exact channel, so fork completion reads `Updated fork-dev channel`.

- [ ] **Step 5: Add fork-specific failure guidance without a fallback**

Replace the development branch in `summarizeUpdateFailure` with:

```ts
const forkDev = installSource === FORK_DEV_INSTALL_SOURCE;
const officialDev = installSource === DEV_INSTALL_SOURCE;
if (forkDev || officialDev) {
  const repositoryUrl = forkDev
    ? FORK_DEV_REPOSITORY_URL
    : DEV_REPOSITORY_URL;
  const retryFlag = forkDev ? '--fork-dev' : '--dev';
  return [
    `[omx] Update failed while building and installing the dev channel from ${repositoryUrl}#${DEV_REPOSITORY_BRANCH}.`,
    details ? `[omx] update stderr: ${details}` : undefined,
    logPath ? `[omx] Full log: ${logPath}` : undefined,
    `[omx] You can retry manually with: omx update ${retryFlag}`,
  ].filter((line): line is string => typeof line === 'string').join('\n');
}
```

Do not catch this failure by invoking the official source.

- [ ] **Step 6: Run the updater test and confirm the lifecycle passes**

Run the Step 2 command again.

Expected: PASS.

- [ ] **Step 7: Commit prefix-safe post-install behavior**

```bash
git add src/cli/update.ts src/cli/__tests__/update.test.ts
git commit \
  -m "Keep fork setup refresh bound to the installed package" \
  -m "Carry the fixed ~/.local prefix through npm root discovery, installed metadata, setup refresh, stamps, and failure guidance." \
  -m "Constraint: A successful fork install must never refresh the machine-default OMX package" \
  -m "Rejected: Fall back to official dev on failure | would replace the custom build" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Directive: Any future fork prefix change must update install and post-install discovery together" \
  -m "Tested: focused updater tests"
```

### Task 4: Verify the complete fork-safe updater without touching the live install

**Files:**
- Verify: `src/cli/index.ts`
- Verify: `src/cli/update.ts`
- Verify: `src/cli/__tests__/index.test.ts`
- Verify: `src/cli/__tests__/update.test.ts`
- Verify: `src/cli/__tests__/package-bin-contract.test.ts`

- [ ] **Step 1: Run build, static checks, and focused updater tests**

Run:

```bash
npm run build
npm run check:no-unused
npm run lint
node --test \
  dist/cli/__tests__/index.test.js \
  dist/cli/__tests__/update.test.js \
  dist/cli/__tests__/package-bin-contract.test.js
```

Expected: every command exits `0`.

- [ ] **Step 2: Verify the built CLI help**

Run:

```bash
node dist/cli/omx.js --help | rg -n -A1 'omx update --fork-dev'
```

Expected output contains:

```text
omx update --fork-dev
Install WangErgouaaaa/oh-my-codex#dev under ~/.local, then refresh setup
```

- [ ] **Step 3: Run the full project suite**

Run:

```bash
npm test
```

Expected: exit `0`, including the catalog check.

- [ ] **Step 4: Inspect the final diff and repository state**

Run:

```bash
git diff --check fork/dev...HEAD
git diff --stat fork/dev...HEAD
git status --short --branch
```

Expected:

- `git diff --check` prints nothing.
- The diff contains only the design, plan, updater, CLI, and updater-related tests.
- The worktree is clean and the feature branch is ahead of `fork/dev`.

- [ ] **Step 5: Preserve the delivery boundary**

Do not run the real `omx update --fork-dev` during implementation verification,
because it mutates the active `~/.local` installation. Do not open a pull
request to `Yeachan-Heo/oh-my-codex`.

After review, push `feature/fork-safe-updater` only to
`WangErgouaaaa/oh-my-codex`. Integration and live installation are separate
explicit closeout steps.
