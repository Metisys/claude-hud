# Claude HUD

A Claude Code plugin that shows what's happening: context usage, rate limits, active tools, running agents, and todo progress, always visible below your input.

[![License](https://img.shields.io/github/license/jarrodwatts/claude-hud?v=2)](LICENSE)
[![Stars](https://img.shields.io/github/stars/jarrodwatts/claude-hud)](https://github.com/jarrodwatts/claude-hud/stargazers)

![Claude HUD in action](claude-hud-preview-5-2.png)

> 🌐 English | [中文文档](README.zh.md)

## Install

Inside Claude Code, run:

```
/plugin marketplace add jarrodwatts/claude-hud
/plugin install claude-hud
/reload-plugins
/hud
```

`/hud` checks your setup and points your status line at the HUD, after asking you. It needs Node.js 22.18 or later; if yours is older, `/hud` finds a newer one on your machine or helps you install one.

<details>
<summary><strong>Prefer the terminal?</strong></summary>

```bash
claude plugin marketplace add jarrodwatts/claude-hud
claude plugin install claude-hud@claude-hud
```

Then run `/reload-plugins` and `/hud` inside a session.

</details>

**Updates:** Claude Code doesn't auto-update third-party plugins by default. To turn it on, run `/plugin`, open **Marketplaces**, select **claude-hud**, and choose **Enable auto-update**. Or update by hand with `claude plugin marketplace update claude-hud` and `claude plugin update claude-hud@claude-hud`, then `/reload-plugins`. You don't need to set it up again.

## What You See

The default is two lines:

```
[Opus] │ my-project git:(main*)
Context █████░░░░░ 45% │ Usage ██░░░░░░░░ 25% (resets in 1h 30m)
```

- **Line 1**: model, a provider label when one is detected (`Bedrock`, `Vertex`, `MiniMax`), project path, and git branch.
- **Line 2**: context used (green, then yellow, then red as it fills) and your subscriber rate limits.

Optional lines include tools, agents and todos, plus about a hundred other options:

```
◐ Edit: auth.ts | ✓ Read ×3 | ✓ Grep ×2        ← tools
◐ explore [haiku]: Finding auth code (2m 15s)    ← agents
▸ Fix authentication bug (2/5)                   ← todos
```

## Metisys fork: usage per account

This fork ([Metisys/claude-hud](https://github.com/Metisys/claude-hud)) adds usage per account ([fdectl#124](https://github.com/Metisys/fdectl/issues/124)). The added lines are off by default. To turn them on:

```bash
node hud.mjs set display.showAccountUsage=true display.showCodexUsage=true
```

```
Context █████░░░░░ 45%
Claude   GAO  5h ██░░░░░░░░ 17% (2h) │ 7d █░░░░░░░░░ 12% (3d 11h, at Nov 7 23:20)
Claude ▶ GAO2 5h ██████░░░░ 60% ▲ (3h 20m, full in 1h 10m) │ 7d ██████████ 98% (10h, at 22:00)
Codex  ▶ gao@metisys.ai  5h ██░░░░░░░░ 20% (1h 40m) │ 7d █████████░ 92% (2d 2h, at Nov 6 14:00)
Codex    gao2@metisys.ai 5h ░░░░░░░░░░ 0% (4h 10m) │ 7d ░░░░░░░░░░ 2% (6d 4h, at Nov 11 08:00) │ unavailable: model not supported 20m ago
```

- **Claude lines** (`display.showAccountUsage`). The collector sends `GET http://127.0.0.1:18100/_relay/state` to the token relay. The time limit is 300 ms. Each relay token gets one line with its 5h and 7d windows. When the relay does not answer, or has no window values, the usage line shows the stdin `rate_limits` as before. No error line shows.
- **`▶`** marks the account that serves this session. The HUD calculates it as the relay does (`Pool.order` in `relay/anthropic-token-relay`). It is the token in `x-relay-prefer` (from `ANTHROPIC_CUSTOM_HEADERS`), else SHA-256 of the session id modulo the token count. A parked token is passed. The relay keeps no table of sessions, and the HUD reads none.
- **7d reset**. The 7d window shows the countdown and the local wall-clock time of its reset (`3d 11h, at Nov 7 23:20`). The 5h window shows the countdown only.
- **`full in`** is the time until the window is at 100 % at the recent use rate. The window then shows in red with `▲`. Each render adds the current value of each window to `data/usage-rate.json`, with the time at which the source measured it. The rate is the change over the last 1 hour (5h window) or 24 hours (7d window). When the window resets before it is full, or the account has no new value for the lookback time, no time shows.
- **Codex lines** (`display.showCodexUsage`). The collector runs `codex-usage` (fdectl) on minipc. On another host, it runs `ssh -o RemoteCommand=none -o BatchMode=yes minipc codex-usage`. The command runs in a separate process, and its output goes to `plugins/claude-hud/codex-usage.json`. When that file is 60 s old, the next render starts a new run and does not wait for it. When minipc does not answer, the last values show, with their age.
- **Codex `▶`** marks the account of this session's Codex home: `CODEX_HOME` when it is set, else `~/.codex`. Each `codex-usage` line names its home. When no line names the session home, the HUD compares accounts: the account of a home is `creator_account_id` in its newest rollout file (`<home>/sessions/…/rollout-*.jsonl`). A file with more than one link is used only when the home has no other file, because Orca links the `~/.codex` rollout files into each managed home.
- **`unavailable: <reason> <age>`** shows when the newest finished turn of the home's account, in its 40 newest rollout files, failed with `out of credits` (`no credits`) or with `model_not_found` / `is not supported when using Codex with a ChatGPT account` (`model not supported`), and no later turn of that account succeeded. The background run of `codex-usage` also reads these files. The HUD does not read `auth.json` and does not send a request to Codex. The homes are on minipc, so on another host the Codex lines have no `▶` and no `unavailable`.
- **`hud usage [--days n]`** prints the cost and tokens per repository or worktree, and per day. The Claude rows come from `~/.claude/metrics/costs.jsonl` (the ecc cost-tracker hook). The Codex rows come from `codex-usage --tokens` on minipc (fdectl 2026-11-04 or later), and their cost is "subscription". The Claude days use the local time zone, and the Codex days use the time zone of minipc. Claude Code has its own `/usage`, and a plugin cannot replace it. Thus the table is `/hud usage`.

### Install the fork in place of claude-hud@claude-hud

The fork keeps the marketplace name `claude-hud`. Thus the plugin id stays `claude-hud@claude-hud`, and only the marketplace source changes:

```bash
claude plugin uninstall claude-hud@claude-hud
claude plugin marketplace remove claude-hud
claude plugin marketplace add Metisys/claude-hud
claude plugin install claude-hud@claude-hud
```

The `statusLine` command must run the fork's build. `hud install` copies the launcher (`scripts/statusline.mjs`) to `~/.claude/plugins/claude-hud/statusline.mjs`, and sets `statusLine.command` in `~/.claude/settings.json` to run it with the absolute path of a Node 22.18 or later. The launcher runs the newest version under `~/.claude/plugins/cache/*/claude-hud/`. After the steps above, that is the fork's version.

```bash
node ~/.claude/plugins/cache/claude-hud/claude-hud/<version>/hud.mjs install --replace
```

## Change It, Fix It, Report It

Ask Claude, or type `/hud` and say what you want: "show tool activity", "use the compact layout", "the HUD is blank", "the context bar looks wrong". Claude looks up the options, shows you a preview, and saves the change once you approve it. `/hud` also undoes the last change, replays the last real render to explain what you see, and, for a real bug, writes a scrubbed report that you read in full before anything is filed.

Settings live in `~/.claude/plugins/claude-hud/config.json` (under `$CLAUDE_CONFIG_DIR` if set). To turn the HUD off for one session, start Claude Code with `CLAUDE_HUD_DISABLE=1`.

## Security

The HUD's logic runs in a locked-down Node process. Node's permission model blocks it from starting programs, reading your credentials, and writing anywhere but its own data folder. An import fence keeps Node's network modules and globals out of its reach; that fence blocks every way out found so far, and is tested against each one on every change. A small separate file runs the fixed `git`, `jj` and memory commands it needs. The HUD reads Claude Code's stdin, the session transcript, Claude config files, and git or jj metadata for the current directory, and calls no undocumented APIs.

`--extra-cmd` runs a shell command on every refresh and puts its output on the first line. It is ignored unless `CLAUDE_HUD_ALLOW_EXTRA_CMD=1` is set in the HUD's environment. Treat it as arbitrary code execution and never use a command from an untrusted source.

## Requirements

- Claude Code v2.1.260 or later
- Node.js 22.18 or later (Bun can start the HUD, which then runs on Node)

## Development

```bash
git clone https://github.com/jarrodwatts/claude-hud
cd claude-hud
npm ci && npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jarrodwatts/claude-hud&type=Date)](https://star-history.com/#jarrodwatts/claude-hud&Date)
