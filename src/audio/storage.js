// Saves the project in the browser (IndexedDB). Audio is stored as 16-bit to keep it small.
import { bufferFromArrays } from './engine.js';
const S = 'projects';
const open = () => new Promise((res, rej) => {
  const r = indexedDB.open('unmix', 1);
  r.onupgradeneeded = () => r.result.createObjectStore(S);
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = async (mode, fn) => {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(S, mode), rq = fn(t.objectStore(S));
    t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error);
  });
};
const toI16 = f => Int16Array.from(f, v => Math.max(-1, Math.min(1, v)) * 32767);
const toF32 = i => Float32Array.from(i, v => v / 32767);
export const has = async () => (await tx('readonly', s => s.count())) > 0;
export const save = (name, tracks) => {
  const bufs = [], idx = new Map();   // clips from one split share one stored buffer
  const ref = b => {
    if (!idx.has(b)) { idx.set(b, bufs.length); bufs.push([...Array(b.numberOfChannels).keys()].map(c => toI16(b.getChannelData(c)))); }
    return idx.get(b);
  };
  const ts = tracks.map(({ id, label, color, vol, pan, muted, solo, fx, clips }) => ({
    id, label, color, vol, pan, muted, solo, fx,
    clips: clips.map(({ id, buffer, orig, tune, start, offset, dur }) => ({ id, buf: ref(buffer), orig: ref(orig || buffer), tune, start, offset, dur })),
  }));
  return tx('readwrite', s => s.put({ name, v: 3, buffers: bufs, tracks: ts }, 'last'));
};
export const load = async () => {
  const p = await tx('readonly', s => s.get('last'));
  if (!p || p.v !== 3) return null;
  const bufs = p.buffers.map(chs => bufferFromArrays(chs.map(toF32)));
  return { name: p.name, tracks: p.tracks.map(t => ({ ...t, clips: t.clips.map(({ buf, orig, ...c }) => ({ ...c, buffer: bufs[buf], orig: bufs[orig ?? buf] })) })) };
};
