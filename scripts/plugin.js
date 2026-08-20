#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const readline = require('node:readline');
const {spawn, spawnSync} = require('node:child_process');

const NUMBERED_LINE = /^\s*1\s*[.)\-:]\s+\S+/m;
const NUMBERED_CUE = /\b(?:choose|select)\s+(?:an?\s+)?option\b/i;
const NUMBERED_INPUT_CUE = /\b(?:enter|input|type|press|send)\s+1\b|\b1\s+(?:to|for)\s+(?:yes|ok|okay|continue|approve|allow|confirm|proceed)\b/i;
const PROMPT_CUE = /(?:\?|\[\s*[yn](?:\s*\/\s*[yn])?\s*\]|\b(?:enter|input|choose|select|approve|allow|continue|permission|confirm|proceed|yes\/no)\b)/i;

function classifyPrompt(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return null;
    if (NUMBERED_LINE.test(normalized) || NUMBERED_INPUT_CUE.test(normalized) || (NUMBERED_CUE.test(normalized) && /^\s*\d+\s*[.)\-:]/m.test(normalized))) return '1';
    if (PROMPT_CUE.test(normalized)) return 'y';
    return null;
}

function promptFingerprint(agent, text) {
    return crypto.createHash('sha256').update(`${agent}\0${String(text).trim()}`).digest('hex');
}

function readTriggerStats(dir = process.env.HERDR_PLUGIN_STATE_DIR) {
    const empty = {total: 0, agents: {}};
    if (!dir) return empty;
    try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, 'trigger-stats.json'), 'utf8'));
        if (!Number.isInteger(data.total) || data.total < 0 || !data.agents || typeof data.agents !== 'object') return empty;
        return {total: data.total, agents: data.agents};
    } catch { return empty; }
}

function recordTrigger(agent, dir = process.env.HERDR_PLUGIN_STATE_DIR) {
    if (!dir) return readTriggerStats();
    fs.mkdirSync(dir, {recursive: true});
    const stats = readTriggerStats(dir);
    const name = String(agent || 'unknown');
    stats.total++;
    stats.agents[name] = (Number(stats.agents[name]) || 0) + 1;
    const file = path.join(dir, 'trigger-stats.json');
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(stats, null, 2)}\n`);
    fs.renameSync(temporary, file);
    return stats;
}

class Limits {
    constructor(count = null, deadline = null) {
        this.count = count;
        this.deadline = deadline;
    }

    reached(sent, now = performance.now() / 1000) {
        return (this.count !== null && sent >= this.count) || (this.deadline !== null && now >= this.deadline);
    }
}

function parseJson(output) {
    return JSON.parse(String(output).trim());
}

function* items(value) {
    if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === 'object' && !Array.isArray(item)) yield item;
    } else if (value && typeof value === 'object') {
        for (const key of ['agents', 'agent', 'items', 'result', 'sessions']) if (key in value) yield* items(value[key]);
        if ('name' in value || 'agent_name' in value || 'agent' in value || 'pane_id' in value || 'id' in value || 'sessionId' in value) yield value;
    }
}

function agentName(item) {
    const name = item.name || item.agent_name || item.agent || item.display_agent || item.id || item.sessionId;
    return typeof name === 'string' && name ? name : null;
}

class Herdr {
    constructor(runner = null) {
        this.runner = runner || ((args) => spawnSync(args[0], args.slice(1), {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        }));
        this.binary = process.env.HERDR_BIN_PATH || 'herdr';
    }

    run(...args) {
        debug(`herdr ${args.join(' ')}`);
        const result = this.runner([this.binary, ...args]);
        if (result.status && result.status !== 0) {
            debug(`herdr failed: ${(result.stderr || result.stdout || '').trim()}`);
            throw new Error((result.stderr || '').trim() || `herdr exited ${result.status}`);
        }
        return String(result.stdout || '');
    }

    call(...args) {
        return parseJson(this.run(...args));
    }

    agents(target) {
        const data = target ? this.call('agent', 'get', target) : this.call('agent', 'list');
        const list = [...items(data)];
        if (target && !list.length && data && typeof data === 'object') list.push(data);
        return list.filter(item => item.pane_id && (!target || agentName(item) === target || item.pane_id === target));
    }

    read(name) {
        return this.run('agent', 'read', name, '--source', 'recent-unwrapped', '--lines', '80');
    }

    send(name, key) {
        return this.run('agent', 'send-keys', name, key);
    }
}

class HerdrSubscription {
    constructor(socketPath = process.env.HERDR_SOCKET_PATH, connector = net.createConnection) {
        this.socketPath = socketPath;
        this.connector = connector;
        this.socket = null;
    }

    subscribe(paneIds, onEvent) {
        if (!this.socketPath) return Promise.reject(new Error('HERDR_SOCKET_PATH is unavailable'));
        return new Promise((resolve, reject) => {
            let settled = false;
            let buffer = '';
            const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${this.socketPath}` : this.socketPath;
            const socket = this.connector(endpoint);
            this.socket = socket;
            const finish = error => {
                if (settled) return;
                settled = true;
                this.socket = null;
                if (error) reject(error); else resolve();
            };
            socket.setEncoding('utf8');
            socket.on('connect', () => {
                const subscriptions = paneIds.map(pane_id => ({type: 'pane.agent_status_changed', pane_id}));
                subscriptions.push({type: 'pane.agent_detected'});
                socket.write(`${JSON.stringify({id: `auto-yes-sir-${process.pid}`, method: 'events.subscribe', params: {subscriptions}})}\n`);
                log(`socket subscribed to ${paneIds.length} agent pane(s)`);
            });
            socket.on('data', chunk => {
                buffer += chunk;
                let newline;
                while ((newline = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (!line) continue;
                    try {
                        const message = JSON.parse(line);
                        if (message.error) return finish(new Error(message.error.message || JSON.stringify(message.error)));
                        if (message.event) onEvent(message);
                    } catch (error) {
                        log(`socket ignored invalid JSON event: ${error.message}`);
                    }
                }
            });
            socket.on('error', finish);
            socket.on('end', () => finish());
            socket.on('close', () => finish());
        });
    }

    close() {
        if (this.socket) this.socket.destroy();
    }
}

function log(message) {
    const line = `[${new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')}] ${message}\n`;
    const root = process.env.HERDR_PLUGIN_ROOT || path.resolve(__dirname, '..');
    try {
        fs.appendFileSync(path.join(root, 'monitor.log'), line);
    } catch (error) {
        process.stderr.write(`[auto-yes-sir] unable to write monitor.log: ${error.message}\n`);
    }
    if (process.env.HERDR_AUTO_YES_SIR_FILE_ONLY !== '1') process.stderr.write(line);
}

function debug(message) {
    if (process.env.HERDR_AUTO_YES_SIR_DEBUG === '1') log(`[debug] ${message}`);
}

function enabled() {
    const dir = process.env.HERDR_PLUGIN_STATE_DIR;
    if (!dir) return true;
    try {
        return fs.readFileSync(path.join(dir, 'enabled'), 'utf8').trim().toLowerCase() !== 'false';
    } catch {
        return true;
    }
}

function sleep(seconds) {
    if (seconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function logConfig(args) {
    log(`monitor configuration: mode=socket-subscription scope=${args.agent || 'all-agents'} key=${args.key || 'auto-classify'} lifetime=${args.forever ? 'forever' : args.count != null ? `count:${args.count}` : `duration:${args.duration}s`} dry_run=${args.dryRun}`);
}

function countdownConfirm(agent, key) {
    const dir = process.env.HERDR_PLUGIN_STATE_DIR;
    if (!dir) {
        sleep(3);
        return true;
    }
    fs.mkdirSync(dir, {recursive: true});
    const token = crypto.randomUUID().replaceAll('-', '');
    const request = path.join(dir, 'countdown-request.json');
    const result = path.join(dir, 'countdown-result.json');
    try {
        fs.unlinkSync(result);
    } catch {
    }
    fs.writeFileSync(request, JSON.stringify({token, agent, key, seconds: 3}));
    const command = [process.env.HERDR_BIN_PATH || 'herdr', 'plugin', 'pane', 'open', '--plugin', 'xlinx.herdr-auto-yes-sir', '--entrypoint', 'countdown', '--placement', 'split', '--direction', 'down', '--focus'];
    if (process.env.HERDR_WORKSPACE_ID) command.push('--workspace', process.env.HERDR_WORKSPACE_ID);
    if (process.env.HERDR_PANE_ID) command.push('--target-pane', process.env.HERDR_PANE_ID);
    const launch = spawnSync(command[0], command.slice(1), {encoding: 'utf8'});
    if (launch.status !== 0) log(`${agent}: countdown window failed to open: ${(launch.stderr || launch.stdout || '').trim()}`); else log(`${agent}: countdown window opened`);
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
        try {
            const data = JSON.parse(fs.readFileSync(result, 'utf8'));
            if (data.token === token) return data.action === 'send';
        } catch {
        }
        sleep(0.1);
    }
    log(`${agent}: countdown completed without popup response; sending ${key}`);
    return true;
}

function parseMonitorArgs(argv) {
    const a = {dryRun: false, forever: false};
    for (let i = 0; i < argv.length; i++) {
        const x = argv[i];
        if (x === '--count') a.count = Number(argv[++i]); else if (x === '--duration') a.duration = Number(argv[++i]); else if (x === '--forever') a.forever = true; else if (x === '--agent') a.agent = argv[++i]; else if (x === '--key') a.key = argv[++i]; else if (x === '--dry-run') a.dryRun = true; else throw new Error(`unknown option ${x}`);
    }
    return a;
}

async function monitorMain(argv = [], client = null, subscriberFactory = null) {
    let args;
    try {
        args = parseMonitorArgs(argv);
    } catch (e) {
        log(e.message);
        return 2;
    }
    if (process.env.HERDR_ENV !== '1') {
        log('HERDR_ENV=1 is required; refusing to run outside Herdr');
        return 2;
    }
    if ((args.count != null && args.count <= 0) || (args.duration != null && args.duration <= 0) || (args.key != null && [...args.key].length !== 1)) {
        log(args.key != null ? '--key must be exactly one character' : 'count and duration must be positive');
        return 2;
    }
    if (args.count == null && args.duration == null && !args.forever) {
        args.duration = 3600;
        log('no lifetime selected; defaulting to 3600 seconds (1 hour; use --forever for an unbounded run)');
    }
    const now = performance.now() / 1000;
    const limits = new Limits(args.count ?? null, args.duration != null ? now + args.duration : null);
    const herdr = client || new Herdr();
    const handled = new Set();
    let sent = 0;
    log('monitor started; waiting for Herdr Socket API status events');
    logConfig(args);
    let activeSubscription = null;
    let stopped = false;
    process.once('SIGTERM', () => {
        log(`monitor stopped by SIGTERM after ${sent} response(s)`);
        stopped = true;
        if (activeSubscription) activeSubscription.close();
        process.exit(0);
    });
    process.once('SIGINT', () => {
        log(`monitor stopped by SIGINT after ${sent} response(s)`);
        stopped = true;
        if (activeSubscription) activeSubscription.close();
        process.exit(0);
    });
    let reconnects = 0;
    while (!stopped && !limits.reached(sent)) {
        try {
            const agents = herdr.agents(args.agent);
            const paneIds = [...new Set(agents.map(item => item.pane_id))];
            const subscriber = subscriberFactory ? subscriberFactory() : new HerdrSubscription();
            activeSubscription = subscriber;
            let queue = Promise.resolve();
            let refresh = false;
            const subscription = subscriber.subscribe(paneIds, message => {
                const event = String(message.event || '').replaceAll('_', '.');
                const data = message.data || {};
                if (event === 'pane.agent.detected') {
                    log(`socket detected new agent pane ${data.pane_id || 'unknown'}; refreshing subscriptions`);
                    refresh = true;
                    subscriber.close();
                    return;
                }
                if (event !== 'pane.agent.status.changed' || data.agent_status !== 'blocked') return;
                queue = queue.then(async () => {
                    if (stopped || limits.reached(sent) || !enabled()) return;
                    const target = data.pane_id;
                    const name = data.display_agent || data.agent || target;
                    log(`${name}: received blocked status event for pane ${target}`);
                    try {
                        const text = herdr.read(target);
                        const fp = promptFingerprint(target, text);
                        if (handled.has(fp)) {
                            debug(`${name}: prompt already handled`);
                            return;
                        }
                        handled.add(fp);
                        const key = args.key || classifyPrompt(text) || 'y';
                        if (!key) {
                            log(`${name}: skipped non-actionable blocked output`);
                            return;
                        }
                        if (!args.dryRun && !countdownConfirm(target, key)) {
                            log(`${name}: cancelled by user`);
                            return;
                        }
                        if (args.dryRun) log(`${name}: would send ${key}`); else {
                            herdr.send(target, key);
                            log(`${name}: sent ${key}`);
                            try { recordTrigger(name); }
                            catch (error) { log(`${name}: unable to save trigger statistics: ${error.message}`); }
                        }
                        sent++;
                        if (args.count != null) log(`count lifetime: ${Math.max(0, args.count - sent)} response(s) remaining`);
                        if (limits.reached(sent)) subscriber.close();
                    } catch (error) {
                        log(`${name}: blocked event handling failed: ${error.message}`);
                    }
                });
            });
            const remainingMs = limits.deadline === null ? null : Math.max(0, (limits.deadline - performance.now() / 1000) * 1000);
            if (remainingMs === null) await subscription; else await Promise.race([subscription, new Promise(resolve => setTimeout(() => { subscriber.close(); resolve(); }, remainingMs))]);
            await queue;
            activeSubscription = null;
            if (!refresh && !stopped && !limits.reached(sent)) throw new Error('subscription socket closed');
            reconnects++;
        } catch (error) {
            if (stopped || limits.reached(sent)) break;
            reconnects++;
            log(`socket subscription failed; reconnecting in 2s: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    log(`monitor finished after ${sent} response(s) and ${reconnects} subscription cycle(s)`);
    return 0;
}

function parseControlArgs(argv) {
    const state = argv[0];
    if (!['enable', 'disable', 'pause', 'resume', 'restart'].includes(state)) throw new Error('state must be enable, disable, pause, resume, or restart');
    const args = {};
    for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--agent') args.agent = argv[++i];
        else if (argv[i] === '--key') args.key = argv[++i];
        else if (argv[i] === '--duration') args.duration = Number(argv[++i]);
        else if (argv[i] === '--count') args.count = Number(argv[++i]);
        else if (argv[i] === '--forever') args.forever = true;
        else throw new Error(`unknown option ${argv[i]}`);
    }
    return {state, args};
}

function monitorCommand(root, config) {
    const command = [path.join(root, 'scripts', 'plugin.js'), 'monitor'];
    if (config.count != null) command.push('--count', String(config.count));
    else if (config.forever) command.push('--forever');
    else command.push('--duration', String(config.duration || 3600));
    if (config.agent) command.push('--agent', config.agent);
    if (config.key) command.push('--key', config.key);
    return command;
}

function controlMain(argv = []) {
    let parsed;
    try { parsed = parseControlArgs(argv); } catch (error) { console.error(error.message); return 2; }
    const {state} = parsed;
    let {args} = parsed;
    const dir = process.env.HERDR_PLUGIN_STATE_DIR || process.env.herdr;
    if (!dir) { console.error('HERDR_PLUGIN_STATE_DIR is unavailable'); return 2; }
    fs.mkdirSync(dir, {recursive: true});
    const root = process.env.HERDR_PLUGIN_ROOT || path.resolve(__dirname, '..');
    const stateFile = path.join(dir, 'enabled');
    const pidFile = path.join(dir, 'monitor.pid');
    const configFile = path.join(dir, 'monitor-config.json');
    const logFile = path.join(root, 'monitor.log');
    const controlLog = message => fs.appendFileSync(logFile, `[${new Date().toISOString()}] [control] ${message}\n`);
    const currentPid = () => {
        try { const pid = Number(fs.readFileSync(pidFile, 'utf8')); process.kill(pid, 0); return pid; }
        catch { return null; }
    };
    const processExists = pid => {
        try { process.kill(pid, 0); return true; }
        catch { return false; }
    };
    const waitForExit = (pid, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!processExists(pid)) return true;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
        return !processExists(pid);
    };
    const stop = reason => {
        const pid = currentPid();
        if (pid) {
            try { process.kill(pid, 'SIGCONT'); } catch {}
            process.kill(pid, 'SIGTERM');
            controlLog(`${reason}: graceful stop requested pid=${pid}`);
            if (!waitForExit(pid, 1500)) {
                process.kill(pid, 'SIGKILL');
                controlLog(`${reason}: forced stop requested pid=${pid}`);
                if (!waitForExit(pid, 500)) controlLog(`${reason}: process still exists after SIGKILL pid=${pid}`);
            } else controlLog(`${reason}: process exit verified pid=${pid}`);
        } else controlLog(`${reason}: monitor is not running`);
        try { fs.unlinkSync(pidFile); } catch {}
        return pid;
    };
    const start = config => {
        const command = monitorCommand(root, config);
        const child = spawn(process.execPath, command, {cwd: root, env: {...process.env, HERDR_AUTO_YES_SIR_FILE_ONLY: '1'}, detached: true, stdio: 'ignore'});
        child.unref();
        fs.writeFileSync(pidFile, `${child.pid}\n`);
        fs.writeFileSync(stateFile, 'true\n');
        controlLog(`monitor started pid=${child.pid} command=${command.join(' ')}`);
        return child.pid;
    };

    controlLog(`plugin control: ${state}`);
    if (state === 'pause' || state === 'resume') {
        const pid = currentPid();
        if (!pid) { controlLog(`monitor is not running; ${state} failed`); console.log('auto-yes-sir monitor is not running'); return 1; }
        process.kill(pid, state === 'pause' ? 'SIGSTOP' : 'SIGCONT');
        controlLog(`monitor ${state} requested pid=${pid}`);
        console.log(`auto-yes-sir monitor ${state}d (pid ${pid})`);
        return 0;
    }
    if (state === 'disable') {
        fs.writeFileSync(stateFile, 'false\n');
        const pid = stop('disable');
        console.log(pid ? `auto-yes-sir monitor stopped (pid ${pid})` : 'auto-yes-sir monitor is not running');
        return 0;
    }
    if (state === 'restart') {
        try { args = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
        catch { console.error('No saved monitor configuration; run enable first'); controlLog('restart failed: saved configuration unavailable'); return 1; }
        stop('restart');
        const pid = start(args);
        console.log(`auto-yes-sir monitor restarted (pid ${pid})`);
        return 0;
    }
    if (args.key && [...args.key].length !== 1) { console.error('--key must be exactly one character'); return 2; }
    if ((args.count != null && (!Number.isInteger(args.count) || args.count <= 0)) || (args.duration != null && !(args.duration > 0))) { console.error('count and duration must be positive'); return 2; }
    const pid = currentPid();
    if (pid) { console.log(`auto-yes-sir monitor already running (pid ${pid})`); return 0; }
    fs.writeFileSync(configFile, `${JSON.stringify(args, null, 2)}\n`);
    const newPid = start(args);
    console.log(`auto-yes-sir monitor started (pid ${newPid})`);
    return 0;
}

function ask(rl, question) {
    return new Promise(resolve => rl.question(question, resolve));
}

function triggerCount(input) {
    const value = String(input || '').trim();
    return value ? Number(value) : 10;
}

async function pickerMain() {
    const binary = process.env.HERDR_BIN_PATH || 'herdr';
    const result = spawnSync(binary, ['agent', 'list'], {encoding: 'utf8'});
    if (result.status !== 0) {
        console.error(`Unable to list Herdr agents: ${(result.stderr || '').trim()}`);
        return 1;
    }
    const names = [];
    for (const item of items(JSON.parse(result.stdout))) {
        const name = agentName(item);
        if (name && !names.includes(name)) names.push(name);
    }
    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    console.log('Auto Yes Sir monitor — choose scope\n\n1) All agents');
    names.forEach((name, i) => console.log(`${i + 2}) ${name}`));
    console.log('p) Pause monitor    r) Resume monitor    s) Stop monitor');
    const stats = readTriggerStats();
    console.log(`\n============Trigger statistics\nAll agents: ${stats.total}`);
    Object.entries(stats.agents).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([name, count]) => console.log(`${name}: ${count}`));
    const choice = (await ask(rl, '\nEnter a choice (q to cancel): ')).trim().toLowerCase();
    if (!choice || ['q', 'quit'].includes(choice)) {
        console.log('Cancelled');
        rl.close();
        return 0;
    }
    if (['p', 'r', 's'].includes(choice)) {
        rl.close();
        return spawnSync(process.execPath, [__filename, 'control', {p: 'pause', r: 'resume', s: 'disable'}[choice]], {stdio: 'inherit'}).status;
    }
    const selected = Number(choice);
    if (!Number.isInteger(selected) || selected < 1 || selected > names.length + 1) {
        console.log('Invalid choice');
        rl.close();
        return 2;
    }
    const target = selected === 1 ? null : names[selected - 2];
    const key = (await ask(rl, 'When status become blocked(red), which Key to send [y|1|2|3|...any char key]: ')).trim() || '1';
    if ([...key].length !== 1) {
        console.log('The response key must be exactly one character');
        rl.close();
        return 2;
    }
    console.log('\nMonitor lifetime:\n1) Forever\n2) 1 hour\n3) Custom seconds\n4) By count');
    const lifetime = (await ask(rl, 'Choose lifetime [1]: ')).trim() || '1';
    const command = [__filename, 'control', 'enable', '--key', key];
    if (lifetime === '4') {
        const count = triggerCount(await ask(rl, 'Trigger count [10]: '));
        if (!Number.isInteger(count) || count <= 0) {
            console.log('Trigger count must be a positive integer');
            rl.close();
            return 2;
        }
        command.push('--count', String(count));
    } else if (lifetime === '3') {
        const seconds = Number(await ask(rl, 'Duration in seconds: '));
        if (!(seconds > 0)) {
            console.log('Duration must be a positive number');
            rl.close();
            return 2;
        }
        command.push('--duration', String(seconds));
    } else if (lifetime === '1') command.push('--forever'); else if (lifetime !== '2') {
        console.log('Invalid lifetime choice');
        rl.close();
        return 2;
    }
    if (target) command.push('--agent', target);
    rl.close();
    return spawnSync(process.execPath, command, {stdio: 'inherit'}).status;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function countdownMain() {
    const dir = process.env.HERDR_PLUGIN_STATE_DIR;
    if (!dir) return 1;
    const requestFile = path.join(dir, 'countdown-request.json');
    const outputFile = path.join(dir, 'countdown-result.json');
    let request;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
        try { request = JSON.parse(fs.readFileSync(requestFile, 'utf8')); break; }
        catch { await wait(50); }
    }
    if (!request) return 1;
    console.log(`Agent: ${request.agent}\nKey: ${request.key}\n\nPress c then Enter to cancel this response.`);
    let action = 'send';
    const rl = readline.createInterface({input: process.stdin, terminal: false});
    rl.on('line', line => { if (line.trim().toLowerCase() === 'c') action = 'cancel'; });
    for (let i = Number(request.seconds || 3); i > 0; i--) {
        console.log(`Sending in ${i}...`);
        await wait(1000);
    }
    rl.close();
    fs.writeFileSync(outputFile, JSON.stringify({token: request.token, action}));
    console.log(action === 'cancel' ? 'Cancelled.' : 'Sending.');
    if (process.env.HERDR_PANE_ID) spawnSync(process.env.HERDR_BIN_PATH || 'herdr', ['pane', 'close', '--current'], {stdio: 'ignore'});
    return 0;
}

async function dispatch(argv = process.argv.slice(2)) {
    const [mode, ...args] = argv;
    if (mode === 'monitor') return monitorMain(args);
    if (mode === 'control') return controlMain(args);
    if (mode === 'picker') return pickerMain();
    if (mode === 'countdown') return countdownMain();
    console.error('usage: plugin.js <monitor|control|picker|countdown> [options]');
    return 2;
}

module.exports = {classifyPrompt, promptFingerprint, readTriggerStats, recordTrigger, Limits, Herdr, HerdrSubscription, monitorMain, parseControlArgs, monitorCommand, controlMain, triggerCount, pickerMain, countdownMain, dispatch, items, agentName};
if (require.main === module) dispatch().then(code => { process.exitCode = code; }).catch(error => { log(`plugin fatal error: ${error.message}`); process.exitCode = 1; });
