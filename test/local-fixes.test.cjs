// Synthetic, offline regression tests. Each case imports fresh modules in its own HOME.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const cases = [
  'absent index scans active sessions',
  'absent index scans archived sessions',
  'empty index falls back',
  'invalid JSON index falls back',
  'malformed index entry falls back',
  'hybrid index takes precedence',
  'scan filters names and tolerates non-directory projects',
  'missing sources return empty list',
  'directory source enables session start without hybrid index',
  'proposal timer clears while session is active',
  'degrading status replaces proposal timer',
  'shutdown cancels proposal timer',
  'shutdown cancels degrading timer',
  'shutdown cancels overlapping status timers',
  'repeated start isolates old and new session contexts',
  'repeated start with no new status cancels old timer',
  'separate extension instances own separate timers',
  'before_agent_start reads Pi 1.2.0 user prompt',
  'before_agent_start ignores unrelated user prompt',
  'before_agent_start skips Pi 1.2.0 custom message',
  'before_agent_start reads legacy prompt-only event',
  'before_agent_start leaves prompt unchanged before state loads',
];

if (process.argv[2] !== '--worker') {
  for (const name of cases) test(name, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-evolution-test-'));
    try {
      for (const d of ['home', 'tmp', 'claude']) fs.mkdirSync(path.join(root, d));
      const result = spawnSync(process.execPath, [__filename, '--worker', name], {
        env: { ...process.env, HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'),
          CLAUDE_CONFIG_DIR: path.join(root, 'claude') }, encoding: 'utf8', timeout: 15000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
} else {
  run(process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
}

async function run(name) {
  // There is no model/provider in this harness; fail closed on accidental network use.
  global.fetch = () => { throw new Error('Network forbidden in regression tests'); };
  for (const module of ['node:http', 'node:https']) {
    const transport = require(module);
    transport.request = transport.get = () => { throw new Error('Network forbidden in regression tests'); };
  }
  const createJiti = require(process.env.SKILL_TEST_JITI || 'jiti').createJiti;
  const jiti = createJiti(__filename, { fsCache: false, moduleCache: false });
  const source = process.env.SKILL_TEST_SOURCE || path.resolve(__dirname, '../src');
  const miner = await jiti.import(path.join(source, 'miner.ts'));
  const indexPath = path.join(process.env.HOME, '.pi/session-search/index/session-index.json');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const session = (root = 'sessions', id = ids[0]) => {
    const file = path.join(process.env.HOME, '.pi/agent', root, 'synthetic-项目',
      `2026-01-02T03-04-05-006Z_${id}.jsonl`);
    write(file, JSON.stringify({ type: 'session', id, timestamp: '2026-01-02T03:04:05.006Z' }) + '\n');
    return { file, id, startedAt: '2026-01-02T03:04:05.006Z' };
  };
  const checkFallback = () => {
    const expected = session();
    assert.deepEqual(miner.loadSessionList(), [expected]);
    assert.equal(miner.sessionSourceAvailable(), true);
  };

  switch (name) {
    case 'absent index scans active sessions': checkFallback(); return;
    case 'absent index scans archived sessions': {
      const expected = session('sessions-archive');
      assert.deepEqual(miner.loadSessionList(), [expected]); return;
    }
    case 'empty index falls back': write(indexPath, '{"sessions":{}}'); checkFallback(); return;
    case 'invalid JSON index falls back': write(indexPath, '{broken'); checkFallback(); return;
    case 'malformed index entry falls back': write(indexPath, '{"sessions":{"bad":{}}}'); checkFallback(); return;
    case 'hybrid index takes precedence': {
      session(); const expected = session('sessions-archive', ids[1]);
      write(indexPath, JSON.stringify({ sessions: { [expected.id]: { session: expected } } }));
      assert.deepEqual(miner.loadSessionList(), [expected]); return;
    }
    case 'scan filters names and tolerates non-directory projects': {
      const active = session(); const archive = session('sessions-archive', ids[1]);
      write(path.join(path.dirname(active.file), 'not-a-session.jsonl'), '{}');
      write(path.join(process.env.HOME, '.pi/agent/sessions', 'not-a-directory'), '{}');
      assert.deepEqual(miner.loadSessionList(), [active, archive]); return;
    }
    case 'missing sources return empty list':
      assert.deepEqual(miner.loadSessionList(), []); return;
  }

  const timers = new Map(); let now = 0; let timerId = 0;
  global.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; };
  global.clearTimeout = id => timers.delete(id);
  const advance = milliseconds => {
    const end = now + milliseconds;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = end;
  };
  const extension = (await jiti.import(path.join(source, 'index.ts'))).default;
  const makeInstance = () => {
    const handlers = new Map();
    extension({ on: (event, handler) => handlers.set(event, handler), registerTool() {}, registerCommand() {} });
    return handlers;
  };
  const context = () => {
    const statuses = []; const notices = [];
    return { statuses, notices, ui: { setStatus: (key, text) => statuses.push({ key, text }),
      notify: (text, level) => notices.push({ text, level }) },
      sessionManager: { getSessionFile: () => path.join(process.env.HOME, `${ids[0]}.jsonl`) } };
  };
  const state = (proposals = true, degrading = false) => {
    write(path.join(process.env.HOME, '.pi/skill-evolution/state.json'), JSON.stringify({
      version: 1, patterns: [], proposals: proposals ? [0, 1, 2].map(i => ({ name: `synthetic-${i}`, status: 'proposed' })) : [],
      health: degrading ? { synthetic: { skill: 'synthetic', trend: 'degrading', issues: [] } } : {},
      analyzedSessionIds: [], lastAnalysis: '',
    }));
  };
  const handlers = makeInstance(); const first = context();
  if (name.startsWith('before_agent_start')) {
    const systemPrompt = 'Original system prompt mentioning synthetic-skill.';
    const userEvent = {
      type: 'before_agent_start', messageType: 'user', prompt: 'Please use SYNTHETIC SKILL.',
      systemPrompt, systemPromptOptions: {},
    };
    const beforeStart = handlers.get('before_agent_start');
    if (name.includes('before state loads')) {
      assert.equal(await beforeStart(userEvent, first), undefined); return;
    }
    write(indexPath, '{"sessions":{}}');
    write(path.join(process.env.HOME, '.pi/skill-evolution/state.json'), JSON.stringify({
      version: 1, patterns: [], proposals: [], analyzedSessionIds: [], lastAnalysis: '',
      health: { 'synthetic-skill': { skill: 'synthetic-skill', trend: 'stable', issues: [
        { severity: 'warning', description: 'Synthetic warning', suggestion: 'Check the synthetic result.' },
        { severity: 'info', description: 'Synthetic info', suggestion: 'Not a warning.' },
      ] } },
    }));
    await handlers.get('session_start')({}, first);
    assert.equal(first.notices.length, 0);
    if (name.includes('unrelated')) {
      assert.equal(await beforeStart({ ...userEvent, prompt: 'Please summarize this document.' }, first), undefined);
      return;
    }
    if (name.includes('custom message')) {
      // The real Pi 1.2.0 custom variant has message, not prompt. Do not treat its content as user input.
      assert.equal(await beforeStart({
        type: 'before_agent_start', messageType: 'custom', systemPrompt, systemPromptOptions: {},
        message: { role: 'custom', customType: 'synthetic', content: 'Use synthetic-skill.',
          display: false, timestamp: 0 },
      }, first), undefined);
      return;
    }
    const event = name.includes('legacy')
      ? { type: 'before_agent_start', prompt: 'Please use synthetic-skill.', systemPrompt }
      : userEvent;
    assert.deepEqual(await beforeStart(event, first), {
      systemPrompt: systemPrompt + '\n<skill_health_warnings>\n'
        + 'The following skills have known issues. Be extra careful and consider the suggestions:\n'
        + '- synthetic-skill: Synthetic warning. Check the synthetic result.\n</skill_health_warnings>',
    });
    assert.equal(event.systemPrompt, systemPrompt, 'the original event must remain unchanged');
    return;
  }
  if (name === 'directory source enables session start without hybrid index') {
    session(); state();
    await handlers.get('session_start')({}, first);
    assert.equal(first.notices.length, 0);
    assert.equal(first.statuses[0]?.text, '3 skill proposals pending review'); return;
  }
  // A valid hybrid index lets the pristine baseline reach its timer code.
  write(indexPath, '{"sessions":{}}');
  const degrading = name.includes('degrading') || name.includes('overlapping');
  state(name !== 'shutdown cancels degrading timer', degrading);
  await handlers.get('session_start')({}, first);
  assert.ok(first.statuses.length > 0);

  if (name === 'proposal timer clears while session is active') {
    advance(9999); assert.equal(first.statuses.length, 1);
    advance(1); assert.equal(first.statuses.at(-1).text, ''); assert.equal(timers.size, 0); return;
  }
  if (name === 'degrading status replaces proposal timer') {
    assert.equal(timers.size, 1);
    advance(8000); assert.equal(first.statuses.at(-1).text, '');
    const count = first.statuses.length; advance(2000);
    assert.equal(first.statuses.length, count); return;
  }
  if (name.startsWith('shutdown cancels')) {
    await handlers.get('session_shutdown')({});
    const count = first.statuses.length;
    advance(20000);
    assert.equal(first.statuses.length, count, 'shutdown must not leave stale-context status callbacks');
    assert.equal(timers.size, 0); return;
  }
  if (name.startsWith('repeated start')) {
    advance(2000); const second = context();
    state(!name.includes('no new status'));
    await handlers.get('session_start')({}, second);
    const firstCount = first.statuses.length;
    advance(8000);
    assert.equal(first.statuses.length, firstCount, 'old session must never receive the old timer');
    if (name.includes('no new status')) {
      assert.equal(second.statuses.length, 0); assert.equal(timers.size, 0);
    } else {
      assert.equal(second.statuses.length, 1, 'old timer must not clear the new status');
      advance(2000); assert.equal(second.statuses.at(-1).text, ''); assert.equal(timers.size, 0);
    }
    return;
  }
  if (name === 'separate extension instances own separate timers') {
    const other = makeInstance(); const second = context();
    await other.get('session_start')({}, second);
    await handlers.get('session_shutdown')({});
    const count = first.statuses.length;
    assert.equal(timers.size, 1, 'one instance shutdown must not cancel another instance timer');
    advance(10000);
    assert.equal(first.statuses.length, count); assert.equal(second.statuses.at(-1).text, ''); return;
  }
  throw new Error(`Unhandled scenario: ${name}`);
}
