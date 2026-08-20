# DECADE.TW - herdr-Auto-Yes-Sir

Automatically respond to blocked Herdr agent prompts after a three-second, cancellable countdown.

![Herdr Auto Yes Sir picker](herdr_auto_yes_sir.png)

The monitor uses Herdr's Socket API instead of polling. When an agent enters the `blocked` state—the red status shown in Herdr—it reads the prompt and sends the configured one-character response. Numbered menus can use `1`; approval and yes/no prompts commonly use `y`.

> [!WARNING]
> This plugin can approve commands and permissions on your behalf. Review the source, choose the narrowest useful agent scope and lifetime, and watch the countdown before enabling it.

## Requirements

- Herdr 0.8.2 or newer
- Node.js 18 or newer
- macOS or Linux

## Install

Install the published plugin from GitHub:

```bash
herdr plugin install xlinx/herdr-auto-yes-sir
```

For local development, link a checkout instead:

```bash
git clone https://github.com/xlinx/herdr-auto-yes-sir.git
herdr plugin link "$PWD/herdr-auto-yes-sir"
```

Verify the installation and its two public actions:

```bash
herdr plugin list
herdr plugin action list --plugin xlinx.herdr-auto-yes-sir
```

## Use

Open the picker:

```bash
herdr plugin action invoke xlinx.herdr-auto-yes-sir.enable
```

The picker lets you:

- monitor all live agents or one selected agent;
- choose the one-character response key (`y` by default);
- run forever, for one hour, or for a custom number of seconds;
- pause with `p`, resume with `r`, or stop with `s`.

When an agent becomes blocked, a split pane opens with a three-second countdown. Press `c` followed by Enter to cancel that response. If it is not cancelled, the configured key is sent to the blocked agent.

Stop the monitor:

```bash
herdr plugin action invoke xlinx.herdr-auto-yes-sir.disable
```

Disabling resumes a paused monitor if necessary, requests graceful shutdown, verifies process exit, and force-stops it if it does not exit promptly.

## Keybindings

The manifest registers:

- `prefix+y` — open the monitor picker;
- `prefix+shift+y` — stop the monitor.

The actions can also be bound manually in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+y"
type = "plugin_action"
command = "xlinx.herdr-auto-yes-sir.enable"
description = "Configure and start Auto Yes Sir"

[[keys.command]]
key = "prefix+shift+y"
type = "plugin_action"
command = "xlinx.herdr-auto-yes-sir.disable"
description = "Stop Auto Yes Sir"
```

## Direct monitor usage

The plugin actions are recommended. From a Herdr-managed pane, the monitor can also be run directly:

```bash
HERDR_ENV=1 node scripts/auto_approve.js --forever
HERDR_ENV=1 node scripts/auto_approve.js --duration 900 --agent AGENT_NAME --key y
HERDR_ENV=1 node scripts/auto_approve.js --count 10 --dry-run
```

Available options:

- `--forever`
- `--duration SECONDS`
- `--count N`
- `--agent NAME`
- `--key CHARACTER`
- `--dry-run`

Without a lifetime option, direct usage defaults to one hour.

## Logging and troubleshooting

Runtime activity is appended to `monitor.log` in the plugin directory. The log includes lifecycle actions, Socket API subscriptions, blocked events, countdown results, responses, reconnects, and shutdown verification. The file is ignored by Git.

Enable additional diagnostics before starting the monitor:

```bash
export HERDR_AUTO_YES_SIR_DEBUG=1
```

If behavior does not change after updating the source, stop and re-enable the monitor so the background Node.js process loads the new code.

## How it works

1. The picker starts a detached monitor through `scripts/control.js`.
2. The monitor subscribes to `pane.agent_status_changed` through `HERDR_SOCKET_PATH`.
3. An `agent_status: "blocked"` event triggers a recent-output read.
4. The prompt is fingerprinted to prevent duplicate responses.
5. A cancellable countdown opens before the selected key is sent.
6. New-agent events refresh all-agent subscriptions; socket failures reconnect after a short delay.

See [function.md](function.md) for the detailed function manual.

## Development

Run syntax checks and tests:

```bash
node --check scripts/auto_approve.js
node --check scripts/control.js
node --test scripts/test_auto_approve.test.js
```

## Marketplace

This repository is published with the `herdr-plugin` GitHub topic. Herdr's community marketplace automatically indexes public repositories that contain a valid `herdr-plugin.toml` on the default branch.

## License

No license has been selected yet. All rights are reserved by the repository owner.
