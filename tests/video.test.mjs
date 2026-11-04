import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VideoSession } from '../lib/video-session.mjs';
import { roleInstructions } from '../lib/qwen-session.mjs';
import { CHARACTERS } from '../public/service-config.js';

function fixture() {
  const events = [];
  const frames = [];
  const session = new VideoSession({ readyState: 1, send: raw => events.push(JSON.parse(raw)) });
  session.socket = { readyState: 1, bufferedAmount: 0, send: frame => frames.push(frame), close() { this.readyState = 3; } };
  return { session, events, frames };
}

test('video readiness waits for browser RTC and returns only the temporary join fields', () => {
  const { session, events } = fixture();
  try {
    session.mode = 'realtime';
    session.rtc = { token: 'rtc-ticket', user_id: 'viewer', provider: 'artc', client_secret: 'do-not-forward' };
    session.join();
    assert.deepEqual(events, []);
    session.handleSignal({ type: 2, payload: { conn_init_ack: { success: true } } });
    assert.deepEqual(events, [{ type: 'rtc', mode: 'realtime', token: 'rtc-ticket', userId: 'viewer' }]);
    session.join();
    session.join();
    assert.deepEqual(events.at(-1), { type: 'ready' });
    assert.equal(events.length, 2);
  } finally { session.close(); }
});

test('interrupt clears queued PCM and hangup closes the Vidu socket', () => {
  const { session, frames } = fixture();
  session.mode = 'component';
  session.queueAudio(Buffer.alloc(1920));
  session.interruptVidu();
  assert.equal(session.queuedPcm.length, 0);
  assert.equal(session.audioTimer, null);
  assert.equal(JSON.parse(frames[0]).type, 7);
  session.close();
  assert.equal(JSON.parse(frames[1]).type, 5);
  assert.equal(session.socket.readyState, 3);
});

test('public session requires a video mode before it can create a cloud session', async () => {
  const { session } = fixture();
  await assert.rejects(session.start({ mode: 'audio' }), /视频通话模式/);
});

test('both video modes use the chosen portrait and only 阿勒 receives the local game notes', async t => {
  const oldViduKey = process.env.VIDU_API_KEY;
  const oldQwenKey = process.env.TOKEN_PLAN_API_KEY;
  process.env.VIDU_API_KEY = 'fixture-vidu';
  process.env.TOKEN_PLAN_API_KEY = 'fixture-qwen';
  t.after(() => {
    if (oldViduKey === undefined) delete process.env.VIDU_API_KEY; else process.env.VIDU_API_KEY = oldViduKey;
    if (oldQwenKey === undefined) delete process.env.TOKEN_PLAN_API_KEY; else process.env.TOKEN_PLAN_API_KEY = oldQwenKey;
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return Response.json({}, { status: 400 });
  });
  const settings = { mode: 'component', name: '胡桃', persona: CHARACTERS.hutao.persona, voice: 'longanlingxi', turnDetection: 'smart_turn_v2' };
  await assert.rejects(fixture().session.start({ ...settings, avatarId: '../private' }), /人物大厅/);
  assert.equal(requests.length, 0);
  const coser = fixture().session;
  await assert.rejects(coser.start({ ...settings, avatarId: 'hutao', knowledge: 'untrusted-client-value' }), /HTTP 400/);
  assert.equal(coser.settings.knowledge, '');
  const aleSettings = { ...settings, avatarId: 'ache', name: '阿勒', persona: CHARACTERS.ache.persona };
  const ale = fixture().session;
  await assert.rejects(ale.start(aleSettings), /HTTP 400/);
  await assert.rejects(fixture().session.start({ ...aleSettings, mode: 'realtime' }), /HTTP 400/);
  const hutao = await readFile(new URL('../public/assets/avatars/hutao.png', import.meta.url));
  const original = await readFile(new URL('../public/assets/character.jpg', import.meta.url));
  assert.ok(requests[0].body.image_uri === 'data:image/png;base64,' + hutao.toString('base64'));
  assert.ok(requests[2].body.avatar.image_uri === 'data:image/jpeg;base64,' + original.toString('base64'));
  assert.match(roleInstructions(ale.settings), /部落的塑风者分支额外可选萨满祭司/);
  assert.match(requests[2].body.avatar.persona, /【WoW-Forever 资料】[\s\S]+泽风岛/);
});
