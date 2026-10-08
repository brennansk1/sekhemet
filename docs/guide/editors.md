# Editors

Your editor can reach Sekhemet's board through its MCP server (`sekhemet mcp`), and Zed can talk to Seshat as an agent through ACP (`sekhemet acp`). `sekhemet editors` prints the same snippets with where each goes; `sekhemet editors zed` prints one.

Put each snippet in your **own, user-level** editor configuration, never in the repository. A copy committed to the repository (`.vscode/`, `.cursor/`, `.mcp.json`) is configuration another tool runs on whoever opens it, and Sekhemet's review flags it as code that runs later.

The `sekhemet` in each snippet must be on your editor's `PATH`: the npm package puts it there. For a source install, make `sekhemet` a link to the checkout's `apps/harness/dist/index.js`, or replace `"command": "sekhemet"` with `"command": "node"` and put that file's full path first in `args`.

<!-- generated:editors:start -->
### VS Code

Your user mcp.json: Command Palette › MCP: Open User Configuration. Not .vscode/mcp.json in the repository, which Review flags as code that runs later.

```json
{
  "servers": {
    "sekhemet": {
      "type": "stdio",
      "command": "sekhemet",
      "args": [
        "mcp",
        "--repo",
        "${workspaceFolder}"
      ]
    }
  }
}
```

### Cursor

Your user file ~/.cursor/mcp.json. Not .cursor/mcp.json in the repository, which Review flags as code that runs later.

```json
{
  "mcpServers": {
    "sekhemet": {
      "command": "sekhemet",
      "args": [
        "mcp",
        "--repo",
        "${workspaceFolder}"
      ]
    }
  }
}
```

### Zed

Your user settings, ~/.config/zed/settings.json (Zed › Settings › Open Settings). To serve one project wherever Zed starts them, add "--repo" and that project's folder to both args.

```json
{
  "agent_servers": {
    "Sekhemet": {
      "type": "custom",
      "command": "sekhemet",
      "args": [
        "acp"
      ]
    }
  },
  "context_servers": {
    "sekhemet": {
      "source": "custom",
      "command": "sekhemet",
      "args": [
        "mcp"
      ]
    }
  }
}
```
<!-- generated:editors:end -->
