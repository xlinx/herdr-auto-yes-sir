#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

function parseArgs(argv) {
    const state = argv[0];
    if (!['enable', 'disable', 'pause', 'resume', 'restart'].includes(state)) throw new Error('state must be enable, disable, pause, resume, or restart');
    const args = {};
    for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--agent') args.agent = argv[++i];
        else if (argv[i] === '--key') args.key = argv[++i];
        else if (argv[i] === '--duration') args.duration = Number(argv[++i]);
        else if (argv[i] === '--forever') args.forever = true;
        else throw new Error(`unknown option ${argv[i]}`);
    }
    return {state, args};
}

function monitorCommand(root, config) {
    const command = [path.join(root, 'scripts', 'auto_approve.js')];
    if (config.forever) command.push('--forever');
    else command.push('--duration', String(config.duration || 3600));
    if (config.agent) command.push('--agent', config.agent);
    if (config.key) command.push('--key', config.key);
    return command;
}

function main(argv = process.argv.slice(2)) {
    let parsed;
    try { parsed = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
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
    const log = message => fs.appendFileSync(logFile, `[${new Date().toISOString()}] [control] ${message}\n`);
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
            log(`${reason}: graceful stop requested pid=${pid}`);
            if (!waitForExit(pid, 1500)) {
                process.kill(pid, 'SIGKILL');
                log(`${reason}: forced stop requested pid=${pid}`);
                if (!waitForExit(pid, 500)) log(`${reason}: process still exists after SIGKILL pid=${pid}`);
            } else log(`${reason}: process exit verified pid=${pid}`);
        } else log(`${reason}: monitor is not running`);
        try { fs.unlinkSync(pidFile); } catch {}
        return pid;
    };
    const start = config => {
        const command = monitorCommand(root, config);
        const child = spawn(process.execPath, command, {cwd: root, env: {...process.env, HERDR_AUTO_YES_SIR_FILE_ONLY: '1'}, detached: true, stdio: 'ignore'});
        child.unref();
        fs.writeFileSync(pidFile, `${child.pid}\n`);
        fs.writeFileSync(stateFile, 'true\n');
        log(`monitor started pid=${child.pid} command=${command.join(' ')}`);
        return child.pid;
    };

    log(`plugin control: ${state}`);
    if (state === 'pause' || state === 'resume') {
        const pid = currentPid();
        if (!pid) { log(`monitor is not running; ${state} failed`); console.log('auto-yes-sir monitor is not running'); return 1; }
        process.kill(pid, state === 'pause' ? 'SIGSTOP' : 'SIGCONT');
        log(`monitor ${state} requested pid=${pid}`);
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
        catch { console.error('No saved monitor configuration; run enable first'); log('restart failed: saved configuration unavailable'); return 1; }
        stop('restart');
        const pid = start(args);
        console.log(`auto-yes-sir monitor restarted (pid ${pid})`);
        return 0;
    }
    if (args.key && [...args.key].length !== 1) { console.error('--key must be exactly one character'); return 2; }
    const pid = currentPid();
    if (pid) { console.log(`auto-yes-sir monitor already running (pid ${pid})`); return 0; }
    fs.writeFileSync(configFile, `${JSON.stringify(args, null, 2)}\n`);
    const newPid = start(args);
    console.log(`auto-yes-sir monitor started (pid ${newPid})`);
    return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = {main, parseArgs, monitorCommand};
