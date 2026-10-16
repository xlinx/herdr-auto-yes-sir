const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { classifyPrompt, responseKeys, countdownConfirm, parseControlArgs, readTriggerStats, recordTrigger, Limits, Herdr, monitorMain, monitorCommand, triggerCount } = require('./plugin');
test('classifies numbered menu', () => assert.equal(classifyPrompt('Choose an option:\n1. Continue\n2. Cancel'), '1'));
test('classifies approval prompt', () => assert.equal(classifyPrompt('Allow this command? [y/N]'), 'y'));
test('classifies Codex numbered approval prompt', () => assert.equal(classifyPrompt('Type 1 to approve this action'), '1'));
test('classifies Codex yes prompt', () => assert.equal(classifyPrompt('Press y to continue'), 'y'));
test('ignores empty prompt', () => assert.equal(classifyPrompt('  '), null));
test('enforces count limit', () => { assert.equal(new Limits(2).reached(2), true); assert.equal(new Limits(2).reached(1), false); });
test('enforces deadline limit', () => assert.equal(new Limits(null, 10).reached(0, 10), true));
test('blocked subscription event triggers dry-run response', async () => {
  process.env.HERDR_ENV = '1';
  const fake = { agents: () => [{ agent: 'agent', pane_id: 'w1:p1' }], read: () => 'Allow? [y/N]', send: () => { throw new Error('sent'); } };
  const subscriber = { subscribe: async (_panes, onEvent) => onEvent({ event: 'pane.agent_status_changed', data: { pane_id: 'w1:p1', agent: 'agent', agent_status: 'blocked' } }), close() {} };
  assert.equal(await monitorMain(['--count', '1', '--dry-run'], fake, () => subscriber), 0);
});
test('extracts agent panes for socket subscriptions', () => { const client = new Herdr(() => ({ status: 0, stdout: JSON.stringify({ result: { agents: [{ agent: 'agent-1', pane_id: 'w1:p1', agent_status: 'working' }] } }) })); assert.deepEqual(client.agents(), [{ agent: 'agent-1', pane_id: 'w1:p1', agent_status: 'working' }]); });
test('forever monitor command has no duration value', () => assert.deepEqual(monitorCommand('/plugin', { forever: true, key: 'y' }), ['/plugin/scripts/plugin.js', 'monitor', '--forever', '--key', 'y']));
test('timed monitor command includes duration', () => assert.deepEqual(monitorCommand('/plugin', { duration: 900 }), ['/plugin/scripts/plugin.js', 'monitor', '--duration', '900']));
test('agent read accepts plain output beginning with dash', () => { const client = new Herdr(() => ({ status: 0, stdout: '- Allow this command? [y/N]\n' })); assert.equal(client.read('w1:p1'), '- Allow this command? [y/N]\n'); });
test('send keys accepts plain non-JSON output', () => { const client = new Herdr(() => ({ status: 0, stdout: '✗ You cancelled the prompt\n' })); assert.equal(client.send('w1:p1', 'y'), '✗ You cancelled the prompt\n'); });
test('count lifetime command uses count instead of duration', () => assert.deepEqual(monitorCommand('/plugin', { count: 10 }), ['/plugin/scripts/plugin.js', 'monitor', '--count', '10']));
test('picker count defaults to 10', () => { assert.equal(triggerCount(''), 10); assert.equal(triggerCount('7'), 7); });
test('trigger statistics persist total and per-agent counts', () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-yes-sir-stats-')); try { recordTrigger('codex', dir); recordTrigger('codex', dir); recordTrigger('reviewer', dir); assert.deepEqual(readTriggerStats(dir), { total: 3, agents: { codex: 2, reviewer: 1 } }); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
test('response keys accept one character, key names, and sequences', () => { assert.deepEqual(responseKeys('y'), ['y']); assert.deepEqual(responseKeys('enter'), ['enter']); assert.deepEqual(responseKeys('ctrl+c'), ['ctrl+c']); assert.deepEqual(responseKeys('y enter'), ['y', 'enter']); assert.equal(responseKeys('yes'), null); assert.equal(responseKeys(''), null); });
test('send keys passes key sequences as separate arguments', () => { const calls = []; const client = new Herdr(args => { calls.push(args.slice(1)); return { status: 0, stdout: '' }; }); client.send('w1:p1', 'y enter'); assert.deepEqual(calls, [['agent', 'send-keys', 'w1:p1', 'y', 'enter']]); });
test('unnamed agents resolve by pane id', () => { const client = new Herdr(() => ({ status: 0, stdout: JSON.stringify({ result: { agent: { agent: 'agy', pane_id: 'w9:p1' }, type: 'agent_info' } }) })); assert.deepEqual(client.agents('w9:p1'), [{ agent: 'agy', pane_id: 'w9:p1' }]); });
test('agent type matches every agent of that type', () => { const client = new Herdr(() => ({ status: 0, stdout: JSON.stringify({ result: { agents: [{ agent: 'claude', name: 'claude', pane_id: 'w1:p1' }, { agent: 'claude', name: 'claude-2', pane_id: 'w2:p1' }, { agent: 'agy', pane_id: 'w3:p1' }] } }) })); assert.deepEqual(client.agents(null, 'claude').map(a => a.pane_id), ['w1:p1', 'w2:p1']); assert.deepEqual(client.agents(null, 'codex'), []); });
test('agent type flows through control and monitor commands', () => { assert.deepEqual(parseControlArgs(['enable', '--agent-type', 'agy']).args, { agentType: 'agy' }); assert.deepEqual(monitorCommand('/plugin', { forever: true, agentType: 'agy', key: 'enter' }), ['/plugin/scripts/plugin.js', 'monitor', '--forever', '--agent-type', 'agy', '--key', 'enter']); });
test('countdown targets the blocked pane and fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-yes-sir-countdown-'));
  const argsFile = path.join(dir, 'args'); const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > '${argsFile}'\nexit 1\n`, { mode: 0o755 });
  const saved = { ...process.env };
  Object.assign(process.env, { HERDR_BIN_PATH: bin, HERDR_PLUGIN_STATE_DIR: dir, HERDR_PLUGIN_ROOT: dir, HERDR_AUTO_YES_SIR_FILE_ONLY: '1', HERDR_WORKSPACE_ID: 'w1', HERDR_PANE_ID: 'w1:p9' });
  try {
    assert.equal(countdownConfirm('w3:p1', 'enter'), false);
    const args = fs.readFileSync(argsFile, 'utf8').trim().split(' ');
    assert.equal(args[args.indexOf('--target-pane') + 1], 'w3:p1');
    assert.equal(args.includes('--workspace'), false);
  } finally { process.env = saved; fs.rmSync(dir, { recursive: true, force: true }); }
});
