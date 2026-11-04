export function redact(value) {
  let text = String(value || '请求失败');
  for (const name of ['TOKEN_PLAN_API_KEY', 'VIDU_API_KEY']) {
    const secret = process.env[name];
    if (secret) text = text.split(secret).join('[已隐藏]');
  }
  return text.replace(/(?:https?|wss?):\/\/[^\s]*[?&](?:Signature|signature|q-signature)=[^\s]*/gi, '[已隐藏签名地址]').slice(0, 500);
}
