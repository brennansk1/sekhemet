# Upgrade and uninstall

## Is there a new version?

Sekhemet never checks for a release on its own. When you want to know, ask once:

```bash
sekhemet doctor --check-updates
```

It names the one host it will ask (`registry.npmjs.org`), sends nothing until you answer yes (`--yes` answers for a script), and prints the installed version, the latest one and the address of its release notes. Under `[network] mode = "offline"` it asks nothing and names the setting that would allow it.

## Upgrade

From 0.9.0, with the npm package:

```bash
npm install --global sekhemet@latest
```

From source, in your checkout: `git pull`, then `pnpm install` and `pnpm build`.

Your data comes along. The first command after an upgrade:

- backs up each Activity log older than the new version, migrates it forward and verifies its hash chain before anything is served; the backup is kept in the project's `.sekhemet/backups/` as `pre-migration-v<from>-to-v<to>-<time>.db`;
- rewrites renamed `config.toml` keys after backing the file up beside itself, and `sekhemet doctor` lists what changed;
- prints, once, a *What's new* note for each version since the one you last saw — Security entries first, at most 20 lines — read from the changelog in the package, with no network request.

A dashboard you set to start at login runs the `node` it found on your PATH when you registered it (Homebrew's `/opt/homebrew/bin/node` follows upgrades). If you upgrade or move Node with a version manager such as nvm, or move your Sekhemet checkout, `sekhemet daemon status` says the program is gone instead of *yes*; register it again:

```bash
sekhemet daemon stop --at-login
sekhemet daemon start --at-login
```

A Team server upgrades the same way: rebuild its image from the new release and restart it ([Team administrator's guide](team-admin.md)).

## Roll back

Install the version you had:

```bash
npm install --global sekhemet@<version>
```

An older version refuses an Activity log that a newer one has migrated, and names the backup to restore: the newest `pre-migration-…` file this version can open, else the newest backup set at a schema it reads. List the backup sets with their schema versions, then restore the one it named, with the server stopped:

```bash
sekhemet backup --list
sekhemet restore <the file or set folder it named>
```

Restoring an older backup loses the events recorded since it; the refusal says so before you do it.

## Uninstall

An install writes outside its package: your user directory (`~/.sekhemet`), the Crawl4AI environment when research installed it, the link `scripts/install.sh` makes, each project's `.sekhemet/` and issue worktrees, keychain items for your integrations, start-at-login services, and a SearXNG container when research started one. First see all of it, with sizes:

```bash
sekhemet uninstall --dry-run
```

It lists every path, keychain item (by name, never its value) and container, and changes nothing. Then remove it:

```bash
sekhemet uninstall --yes
```

This keeps each project's Activity log and every backup: a log is the project's record and cannot be rebuilt. To remove those too:

```bash
sekhemet uninstall --yes --include-ledgers
```

It never touches your repositories' own files or branches, including the files in `.sekhemet/` your team shares and commits (`config.toml`, `gates.toml`, `hooks.toml`, `mcp.json`, `skills/`, `playbook.toml`, and anything else there git tracks): the dry run names them as never removed. It ends by printing the line that removes the package itself:

```bash
npm uninstall -g sekhemet
```

For a source install, delete the checkout and the `alias` line instead.
