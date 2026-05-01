import { useState, useEffect, useRef, useCallback } from "react";

// ── Mobile breakpoint hook ───────────────────────────────────────
function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = e => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return mobile;
}

// ── Design tokens ────────────────────────────────────────────────
const C = {
  bg:       '#F5F0E6',
  darker:   '#EDE6D8',
  grid:     '#DCD5C5',
  border:   '#C5BCA8',
  A:        '#B8860B',
  B:        '#8B7355',
  text:     '#4A3B28',
  dim:      '#B0A590',
  mid:      '#7B6B4A',
  err:      '#C0392B',
};

// ── WebAudio support guard ───────────────────────────────────────
const AudioCtx = window.AudioContext || window.webkitAudioContext || null;

// ── Audio file validation ────────────────────────────────────────
const AUDIO_EXTS = /\.(mp3|wav|ogg|flac|aac|m4a|opus|weba|webm|aiff|aif)$/i;
function isAudioFile(file) {
  if (!file) return false;
  if (file.type.startsWith('audio/')) return true;
  if (file.type === 'video/ogg' || file.type === 'video/webm') return true;
  return AUDIO_EXTS.test(file.name); // fallback for browsers that omit MIME
}

// ── BPM estimator — capped at 30s to avoid main-thread freeze ───
function estimateBPM(buffer) {
  try {
    const sr         = buffer.sampleRate;
    const maxSamples = Math.min(buffer.length, sr * 30);
    const data       = buffer.getChannelData(0).slice(0, maxSamples);
    const winSamples = Math.max(1, Math.floor(sr * 0.01));
    const energies   = [];

    for (let i = 0; i + winSamples < data.length; i += winSamples) {
      let e = 0;
      for (let j = 0; j < winSamples; j++) e += data[i + j] ** 2;
      energies.push(e / winSamples);
    }

    if (!energies.length) return null;
    const mean = energies.reduce((a, b) => a + b, 0) / energies.length;
    if (!mean || !isFinite(mean)) return null;

    const thresh = mean * 1.7;
    const peaks  = [];
    for (let i = 2; i < energies.length - 2; i++) {
      if (
        energies[i] > thresh &&
        energies[i] >= energies[i - 1] &&
        energies[i] >= energies[i + 1] &&
        (!peaks.length || i - peaks[peaks.length - 1] > 7)
      ) peaks.push(i);
    }

    if (peaks.length < 4) return null;
    const intervals = [];
    for (let i = 1; i < Math.min(peaks.length, 24); i++)
      intervals.push(peaks[i] - peaks[i - 1]);

    const avgI = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (!avgI || !isFinite(avgI)) return null;

    const bpm = Math.round(60000 / (avgI * 10));
    return bpm > 55 && bpm < 210 ? bpm : null;
  } catch {
    return null;
  }
}

// ── DPR-aware canvas resize (crisp on retina) ────────────────────
function resizeCanvas(canvas) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr  = window.devicePixelRatio || 1;
  const w = Math.round(rect.width  * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
  }
}

// ── Waveform renderer ────────────────────────────────────────────
function drawScope(canvas, analyser, color, playing) {
  if (!canvas) return;
  resizeCanvas(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;

  ctx.fillStyle = C.darker;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = C.grid;
  ctx.lineWidth   = 1;
  for (let i = 1; i < 4; i++) {
    const y = (H * i) / 4;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();

  if (!playing || !analyser) {
    ctx.strokeStyle = color + '28';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    return;
  }

  const bufLen = analyser.frequencyBinCount;
  const data   = new Uint8Array(bufLen);
  analyser.getByteTimeDomainData(data);
  const step = W / bufLen;

  ctx.beginPath(); ctx.lineWidth = 5; ctx.strokeStyle = color + '25';
  for (let i = 0; i < bufLen; i++) {
    const y = H / 2 + (data[i] / 128 - 1) * H * 0.44;
    i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * step, y);
  }
  ctx.stroke();

  ctx.beginPath(); ctx.lineWidth = 1.5; ctx.strokeStyle = color;
  for (let i = 0; i < bufLen; i++) {
    const y = H / 2 + (data[i] / 128 - 1) * H * 0.44;
    i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * step, y);
  }
  ctx.stroke();
}

// ── VU bar renderer ──────────────────────────────────────────────
function drawVU(canvas, analyser, color, playing) {
  if (!canvas) return;
  resizeCanvas(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;

  ctx.fillStyle = C.darker;
  ctx.fillRect(0, 0, W, H);
  if (!analyser || !playing) return;

  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);

  const bars = 32;
  const barW = W / bars - 1;
  for (let i = 0; i < bars; i++) {
    const idx   = Math.floor((i / bars) * data.length * 0.7);
    const val   = data[idx] / 255;
    const barH  = val * H;
    const alpha = 0.4 + val * 0.6;
    ctx.fillStyle = color + Math.floor(alpha * 255).toString(16).padStart(2, '0');
    ctx.fillRect(i * (barW + 1), H - barH, barW, barH);
  }
}

// ── Vertical EQ slider ───────────────────────────────────────────
function VSlider({ value, min, max, step, onChange, color, label, display, height = 72 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
      <div style={{ fontSize: '8px', color: C.dim, letterSpacing: '2px' }}>{label}</div>
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'visible' }}>
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(+e.target.value)}
          style={{ transform: 'rotate(-90deg)', width: `${height}px`, accentColor: color, cursor: 'ns-resize' }}
        />
      </div>
      <div style={{ fontSize: '9px', color, minWidth: '28px', textAlign: 'center' }}>{display}</div>
    </div>
  );
}

// ── Deck component ───────────────────────────────────────────────
function Deck({ id, d, color, scopeRef, vuRef, onLoad, onPlay, onEQ, onPitch, onDrop, onInit }) {
  const fileRef = useRef(null);
  const [hovBtn,  setHovBtn]  = useState(false);
  const [dragging, setDragging] = useState(false);

  return (
    <div style={{
      border: `1px solid ${
        d.error   ? C.err + '80' :
        dragging  ? color + 'AA' :
        d.playing ? color + '60' : C.border
      }`,
      padding: '16px', position: 'relative',
      transition: 'border-color 0.3s', background: C.bg,
    }}>

      {/* Deck label */}
      <div style={{ position: 'absolute', top: '-8px', left: '10px', background: C.bg, padding: '0 8px', color, letterSpacing: '5px', fontSize: '9px' }}>
        DECK {id}
      </div>

      {/* Decoding badge */}
      {d.loading && (
        <div style={{ position: 'absolute', top: '-8px', right: '10px', background: C.bg, padding: '0 8px', color: C.mid, letterSpacing: '3px', fontSize: '8px' }}>
          DECODING…
        </div>
      )}

      {/* Track name / error */}
      <div style={{
        color: d.error ? C.err : d.name ? color : C.dim,
        marginBottom: '10px', overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', letterSpacing: '1px', fontSize: '10px', cursor: 'pointer',
      }} onClick={() => { onInit(); fileRef.current?.click(); }}>
        {d.error ? `ERR: ${d.error}` : d.name ? d.name : '── DROP AUDIO OR CLICK ──'}
      </div>

      {/* Oscilloscope — drag target */}
      <canvas ref={scopeRef}
        style={{
          width: '100%', height: '88px', display: 'block', marginBottom: '8px',
          cursor: 'pointer', boxSizing: 'border-box',
          border: `1px solid ${dragging ? color + '80' : C.border}`,
          transition: 'border-color 0.2s',
        }}
        onDrop={e => { setDragging(false); onDrop(e); }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onClick={() => { onInit(); fileRef.current?.click(); }}
        title="Drop audio file or click to browse"
      />

      {/* Spectrum */}
      <canvas ref={vuRef}
        style={{ width: '100%', height: '32px', display: 'block', marginBottom: '12px', border: `1px solid ${C.border}`, boxSizing: 'border-box' }}
      />

      {/* BPM + status */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <span style={{ fontSize: '9px', color: C.dim, letterSpacing: '2px' }}>BPM</span>
          <span style={{ fontSize: '32px', color, letterSpacing: '1px', lineHeight: 1, fontWeight: 'bold' }}>
            {d.loading ? '···' : (d.bpm ?? '---')}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '12px', fontSize: '8px', color: C.dim, letterSpacing: '2px' }}>
          <span style={{ color: d.buf ? C.mid : C.dim }}>LOADED {d.buf ? '◉' : '○'}</span>
          <span style={{ color: d.playing ? color : C.dim }}>PLAY {d.playing ? '◉' : '○'}</span>
        </div>
      </div>

      {/* Play / Stop */}
      <button
        disabled={d.loading}
        onMouseEnter={() => setHovBtn(true)}
        onMouseLeave={() => setHovBtn(false)}
        onClick={onPlay}
        style={{
          width: '100%', padding: '10px',
          background: hovBtn && !d.loading ? color + '1A' : 'transparent',
          border: `1px solid ${d.loading ? C.dim : color}`,
          color: d.loading ? C.dim : color,
          fontFamily: '"Courier New", monospace', fontSize: '11px', letterSpacing: '5px',
          cursor: d.loading ? 'not-allowed' : 'pointer',
          transition: 'background 0.15s, color 0.15s', marginBottom: '16px',
          opacity: d.loading ? 0.5 : 1,
        }}
      >
        {d.playing ? '■  STOP' : '▶  PLAY'}
      </button>

      {/* EQ */}
      <div style={{ display: 'flex', justifyContent: 'space-around', marginBottom: '14px', borderTop: `1px solid ${C.border}`, paddingTop: '14px' }}>
        {[['lo', 'LOW'], ['mid', 'MID'], ['hi', 'HIGH']].map(([band, label]) => (
          <VSlider key={band} label={label} value={d.eq[band]} min={-12} max={12} step={0.5}
            color={color} height={72}
            display={`${d.eq[band] > 0 ? '+' : ''}${d.eq[band]}`}
            onChange={v => onEQ(band, v)}
          />
        ))}
      </div>

      {/* Pitch */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderTop: `1px solid ${C.border}`, paddingTop: '12px' }}>
        <span style={{ color: C.dim, letterSpacing: '2px', fontSize: '8px', whiteSpace: 'nowrap' }}>PITCH</span>
        <input type="range" min={0.7} max={1.4} step={0.01} value={d.pitch}
          onChange={e => onPitch(+e.target.value)}
          style={{ flex: 1, accentColor: color, cursor: 'pointer' }}
        />
        <span style={{ color, fontSize: '10px', minWidth: '42px', textAlign: 'right' }}>
          {d.pitch.toFixed(2)}×
        </span>
      </div>

      <input ref={fileRef} type="file" accept="audio/*" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) onLoad(f); e.target.value = ''; }}
      />
    </div>
  );
}

// ── No WebAudio fallback ─────────────────────────────────────────
function NoAudioSupport() {
  return (
    <div style={{
      background: C.bg, minHeight: '100vh', color: C.text,
      fontFamily: '"Courier New", Courier, monospace',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: '16px', padding: '20px', textAlign: 'center',
    }}>
      <div style={{ color: C.err, fontSize: '12px', letterSpacing: '4px' }}>AUDIO ENGINE UNAVAILABLE</div>
      <div style={{ color: C.dim, fontSize: '10px', letterSpacing: '2px', maxWidth: '320px', lineHeight: 1.8 }}>
        Web Audio API not supported in this browser.<br />
        Try Chrome, Firefox, Edge, or Safari 14+.
      </div>
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────
export default function App() {
  if (!AudioCtx) return <NoAudioSupport />;
  const mobile = useIsMobile();
  return <Mixer mobile={mobile} />;
}

// ── Mixer ─────────────────────────────────────────────────────────
function Mixer({ mobile }) {
  const acRef      = useRef(null);
  const nodesA     = useRef(null);
  const nodesB     = useRef(null);
  const srcA       = useRef(null);
  const srcB       = useRef(null);
  const tStartA    = useRef(0);
  const tStartB    = useRef(0);
  const offA       = useRef(0);
  const offB       = useRef(0);
  const loadTokenA = useRef(0); // race-condition guard per deck
  const loadTokenB = useRef(0);
  const scopeA     = useRef(null);
  const scopeB     = useRef(null);
  const vuA        = useRef(null);
  const vuB        = useRef(null);
  const raf        = useRef(null);

  const [ready, setReady] = useState(false);
  const [xfade, setXfade] = useState(0.5);

  const mkDeck = () => ({
    buf: null, name: '', playing: false,
    bpm: null, pitch: 1,
    eq: { lo: 0, mid: 0, hi: 0 },
    loading: false, error: null,
  });
  const [dA, setDA] = useState(mkDeck);
  const [dB, setDB] = useState(mkDeck);

  const dARef = useRef(dA);
  const dBRef = useRef(dB);
  useEffect(() => { dARef.current = dA; }, [dA]);
  useEffect(() => { dBRef.current = dB; }, [dB]);

  // ── Init AudioContext ────────────────────────────────────────
  const init = useCallback(() => {
    if (acRef.current) return;
    const ac = new AudioCtx();
    acRef.current = ac;

    const mkNodes = () => {
      const gain = ac.createGain(); gain.gain.value = 1;
      const lo   = ac.createBiquadFilter(); lo.type = 'lowshelf';  lo.frequency.value = 250;
      const mid  = ac.createBiquadFilter(); mid.type = 'peaking';  mid.frequency.value = 1000; mid.Q.value = 0.5;
      const hi   = ac.createBiquadFilter(); hi.type  = 'highshelf'; hi.frequency.value = 4000;
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 8;
      comp.attack.value = 0.003; comp.release.value = 0.12; comp.knee.value = 20;
      const scope    = ac.createAnalyser(); scope.fftSize = 2048;
      const spectrum = ac.createAnalyser(); spectrum.fftSize = 256;
      const xg = ac.createGain();
      gain.connect(lo); lo.connect(mid); mid.connect(hi); hi.connect(comp);
      comp.connect(scope); scope.connect(spectrum); spectrum.connect(xg);
      xg.connect(ac.destination);
      return { gain, lo, mid, hi, comp, scope, spectrum, xg };
    };

    nodesA.current = mkNodes();
    nodesB.current = mkNodes();
    setReady(true);
  }, []);

  // ── Cleanup on unmount ───────────────────────────────────────
  useEffect(() => () => {
    cancelAnimationFrame(raf.current);
    if (acRef.current?.state !== 'closed') acRef.current?.close();
  }, []);

  // ── Crossfader ───────────────────────────────────────────────
  useEffect(() => {
    if (!nodesA.current || !nodesB.current) return;
    nodesA.current.xg.gain.value = Math.cos(xfade * Math.PI / 2);
    nodesB.current.xg.gain.value = Math.cos((1 - xfade) * Math.PI / 2);
  }, [xfade]);

  // ── EQ sync ──────────────────────────────────────────────────
  useEffect(() => {
    if (!nodesA.current) return;
    nodesA.current.lo.gain.value  = dA.eq.lo;
    nodesA.current.mid.gain.value = dA.eq.mid;
    nodesA.current.hi.gain.value  = dA.eq.hi;
  }, [dA.eq]);

  useEffect(() => {
    if (!nodesB.current) return;
    nodesB.current.lo.gain.value  = dB.eq.lo;
    nodesB.current.mid.gain.value = dB.eq.mid;
    nodesB.current.hi.gain.value  = dB.eq.hi;
  }, [dB.eq]);

  // ── Pitch sync ───────────────────────────────────────────────
  useEffect(() => { if (srcA.current) srcA.current.playbackRate.value = dA.pitch; }, [dA.pitch]);
  useEffect(() => { if (srcB.current) srcB.current.playbackRate.value = dB.pitch; }, [dB.pitch]);

  // ── Internal stop (used by loadFile before replacing buffer) ─
  const stopSilent = useCallback((deck) => {
    const ac = acRef.current;
    if (!ac) return;
    if (deck === 'A') {
      try { srcA.current?.stop(); } catch {}
      srcA.current = null;
      const d = dARef.current;
      if (d.playing)
        offA.current = (ac.currentTime - tStartA.current + offA.current) % (d.buf?.duration || 1);
      setDA(p => ({ ...p, playing: false }));
    } else {
      try { srcB.current?.stop(); } catch {}
      srcB.current = null;
      const d = dBRef.current;
      if (d.playing)
        offB.current = (ac.currentTime - tStartB.current + offB.current) % (d.buf?.duration || 1);
      setDB(p => ({ ...p, playing: false }));
    }
  }, []);

  // ── Load file ────────────────────────────────────────────────
  const loadFile = useCallback(async (file, deck) => {
    if (!isAudioFile(file)) {
      (deck === 'A' ? setDA : setDB)(p => ({ ...p, error: 'not an audio file' }));
      return;
    }

    init();
    const ac   = acRef.current;
    const isA  = deck === 'A';
    const setD = isA ? setDA : setDB;
    const tokenRef = isA ? loadTokenA : loadTokenB;
    const token = ++tokenRef.current;

    // Stop whatever is playing before we swap the buffer
    stopSilent(deck);

    setD(p => ({ ...p, loading: true, error: null, name: file.name, buf: null, bpm: null }));

    try {
      if (ac.state === 'suspended') await ac.resume();
      const ab  = await file.arrayBuffer();
      if (tokenRef.current !== token) return; // superseded by a newer load

      const buf = await ac.decodeAudioData(ab);
      if (tokenRef.current !== token) return;

      const bpm = estimateBPM(buf);
      if (isA) offA.current = 0;
      else     offB.current = 0;

      setD(p => ({ ...p, buf, bpm, loading: false, error: null }));
    } catch (err) {
      if (tokenRef.current !== token) return;
      const msg = /decode|unable/i.test(err?.message ?? '')
        ? 'unsupported format'
        : 'load failed';
      setD(p => ({ ...p, loading: false, error: msg, buf: null, bpm: null }));
    }
  }, [init, stopSilent]);

  // ── Toggle play / stop ───────────────────────────────────────
  const togglePlay = useCallback(async (deck) => {
    if (!acRef.current) { init(); return; }
    const ac = acRef.current;

    // Await resume — critical on mobile Safari where gesture context expires
    if (ac.state === 'suspended') {
      try { await ac.resume(); } catch {}
    }

    const isA    = deck === 'A';
    const d      = isA ? dARef.current : dBRef.current;
    const nodes  = isA ? nodesA.current : nodesB.current;
    const srcRef = isA ? srcA   : srcB;
    const tRef   = isA ? tStartA : tStartB;
    const offRef = isA ? offA   : offB;
    const setD   = isA ? setDA  : setDB;

    if (d.playing) {
      try { srcRef.current?.stop(); } catch {}
      srcRef.current = null;
      offRef.current = (ac.currentTime - tRef.current + offRef.current) % (d.buf?.duration || 1);
      setD(p => ({ ...p, playing: false }));
    } else if (d.buf && !d.loading) {
      const s = ac.createBufferSource();
      s.buffer              = d.buf;
      s.playbackRate.value  = d.pitch;
      s.loop                = true;

      // Safety net: if loop somehow ends, sync state
      s.onended = () => {
        if (srcRef.current === s) {
          srcRef.current = null;
          setD(p => ({ ...p, playing: false }));
        }
      };

      s.connect(nodes.gain);
      s.start(0, offRef.current % d.buf.duration);
      srcRef.current = s;
      tRef.current   = ac.currentTime;
      setD(p => ({ ...p, playing: true }));
    }
  }, [init]);

  // ── Animation loop ───────────────────────────────────────────
  useEffect(() => {
    const loop = () => {
      drawScope(scopeA.current, nodesA.current?.scope,    C.A, dARef.current.playing);
      drawScope(scopeB.current, nodesB.current?.scope,    C.B, dBRef.current.playing);
      drawVU(vuA.current,       nodesA.current?.spectrum, C.A, dARef.current.playing);
      drawVU(vuB.current,       nodesB.current?.spectrum, C.B, dBRef.current.playing);
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  const setEQ = (deck, band, val) => {
    if (deck === 'A') setDA(d => ({ ...d, eq: { ...d.eq, [band]: val } }));
    else              setDB(d => ({ ...d, eq: { ...d.eq, [band]: val } }));
  };

  const handleDrop = (e, deck) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return; // dragged text / link — ignore
    loadFile(f, deck);
  };

  // ── Render ───────────────────────────────────────────────────
  return (
    <div
      style={{ background: C.bg, minHeight: '100vh', color: C.text, fontFamily: '"Courier New", Courier, monospace', fontSize: '11px', padding: '20px', boxSizing: 'border-box' }}
      onClick={() => { if (!ready) init(); }}
    >
      {/* Header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '8px', borderBottom: `1px solid ${C.border}`, paddingBottom: '12px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
          <span style={{ color: C.A, letterSpacing: '6px', fontSize: '14px' }}>BNDR</span>
          <span style={{ color: C.dim, fontSize: '10px' }}>//</span>
          <span style={{ color: C.B, letterSpacing: '6px', fontSize: '14px' }}>MIX</span>
        </div>
        <div style={{ display: 'flex', gap: '20px', fontSize: '9px', letterSpacing: '2px' }}>
          <span style={{ color: C.mid }}>COMP ◉</span>
          <span style={{ color: C.mid }}>NORMALIZE ◉</span>
          <span style={{ color: C.mid }}>LOOP ◉</span>
          <span style={{ color: ready ? C.A : C.dim }}>{ready ? 'AUDIO ◉' : 'CLICK TO INIT ○'}</span>
        </div>
      </div>

      {/* Decks */}
      <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : '1fr 56px 1fr', gap: '12px', alignItems: 'start' }}>
        <Deck id="A" d={dA} color={C.A} scopeRef={scopeA} vuRef={vuA}
          onLoad={f => loadFile(f, 'A')} onPlay={() => togglePlay('A')}
          onEQ={(b, v) => setEQ('A', b, v)} onPitch={v => setDA(d => ({ ...d, pitch: v }))}
          onDrop={e => handleDrop(e, 'A')} onInit={init}
        />

        {/* Crossfader */}
        {mobile ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0' }}>
            <span style={{ color: C.A, fontSize: '8px', letterSpacing: '2px' }}>A</span>
            <input type="range" min={0} max={1} step={0.01} value={xfade}
              onChange={e => setXfade(+e.target.value)}
              style={{ flex: 1, accentColor: C.mid, cursor: 'pointer' }}
            />
            <span style={{ color: C.B, fontSize: '8px', letterSpacing: '2px' }}>B</span>
            <span style={{ color: C.dim, fontSize: '8px', minWidth: '24px', textAlign: 'right' }}>{Math.round(xfade * 100)}</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', paddingTop: '130px' }}>
            <span style={{ color: C.A, fontSize: '8px', letterSpacing: '2px' }}>A</span>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '160px', overflow: 'visible' }}>
              <input type="range" min={0} max={1} step={0.01} value={xfade}
                onChange={e => setXfade(+e.target.value)}
                style={{ transform: 'rotate(-90deg)', width: '160px', accentColor: C.mid, cursor: 'ns-resize' }}
              />
            </div>
            <span style={{ color: C.B, fontSize: '8px', letterSpacing: '2px' }}>B</span>
            <span style={{ color: C.dim, fontSize: '8px', marginTop: '4px' }}>{Math.round(xfade * 100)}</span>
          </div>
        )}

        <Deck id="B" d={dB} color={C.B} scopeRef={scopeB} vuRef={vuB}
          onLoad={f => loadFile(f, 'B')} onPlay={() => togglePlay('B')}
          onEQ={(b, v) => setEQ('B', b, v)} onPitch={v => setDB(d => ({ ...d, pitch: v }))}
          onDrop={e => handleDrop(e, 'B')} onInit={init}
        />
      </div>

      {/* Footer */}
      <div style={{ marginTop: '20px', borderTop: `1px solid ${C.border}`, paddingTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'space-between', color: C.dim, fontSize: '9px', letterSpacing: '2px' }}>
        <span>DROP MP3/WAV/OGG ONTO EACH DECK  ·  PITCH SHIFTS LIVE  ·  3-BAND EQ ACTIVE  ·  LOOPS AUTO</span>
        <span>WEB AUDIO API · AUTO-NORMALIZE · COMPRESSOR</span>
      </div>
    </div>
  );
}
