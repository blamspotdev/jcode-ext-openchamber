# jcode-ext-openchamber

JCode extension packaging of [OpenChamber](https://github.com/openchamber/openchamber) — an agentic
development UI for the [opencode](https://opencode.ai) AI coding agent — adapted to run inside the
JCode Android IDE.

This repo is a **content fork** of `openchamber/openchamber` (MIT). Upstream code is kept intact so
`git fetch upstream && git merge upstream/main` stays cheap; all JCode-specific work lives in
additive locations:

- `packages/jcode/` — the JCode adapter: implements the runtime-API seam
  (`window.__OPENCHAMBER_RUNTIME_APIS__`) over the JCode extension bridge, plus the extension
  manifest and packaging inputs for the JCode marketplace.
- `packages/jcode/agent/` — the JCode environment briefing for the agent (how the IDE, the proot
  Ubuntu runtime, the `/workspace` mount, and Build & Run flows work).

Everything outside `packages/jcode/` is upstream OpenChamber — see
[README.upstream.md](README.upstream.md) for the original documentation and [LICENSE](LICENSE)
(MIT, © OpenChamber contributors).

## Syncing with upstream

```sh
git fetch upstream main
git merge upstream/main   # conflicts should be limited to README.md, if any
```

Upstream remote: `https://github.com/openchamber/openchamber.git`
