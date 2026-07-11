# OpenChamber for JCode

[OpenChamber](https://github.com/openchamber/openchamber) is a rich web interface for the
[opencode](https://opencode.ai) AI coding agent: chat with an agent about your code, review diffs,
manage sessions, and let it edit your project — all without leaving JCode.

This extension installs and manages the whole stack **inside JCode's Linux runtime**:

- the `opencode` agent server (official ARM64 build),
- the OpenChamber web UI server,
- a JCode environment briefing written to `~/.config/opencode/AGENTS.md`, so the agent knows about
  the proot runtime, the `/workspace` mount (and its noexec rule), `.jcode/run.yaml`, and the other
  quirks of coding on this device.

Open **Manage** to run the guided setup, start/stop the server, and launch the UI. The agent works
against the same `/workspace` projects you have open in the IDE.

Requires network access for the initial setup (Node.js, opencode, OpenChamber downloads) and an
opencode-supported model provider (API key or subscription) configured on first run.
