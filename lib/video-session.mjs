import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { CHARACTERS, SERVICE, VIDEO_MODES } from '../public/service-config.js';
import { QwenSession, configuration } from './qwen-session.mjs';
import { redact } from './secrets.mjs';

const VIDU_HOST = 'api.vidu.cn';
const PUBLIC = new URL('../public/', import.meta.url);
const ALE_KNOWLEDGE = new URL('./ale-knowledge.md', import.meta.url);
const PCM_FRAME_BYTES = 960; // 20 ms of 24 kHz, signed 16-bit mono.
const AUDIO_QUEUE_LIMIT = 30 * 48000;

export function videoConfiguration() {
  const vidu = Boolean(process.env.VIDU_API_KEY?.trim());
  const qwen = configuration().configured;
  return {
    modes: {
      component: { ready: vidu && qwen, setupError: !vidu ? '请配置 VIDU_API_KEY。' : !qwen ? '请配置 TOKEN_PLAN_API_KEY。' : undefined },
      realtime: { ready: vidu, setupError: vidu ? undefined : '请配置 VIDU_API_KEY。' },
    },
  };
}

export class VideoSession {
  constructor(client) {
    this.client = client;
    this.connId = randomUUID();
    this.seq = 0;
    this.closed = false;
    this.viduReady = false;
    this.joined = false;
    this.muted = false;
    this.queuedPcm = Buffer.alloc(0);
  }

  send(event) {
    if (!this.closed && this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(event));
  }

  async start(settings) {
    if (!Object.hasOwn(VIDEO_MODES, settings.mode)) throw new Error('请选择视频通话模式。');
    const avatarId = settings.avatarId ?? 'ache';
    if (!Object.hasOwn(CHARACTERS, avatarId)) throw new Error('请选择人物大厅里的角色。');
    if (typeof settings.name !== 'string' || !settings.name.trim() || settings.name.length > 30 ||
        typeof settings.persona !== 'string' || settings.persona.length > 4000) throw new Error('角色设置不合法。');
    this.mode = settings.mode;
    const availability = videoConfiguration().modes[this.mode];
    if (!availability.ready) throw new Error(availability.setupError);
    if (this.mode === 'component' &&
        (!Object.hasOwn(SERVICE.voices, settings.voice) || !Object.hasOwn(SERVICE.turnDetection, settings.turnDetection))) {
      throw new Error('请选择支持的千问音色与对话节奏。');
    }
    this.authorization = 'Token ' + process.env.VIDU_API_KEY.trim();
    this.send({ type: 'state', state: 'connecting', text: '正在准备数字人画面…' });
    const { image: imagePath } = CHARACTERS[avatarId];
    const [image, notes] = await Promise.all([
      readFile(new URL('.' + imagePath, PUBLIC)),
      avatarId === 'ache' ? readFile(ALE_KNOWLEDGE, 'utf8') : '',
    ]);
    if (this.closed) return;
    const knowledge = notes ? '\n\n【WoW-Forever 资料】\n' + notes.trim() : '';
    this.settings = { ...settings, knowledge };
    const mime = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const imageUri = 'data:' + mime + ';base64,' + image.toString('base64');
    const component = this.mode === 'component';
    const body = component ? { model: 'vidu-s2', image_uri: imageUri, managed_rtc: { provider: 'artc' } } : {
      model: 'vidu-s2',
      call_mode: 'video',
      rtc: { provider: 'artc' },
      avatar: { image_uri: imageUri, persona: `你是名叫“${settings.name}”的虚构数字人。用自然中文简短回应。\n${settings.persona}${knowledge}` },
      audio: { enable_transcription: true },
    };
    const endpoint = component ? '/live/s_avatar/component' : '/live/s_avatar/realtime';
    const response = await fetch('https://' + VIDU_HOST + endpoint, {
      method: 'POST',
      headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(35000),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(`Vidu 创建失败（HTTP ${response.status}）${failure.message ? ' · ' + failure.message : ''}`);
    }
    const result = await response.json();
    this.liveId = result.live?.id;
    if (!this.liveId) throw new Error('Vidu 返回的会话缺少 ID。');
    this.rtc = component ? result.managed_rtc : result.rtc;
    const query = new URLSearchParams({ conn_id: this.connId });
    if (!component) query.set('live_id', this.liveId);
    const route = component ? `/live/v1/external-lives/${encodeURIComponent(this.liveId)}/stream` : '/live/ws/live/connect';
    this.socket = new WebSocket(`wss://${VIDU_HOST}${route}?${query}`, {
      headers: { Authorization: this.authorization },
      handshakeTimeout: 12000,
      maxPayload: 1024 * 1024,
    });
    this.socket.on('open', () => {
      this.signal(1, { conn_init: { version: 1 } });
      if (this.closed) this.hangup();
    });
    this.socket.on('message', (data, binary) => {
      if (binary || this.closed) return;
      try { this.handleSignal(JSON.parse(data.toString())); } catch (error) { this.fail(error); }
    });
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('Vidu 视频连接已关闭，请重新通话。')));
    if (!this.closed) this.initTimer = setTimeout(() => this.fail(new Error('等待 Vidu 视频准备超时。')), 60000);
  }

  signal(type, payload = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type, live_id: this.liveId, conn_id: this.connId, seq_id: ++this.seq, payload }));
  }

  handleSignal(message) {
    const payload = message.payload ?? {};
    if (message.type === 2 && !this.viduReady) {
      const ack = payload.conn_init_ack;
      if (ack?.error_code === 'NOT_READY') {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.signal(1, { conn_init: { version: 1 } }), 2000);
        return;
      }
      if (!ack?.success) throw new Error(ack?.error_msg || 'Vidu 初始化失败。');
      clearTimeout(this.initTimer);
      clearTimeout(this.retryTimer);
      const rtc = this.rtc;
      if (!rtc?.token || !rtc.user_id || (rtc.provider && rtc.provider !== 'artc')) {
        throw new Error('Vidu 未返回可用的托管 RTC 入会凭证。');
      }
      this.viduReady = true;
      this.send({ type: 'rtc', mode: this.mode, token: rtc.token, userId: rtc.user_id });
      this.joinTimer = setTimeout(() => this.fail(new Error('浏览器接收数字人画面超时。')), 35000);
    } else if (message.type === 6) {
      throw new Error('Vidu 已结束通话 · ' + (payload.hangup?.hangup_reason || '服务端挂断'));
    } else if (this.mode === 'realtime' && (message.type === 9 || message.type === 10)) {
      const text = payload.text_msg;
      if (typeof text?.content === 'string' && text.content) {
        this.send({ type: 'vidu_transcript', role: message.type === 9 ? 'user' : 'assistant',
          text: text.content, itemId: text.msg_id });
      }
    } else if (message.type === 103) {
      this.send({ type: 'turn_error', message: 'Vidu 未能执行本次互动，请重试。' });
    }
  }

  join() {
    if (this.closed || !this.viduReady || this.joined) return;
    clearTimeout(this.joinTimer);
    this.joined = true;
    if (this.mode === 'realtime') {
      this.send({ type: 'ready' });
      return;
    }
    this.qwen = new QwenSession(this.client, {
      onAudio: pcm => this.queueAudio(pcm),
      onInterrupt: () => this.interruptVidu(),
      onClose: () => this.close(),
    });
    this.qwen.start(this.settings);
    this.qwen.muted = this.muted;
  }

  audio(data) { this.qwen?.audio(data); }

  queueAudio(pcm) {
    if (this.closed) return;
    if (this.queuedPcm.length + pcm.length > AUDIO_QUEUE_LIMIT) throw new Error('数字人语音积压，请重新通话。');
    this.queuedPcm = Buffer.concat([this.queuedPcm, pcm]);
    this.hasOutput = true;
    if (this.audioTimer) return;
    this.send({ type: 'state', state: 'speaking', text: '数字人正在回答…' });
    this.audioTimer = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      if (this.socket.bufferedAmount > 256 * 1024) { this.fail(new Error('Vidu 音频上传拥堵。')); return; }
      const frame = this.queuedPcm.subarray(0, PCM_FRAME_BYTES);
      this.queuedPcm = this.queuedPcm.subarray(frame.length);
      if (frame.length) this.socket.send(frame);
      if (!this.queuedPcm.length) {
        clearInterval(this.audioTimer); this.audioTimer = null;
        this.send({ type: 'state', state: 'listening', text: '我在听，你说。' });
      }
    }, 20);
  }

  interruptVidu() {
    clearInterval(this.audioTimer);
    this.audioTimer = null;
    this.queuedPcm = Buffer.alloc(0);
    if (this.mode === 'realtime' || this.hasOutput) this.signal(7);
    this.hasOutput = false;
  }

  interrupt() {
    if (this.qwen) this.qwen.interrupt();
    else if (this.joined) this.interruptVidu();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.qwen) this.qwen.muted = muted;
  }

  respond(text) {
    if (!this.joined) throw new Error('请先开始视频通话。');
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('文字消息长度不合法。');
    if (this.qwen) {
      if (!this.qwen.current?.active) this.interruptVidu();
      this.qwen.respond(text);
    } else {
      const id = randomUUID();
      this.signal(99, { text_msg: { msg_id: id, content: text.trim(), timestamp: Date.now() } });
      this.send({ type: 'user', text: text.trim(), itemId: id });
    }
  }

  fail(error) {
    if (this.closed) return;
    this.send({ type: 'error', message: redact(error.message) });
    this.close();
    if (this.client.readyState === WebSocket.OPEN) this.client.close(1011, 'video-unavailable');
  }

  hangup() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.signal(5, { hangup: { hangup_reason: 'client_hangup' } });
    this.socket.close(1000, 'session ended');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.initTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.joinTimer);
    clearInterval(this.audioTimer);
    this.queuedPcm = Buffer.alloc(0);
    this.qwen?.close();
    // If creation is still in flight, the open handler hangs up as soon as it can.
    this.hangup();
  }
}
