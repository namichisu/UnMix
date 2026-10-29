// Plain-JS audio engine. Knows nothing about React.
import { Mp3Encoder } from '@breezystack/lamejs';
import { SoundTouch, SimpleFilter, WebAudioBufferSource } from 'soundtouchjs';
export const SR = 44100;
let ctx, master, analyser, mic, recorder, chunks = [];
let metro = { on: false, bpm: 100, off: 0 }, metroTimer = 0, nextBeat = 0;
const chains = new Map();           // track id -> live audio nodes
let live = [], playing = false, startedAt = 0, offset = 0;

export const getCtx = () => {
  if (!ctx) { ctx = new AudioContext({ sampleRate: SR }); master = ctx.createGain(); master.connect(ctx.destination); analyser = ctx.createAnalyser(); master.connect(analyser); }
  return ctx;
};
export async function decodeFile(file) {
  return getCtx().decodeAudioData(await file.arrayBuffer());
}
export function bufferFromChannels(l, r) {
  const b = getCtx().createBuffer(2, l.length, SR);
  b.copyToChannel(l, 0); b.copyToChannel(r, 1); return b;
}
export function bufferFromArrays(chs) {
  const b = getCtx().createBuffer(chs.length, chs[0].length, SR);
  chs.forEach((c, i) => b.copyToChannel(c, i)); return b;
}
export const uid = () => Math.random().toString(36).slice(2, 9);
export const clipFrom = b => ({ id: uid(), buffer: b, orig: b, start: 0, offset: 0, dur: b.duration });
export const duration = tracks => Math.max(0, ...tracks.flatMap(t => t.clips.map(c => c.start + c.dur)));

const audible = (t, tracks) => !t.muted && (!tracks.some(x => x.solo) || t.solo);

function impulse(c) {                 // simple generated room reverb
  const len = c.sampleRate * 1.8, b = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
  return b;
}
function makeChain(c, dest) {
  const lo = c.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 200;
  const mi = c.createBiquadFilter(); mi.type = 'peaking'; mi.frequency.value = 1500;
  const hi = c.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 5000;
  const out = c.createGain(), pan = c.createStereoPanner(), comp = c.createDynamicsCompressor();
  const dly = c.createDelay(1), fb = c.createGain(), echo = c.createGain();
  const conv = c.createConvolver(), rev = c.createGain();
  dly.delayTime.value = 0.3; fb.gain.value = 0.35; conv.buffer = impulse(c);
  lo.connect(mi); mi.connect(hi); hi.connect(out);
  hi.connect(dly); dly.connect(fb); fb.connect(dly); dly.connect(echo); echo.connect(out);
  hi.connect(conv); conv.connect(rev); rev.connect(out);
  out.connect(pan); pan.connect(comp); comp.connect(dest);
  return { input: lo, lo, mi, hi, out, pan, comp, echo, rev };
}
function applyParams(n, t, tracks) {
  const f = t.fx;
  n.out.gain.value = audible(t, tracks) ? t.vol : 0;
  n.pan.value = t.pan || 0;
  n.rev.gain.value = (f.reverb / 100) * 0.8;
  n.echo.gain.value = (f.echo / 100) * 0.6;
  n.lo.gain.value = ((f.low - 50) / 50) * 12;
  n.mi.gain.value = ((f.mid - 50) / 50) * 12;
  n.hi.gain.value = ((f.high - 50) / 50) * 12;
  n.comp.threshold.value = -(f.comp / 100) * 40;
}
export function refresh(tracks) {
  for (const t of tracks) { const n = chains.get(t.id); if (n) applyParams(n, t, tracks); }
}
export const position = () => (playing ? ctx.currentTime - startedAt : offset);
export const isPlaying = () => playing;

export function play(tracks, from) {
  const c = getCtx(); c.resume(); stop();
  offset = from ?? offset; startedAt = c.currentTime - offset; playing = true;
  for (const t of tracks) {
    if (!chains.has(t.id)) chains.set(t.id, makeChain(c, master));
    const n = chains.get(t.id); applyParams(n, t, tracks);
    for (const k of t.clips) {
      if (offset >= k.start + k.dur) continue;
      const s = c.createBufferSource(); s.buffer = k.buffer; s.connect(n.input);
      if (offset >= k.start) s.start(0, k.offset + (offset - k.start), k.dur - (offset - k.start));
      else s.start(c.currentTime + (k.start - offset), k.offset, k.dur);
      live.push(s);
    }
  }
  startMetro();
}
export function stop() {
  stopMetro();
  if (playing) offset = ctx.currentTime - startedAt;
  live.forEach(s => { try { s.stop(); } catch {} }); live = []; playing = false;
}
export function seek(tracks, t) { const was = playing; stop(); offset = t; if (was) play(tracks, t); }

// ---- Recording (always from the start of the song in v1) ----
export async function startRecording() {
  mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  recorder = new MediaRecorder(mic); chunks = [];
  recorder.ondataavailable = e => chunks.push(e.data);
  recorder.start();
}
export function stopRecording(latencyMs) {
  return new Promise(res => {
    recorder.onstop = async () => {
      mic.getTracks().forEach(t => t.stop());
      const raw = await getCtx().decodeAudioData(await new Blob(chunks).arrayBuffer());
      const skip = Math.round((latencyMs / 1000) * SR), len = Math.max(1, raw.length - skip);
      const b = getCtx().createBuffer(1, len, SR);
      b.copyToChannel(raw.getChannelData(0).subarray(skip), 0); res(b);
    };
    recorder.stop();
  });
}

// ---- Export: render the whole mix offline, then write a WAV ----
async function renderMix(tracks) {
  const dur = duration(tracks), oc = new OfflineAudioContext(2, Math.ceil(dur * SR), SR);
  for (const t of tracks) {
    const n = makeChain(oc, oc.destination); applyParams(n, t, tracks);
    for (const k of t.clips) { const s = oc.createBufferSource(); s.buffer = k.buffer; s.connect(n.input); s.start(k.start, k.offset, k.dur); }
  }
  return oc.startRendering();
}
export const exportWav = async t => encodeWav(await renderMix(t));
export async function exportMp3(tracks) {
  const b = await renderMix(tracks), enc = new Mp3Encoder(2, SR, 192);
  const i16 = f => Int16Array.from(f, v => Math.max(-1, Math.min(1, v)) * 32767);
  const L = i16(b.getChannelData(0)), R = i16(b.getChannelData(b.numberOfChannels > 1 ? 1 : 0)), parts = [];
  for (let i = 0; i < L.length; i += 1152) { const m = enc.encodeBuffer(L.subarray(i, i + 1152), R.subarray(i, i + 1152)); if (m.length) parts.push(m); }
  parts.push(enc.flush()); return new Blob(parts, { type: 'audio/mpeg' });
}
function encodeWav(buf) {
  const ch = buf.numberOfChannels, len = buf.length, out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, len * ch * 2, true);
  const data = [...Array(ch).keys()].map(i => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, data[c][i])); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
  }
  return new Blob([out], { type: 'audio/wav' });
}

// ---- Auto latency: play a beep, record it with the mic, measure the delay ----
export async function calibrate() {
  const c = getCtx(); await c.resume();
  const m = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const r = new MediaRecorder(m), parts = [];
  r.ondataavailable = e => parts.push(e.data);
  const done = new Promise(res => (r.onstop = res));
  r.start();
  const o = c.createOscillator(), g = c.createGain(), at = c.currentTime + 0.5;
  o.frequency.value = 1000; g.gain.value = 0.8; o.connect(g); g.connect(c.destination); o.start(at); o.stop(at + 0.05);
  setTimeout(() => r.stop(), 1600); await done; m.getTracks().forEach(t => t.stop());
  const d = (await c.decodeAudioData(await new Blob(parts).arrayBuffer())).getChannelData(0);
  let peak = 0; for (const v of d) peak = Math.max(peak, Math.abs(v));
  if (peak < 0.02) return null;
  const i = d.findIndex(v => Math.abs(v) > peak * 0.4);
  return Math.max(0, Math.round((i / SR - 0.5) * 1000));
}

// ---- Output level (for the meter) ----
export function level() {
  if (!analyser) return 0;
  const d = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(d);
  let m = 0; for (const v of d) m = Math.max(m, Math.abs(v)); return m;
}

// ---- Metronome: clicks scheduled a little ahead, locked to the song position (never exported) ----
function click(at, accent) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = accent ? 1500 : 1000;
  g.gain.setValueAtTime(0.4, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
  o.connect(g); g.connect(master); o.start(at); o.stop(at + 0.06);
}
function stopMetro() { clearInterval(metroTimer); }
function startMetro() {
  stopMetro();
  if (!metro.on || !playing) return;
  nextBeat = Math.max(0, Math.ceil(((ctx.currentTime - startedAt - metro.off) * metro.bpm) / 60 - 1e-6));
  metroTimer = setInterval(() => {
    const spb = 60 / metro.bpm;
    while (startedAt + metro.off + nextBeat * spb < ctx.currentTime + 0.1) {
      const at = startedAt + metro.off + nextBeat * spb;
      if (at >= ctx.currentTime) click(at, nextBeat % 4 === 0);
      nextBeat++;
    }
  }, 25);
}
export function setMetro(on, bpm, off = 0) { metro = { on, bpm, off }; if (playing) startMetro(); else stopMetro(); }
export function countIn(bpm, beats = 4) {       // clicks before recording starts
  const c = getCtx(), spb = 60 / bpm, t0 = c.currentTime + 0.1; c.resume();
  for (let i = 0; i < beats; i++) click(t0 + i * spb, i === 0);
  return new Promise(r => setTimeout(r, (0.1 + beats * spb) * 1000));
}

// ---- Tempo detection: find the repeating pulse in the drum stem ----
export function detectBpm(buffer) {
  const d = buffer.getChannelData(0), hop = 512, n = Math.floor(d.length / hop), e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < hop; j += 4) s += Math.abs(d[i * hop + j]); e[i] = s; }
  const on = new Float32Array(n); for (let i = 1; i < n; i++) on[i] = Math.max(0, e[i] - e[i - 1]);
  const hs = hop / buffer.sampleRate; let best = 0, bestLag = 0;
  for (let lag = Math.round(60 / 180 / hs); lag <= Math.round(60 / 60 / hs); lag++) {
    let s = 0; for (let i = 0; i + lag < n; i++) s += on[i] * on[i + lag];
    s /= n - lag;
    if (s > best) { best = s; bestLag = lag; }
  }
  if (!bestLag) return null;
  let bpm = 60 / (bestLag * hs); while (bpm < 70) bpm *= 2; while (bpm > 160) bpm /= 2;
  const period = 60 / bpm / hs; let bo = 0, bs = 0;
  for (let ph = 0; ph < period; ph++) { let s = 0; for (let k = ph; k < n; k += period) s += on[Math.round(k)]; if (s > bs) { bs = s; bo = ph; } }
  return { bpm: Math.round(bpm * 10) / 10, offset: bo * hs };
}

// ---- Speed and pitch: re-render a buffer with SoundTouch (tempo 1 = normal, semis = pitch steps) ----
export async function stretch(buf, tempo, semis, onProgress) {
  const st = new SoundTouch(buf.sampleRate); st.tempo = tempo; st.pitch = Math.pow(2, semis / 12);
  const filter = new SimpleFilter(new WebAudioBufferSource(buf), st);
  const total = Math.ceil(buf.length / tempo), out = new Float32Array(total * 2 + 16384), chunk = new Float32Array(4096 * 2);
  let n = 0, k = 0;
  while (n < total) {
    const got = filter.extract(chunk, 4096); if (!got) break;
    out.set(chunk.subarray(0, got * 2), n * 2); n += got;
    if (++k % 30 === 0) { onProgress(Math.min(1, n / total)); await new Promise(r => setTimeout(r)); }   // let the screen update
  }
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = out[i * 2]; R[i] = out[i * 2 + 1]; }
  return bufferFromChannels(L, R);
}
