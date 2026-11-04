const SDK_URL = 'https://g.alicdn.com/apsara-media-box/imp-web-rtc/7.1.9/aliyun-rtc-sdk.js';
let sdkPromise;

export function loadRtcSdk() {
  if (window.AliRtcEngine?.getInstance) return Promise.resolve(window.AliRtcEngine);
  sdkPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const failed = () => {
      clearTimeout(timer);
      script.remove();
      sdkPromise = null;
      reject(new Error('RTC 播放组件加载失败，请检查网络后重试。'));
    };
    const timer = setTimeout(failed, 15000);
    script.src = SDK_URL;
    script.onload = () => {
      if (!window.AliRtcEngine?.getInstance) { failed(); return; }
      clearTimeout(timer);
      resolve(window.AliRtcEngine);
    };
    script.onerror = failed;
    document.head.append(script);
  });
  return sdkPromise;
}

export class RtcPlayback {
  constructor(video, { onError, onPlayRequired }) {
    this.video = video;
    this.onError = onError;
    this.onPlayRequired = onPlayRequired;
    this.controller = new AbortController();
    this.muteTask = Promise.resolve();
  }

  join(credentials, publishMic) {
    this.joinTask = this.connect(credentials, publishMic);
    return this.joinTask;
  }

  async connect({ token, userId }, publishMic) {
    const { signal } = this.controller;
    const sdk = await loadRtcSdk();
    const support = await sdk.isSupported();
    signal.throwIfAborted();
    if (!support.support) throw new Error('当前浏览器无法播放实时视频，请用 Chrome 或 Edge。');

    const engine = this.engine = sdk.getInstance();
    this.publishMic = publishMic;
    const firstFrame = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('加入房间后未收到数字人视频。')), 30000);
      const playing = () => finish();
      const stopped = () => finish(signal.reason);
      const finish = error => {
        clearTimeout(timer);
        this.video.removeEventListener('playing', playing);
        signal.removeEventListener('abort', stopped);
        if (error) reject(error); else resolve();
      };
      signal.addEventListener('abort', stopped, { once: true });
      this.video.addEventListener('playing', playing, { once: true });
    });
    firstFrame.catch(() => {}); // RTC setup can fail before the video promise is awaited.
    engine.on('videoSubscribeStateChanged', (remoteUser, oldState, newState) => {
      if (signal.aborted || newState !== 3) return;
      Promise.resolve(engine.setRemoteViewConfig(this.video, remoteUser, 1))
        .then(() => {
          if (!signal.aborted) return this.video.play();
        })
        .catch(error => {
          if (signal.aborted) return;
          if (error.name === 'NotAllowedError') this.onPlayRequired();
          else if (error.name !== 'AbortError') this.onError('数字人画面播放失败。');
        });
    });
    engine.on('bye', () => { if (!signal.aborted) this.onError('RTC 房间已断开。'); });
    engine.on('authInfoExpired', () => { if (!signal.aborted) this.onError('RTC 入房凭证已过期。'); });
    await engine.setChannelProfile('communication');
    await engine.setAudioOnlyMode(false);
    await engine.setDefaultSubscribeAllRemoteAudioStreams(true);
    await engine.setDefaultSubscribeAllRemoteVideoStreams(true);
    signal.throwIfAborted();
    await engine.joinChannel(token, userId);
    signal.throwIfAborted();
    if (publishMic) await engine.publishLocalAudioStream(true);
    await firstFrame;
  }

  mute(muted) {
    if (!this.publishMic || this.controller.signal.aborted) return;
    this.muteTask = this.muteTask.catch(() => {}).then(async () => {
      if (!this.controller.signal.aborted) await this.engine.publishLocalAudioStream(!muted);
    });
    return this.muteTask;
  }

  async close() {
    this.controller.abort();
    await this.joinTask?.catch(() => {});
    await this.muteTask.catch(() => {});
    if (this.engine) {
      try { await this.engine.leaveChannel(); } catch {}
      try { await this.engine.destroy?.(); } catch {}
      this.engine = null;
    }
    this.video.pause();
    this.video.srcObject = null;
  }
}
