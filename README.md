# herdr-Auto-Yes-Sir 

##### as a developer, I know... sometimes, just yes sir.

Automatically respond to blocked Herdr agent prompts after a three-second, cancellable countdown.

## 💡Update Log
* [add|0818] | 🟢 by count(default 10) 
* [add|0819] | 🟢 by forever/time(1hr)/time(seconds)

![Herdr Auto Yes Sir picker](herdr_auto_yes_sir.png)

The monitor uses Herdr's Socket API instead of polling. When an agent enters the `blocked` state—the red status shown in Herdr—it reads the prompt and sends the configured one-character response. Numbered menus can use `1`; approval and yes/no prompts commonly use `y`.

> [!WARNING]
> This plugin can approve commands and permissions on your behalf. Review the source, choose the narrowest useful agent scope and lifetime, and keep running.

## Requirements

- Herdr 0.8.2 or newer
- Node.js 18 or newer
- macOS or Linux
- i dont have windows

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
- run forever, for one hour, for a custom number of seconds, or for a response count;
- pause with `p`, resume with `r`, or stop with `s`.

When an agent becomes blocked, a split pane opens with a three-second countdown. Press `c` followed by Enter to cancel that response. If it is not cancelled, the configured key is sent to the blocked agent.

`Forever` remains the default lifetime. The `By count` option defaults to 10 responses when its count prompt is left empty, logs the remaining count after each successful response, and stops at zero.

The picker bottom shows persistent trigger statistics: the total across all agents and the successful-response count for each agent. Cancelled countdowns and failed sends are not counted.

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
HERDR_ENV=1 node scripts/plugin.js monitor --forever
HERDR_ENV=1 node scripts/plugin.js monitor --duration 900 --agent AGENT_NAME --key y
HERDR_ENV=1 node scripts/plugin.js monitor --count 10 --dry-run
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

Runtime activity is appended to `monitor.log` in the plugin directory. The log includes lifecycle actions, Socket API subscriptions, blocked events, countdown results, responses, reconnects, and shutdown verification. Persistent aggregate and per-agent counters are stored in the Herdr-managed plugin state directory. The runtime log is ignored by Git.

Enable additional diagnostics before starting the monitor:

```bash
export HERDR_AUTO_YES_SIR_DEBUG=1
```

If behavior does not change after updating the source, stop and re-enable the monitor so the background Node.js process loads the new code.

## How it works

1. `scripts/plugin.js picker` starts a detached `monitor` subcommand through the `control` subcommand.
2. The monitor subscribes to `pane.agent_status_changed` through `HERDR_SOCKET_PATH`.
3. An `agent_status: "blocked"` event triggers a recent-output read.
4. The prompt is fingerprinted to prevent duplicate responses.
5. A cancellable countdown opens before the selected key is sent.
6. New-agent events refresh all-agent subscriptions; socket failures reconnect after a short delay.

See [md/function.md](md/function.md) for the detailed function manual.

## Development

Run syntax checks and tests:

```bash
node --check scripts/plugin.js
node --test scripts/test_plugin.test.js
```

## for developer
### link local source
```text
Use Herdr’s local link workflow—no GitHub push needed.

  From the plugin directory:

  cd yes_sir_herdr/plugins/herdr-auto-yes-sir

  node --test scripts/test_plugin.test.js
  herdr plugin link "$PWD"
  herdr plugin action list --plugin xlinx.herdr-auto-yes-sir

  Start the local code:

  herdr plugin action invoke xlinx.herdr-auto-yes-sir.enable

  To test the new count feature:

  1. Select an agent or all agents.
  2. Select 4) By count.
  3. Press Enter to use the default count of 10.
  4. Trigger a blocked agent prompt.
  5. Check the remaining count:

  tail -f monitor.log

  Stop and reload after code changes:

  herdr plugin action invoke xlinx.herdr-auto-yes-sir.disable
  herdr plugin action invoke xlinx.herdr-auto-yes-sir.enable

  If you changed herdr-plugin.toml, relink it:

  herdr plugin unlink xlinx.herdr-auto-yes-sir
  herdr plugin link "$PWD"

  If the older development ID is still registered, remove it once:

  herdr plugin unlink local.herdr-auto-yes-sir

  Opening the picker again will show the persistent total and per-agent trigger counts at the bottom.
```
### link back to github
```text
To switch from a locally linked plugin to the GitHub-managed version:

  herdr plugin action invoke xlinx.herdr-auto-yes-sir.disable
  herdr plugin unlink xlinx.herdr-auto-yes-sir
  
  herdr plugin install xlinx/herdr-auto-yes-sir

  #Verify it:

  herdr plugin list
  herdr plugin action list --plugin xlinx.herdr-auto-yes-sir
  herdr plugin action invoke xlinx.herdr-auto-yes-sir.enable

  To update after pushing newer code, reinstall:

  herdr plugin uninstall xlinx.herdr-auto-yes-sir
  herdr plugin install xlinx/herdr-auto-yes-sir

  Herdr preserves the plugin config/state directory across reinstallations, so saved settings and trigger statistics should remain.
```

## Marketplace

This repository is published with the `herdr-plugin` GitHub topic. Herdr's community marketplace automatically indexes public repositories that contain a valid `herdr-plugin.toml` on the default branch.


## License

No license has been selected yet. All rights are reserved by the repository owner.

<hr/>

## Quick Link other ai tools

* Auto prompt by LLM and LLM-Vision (Trigger more details out inside model)
    * SD-WEB-UI: https://github.com/xlinx/sd-webui-decadetw-auto-prompt-llm
    * ComfyUI:   https://github.com/xlinx/ComfyUI-decadetw-auto-prompt-llm
* Auto msg to ur mobile  (LINE | Telegram | Discord)
    * SD-WEB-UI :https://github.com/xlinx/sd-webui-decadetw-auto-messaging-realtime
    * ComfyUI:  https://github.com/xlinx/ComfyUI-decadetw-auto-messaging-realtime
* I'm SD-VJ. (share SD-generating-process in realtime by gpu)
    * SD-WEB-UI: https://github.com/xlinx/sd-webui-decadetw-spout-syphon-im-vj
    * ComfyUI:   https://github.com/xlinx/ComfyUI-decadetw-spout-syphon-im-vj
* CivitAI Info|discuss:
    * https://civitai.com/articles/6988/extornode-using-llm-trigger-more-detail-that-u-never-thought
    * https://civitai.com/articles/6989/extornode-sd-image-auto-msg-to-u-mobile-realtime
    * https://civitai.com/articles/7090/share-sd-img-to-3rd-software-gpu-share-memory-realtime-spout-or-syphon
