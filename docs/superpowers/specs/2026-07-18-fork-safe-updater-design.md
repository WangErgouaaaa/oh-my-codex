# Fork-safe updater design

## Context

The user's OMX build is maintained on `WangErgouaaaa/oh-my-codex#dev` and is
installed under `~/.local`. The existing `omx update --dev` command instead
clones the official `Yeachan-Heo/oh-my-codex#dev` branch and installs through
the machine's default npm global prefix. Running it would replace the custom
build with the official development build in a different installation root.

## Goal

Add one explicit command:

```text
omx update --fork-dev
```

It must clone `WangErgouaaaa/oh-my-codex#dev`, reuse the existing dev
clone/build/pack flow, install the packed tarball with
`npm install -g --prefix ~/.local`, refresh setup from that installation, and
record the fork channel and revision.

The existing stable and official `--dev` behavior must remain unchanged.

## Non-goals

- No arbitrary repository, branch, or prefix flags.
- No environment-variable configuration layer.
- No fallback to the official repository if the fork update fails.
- No new dependency or separate updater implementation.
- No automatic deployment during tests.

## CLI contract

`UpdateChannel` gains `fork-dev`. `resolveUpdateChannelArg` accepts
`--fork-dev`; it remains mutually exclusive with `--stable` and `--dev`.
Top-level help describes the fork source and `~/.local` destination.

Unknown or combined update flags fail before any clone or installation starts.

## Implementation

Extend the existing channel configuration with an optional install prefix.
The fork channel uses:

- install source: `github:WangErgouaaaa/oh-my-codex#dev`
- repository: `https://github.com/WangErgouaaaa/oh-my-codex.git`
- branch: `dev`
- prefix: `join(homedir(), '.local')`

Parameterize the current internal dev updater with repository URL and optional
install prefix. Both development channels continue through the same
clone → dependency install → prepack → pack → global install path. Only the
fork invocation adds `--prefix <home>/.local` to the final npm install.

Use one small development-channel predicate for behavior shared by `dev` and
`fork-dev`, including forced installation, revision capture, dev baseline
metadata, logs, and install stamps.

Post-install discovery must use the selected prefix too. Resolve the global
package root with `npm root -g --prefix <prefix>` for the fork channel, then
read the installed version/revision and execute setup from that resolved
package. This prevents the updater from installing into `~/.local` but
accidentally refreshing the machine-default npm installation.

## Failure behavior

Clone, build, pack, install, package discovery, or setup-refresh failure returns
`failed` and names the failed fork update. The retry guidance is
`omx update --fork-dev`. Temporary checkout cleanup remains best-effort and
must not hide the primary result.

There is no official-repository fallback.

## Verification

Add focused tests that prove:

1. `--fork-dev` parses and conflicts with the other channel flags.
2. The fork channel resolves the expected source and `~/.local` prefix.
3. The shared dev pipeline clones the fork `dev` branch.
4. The final npm install includes `--prefix ~/.local`.
5. Version/revision lookup and setup refresh use the same prefixed global root.
6. Stable and official `--dev` command arguments remain unchanged.
7. Failure output recommends `omx update --fork-dev`.

Run the focused updater tests, build/typecheck, and the full project test suite
before integration.

## Delivery boundary

Commit and push this customization only to the user's fork. Do not open or
retarget a pull request to the official repository.
