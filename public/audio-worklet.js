class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; this.phase = 0; this.sum = 0; this.count = 0; this.levelSum = 0; this.levelCount = 0; this.port.onmessage = ({data}) => { if (data.type === 'flush') { this.emit(); this.port.postMessage({flushed:true}); } }; }
  emit() {
    if (!this.samples.length) return;
    const length = this.samples.length; const buffer = new ArrayBuffer(length * 2); const view = new DataView(buffer); let square = 0;
    for (let j = 0; j < length; j++) { const value = Math.max(-1, Math.min(1, this.samples[j])); square += value * value; view.setInt16(j * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true); }
    this.port.postMessage({ buffer, rms: Math.sqrt(square / length) }, [buffer]); this.samples = [];
  }
  process(inputs) {
    const input = inputs[0]?.[0]; if (!input) return true;
    const step = sampleRate / 16000;
    for (let i = 0; i < input.length; i++) {
      this.levelSum += input[i] * input[i]; this.levelCount++;
      if (this.levelCount >= sampleRate * .04) { this.port.postMessage({ rms: Math.sqrt(this.levelSum / this.levelCount) }); this.levelSum = 0; this.levelCount = 0; }
      this.sum += input[i]; this.count++; this.phase++;
      if (this.phase >= step) { this.phase -= step; this.samples.push(this.sum / this.count); this.sum = 0; this.count = 0; }
      if (this.samples.length === 640) {
        this.emit();
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
