# plugin-bundle/

Everything for building the multi-client zero-memory guest bundle and installing
it into a client. `build-zm-bundle.sh` **packages**; each `deploy-zm-<client>.sh`
**installs** one client; each `deploy-zm-<client>-remote-host.sh` **re-homes** the
bundle off a flaky mount, then installs. Symmetric across Claude Code, Codex and
Cursor — same command shape for every client.

The pre-plugin, non-bundle Claude wiring (`deploy-zm-client.sh`) stays in
`scripts/`: it wires hooks/rule/MCP directly, with no plugin and no bundle.

| Script                            | Run where                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build-zm-bundle.sh`              | dev/build host           | **Packager.** Stage a multi-client guest bundle into `<dir>`: the shared watcher binary, all client plugin folders, every per-client installer + re-home helper, `README.md`/`VERSION`/`bundle.json`. `--tar <dir>` / `--zip <dir>` also pack `zm-bundle-<version>-<platform>.tar.gz` / `.zip` (each with a `.sha256`) from the same staging; `--target <platform>` cross-compiles for another machine. Installs nothing locally. |
| `deploy-zm-claude.sh`             | dev host **or** consumer | Install **Claude Code**: binary → `~/.local/bin`, plugin `bin/` symlink, marketplace + plugin at user scope, user-scope `zero-memory` MCP. Flags: `--with-rule`, `--with-ingest`, `--rules-file=`, `--rules-dest=`.                                                                                                                                                                                                               |
| `deploy-zm-codex.sh`              | consumer                 | Install **Codex**: binary, `codex mcp add`, a generated local marketplace + `.codex-plugin`, migrating off legacy `config.toml` hooks.                                                                                                                                                                                                                                                                                            |
| `deploy-zm-cursor.sh`             | consumer                 | Install **Cursor**: binary, `~/.cursor/mcp.json`, the `.cursor-plugin` in `~/.cursor/plugins/local`.                                                                                                                                                                                                                                                                                                                              |
| `deploy-zm-claude-remote-host.sh` | consumer                 | Re-home + install Claude off a flaky mount: copy the bundle to local disk, uninstall stale plugin/marketplace, then delegate to the local copy's `deploy-zm-claude.sh` (marketplace points at local disk, not the mount).                                                                                                                                                                                                         |
| `deploy-zm-codex-remote-host.sh`  | consumer                 | Re-home + install Codex: copy the bundle to local disk, then run `deploy-zm-codex.sh` from there.                                                                                                                                                                                                                                                                                                                                 |
| `deploy-zm-cursor-remote-host.sh` | consumer                 | Re-home + install Cursor: copy the bundle to local disk, then run `deploy-zm-cursor.sh` from there.                                                                                                                                                                                                                                                                                                                               |

`build-zm-bundle.sh` also stages the shared helpers that live in `scripts/`
(next to `build-watcher.sh`, because a source machine's own `start` uses them
too): `wire-hooks.sh`, so the Claude installer's `--with-ingest` finds it in the
bundle and applies the hook set the binary declares; `zm-server-url.sh`, which
asks for and stores the server address; and `zm-platform.sh`, which names the
platform.

**A bundle is per-platform.** It carries a compiled binary, so the builder names
the archive for the platform it was built for
(`zm-bundle-<version>-linux-x86_64.tar.gz`), records the same value in
`bundle.json`, and every installer refuses a bundle whose manifest names another
machine — before copying anything. Builds for other platforms sit beside it on
the release page under their own names; adding one means adding its row in
`zm-platform.sh` and either building there or naming it with `--target`, which
cross-compiles (this is how the Windows bundle is produced on Linux).

**Windows.** The binary is `zero-memory-watcher.exe` and the installers are the
same shell scripts, run from Git Bash. Where a symlink would normally bridge the
Claude plugin's hooks to the installed binary, the installer writes a small shim
instead, because a Windows filesystem usually refuses the symlink and a `.exe`
under another name will not start.

## Which one do I run?

- **Publish a bundle from the dev host** (build + stage to a LAN share):

  ```sh
  bash scripts/plugin-bundle/build-zm-bundle.sh /path/to/share/zm-bundle
  ```

- **Install on a consumer** (bundle on reliable local/LAN storage) — pick your
  client, run from the bundle directory:

  ```sh
  cd <bundle-dir>
  bash deploy-zm-claude.sh [--with-rule] [--with-ingest] [--rules-file=<path>] [--rules-dest=<path>]
  bash deploy-zm-codex.sh
  bash deploy-zm-cursor.sh
  ```

- **Install on a consumer, bundle on a flaky network mount** — same client, the
  `-remote-host` variant (copies the bundle to local disk first):

  ```sh
  bash deploy-zm-claude-remote-host.sh  [bundle-dir]
  bash deploy-zm-codex-remote-host.sh   [bundle-dir]
  bash deploy-zm-cursor-remote-host.sh  [bundle-dir]
  # bundle source defaults to the dir the script ships in; env: PLUGIN_BUNDLE_DIR, LOCAL_DEST
  ```

Claude flags: `--with-rule` appends the always-on ZM-first rule to
`~/.claude/CLAUDE.md`; `--with-ingest` wires the Stop transcript-capture hook
(inert until a consent config exists); `--rules-file=`/`--rules-dest=`
materialize promoted rules for clients that ignore the MCP `instructions`
channel. All off by default.

After any install: `zero-memory-watcher login` (one-time OAuth), then fully
reload the client (Claude Code: VSCode → "Developer: Reload Window") and start a
**new** session. Verify with `/hooks` in-session and
`tail ~/.local/state/zero-memory/watcher.log`.

All installers are idempotent — safe to re-run.

Updates announce themselves: every install records its source in
`~/.local/state/zero-memory/plugin-origin.json`, and the watcher's session-start
hook compares the installed version against that source — when the source ships a
newer version, the session opens with an update notice carrying the exact command
to run (hook `systemMessage`, so it never depends on the model relaying it),
rechecked ~hourly on prompts until the update is installed.
