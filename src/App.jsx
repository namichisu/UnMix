import { useEffect, useRef, useState } from 'react';
import * as engine from './audio/engine.js';
import * as store from './audio/storage.js';

const STEMS = [['vocals', 'Vocals', '#FF7AA2'], ['drums', 'Drums', '#FFB020'], ['bass', 'Bass', '#4CC9F0'], ['other', 'Other', '#A78BFA']];
const FX = [['reverb', 'Reverb'], ['echo', 'Echo'], ['low', 'EQ low'], ['mid', 'EQ mid'], ['high', 'EQ high'], ['comp', 'Compressor']];
const newFx = () => ({ reverb: 0, echo: 0, low: 50, mid: 50, high: 50, comp: 0 });
const PRESETS = {
  Clean: { reverb: 0, echo: 0, low: 50, mid: 50, high: 50, comp: 0 },
  'Radio voice': { reverb: 5, echo: 0, low: 20, mid: 75, high: 60, comp: 55 },
  'Big hall': { reverb: 70, echo: 15, low: 50, mid: 50, high: 55, comp: 20 },
  'Lo-fi': { reverb: 10, echo: 10, low: 70, mid: 40, high: 15, comp: 35 },
  'Slap echo': { reverb: 15, echo: 55, low: 50, mid: 55, high: 55, comp: 25 },
};
const mkTrack = (id, label, color, clips) => ({ id, label, color, vol: 1, pan: 0, muted: false, solo: false, fx: newFx(), clips });
const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// One draggable piece of audio on a lane
function Clip({ clip, color, dur, selected, onSelect, onMove }) {
  const ref = useRef();
  useEffect(() => {
    const cv = ref.current, w = (cv.width = cv.clientWidth), h = (cv.height = cv.clientHeight), x = cv.getContext('2d');
    const sr = clip.buffer.sampleRate, d = clip.buffer.getChannelData(0), i0 = Math.floor(clip.offset * sr), n = Math.floor(clip.dur * sr);
    const step = Math.max(1, Math.floor(n / (w / 6)));
    x.fillStyle = color;
    for (let i = 0, px = 0; px < w && i < n; i += step, px += 6) {
      let m = 0; for (let j = i; j < i + step && j < n; j += 50) m = Math.max(m, Math.abs(d[i0 + j] || 0));
      const bh = Math.max(2, m * h * 0.9); x.fillRect(px, (h - bh) / 2, 3, bh);
    }
  }, [clip.buffer, clip.offset, clip.dur, dur, color]);
  function down(e) {
    e.stopPropagation(); onSelect();
    const laneW = e.currentTarget.parentElement.getBoundingClientRect().width, x0 = e.clientX, s0 = clip.start, max = Math.max(0, dur - clip.dur);
    const move = ev => onMove(Math.min(max, Math.max(0, s0 + ((ev.clientX - x0) / laneW) * dur)));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  }
  return <canvas ref={ref} className={`clip ${selected ? 'sel' : ''}`} onPointerDown={down} onClick={e => e.stopPropagation()}
    style={{ left: `${(clip.start / dur) * 100}%`, width: `${(clip.dur / dur) * 100}%` }} />;
}

export default function App() {
  const [tracks, setTracks] = useState([]);
  const [stage, setStage] = useState('idle');        // idle | splitting | ready
  const [name, setName] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [sel, setSel] = useState('vocals');
  const [selClip, setSelClip] = useState('');
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [latency, setLatency] = useState(100);
  const [pos, setPos] = useState(0);
  const [hasSaved, setHasSaved] = useState(false);
  const [fileType, setFileType] = useState('wav');
  const [saveMsg, setSaveMsg] = useState('');
  const [calibrating, setCalibrating] = useState(false);
  const [loop, setLoop] = useState(null);       // { a, b } in seconds
  const [loopOn, setLoopOn] = useState(false);
  const hist = useRef({ past: [], future: [], last: null, t: 0, skip: false });
  const [metroOn, setMetroOn] = useState(false);
  const [bpm, setBpm] = useState(100);
  const [beatOff, setBeatOff] = useState(0);
  const [pend, setPend] = useState({ tempo: 100, semis: 0 });   // slider values, not yet applied
  const [busy, setBusy] = useState(null);                       // progress 0..1 while processing
  const [lvl, setLvl] = useState(0);
  const counting = useRef(false);
  const recStart = useRef(0);
  const tr = useRef(tracks); tr.current = tracks;
  const dur = engine.duration(tracks) || 1;
  const applied = tracks.find(t => t.id !== 'voice')?.clips[0]?.tune || { tempo: 100, semis: 0 };

  useEffect(() => { engine.refresh(tracks); }, [tracks]);
  useEffect(() => { store.has().then(setHasSaved).catch(() => {}); }, []);
  useEffect(() => {
    let id; const tick = () => { setPos(engine.position()); setLvl(engine.level()); id = requestAnimationFrame(tick); };
    tick(); return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => { if (playing && pos >= dur) { engine.stop(); setPlaying(false); engine.seek(tr.current, 0); } }, [pos]);
  useEffect(() => { if (playing && !recording && loopOn && loop && pos >= loop.b) engine.play(tr.current, loop.a); }, [pos]);
  useEffect(() => {                              // undo history: quick changes in a row count as one step
    const h = hist.current, now = Date.now();
    if (h.skip) { h.skip = false; h.last = tracks; h.t = now; return; }
    if (h.last && h.last.length && h.last !== tracks) {
      if (now - h.t > 700) { h.past.push(h.last); if (h.past.length > 50) h.past.shift(); }
      h.future = [];
    }
    h.last = tracks; h.t = now;
  }, [tracks]);

  useEffect(() => { engine.setMetro(metroOn, bpm, beatOff); }, [metroOn, bpm, beatOff]);
  const update = (id, patch) => setTracks(ts => ts.map(t => (t.id === id ? { ...t, ...patch } : t)));
  const updateFx = (id, k, v) => setTracks(ts => ts.map(t => (t.id === id ? { ...t, fx: { ...t.fx, [k]: v } } : t)));
  const halt = () => { engine.stop(); setPlaying(false); };   // edits pause playback so clips re-schedule on next play
  const patchClip = (cid, patch) => setTracks(ts => ts.map(t => ({ ...t, clips: t.clips.map(c => (c.id === cid ? { ...c, ...patch } : c)) })));

  function splitClip() {
    const p = engine.position(), c = tr.current.flatMap(t => t.clips).find(x => x.id === selClip);
    if (!c || p <= c.start + 0.05 || p >= c.start + c.dur - 0.05) return;
    const cut = p - c.start, b = { ...c, id: engine.uid(), start: p, offset: c.offset + cut, dur: c.dur - cut };
    halt();
    setTracks(ts => ts.map(t => ({ ...t, clips: t.clips.flatMap(x => (x.id === c.id ? [{ ...x, dur: cut }, b] : [x])) })));
    setSelClip(b.id);
  }
  function deleteClip() {
    if (!selClip) return;
    halt(); setTracks(ts => ts.map(t => ({ ...t, clips: t.clips.filter(c => c.id !== selClip) }))); setSelClip('');
  }

  function detectTempo() {
    const t = tracks.find(x => x.id === 'drums') || tracks[0], c = t && t.clips[0];
    const r = c && engine.detectBpm(c.buffer);
    if (!r) { setError('Could not find a steady beat in this song.'); return; }
    setBpm(r.bpm); setBeatOff(r.offset + c.start - c.offset); setMetroOn(true);
  }
  async function applyTune() {
    if (busy !== null) return;
    setBusy(0); halt(); setError('');
    const old = applied, f = old.tempo / pend.tempo, now = { ...pend };
    try {
      const origs = [...new Set(tr.current.filter(t => t.id !== 'voice').flatMap(t => t.clips.map(c => c.orig)))], map = new Map();
      for (let i = 0; i < origs.length; i++) {
        map.set(origs[i], now.tempo === 100 && now.semis === 0 ? origs[i] : await engine.stretch(origs[i], now.tempo / 100, now.semis, p => setBusy((i + p) / origs.length)));
      }
      setTracks(ts => ts.map(t => (t.id === 'voice' ? t : { ...t, clips: t.clips.map(c => ({ ...c, buffer: map.get(c.orig), start: c.start * f, offset: c.offset * f, dur: c.dur * f, tune: now })) })));
      setBpm(b => Math.round(b * (now.tempo / old.tempo) * 10) / 10); setBeatOff(o => o * f); setLoop(l => l && { a: l.a * f, b: l.b * f });
    } catch { setError('Could not change the speed or pitch.'); }
    setBusy(null);
  }
  function undo() { const h = hist.current; if (!h.past.length) return; halt(); h.future.push(tr.current); h.skip = true; setTracks(h.past.pop()); }
  function redo() { const h = hist.current; if (!h.future.length) return; halt(); h.past.push(tr.current); h.skip = true; setTracks(h.future.pop()); }
  function loopIn() { const p = engine.position(); setLoop(l => ({ a: p, b: l && l.b > p ? l.b : Math.min(dur, p + 4) })); setLoopOn(true); }
  function loopOut() { const p = engine.position(); setLoop(l => ({ a: l && l.a < p ? l.a : Math.max(0, p - 4), b: p })); setLoopOn(true); }

  async function load(file) {
    if (!file) return;
    setError(''); setName(file.name); setProgress(0); setStage('splitting');
    try {
      const buf = await engine.decodeFile(file);
      const left = buf.getChannelData(0).slice(), right = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice();
      const w = new Worker(new URL('./audio/splitter.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = ({ data }) => {
        if (data.type === 'progress') setProgress(data.value);
        if (data.type === 'error') { setError(data.message); setStage('idle'); w.terminate(); }
        if (data.type === 'done') {
          setTracks(STEMS.map(([id, label, color]) => mkTrack(id, label, color, [engine.clipFrom(engine.bufferFromChannels(...data.stems[id]))])));
          setSel('vocals'); setStage('ready'); w.terminate();
        }
      };
      w.postMessage({ left, right }, [left.buffer, right.buffer]);
    } catch (e) { setError('Could not read that file. Try an MP3 or WAV.'); setStage('idle'); }
  }
  async function openSaved() {
    try {
      const p = await store.load();
      if (!p) { setError('That project was saved by an older version and can’t be opened.'); return; }
      setName(p.name); setTracks(p.tracks); setSel(p.tracks[0].id); setStage('ready');
    } catch { setError('Could not open the saved project.'); }
  }
  async function saveProject() {
    setSaveMsg('Saving…');
    try { await store.save(name, tracks); setSaveMsg('Saved'); } catch { setSaveMsg('Could not save (storage full?)'); }
    setTimeout(() => setSaveMsg(''), 2500);
  }
  async function calibrate() {
    setCalibrating(true); setError('');
    try {
      const ms = await engine.calibrate();
      if (ms == null) setError("Didn't hear the beep. Turn the volume up and try again."); else setLatency(Math.min(500, ms));
    } catch { setError('Microphone access was blocked.'); }
    setCalibrating(false);
  }
  const togglePlay = () => { if (playing) halt(); else { engine.play(tracks); setPlaying(true); } };
  async function toggleRec() {
    if (!recording) {
      if (counting.current) return;
      if (metroOn) { counting.current = true; await engine.countIn(bpm); counting.current = false; }
      try { await engine.startRecording(); } catch { setError('Microphone access was blocked.'); return; }
      recStart.current = engine.position(); engine.play(tracks.filter(t => t.id !== 'voice'), recStart.current); setPlaying(true); setRecording(true);
    } else {
      halt(); setRecording(false);
      const clip = { ...engine.clipFrom(await engine.stopRecording(latency)), start: recStart.current };
      setTracks(ts => (ts.some(t => t.id === 'voice') ? ts.map(t => (t.id === 'voice' ? { ...t, clips: [...t.clips, clip] } : t)) : [...ts, mkTrack('voice', 'My voice', '#FF5A36', [clip])]));
      setSel('voice'); setSelClip(clip.id);
    }
  }
  async function doExport() {
    const blob = fileType === 'mp3' ? await engine.exportMp3(tracks) : await engine.exportWav(tracks);
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `unmix-mix.${fileType}` }).click();
  }

  const act = useRef({});
  act.current = { metro: () => setMetroOn(v => !v), togglePlay, toggleRec, splitClip, deleteClip, undo, redo, loopIn, loopOut, loopToggle: () => setLoopOn(v => !v), mute: () => { const t = tr.current.find(x => x.id === sel); if (t) update(t.id, { muted: !t.muted }); } };
  useEffect(() => {
    const onKey = e => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || !tr.current.length) return;
      if (e.metaKey || e.ctrlKey) {
        const k = e.key.toLowerCase();
        if (k === 'z') { e.preventDefault(); if (e.shiftKey) act.current.redo(); else act.current.undo(); }
        if (k === 'y') { e.preventDefault(); act.current.redo(); }
        return;
      }
      if (e.target.tagName === 'BUTTON') return;
      if (e.code === 'Space') { e.preventDefault(); act.current.togglePlay(); }
      if (e.key === 'r') act.current.toggleRec();
      if (e.key === 'm') act.current.mute();
      if (e.key === 's') act.current.splitClip();
      if (e.key === '[') act.current.loopIn();
      if (e.key === ']') act.current.loopOut();
      if (e.key === 'l') act.current.loopToggle();
      if (e.key === 'c') act.current.metro();
      if (e.key === 'Delete' || e.key === 'Backspace') act.current.deleteClip();
    };
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey);
  }, []);

  if (stage !== 'ready') return (
    <main className="hero">
      <span className="logo">unmix<b>.</b></span>
      <h1>Pull any song apart into its pieces</h1>
      {stage === 'splitting' ? (
        <section className="card">
          <div className="row"><strong>{name}</strong><span className="muted">{progress ? `Splitting… ${Math.round(progress * 100)}%` : 'Loading model (first time takes a while)…'}</span></div>
          <div className="bar"><div style={{ width: `${progress * 100}%` }} /></div>
          <p className="muted small">Runs on your device. Your song is never uploaded.</p>
        </section>
      ) : (
        <label className="drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); load(e.dataTransfer.files[0]); }}>
          Drop a song here or browse files
          <input type="file" accept="audio/*" hidden onChange={e => load(e.target.files[0])} />
        </label>
      )}
      {stage === 'idle' && window.matchMedia('(pointer: coarse)').matches && <p className="muted small">Splitting can take several minutes on a phone. A laptop is much faster.</p>}
      {hasSaved && stage === 'idle' && <button className="ghost" onClick={openSaved}>Continue last project</button>}
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );

  const cur = tracks.find(t => t.id === sel) || tracks[0];
  return (
    <div className="app">
      <header><div><span className="logo">unmix<b>.</b></span><span className="muted">{name}</span></div>
        <div className="actions"><button className="ghost" onClick={undo}>Undo</button><button className="ghost" onClick={redo}>Redo</button><span className="muted small" role="status">{saveMsg}</span><button className="ghost" onClick={saveProject}>Save project</button>
          <select aria-label="Export format" value={fileType} onChange={e => setFileType(e.target.value)}><option value="wav">WAV</option><option value="mp3">MP3</option></select>
          <button className="primary" onClick={doExport}>Export mix</button></div></header>
      <div className="body">
        <section className="tracks">
          {tracks.map(t => (
            <div key={t.id} className={`track ${sel === t.id ? 'sel' : ''}`} onClick={() => setSel(t.id)}>
              <div className="head"><div className="name"><i style={{ background: t.color }} />{t.label}</div>
                <div className="ms">
                  <button aria-pressed={t.muted} className={t.muted ? 'on' : ''} onClick={() => update(t.id, { muted: !t.muted })}>M</button>
                  <button aria-pressed={t.solo} className={t.solo ? 'on' : ''} style={t.solo ? { background: t.color } : null} onClick={() => update(t.id, { solo: !t.solo })}>S</button>
                </div></div>
              <div className="lane" onClick={e => { const r = e.currentTarget.getBoundingClientRect(), s = ((e.clientX - r.left) / r.width) * dur; engine.seek(tracks, s); setPos(s); }}>
                {t.clips.map(c => <Clip key={c.id} clip={c} color={t.color} dur={dur} selected={selClip === c.id}
                  onSelect={() => { setSelClip(c.id); setSel(t.id); }}
                  onMove={s => { if (engine.isPlaying()) halt(); patchClip(c.id, { start: s }); }} />)}
                {loop && <div className={`loop ${loopOn ? 'on' : ''}`} style={{ left: `${(loop.a / dur) * 100}%`, width: `${((loop.b - loop.a) / dur) * 100}%` }} />}
                <div className="playhead" style={{ left: `${(pos / dur) * 100}%` }} />
              </div>
            </div>
          ))}
          {!tracks.some(t => t.id === 'voice') && <div className="track armed"><div className="head"><div className="name"><i style={{ background: '#FF5A36' }} />My voice</div></div><p className="muted lane-msg">Press record to sing along with the stems</p></div>}
        </section>
        <aside className="fx">
          <h2>Effects · {cur.label}</h2>
          <div className="field"><label htmlFor="pre">Preset</label>
            <select id="pre" value="" onChange={e => e.target.value && update(cur.id, { fx: { ...PRESETS[e.target.value] } })}>
              <option value="">Choose a preset…</option>{Object.keys(PRESETS).map(k => <option key={k}>{k}</option>)}</select></div>
          <div className="field"><label htmlFor="vol">Volume</label><input id="vol" type="range" min="0" max="150" value={cur.vol * 100} onChange={e => update(cur.id, { vol: e.target.value / 100 })} /></div>
          <div className="field"><label htmlFor="pan">Pan</label><input id="pan" type="range" min="-100" max="100" value={(cur.pan || 0) * 100} onChange={e => update(cur.id, { pan: e.target.value / 100 })} /></div>
          {FX.map(([k, l]) => <div className="field" key={k}><label htmlFor={k}>{l}</label><input id={k} type="range" min="0" max="100" value={cur.fx[k]} onChange={e => updateFx(cur.id, k, +e.target.value)} /></div>)}
          <div className="field"><label htmlFor="spd">Speed: {pend.tempo}%</label><input id="spd" type="range" min="50" max="150" value={pend.tempo} onChange={e => setPend(p => ({ ...p, tempo: +e.target.value }))} /></div>
          <div className="field"><label htmlFor="pit">Pitch: {pend.semis > 0 ? '+' : ''}{pend.semis} semitones</label><input id="pit" type="range" min="-6" max="6" value={pend.semis} onChange={e => setPend(p => ({ ...p, semis: +e.target.value }))} /></div>
          <button className="ghost" onClick={applyTune} disabled={busy !== null || (pend.tempo === applied.tempo && pend.semis === applied.semis)}>{busy !== null ? `Processing ${Math.round(busy * 100)}%…` : 'Apply speed and pitch'}</button>
          <p className="muted small">Changes the stems only. Do this before recording your voice.</p>
          <div className="field"><label htmlFor="lat">Voice latency fix: {latency} ms</label><input id="lat" type="range" min="0" max="500" value={latency} onChange={e => setLatency(+e.target.value)} /></div>
          <button className="ghost" onClick={calibrate} disabled={calibrating}>{calibrating ? 'Listening…' : 'Auto-detect latency'}</button>
          <p className="muted small">Turn the speakers up, stay quiet, and keep the mic near them.</p>
        </aside>
      </div>
      <footer>
        <button className={`rec ${recording ? 'live' : ''}`} aria-label={recording ? 'Stop recording' : 'Record'} onClick={toggleRec}><span /></button>
        <button className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">{playing ? <path d="M6 4h4v16H6zM14 4h4v16h-4z" /> : <path d="M7 4l13 8-13 8z" />}</svg></button>
        <span className="time">{fmt(pos)} / {fmt(dur)}</span>
        <button className="ghost" onClick={splitClip} disabled={!selClip}>Split at playhead</button>
        <button className="ghost" onClick={deleteClip} disabled={!selClip}>Delete clip</button>
        <button className="ghost" onClick={loopIn}>Loop start</button><button className="ghost" onClick={loopOut}>Loop end</button>
        <button className="ghost" aria-pressed={loopOn} onClick={() => setLoopOn(v => !v)}>{loopOn ? 'Loop on' : 'Loop off'}</button>
        <button className="ghost" aria-pressed={metroOn} onClick={() => setMetroOn(v => !v)}>{metroOn ? 'Click on' : 'Click off'}</button>
        <input className="bpm" type="number" min="40" max="240" step="0.1" aria-label="Tempo in BPM" value={bpm} onChange={e => setBpm(Math.min(240, Math.max(40, +e.target.value || 100)))} />
        <button className="ghost" onClick={detectTempo}>Detect tempo</button>
        <div className="meter" role="img" aria-label="Output level"><div style={{ width: `${Math.min(1, lvl) * 100}%`, background: lvl > 0.98 ? '#FF5A36' : '#4CC9F0' }} /></div>
        <span className="muted small">Space play · R record · M mute · S split · Del delete · [ ] loop · C click · Ctrl+Z undo</span>
      </footer>
      {error && <p className="error toast" role="alert">{error}</p>}
    </div>
  );
}
