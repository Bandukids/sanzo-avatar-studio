import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { SERVICE } from '../public/service-config.js';
import { redact } from './secrets.mjs';

export const REALTIME_URL = `wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=${SERVICE.model}`;
export function configuration() {
  const configured = Boolean(process.env.TOKEN_PLAN_API_KEY?.trim());
  return { model: SERVICE.model, configured, ready: configured, streaming: true, credentialType: 'Token Plan',
    setupError: configured ? undefined : '请在本机配置 TOKEN_PLAN_API_KEY 后重启原型。' };
}
export function roleInstructions({ name, persona, knowledge = '' }) {
  return `你是名叫“${name}”的虚拟语音互动角色。\n【角色设定】\n${persona}\n【交谈方式】\n用自然中文保持角色身份和说话方式，记住当前会话里用户明确提供的名字、偏好和顾虑，不编造用户经历。一次推进一个话题，不替用户决定或编台词。通常只说一到三句，总计不超过120字，适合口语，不用Markdown或冗长旁白。不要每轮重复介绍自己或机械追问。\n【能力与真实边界】\n你能听见用户发送的音频或读取补充文字；没有收到人物照片、摄像头或视频，也没有联网或现实操作工具。不得声称看到了画面、执行了现实动作或让照片开口。照片中真人的身份与经历未知，不能冒充他；直接被问到时如实说明自己是虚拟角色。设定中的故事属于虚构。${knowledge}`;
}

export class QwenSession {
  constructor(client, { socketFactory = (url, options) => new WebSocket(url, options), getKey = () => process.env.TOKEN_PLAN_API_KEY?.trim(), onAudio, onInterrupt, onClose } = {}) {
    this.client = client; this.socketFactory = socketFactory; this.getKey = getKey;
    this.onAudio = onAudio; this.onInterrupt = onInterrupt; this.onClose = onClose;
    this.closed = false; this.started = false; this.ready = false; this.muted = false; this.turn = 0;
    this.transcribed = new Set(); this.current = null; this.queuedText = null; this.createPending = false; this.cancelPending = false;
  }
  send(event) { if (!this.closed && this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(event)); }
  command(event) {
    if (this.closed || this.upstream?.readyState !== WebSocket.OPEN) return;
    if (this.upstream.bufferedAmount > 256 * 1024) throw new Error('语音上传积压，请重新开始通话。');
    this.upstream.send(JSON.stringify({ event_id: 'evt_' + randomUUID(), ...event }));
  }
  start(settings) {
    if (this.started) throw new Error('通话已经启动。');
    if (typeof settings.name !== 'string' || !settings.name.trim() || settings.name.length > 30 || typeof settings.persona !== 'string' || settings.persona.length > 4000) throw new Error('角色设置不合法。');
    if (settings.model && settings.model !== SERVICE.model) throw new Error('当前只支持 Qwen-Audio-3.0-Realtime-Plus。');
    if (!Object.hasOwn(SERVICE.voices, settings.voice) || !Object.hasOwn(SERVICE.turnDetection, settings.turnDetection)) throw new Error('请选择支持的音色与轮次检测方式。');
    this.key = this.getKey(); if (!this.key) throw new Error('未配置 TOKEN_PLAN_API_KEY。');
    this.started = true; this.settings = settings;
    this.send({ type: 'state', state: 'connecting', text: '正在连接 Qwen 实时语音…' });
    const upstream = this.socketFactory(REALTIME_URL, { handshakeTimeout: 10000, maxPayload: 2 * 1024 * 1024,
      headers: { Authorization: 'Bearer ' + this.key, 'User-Agent': 'AvatarLive/0.6' } });
    this.upstream = upstream;
    this.readyTimer = setTimeout(() => this.fail(new Error('Qwen 实时语音连接超时，请重试。')), 15000);
    upstream.on('message', (data, binary) => {
      if (this.closed) return;
      try { if (binary) throw new Error('实时语音事件格式不正确。'); this.onEvent(JSON.parse(data.toString())); }
      catch (error) { this.fail(error); }
    });
    upstream.on('error', error => this.fail(error));
    upstream.on('close', () => { if (!this.closed) this.fail(new Error('Qwen 实时连接已关闭，请重新开始通话。')); });
  }
  onEvent(event) {
    if (event.type === 'session.created' && !this.updateSent) {
      this.updateSent = true;
      const detection = { type: this.settings.turnDetection, threshold: 0.5 };
      if (detection.type === 'server_vad') detection.silence_duration_ms = 600;
      this.command({ type: 'session.update', session: {
        modalities: ['audio', 'text'], voice: this.settings.voice, instructions: roleInstructions(this.settings),
        input_audio_format: 'pcm', output_audio_format: 'pcm', max_history_turns: 10,
        turn_detection: detection,
      } });
    } else if (event.type === 'session.updated' && this.updateSent && !this.ready) {
      this.ready = true; this.lastInput = Date.now(); clearTimeout(this.readyTimer);
      this.send({ type: 'ready', sampleRate: SERVICE.sampleRate, model: SERVICE.model });
      this.watch = setInterval(() => { if (Date.now() - this.lastInput > 7000) this.fail(new Error('麦克风音频已中断，请重新通话。')); }, 1000);
    } else if (event.type === 'input_audio_buffer.speech_started') {
      if (event.item_id) this.send({ type: 'user_start', itemId: event.item_id });
      // The server cancels inference itself. Another response.cancel here could race it.
      this.discardOutput();
      this.send({ type: 'state', state: 'listening', text: '我在听，你继续。' });
    } else if (event.type === 'input_audio_buffer.speech_stopped') {
      this.send({ type: 'state', state: 'thinking', text: '正在听懂你的意思…' });
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const text = String(event.transcript || '').trim(), id = event.item_id;
      if (text && !this.transcribed.has(id)) {
        this.transcribed.add(id); if (this.transcribed.size > 100) this.transcribed.delete(this.transcribed.values().next().value);
        this.send({ type: 'user', text, itemId: id });
      }
    } else if (event.type === 'response.created') {
      this.createPending = false;
      this.current = { id: event.response.id, turnId: ++this.turn, active: true, cancelled: false, pendingPcm: Buffer.alloc(0), text: '' };
      this.send({ type: 'assistant_start', turnId: this.turn });
      this.send({ type: 'state', state: 'thinking', text: '正在想怎么回应你', turnId: this.turn });
      if (this.queuedText || this.cancelPending) { this.cancelPending = false; this.interrupt(); }
    } else if (event.type === 'response.done') {
      const current = this.current;
      if (current && event.response.id === current.id) {
        current.active = false;
        if (event.response.status === 'cancelled') { if (!current.cancelled) this.discardOutput(); }
        else if (event.response.status === 'failed') {
          this.discardOutput(); this.send({ type: 'turn_error', message: this.safe(event.response.status_details?.error?.message || 'Qwen 本轮回复失败，请再说一次。') });
        } else if (!current.cancelled) {
          if (current.pendingPcm.length) throw new Error('收到不完整的语音帧。');
          this.send({ type: 'assistant_end', turnId: current.turnId });
        }
        if (event.response.usage) this.send({ type: 'usage', usage: event.response.usage, turnId: current.turnId });
        this.flushText();
      }
    } else if (event.type === 'error') {
      if (event.error?.param === 'response.cancel' && /no|not|没有|不存在/i.test(event.error.message || '')) return;
      throw new Error(event.error?.message || 'Qwen 实时语音服务异常。');
    } else {
      const current = this.current;
      if (!current || current.cancelled || !current.active || event.response_id !== current.id) return;
      if (event.type === 'response.audio.delta') {
        let pcm = Buffer.from(event.delta || '', 'base64');
        if (current.pendingPcm.length) pcm = Buffer.concat([current.pendingPcm, pcm]);
        const even = pcm.length - pcm.length % 2;
        current.pendingPcm = Buffer.from(pcm.subarray(even));
        if (!even) return;
        if (this.onAudio) { this.onAudio(pcm.subarray(0, even)); return; }
        if (this.client.bufferedAmount > 512 * 1024) throw new Error('语音播放积压，请重新通话。');
        const header = Buffer.alloc(4); header.writeUInt32LE(current.turnId);
        if (this.client.readyState === WebSocket.OPEN) this.client.send(Buffer.concat([header, pcm.subarray(0, even)]));
      } else if (['response.audio_transcript.delta', 'response.text.delta'].includes(event.type)) {
        current.channel ||= event.type;
        if (event.type === current.channel && event.delta) { current.text += event.delta; this.send({ type: 'delta', text: event.delta, turnId: current.turnId }); }
      } else if (event.type === 'response.audio_transcript.done' && !current.text && event.transcript) {
        current.text = event.transcript; this.send({ type: 'delta', text: event.transcript, turnId: current.turnId });
      }
    }
  }
  audio(data) {
    if (this.closed || !this.ready) return;
    if (!Buffer.isBuffer(data) || !data.length || data.length > 6400 || data.length % 2) throw new Error('麦克风音频帧格式不合法。');
    this.lastInput = Date.now();
    this.command({ type: 'input_audio_buffer.append', audio: (this.muted ? Buffer.alloc(data.length) : data).toString('base64') });
  }
  discardOutput() {
    if (this.current) { this.current.cancelled = true; this.current.pendingPcm = Buffer.alloc(0); }
    this.onInterrupt?.();
    this.send({ type: 'interrupted', turnId: ++this.turn });
  }
  interrupt() {
    if (this.closed) return;
    const active = this.current?.active && !this.current.cancelled;
    if (this.createPending) this.cancelPending = true;
    this.discardOutput();
    if (active) this.command({ type: 'response.cancel' });
  }
  respond(text) {
    if (!this.ready || this.closed) throw new Error('请先开始通话。');
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('文字消息长度不合法。');
    this.queuedText = text.trim();
    if (this.current?.active) this.interrupt();
    else if (!this.createPending) this.flushText();
  }
  flushText() {
    if (!this.queuedText || this.createPending || this.current?.active || this.closed) return;
    const text = this.queuedText; this.queuedText = null; this.createPending = true;
    const id = 'text_' + randomUUID();
    this.command({ type: 'conversation.item.create', item: { id, type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this.send({ type: 'user', text, itemId: id });
    this.command({ type: 'response.create' });
  }
  safe(message) { return redact(message).split(this.key || '\u0000').join('[已隐藏]'); }
  fail(error) {
    if (this.closed) return;
    this.send({ type: 'error', message: this.safe(error.message) }); this.close();
    if (this.client.readyState === WebSocket.OPEN) this.client.close(1011, 'realtime-unavailable');
  }
  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.readyTimer); clearInterval(this.watch); this.queuedText = null;
    if (this.upstream?.readyState === WebSocket.CONNECTING) this.upstream.terminate(); else this.upstream?.close();
    this.onClose?.();
  }
}
