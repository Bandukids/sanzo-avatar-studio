import { CHARACTERS, ROLE_PRESETS, SERVICE, VIDEO_MODES } from './service-config.js';
import { loadRtcSdk, RtcPlayback } from './rtc.js';
import { bindTheme } from './theme.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const activeControls = ['mute', 'interrupt', 'text-input', 'send-text'];
const remoteVideo = $('#remote-video');
const routeId = decodeURIComponent(location.pathname.split('/')[2] || '');
const avatarId = Object.hasOwn(CHARACTERS, routeId) ? routeId : 'ache';
const character = CHARACTERS[avatarId];
const characterStorageKey = 'avatar-character-settings:v2:' + avatarId;
const userMessages = new Map();
let call = null;
let closing = false;
let availability;
let openPanel;
let opener;
let captionsEnabled = false;
let captionText = '';

function settings() {
  return {
    avatarId,
    mode: $('input[name="mode"]:checked').value,
    name: $('#character-name').value.trim() || character.name,
    persona: $('#persona').value,
    voice: $('#voice').value,
    turnDetection: $('#turn-detection').value,
  };
}

function populateSelect(id, entries, saved, fallback) {
  const select = $('#' + id);
  for (const [value, item] of Object.entries(entries)) select.add(new Option(item.name, value));
  select.value = Object.hasOwn(entries, saved) ? saved : fallback;
}

function syncSettings() {
  const selected = settings();
  const component = VIDEO_MODES[selected.mode].needsQwen;
  $('#display-name').textContent = selected.name;
  $('#portrait').alt = selected.name + '的人物预览';
  $('#role-title').textContent = ROLE_PRESETS[$('#role-preset').value]?.title ||
    (selected.persona === character.persona ? character.role : '自定义角色');
  $('#qwen-settings').hidden = !component;
  $('#vidu-settings').hidden = component;
  $('#turn-help').textContent = SERVICE.turnDetection[selected.turnDetection]?.description || '';
  const mode = availability?.modes?.[selected.mode];
  $('#connection').textContent = mode?.setupError || (mode?.ready ? '凭据已配置，开始通话时连接 Vidu 托管房间。' : '正在检查连接…');
  if (!call) $('#call-hint').textContent = VIDEO_MODES[selected.mode].label + ' · Vidu 托管 RTC';
}

function saveSettings() {
  try { localStorage.setItem(characterStorageKey, JSON.stringify(settings())); } catch {}
  syncSettings();
}

function loadSettings() {
  $('#portrait').src = character.image;
  $('#portrait').dataset.avatar = avatarId;
  $('#character-summary').textContent = character.description;
  $('#character-name').value = character.name;
  $('#persona').value = character.persona;
  document.title = character.name + ' · SANZO 数字人工作室';
  let saved;
  try {
    const legacy = avatarId === 'ache' && (localStorage.getItem('avatar-character-settings:ache') ||
      localStorage.getItem('avatar-qwen-settings-v1') ||
      localStorage.getItem('avatar-live-settings-v1') || localStorage.getItem('avatar-studio-settings-v1'));
    const current = JSON.parse(localStorage.getItem(characterStorageKey) || 'null');
    saved = current ?? JSON.parse(legacy || 'null');
    if (current?.name) $('#character-name').value = String(current.name).slice(0, 20);
    if (current?.persona) $('#persona').value = String(current.persona).slice(0, 1000);
    if (Object.hasOwn(VIDEO_MODES, saved?.mode)) $('input[name="mode"][value="' + saved.mode + '"]').checked = true;
  } catch {}
  populateSelect('voice', SERVICE.voices, saved?.voice, character.voice);
  populateSelect('turn-detection', SERVICE.turnDetection, saved?.turnDetection, 'smart_turn_v2');
  const requested = new URLSearchParams(location.search).get('role');
  if (Object.hasOwn(ROLE_PRESETS, requested)) setRole(requested);
  const persona = $('#persona').value;
  $('#role-preset').value = persona === character.persona ? 'character' :
    Object.entries(ROLE_PRESETS).find(([, role]) => role.persona === persona)?.[0] || 'custom';
  syncSettings();
}

function setRole(id) {
  const role = id === 'character' ? character : ROLE_PRESETS[id];
  if (!role) return;
  $('#character-name').value = role.name || character.name;
  $('#persona').value = role.persona;
}

function openDrawer(id, button) {
  opener = button || document.activeElement;
  openPanel = $('#' + id);
  openPanel.hidden = false;
  $('#backdrop').hidden = false;
  $('.workspace').inert = true;
  $('[data-open="transcript"]').setAttribute('aria-pressed', String(id === 'transcript'));
  openPanel.querySelector('[data-close]').focus();
}

function closeDrawer() {
  if (!openPanel) return;
  if (openPanel.id === 'settings') saveSettings();
  openPanel.hidden = true;
  openPanel = null;
  $('#backdrop').hidden = true;
  $('.workspace').inert = false;
  $('[data-open="transcript"]').setAttribute('aria-pressed', 'false');
  opener?.focus();
}

function toast(text) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = text;
  $('#toasts').append(node);
  setTimeout(() => node.remove(), 7500);
}

function setStatus(text) { $('#call-status').textContent = text; }

function lockCallSettings(locked) {
  $('.mode-selector').disabled = locked;
  for (const id of ['role-preset', 'character-name', 'persona', 'voice', 'turn-detection']) $('#' + id).disabled = locked;
}

function addMessage(role, text = '') {
  $('.transcript-empty')?.remove();
  const article = document.createElement('article');
  article.className = 'message ' + role;
  const label = document.createElement('div');
  label.className = 'meta';
  label.textContent = role === 'user' ? '你' : settings().name;
  const body = document.createElement('p');
  body.textContent = text;
  article.append(label, body);
  const messages = $('#messages');
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
  return body;
}

function caption(text) {
  captionText = text;
  $('#captions').textContent = text;
  $('#captions').hidden = !captionsEnabled || !text;
}

function send(session, event) {
  if (session?.ws?.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(event));
}

function assertCurrent(session) {
  if (call !== session) throw new DOMException('通话已取消。', 'AbortError');
}

async function getStatus() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  if (!response.ok) throw new Error('本地服务不可用。');
  availability = await response.json();
  syncSettings();
  return availability;
}

async function captureMicrophone(session) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  if (call !== session) {
    stream.getTracks().forEach(track => track.stop());
    assertCurrent(session);
  }
  session.stream = stream;
  await session.context.audioWorklet.addModule('/audio-worklet.js');
  assertCurrent(session);
  const source = session.context.createMediaStreamSource(stream);
  const capture = new AudioWorkletNode(session.context, 'pcm-capture');
  const sink = session.context.createGain();
  sink.gain.value = 0;
  capture.port.onmessage = ({ data }) => {
    if (call !== session || !session.ready || !data.buffer || session.ws?.readyState !== WebSocket.OPEN) return;
    if (session.ws.bufferedAmount > 64000) { fail(session, '麦克风网络拥堵，请重新通话。'); return; }
    session.ws.send(session.muted ? new ArrayBuffer(data.buffer.byteLength) : data.buffer);
  };
  source.connect(capture);
  capture.connect(sink);
  sink.connect(session.context.destination);
}

async function stopCall(statusText = '通话已结束。') {
  const session = call;
  if (!session) return;
  call = null;
  closing = true;
  $('#call').disabled = true;
  setStatus(statusText);
  send(session, { type: 'stop' });
  session.ws?.close();
  session.stream?.getTracks().forEach(track => track.stop());
  void session.context?.close().catch(() => {});
  $('#portrait').hidden = false;
  remoteVideo.hidden = true;
  $('#play-rtc').hidden = true;
  $('#presence').classList.remove('live');
  $('#presence-text').textContent = '人物预览';
  $('#call').classList.remove('ending');
  $('#call span').textContent = '开始视频通话';
  $('#call use').setAttribute('href', '#i-phone');
  $('#mute').setAttribute('aria-pressed', 'false');
  $('#mute').setAttribute('aria-label', '麦克风静音');
  $('#mute use').setAttribute('href', '#i-mic');
  for (const id of activeControls) $('#' + id).disabled = true;
  caption('');
  try { await session.rtc?.close(); } finally {
    closing = false;
    lockCallSettings(false);
    $('#call').disabled = false;
    syncSettings();
  }
}

function fail(session, message) {
  if (call !== session) return;
  void stopCall('连接中断，请重试。');
  toast(message);
}

async function startCall() {
  if (call) { void stopCall(); return; }
  if (closing) return;
  saveSettings();
  const session = call = { settings: settings(), muted: false };
  lockCallSettings(true);
  $('#call span').textContent = '取消连接';
  $('#call use').setAttribute('href', '#i-phone-off');
  $('#call').classList.add('ending');
  setStatus('正在准备视频通话…');
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('请使用支持麦克风的 Chrome 或 Edge。');
    if (session.settings.mode === 'component') {
      session.context = new AudioContext();
      await session.context.resume();
    }
    const status = await getStatus();
    assertCurrent(session);
    const mode = status.modes?.[session.settings.mode];
    if (!mode?.ready) throw new Error(mode?.setupError || '请先配置所选视频链路的凭据。');
    await loadRtcSdk();
    assertCurrent(session);
    if (session.settings.mode === 'component') await captureMicrophone(session);
    assertCurrent(session);
    $('#messages').replaceChildren();
    userMessages.clear();
    $('#duration').textContent = '00:00';
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = session.ws = new WebSocket(scheme + '//' + location.host + '/api/live?token=' + encodeURIComponent(status.csrf));
    ws.onopen = () => send(session, { type: 'start', ...session.settings });
    ws.onmessage = async event => {
      if (call !== session) return;
      try { await onMessage(session, JSON.parse(event.data)); }
      catch (error) { fail(session, error.name === 'NotAllowedError' ? '请在浏览器允许麦克风后重试。' : error.message); }
    };
    ws.onerror = () => fail(session, '本地视频连接失败，请确认后台正在运行。');
    ws.onclose = () => fail(session, '视频通话已断开。');
  } catch (error) {
    fail(session, error.name === 'NotAllowedError' ? '请在浏览器允许麦克风后重试。' : error.message);
  }
}

async function onMessage(session, data) {
  switch (data.type) {
    case 'rtc': {
      if (session.rtc) return;
      setStatus('正在接收数字人画面…');
      remoteVideo.hidden = false;
      session.rtc = new RtcPlayback(remoteVideo, {
        onError: message => fail(session, message),
        onPlayRequired: () => { if (call === session) $('#play-rtc').hidden = false; },
      });
      await session.rtc.join(data, session.settings.mode === 'realtime');
      assertCurrent(session);
      $('#portrait').hidden = true;
      $('#play-rtc').hidden = true;
      send(session, { type: 'rtc_joined' });
      break;
    }
    case 'ready':
      session.ready = true;
      session.began = Date.now();
      $('#presence').classList.add('live');
      $('#presence-text').textContent = '视频通话中';
      $('#call span').textContent = '结束视频通话';
      for (const id of activeControls) $('#' + id).disabled = false;
      setStatus('我在听，你说。');
      $('#call-hint').textContent = '可以直接开口，也可以补充文字';
      break;
    case 'state': setStatus(data.text); break;
    case 'user_start':
      if (!userMessages.has(data.itemId)) userMessages.set(data.itemId, addMessage('user', '正在听…'));
      break;
    case 'user': {
      const item = userMessages.get(data.itemId) || addMessage('user');
      item.textContent = data.text;
      if (data.itemId) userMessages.set(data.itemId, item);
      caption('你：' + data.text);
      break;
    }
    case 'assistant_start':
      session.turn = data.turnId;
      session.assistant = null;
      break;
    case 'delta':
      if (session.turn === data.turnId) {
        session.assistant ||= addMessage('assistant');
        session.assistant.textContent += data.text;
        caption(session.assistant.textContent);
      }
      break;
    case 'vidu_transcript': {
      const key = data.itemId && data.role + ':' + data.itemId;
      const item = (key && userMessages.get(key)) || addMessage(data.role);
      item.textContent = data.text;
      if (key) userMessages.set(key, item);
      caption(data.role === 'user' ? '你：' + data.text : data.text);
      break;
    }
    case 'interrupted':
      session.turn = data.turnId;
      setStatus('我在听，你继续。');
      break;
    case 'turn_error': toast(data.message); break;
    case 'error': fail(session, data.message); break;
  }
}

$$('[data-open]').forEach(button => button.addEventListener('click', () => openDrawer(button.dataset.open, button)));
$$('[data-close]').forEach(button => button.addEventListener('click', closeDrawer));
$('#backdrop').addEventListener('click', closeDrawer);
$('#save-settings').addEventListener('click', closeDrawer);
document.addEventListener('keydown', event => {
  if (!openPanel) return;
  if (event.key === 'Escape') closeDrawer();
  if (event.key !== 'Tab' || !openPanel) return;
  const focusable = [...openPanel.querySelectorAll('button, input, textarea, select, a')]
    .filter(node => !node.disabled && !node.closest('[hidden]'));
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$$('input[name="mode"]').forEach(input => input.addEventListener('change', saveSettings));
$('#role-preset').addEventListener('change', event => { setRole(event.target.value); syncSettings(); });
$('#persona').addEventListener('input', () => { $('#role-preset').value = 'custom'; syncSettings(); });
for (const id of ['character-name', 'voice', 'turn-detection']) $('#' + id).addEventListener('change', syncSettings);
$('#call').addEventListener('click', startCall);
$('#play-rtc').addEventListener('click', () => remoteVideo.play().catch(() => toast('浏览器仍阻止播放，请检查站点播放权限。')));
$('#interrupt').addEventListener('click', () => {
  send(call, { type: 'interrupt' });
  setStatus('我在听，你继续。');
});
$('#mute').addEventListener('click', async () => {
  const session = call;
  if (!session?.ready) return;
  session.muted = !session.muted;
  send(session, { type: 'mute', muted: session.muted });
  $('#mute').setAttribute('aria-pressed', String(session.muted));
  $('#mute').setAttribute('aria-label', session.muted ? '恢复麦克风' : '麦克风静音');
  $('#mute use').setAttribute('href', session.muted ? '#i-mic-off' : '#i-mic');
  $('#call-hint').textContent = session.muted ? '麦克风已静音' : '可以直接开口，也可以补充文字';
  try { await session.rtc?.mute(session.muted); } catch { fail(session, '麦克风状态切换失败。'); }
});
$('#toggle-captions').addEventListener('click', () => {
  captionsEnabled = !captionsEnabled;
  $('#toggle-captions').setAttribute('aria-pressed', String(captionsEnabled));
  $('#toggle-captions').setAttribute('aria-label', captionsEnabled ? '隐藏字幕' : '显示字幕');
  caption(captionText);
});
$('#text-form').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('#text-input').value.trim();
  if (!call?.ready || !text) return;
  send(call, { type: 'text', text });
  $('#text-input').value = '';
});
window.addEventListener('pagehide', () => { void stopCall(); });
setInterval(() => {
  if (!call?.ready) return;
  const seconds = Math.floor((Date.now() - call.began) / 1000);
  $('#duration').textContent = [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}, 1000);

bindTheme();
loadSettings();
void getStatus().catch(error => { $('#connection').textContent = error.message; });
if (new URLSearchParams(location.search).get('settings')) openDrawer('settings');
