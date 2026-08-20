#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const {spawnSync} = require('node:child_process');
const {items, agentName} = require('./auto_approve');

function ask(rl, q) {
    return new Promise(resolve => rl.question(q, resolve));
}

async function main() {
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
    const choice = (await ask(rl, '\nEnter a choice (q to cancel): ')).trim().toLowerCase();
    if (!choice || ['q', 'quit'].includes(choice)) {
        console.log('Cancelled');
        rl.close();
        return 0;
    }
    const root = process.env.HERDR_PLUGIN_ROOT || path.resolve(__dirname, '..');
    if (['p', 'r', 's'].includes(choice)) {
        rl.close();
        return spawnSync(process.execPath, [path.join(root, 'scripts', 'control.js'), {
            p: 'pause',
            r: 'resume',
            s: 'disable'
        }[choice]], {stdio: 'inherit'}).status;
    }
    const selected = Number(choice);
    if (!Number.isInteger(selected) || selected < 1 || selected > names.length + 1) {
        console.log('Invalid choice');
        rl.close();
        return 2;
    }
    const target = selected === 1 ? null : names[selected - 2];
    const key = (await ask(rl, 'Key to send for every prompt [y]: ')).trim() || 'y';
    if ([...key].length !== 1) {
        console.log('The response key must be exactly one character');
        rl.close();
        return 2;
    }
    console.log('\nMonitor lifetime:\n1) Forever\n2) 1 hour\n3) Custom seconds');
    const lifetime = (await ask(rl, 'Choose lifetime [1]: ')).trim() || '1';
    const command = [path.join(root, 'scripts', 'control.js'), 'enable', '--key', key];
    if (lifetime === '3') {
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

if (require.main === module) main().then(code => {
    process.exitCode = code;
});
module.exports = {main};
