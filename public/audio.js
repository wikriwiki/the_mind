/* The Mind — Web Audio 사운드 엔진
 * 외부 음원 없이 발랄한 둠칫둠칫 댄스 BGM + 효과음을 합성합니다. */
const Sound = (() => {
  let ctx = null;
  let master, bgmGain, sfxGain;
  let muted = false;
  let bgmOn = false;
  let schedulerId = null;
  let step = 0;
  let nextNoteTime = 0;
  const BPM = 124;
  const STEP = 60 / BPM / 4; // 16분음표 간격(초)
  const LOOKAHEAD = 0.12;

  // I–vi–IV–V (밝은 팝 진행)
  const BARS = [
    { bass: 48, chord: [60, 64, 67] }, // C
    { bass: 45, chord: [57, 60, 64] }, // Am
    { bass: 41, chord: [53, 57, 60] }, // F
    { bass: 43, chord: [55, 59, 62] }, // G
  ];
  // 4마디 리드 멜로디(16스텝×4). -1은 쉼표.
  const LEAD = [
    [72, -1, 76, -1, 79, -1, 76, -1, 72, -1, 74, -1, 76, -1, -1, -1],
    [69, -1, 72, -1, 76, -1, 72, -1, 69, -1, 71, -1, 72, -1, -1, -1],
    [65, -1, 69, -1, 72, -1, 69, -1, 65, -1, 67, -1, 69, -1, -1, -1],
    [67, -1, 71, -1, 74, -1, 71, -1, 67, -1, 74, -1, 79, -1, 77, -1],
  ];

  const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
    bgmGain = ctx.createGain();
    bgmGain.gain.value = 0.0; // 페이드인
    bgmGain.connect(master);
    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.6;
    sfxGain.connect(master);
    return true;
  }

  function unlock() {
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
  }

  // ---------- 악기 ----------
  function kick(t) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.connect(g).connect(bgmGain);
    o.start(t);
    o.stop(t + 0.18);
  }
  function hat(t, open = false) {
    const src = ctx.createBufferSource();
    const len = Math.floor(ctx.sampleRate * (open ? 0.12 : 0.04));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 8000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(open ? 0.18 : 0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.12 : 0.04));
    src.connect(hp).connect(g).connect(bgmGain);
    src.start(t);
    src.stop(t + (open ? 0.13 : 0.05));
  }
  function clap(t) {
    const src = ctx.createBufferSource();
    const len = Math.floor(ctx.sampleRate * 0.12);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    src.connect(bp).connect(g).connect(bgmGain);
    src.start(t);
    src.stop(t + 0.13);
  }
  function bass(t, m, dur) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    o.type = 'sawtooth';
    o.frequency.value = midi(m);
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.28, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(lp).connect(g).connect(bgmGain);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  function lead(t, m, dur) {
    const o = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o2.type = 'square';
    o.frequency.value = midi(m);
    o2.frequency.value = midi(m) * 1.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    o2.connect(g);
    g.connect(bgmGain);
    o.start(t); o2.start(t);
    o.stop(t + dur + 0.02); o2.stop(t + dur + 0.02);
  }

  function scheduleStep(s, t) {
    const bar = Math.floor(s / 16) % BARS.length;
    const i = s % 16;
    const B = BARS[bar];
    // 킥 (둠) — 4온더플로어
    if (i % 4 === 0) kick(t);
    // 하이햇 (칫) — 오프비트 + 8비트
    if (i % 2 === 0 && i % 4 !== 0) hat(t, i % 8 === 6);
    // 백비트 클랩
    if (i === 4 || i === 12) clap(t);
    // 베이스 — 둠칫 바운스
    if (i === 0) bass(t, B.bass, STEP * 2.0);
    if (i === 6) bass(t, B.bass + 12, STEP * 1.5);
    if (i === 8) bass(t, B.bass + 7, STEP * 1.5);
    if (i === 14) bass(t, B.bass + 12, STEP * 1.2);
    // 리드 멜로디
    const note = LEAD[bar][i];
    if (note > 0) lead(t, note, STEP * 1.8);
  }

  function scheduler() {
    while (nextNoteTime < ctx.currentTime + LOOKAHEAD) {
      scheduleStep(step, nextNoteTime);
      nextNoteTime += STEP;
      step++;
    }
  }

  function startBGM() {
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (bgmOn) return;
    bgmOn = true;
    step = 0;
    nextNoteTime = ctx.currentTime + 0.06;
    schedulerId = setInterval(scheduler, 25);
    if (!muted) bgmGain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 1.2);
  }
  function stopBGM() {
    if (!bgmOn) return;
    bgmOn = false;
    clearInterval(schedulerId);
    schedulerId = null;
    if (ctx) bgmGain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
  }

  // ---------- 효과음 ----------
  function blip(freq, dur, type = 'square', vol = 0.4, glideTo = null) {
    if (!ensure()) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(sfxGain);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  function noiseHit(dur, hpFreq, vol = 0.3) {
    if (!ensure()) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let k = 0; k < len; k++) d[k] = (Math.random() * 2 - 1) * (1 - k / len);
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hpFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(sfxGain);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // 카드 내기 — 찰진 "칩 딸깍 + 휙"
  function card() {
    noiseHit(0.05, 3000, 0.22);
    blip(520, 0.08, 'triangle', 0.32, 900);
    setTimeout(() => blip(760, 0.05, 'square', 0.16), 30);
  }
  // 실수 — 부저
  function mistake() {
    blip(220, 0.35, 'sawtooth', 0.4, 70);
    blip(110, 0.4, 'square', 0.25, 55);
    noiseHit(0.12, 200, 0.15);
  }
  // 레벨 완료 — 상승 아르페지오
  function level() {
    [60, 64, 67, 72].forEach((m, k) => setTimeout(() => blip(midi(m), 0.18, 'triangle', 0.3), k * 90));
  }
  // 표창 — 금속성 휙
  function shuriken() {
    blip(300, 0.3, 'sawtooth', 0.22, 1400);
    noiseHit(0.25, 2500, 0.18);
    setTimeout(() => blip(1800, 0.12, 'triangle', 0.2), 120);
  }
  // 이모지 — 귀여운 팝
  function emoji() {
    blip(700, 0.1, 'sine', 0.3, 1200);
  }
  // 승리 — 팡파르
  function victory() {
    [60, 64, 67, 72, 76, 79].forEach((m, k) => setTimeout(() => blip(midi(m), 0.28, 'triangle', 0.32), k * 110));
  }
  // 게임오버 — 하강
  function gameover() {
    [67, 63, 60, 55].forEach((m, k) => setTimeout(() => blip(midi(m), 0.3, 'sawtooth', 0.3, midi(m) * 0.6), k * 160));
  }
  // UI 클릭
  function click() { blip(880, 0.04, 'square', 0.14); }

  function setMuted(m) {
    muted = m;
    if (!ctx) return;
    if (muted) {
      bgmGain.gain.cancelScheduledValues(ctx.currentTime);
      bgmGain.gain.setValueAtTime(0.0001, ctx.currentTime);
      sfxGain.gain.value = 0.0001;
    } else {
      sfxGain.gain.value = 0.6;
      if (bgmOn) bgmGain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 0.5);
    }
  }
  function toggleMute() { setMuted(!muted); return muted; }
  function isMuted() { return muted; }

  return { unlock, startBGM, stopBGM, toggleMute, isMuted, setMuted,
    card, mistake, level, shuriken, emoji, victory, gameover, click };
})();
