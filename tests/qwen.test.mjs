import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { QwenSession, REALTIME_URL, configuration } from '../lib/qwen-session.mjs';

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
  send(value) { this.sent.push(value); }
  json() { return this.sent.filter(value => typeof value === 'string').map(value => JSON.parse(value)); }
  event(value) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}
const settings = { name: '团团', persona: '自称本机，称呼用户舰长，每次最多两句。', voice: 'longanlufeng', turnDetection: 'smart_turn_v2' };
function fixture(callbacks = {}) {
  const client = new Socket(), cloud = new Socket(); let connection;
  const session = new QwenSession(client, { ...callbacks, getKey: () => 'fixture-private-key', socketFactory: (url, options) => { connection = { url, options }; return cloud; } });
  session.start(settings);
  const ready = () => { cloud.event({ type: 'session.created', session: {} }); cloud.event({ type: 'session.updated', session: {} }); };
  const created = id => cloud.event({ type: 'response.created', response: { id } });
  const audio = (id, bytes) => cloud.event({ type: 'response.audio.delta', response_id: id, delta: Buffer.from(bytes).toString('base64') });
  return { session, client, cloud, ready, created, audio, connection };
}
test('video mode routes aligned PCM to Vidu and discards late PCM after an interrupt', () => {
  const frames = [];
  let interruptions = 0;
  const f = fixture({ onAudio: pcm => frames.push(pcm), onInterrupt: () => interruptions++ });
  try {
    f.ready();
    f.created('one');
    f.audio('one', [1]);
    f.audio('one', [2, 3, 4]);
    f.session.interrupt();
    f.audio('one', [5, 6]);
    assert.deepEqual(frames, [Buffer.from([1, 2, 3, 4])]);
    assert.equal(interruptions, 1);
    assert.equal(f.client.sent.some(Buffer.isBuffer), false);
  } finally { f.session.close(); }
});
test('one fixed model and endpoint, role instructions and audio formats wait for session confirmation', () => {
  const f = fixture();
  try {
    assert.equal(f.connection.url, REALTIME_URL); assert.match(REALTIME_URL, /model=qwen-audio-3.0-realtime-plus$/);
    assert.equal(f.connection.options.headers.Authorization, 'Bearer fixture-private-key');
    assert.equal(f.client.json().some(e => e.type === 'ready'), false);
    f.cloud.event({ type: 'session.created' });
    const update = f.cloud.json()[0];
    assert.equal(update.type, 'session.update'); assert.match(update.session.instructions, /团团/); assert.match(update.session.instructions, /舰长/);
    assert.equal(update.session.input_audio_format, 'pcm'); assert.equal(update.session.output_audio_format, 'pcm');
    assert.deepEqual(update.session.turn_detection, { type: 'smart_turn_v2', threshold: 0.5 });
    f.cloud.event({ type: 'session.updated' }); assert.equal(f.client.json().at(-1).sampleRate, 24000);
    assert.equal(JSON.stringify(configuration()).includes('fixture-private-key'), false);
  } finally { f.session.close(); }
});
test('microphone remains continuous, mute suppresses content, malformed PCM rejected before cloud send', () => {
  const f = fixture();
  try {
    f.session.audio(Buffer.alloc(1280)); assert.equal(f.cloud.sent.length, 0); f.ready();
    const bytes = Buffer.alloc(1280, 7); f.session.audio(bytes);
    assert.deepEqual(Buffer.from(f.cloud.json().at(-1).audio, 'base64'), bytes);
    f.session.muted = true; f.session.audio(bytes);
    assert.deepEqual(Buffer.from(f.cloud.json().at(-1).audio, 'base64'), Buffer.alloc(1280));
    assert.throws(() => f.session.audio(Buffer.alloc(3)), /格式/); assert.throws(() => f.session.audio(Buffer.alloc(6402)), /格式/);
  } finally { f.session.close(); }
});
test('turn IDs align PCM, server interruption discards late audio/text without a duplicate cancellation', () => {
  const f = fixture();
  try {
    f.ready(); f.created('a'); f.audio('a', [1]); f.audio('a', [0, 2, 0]);
    const packet = f.client.sent.find(Buffer.isBuffer); assert.equal(packet.readUInt32LE(0), 1); assert.deepEqual([...packet.subarray(4)], [1, 0, 2, 0]);
    f.cloud.event({ type: 'input_audio_buffer.speech_started', item_id: 'user-a' });
    assert.equal(f.client.json().find(e => e.type === 'user_start').itemId, 'user-a'); const before = f.client.sent.length;
    f.audio('a', [5, 0]); f.cloud.event({ type: 'response.audio_transcript.delta', response_id: 'a', delta: '过期' });
    assert.equal(f.client.sent.length, before); assert.equal(f.cloud.json().some(e => e.type === 'response.cancel'), false);
    f.created('b'); f.audio('a', [7, 0]); f.audio('b', [9, 0]); assert.equal(f.client.sent.filter(Buffer.isBuffer).length, 2);
  } finally { f.session.close(); }
});
test('manual interruption queues text until cancelled response is done and ignores old response endings', () => {
  const f = fixture();
  try {
    f.ready(); f.created('a'); f.session.respond('我叫小林');
    assert.equal(f.cloud.json().at(-1).type, 'response.cancel');
    assert.equal(f.cloud.json().some(e => e.type === 'conversation.item.create'), false);
    f.cloud.event({ type: 'response.done', response: { id: 'a', status: 'cancelled' } });
    assert.deepEqual(f.cloud.json().slice(-2).map(e => e.type), ['conversation.item.create', 'response.create']);
    f.created('b'); f.cloud.event({ type: 'response.done', response: { id: 'a', status: 'completed' } });
    assert.equal(f.client.json().some(e => e.type === 'assistant_end'), false);
    f.cloud.event({ type: 'response.done', response: { id: 'b', status: 'completed' } }); assert.equal(f.client.json().at(-1).type, 'assistant_end');
  } finally { f.session.close(); }
});
test('interrupt before response.created cancels the pending response and repeated clicks do not duplicate cancellation', () => {
  const f = fixture();
  try {
    f.ready(); f.session.respond('你好'); f.session.interrupt(); f.created('pending');
    assert.equal(f.cloud.json().filter(e => e.type === 'response.cancel').length, 1);
    const before = f.client.sent.filter(Buffer.isBuffer).length; f.audio('pending', [4, 0]);
    assert.equal(f.client.sent.filter(Buffer.isBuffer).length, before);
    f.session.interrupt(); assert.equal(f.cloud.json().filter(e => e.type === 'response.cancel').length, 1);
  } finally { f.session.close(); }
});

test('repeated words in separate speech items are retained; duplicate item transcripts are removed', () => {
  const f = fixture();
  try {
    f.ready(); for (const item_id of ['a', 'a', 'b']) f.cloud.event({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript: '你好' });
    assert.equal(f.client.json().filter(e => e.type === 'user').length, 2);
  } finally { f.session.close(); }
});
test('credentials are redacted on upstream failure, cloud connection and timers released', () => {
  const f = fixture(); f.ready(); f.cloud.emit('error', new Error('拒绝 fixture-private-key'));
  const error = f.client.json().find(e => e.type === 'error'); assert.equal(error.message.includes('fixture-private-key'), false);
  assert.equal(f.session.closed, true); assert.equal(f.cloud.readyState, 3); assert.equal(f.client.readyState, 3);
});
test('unsupported models, voices and turn settings cannot trigger cloud requests', () => {
  let calls = 0;
  for (const invalid of [{ model: 'other' }, { voice: '__proto__' }, { turnDetection: 'other' }]) {
    const session = new QwenSession(new Socket(), { getKey: () => 'fixture', socketFactory: () => { calls++; return new Socket(); } });
    assert.throws(() => session.start({ ...settings, ...invalid })); session.close();
  }
  assert.equal(calls, 0);
});
