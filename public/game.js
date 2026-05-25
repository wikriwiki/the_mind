/* global io */
const socket = io();
const $ = (id) => document.getElementById(id);

let state = null;
let myId = null;
let roomId = null;

// 애니메이션 동기화용
let prevTop = 0;
let prevLives = null;
let prevShurikens = null;
let pendingPileFx = null; // 'flash' | 'shake'
let handLocked = false;   // 카드 더블클릭 방지
let modalKind = null;     // 'level-complete' | 'gameover' | 'victory' | 'rules' | 'menu'

// 3초 지연 연출용 변수
let lastPhase = null;
let pendingModalTimer = null;
let delayedPhase = null;


/* ===================== 화면 전환 ===================== */
function show(screen) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('is-active'));
  $('screen-' + screen).classList.add('is-active');
  if (screen === 'game') Sound.startBGM();
  else Sound.stopBGM();
}

/* ===================== 토스트 / 배너 ===================== */
let toastTimer = null;
function toast(msg, danger = false, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('danger', danger);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

let bannerTimer = null;
function banner(msg, variant = '') {
  const el = $('banner');
  el.textContent = msg;
  el.className = 'banner';
  // reflow로 애니메이션 재시작
  void el.offsetWidth;
  if (variant) el.classList.add(variant);
  el.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('show'), 1700);
}

/* ===================== 모달 ===================== */
function openModal({ kind, icon, image, title, body, actions }) {
  modalKind = kind;
  if (image) $('modal-icon').innerHTML = `<img class="modal-img" src="${image}" alt="">`;
  else $('modal-icon').textContent = icon || '';
  $('modal-title').textContent = title || '';
  $('modal-body').innerHTML = body || '';
  const ac = $('modal-actions');
  ac.innerHTML = '';
  (actions || []).forEach((a) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (a.style || 'btn-gold');
    b.textContent = a.label;
    b.onclick = a.onClick;
    ac.appendChild(b);
  });
  $('modal-overlay').classList.add('show');
}
function closeModal() {
  modalKind = null;
  $('modal-overlay').classList.remove('show');
}

/* ===================== 좌석 위치 계산 (포커 테이블) ===================== */
function seatPositions(n) {
  const rx = 45;
  const ry = 40;
  const out = [];
  for (let i = 0; i < n; i++) {
    const deg = 90 + (360 / n) * i; // i=0 → 하단 중앙(나)
    const rad = (deg * Math.PI) / 180;
    out.push({ x: 50 + rx * Math.cos(rad), y: 50 + ry * Math.sin(rad) });
  }
  return out;
}

function initials(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase();
}

/* ===================== 렌더링 ===================== */
function render() {
  if (!state) return;

  // ----- 대기실 -----
  if (state.phase === 'lobby') {
    show('lobby');
    renderLobby();
    closeModalIfPhase();
    return;
  }

  // ----- 인게임 화면 -----
  show('game');
  renderHud();
  renderSeats();
  renderPile();
  renderHand();
  renderShurikenButton();

  // ----- 단계별 모달 -----
  if (['level-complete', 'gameover', 'victory'].includes(state.phase)) {
    if (lastPhase !== state.phase) {
      lastPhase = state.phase;
      clearTimeout(pendingModalTimer);
      delayedPhase = null;
      pendingModalTimer = setTimeout(() => {
        delayedPhase = state.phase;
        render();
      }, 3000);
    }
  } else {
    clearTimeout(pendingModalTimer);
    pendingModalTimer = null;
    delayedPhase = null;
    lastPhase = state.phase;
  }

  if (delayedPhase === 'level-complete') {
    renderLevelCompleteModal();
  } else if (delayedPhase === 'gameover') {
    renderGameOverModal();
  } else if (delayedPhase === 'victory') {
    renderVictoryModal();
  } else {
    closeModalIfPhase();
  }

  prevTop = state.topCard;
  prevLives = state.lives;
  prevShurikens = state.shurikens;
}

function closeModalIfPhase() {
  if (['level-complete', 'gameover', 'victory'].includes(modalKind)) closeModal();
}

function renderLobby() {
  $('lobby-code').textContent = state.roomId;
  const wrap = $('lobby-players');
  wrap.innerHTML = '';
  state.players.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'lobby-player' + (p.id === myId ? ' is-me' : '');
    row.innerHTML = `
      <div class="lobby-avatar">${initials(p.name)}</div>
      <div class="lobby-name">${escapeHtml(p.name)}${p.id === myId ? ' (나)' : ''}</div>
      ${p.isHost ? '<span class="host-badge">방장</span>' : ''}
    `;
    wrap.appendChild(row);
  });

  const n = state.players.length;
  const cfg = configFor(n);
  $('lobby-config').textContent =
    n >= 2 ? `${n}인 · 목표 레벨 ${cfg.maxLevels} · 목숨 ${cfg.lives} · 표창 ${cfg.shurikens}` : '최소 2명이 필요합니다.';

  const me = state.players.find((p) => p.id === myId);
  const startBtn = $('btn-start');
  if (me?.isHost) {
    startBtn.hidden = false;
    startBtn.disabled = n < 2;
    $('lobby-hint').textContent = n < 2 ? '다른 플레이어를 기다리는 중…' : '준비되면 게임을 시작하세요!';
  } else {
    startBtn.hidden = true;
    $('lobby-hint').textContent = '방장이 시작하기를 기다리는 중…';
  }

  // 시작 옵션 수치 연동
  $('lobby-start-level-val').textContent = state.startLevel || 1;
  $('lobby-max-card-val').textContent = state.maxCardVal || 100;

  // 방장 권한 조작 가시성 제어
  const levelDown = $('btn-level-down');
  const levelUp = $('btn-level-up');
  const cardDown = $('btn-card-down');
  const cardUp = $('btn-card-up');

  if (me?.isHost) {
    levelDown.style.visibility = 'visible';
    levelUp.style.visibility = 'visible';
    cardDown.style.visibility = 'visible';
    cardUp.style.visibility = 'visible';
  } else {
    levelDown.style.visibility = 'hidden';
    levelUp.style.visibility = 'hidden';
    cardDown.style.visibility = 'hidden';
    cardUp.style.visibility = 'hidden';
  }

  // 하드코어 모드 렌더링
  const hcBtn = $('btn-hardcore-toggle');
  const isHC = state.hardcore || false;
  hcBtn.textContent = isHC ? '🔥 ON' : 'OFF';
  hcBtn.style.background = isHC ? 'var(--danger)' : '';
  hcBtn.style.color = isHC ? '#fff' : '';
  if (me?.isHost) {
    hcBtn.style.visibility = 'visible';
    hcBtn.disabled = false;
  } else {
    hcBtn.style.visibility = 'visible';
    hcBtn.disabled = true;
  }
}

function renderHud() {
  $('hud-level').textContent = state.level;
  $('hud-maxlevel').textContent = '/' + state.maxLevels;

  const lives = $('hud-lives');
  lives.innerHTML = '';
  const showLives = Math.max(state.maxLives, state.lives);
  for (let i = 0; i < showLives; i++) {
    const s = document.createElement('span');
    s.className = 'pip life' + (i < state.lives ? '' : ' empty');
    s.textContent = '❤';
    lives.appendChild(s);
  }
  if (prevLives !== null && state.lives < prevLives) {
    const pips = lives.querySelectorAll('.pip.life');
    if (pips[state.lives]) pips[state.lives].classList.add('pop');
  }

  const shur = $('hud-shurikens');
  shur.innerHTML = '';
  const showShur = Math.max(state.maxShurikens, state.shurikens);
  for (let i = 0; i < showShur; i++) {
    const s = document.createElement('span');
    s.className = 'pip shuriken' + (i < state.shurikens ? '' : ' empty');
    s.textContent = '★';
    shur.appendChild(s);
  }
  if (prevShurikens !== null && state.shurikens > prevShurikens) {
    const pips = shur.querySelectorAll('.pip.shuriken');
    if (pips[state.shurikens - 1]) pips[state.shurikens - 1].classList.add('pop');
  }
}

function renderSeats() {
  // 나를 0번(하단)으로 정렬
  const me = state.players.find((p) => p.id === myId);
  const others = state.players.filter((p) => p.id !== myId);
  const ordered = me ? [me, ...others] : others;
  const pos = seatPositions(ordered.length);

  const seats = $('seats');
  seats.innerHTML = '';
  ordered.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'seat' + (p.id === myId ? ' is-me' : '') + (p.connected ? '' : ' disconnected');
    el.dataset.pid = p.id;
    el.style.left = pos[i].x + '%';
    el.style.top = pos[i].y + '%';

    const miniCards = '<span class="mini-card"></span>'.repeat(Math.min(p.cardCount, 5));
    let votes = '';
    if (p.shurikenVote) votes += '<span class="seat-vote shuriken">★</span>';
    if (p.readyVote) votes += '<span class="seat-vote ready">✓</span>';

    el.innerHTML = `
      <div class="seat-avatar">${initials(p.name)}${p.isHost ? '<span class="host-dot">★</span>' : ''}</div>
      <div class="seat-name">${escapeHtml(p.name)}${p.id === myId ? ' (나)' : ''}</div>
      <div class="seat-cards">${miniCards}<span>${p.cardCount}</span></div>
      <div class="seat-status">${votes}</div>
    `;
    seats.appendChild(el);
  });
}

function renderPile() {
  const card = $('pile-card');
  const val = $('pile-value');
  const cap = $('pile-caption');

  if (state.topCard > 0) {
    val.textContent = state.topCard;
    card.classList.remove('empty');
    cap.textContent = state.lastPlayedBy ? `${state.lastPlayedBy} 님이 냈습니다` : '';
  } else {
    val.textContent = '—';
    card.classList.add('empty');
    cap.textContent = '낮은 숫자부터 차례로 내세요';
  }

  if (pendingPileFx) {
    card.classList.remove('flash', 'shake');
    void card.offsetWidth;
    card.classList.add(pendingPileFx);
    pendingPileFx = null;
  }
}

function renderHand() {
  const wrap = $('hand-cards');
  wrap.innerHTML = '';
  const cards = state.myCards || [];
  const lowest = cards.length ? Math.min(...cards) : null;

  if (cards.length === 0 && state.phase === 'playing') {
    wrap.innerHTML = '<div style="color:var(--text-dim);font-size:.85rem;padding:30px 0;">낼 카드가 없습니다 — 동료를 기다리세요</div>';
    return;
  }

  cards.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'card' + (c === lowest ? ' lowest' : '');
    el.dataset.v = c;
    el.textContent = c;
    el.onclick = () => playCard(c, el);
    wrap.appendChild(el);
  });
}

function renderShurikenButton() {
  const btn = $('btn-shuriken');
  const me = state.players.find((p) => p.id === myId);
  btn.classList.toggle('voted', !!me?.shurikenVote);
  const playing = state.phase === 'playing';
  const haveCards = (me?.cardCount || 0) > 0;
  btn.disabled = !playing || state.shurikens <= 0 || !haveCards;
  // 투표 필요 인원 = 카드를 가진 활성 플레이어 수
  const need = state.players.filter((p) => p.connected && p.cardCount > 0).length;
  $('shuriken-count').textContent = `${state.shurikenVoteCount}/${need}`;
}

/* ===================== 레벨 완료 / 게임오버 / 승리 모달 ===================== */
function renderLevelCompleteModal() {
  const allReady = state.readyVoteCount;
  const total = state.playerCount;
  const me = state.players.find((p) => p.id === myId);
  const iReady = !!me?.readyVote;

  const body = `
    <p>다음 레벨: <b>레벨 ${state.level + 1}</b></p>
    <p class="ready-status">${allReady} / ${total} 명 준비 완료</p>
  `;
  if (modalKind !== 'level-complete') {
    openModal({
      kind: 'level-complete',
      image: 'win.jpg',
      title: `레벨 ${state.level} 클리어!`,
      body,
      actions: [{ label: iReady ? '준비 완료 ✓' : '준비 완료', onClick: () => socket.emit('ready-next') }],
    });
  } else {
    $('modal-body').innerHTML = body;
    const btn = $('modal-actions').querySelector('button');
    if (btn) {
      btn.textContent = iReady ? '준비 완료 ✓' : '준비 완료';
      btn.disabled = iReady;
      btn.className = 'btn ' + (iReady ? 'btn-outline' : 'btn-gold');
    }
  }
}

function renderGameOverModal() {
  if (modalKind === 'gameover') return;
  const me = state.players.find((p) => p.id === myId);
  const actions = [];
  if (me?.isHost) {
    actions.push({ label: '다시 시작', onClick: () => socket.emit('restart-game') });
    actions.push({ label: '대기실로', style: 'btn-outline', onClick: () => socket.emit('back-to-lobby') });
  } else {
    actions.push({ label: '대기실로 돌아가기를 기다리는 중…', style: 'btn-text', onClick: () => {} });
  }
  let bodyText = `<p>레벨 <b>${state.level}</b>에서 멈췄습니다.</p><p>다음엔 더 깊이 마음을 모아보세요.</p>`;
  if (state.culprit) {
    const culprit = escapeHtml(state.culprit);
    const comments = [
      `"${culprit}"님은 완전 머저리 그 자체네요~ 저였으면 손절했을듯?`,
      `"${culprit}" 또 너야?`,
      `방금 "${culprit}"님이 내신 카드는 트롤의 정석이네요.`,
      `"${culprit}"님, 혹시 눈 감고 마인드 컨트롤 하시나요?`,
      `오늘부로 "${culprit}"님과의 우정은 잠정 보류입니다.`,
      `"${culprit}"님의 뇌와 제 마음은 영원히 평행선일 듯…`,
      `첩자가 분명합니다! "${culprit}"님이 스파이가 아니면 설명이 안 됨.`,
      `대단한 타이밍 감각! "${culprit}"님 덕분에 게임 초고속 종료!`,
      `"${culprit}"님의 마인드는 안드로메다 은하 근처에 계시나 봅니다.`,
      `고의 트롤링 의혹 제기! "${culprit}"님, 청문회 준비하세요.`
    ];
    const randIdx = Math.floor(Math.random() * comments.length);
    bodyText = `<p>레벨 <b>${state.level}</b>에서 멈췄습니다.</p><p class="culprit-roast" style="color:var(--danger);font-weight:700;margin-top:14px;word-break:keep-all;">🔥 ${comments[randIdx]}</p>`;
  }

  openModal({
    kind: 'gameover',
    image: 'lose.jpg',
    title: '게임 오버',
    body: bodyText,
    actions,
  });
}

function renderVictoryModal() {
  if (modalKind === 'victory') return;
  const me = state.players.find((p) => p.id === myId);
  const actions = [];
  if (me?.isHost) {
    actions.push({ label: '다시 도전', onClick: () => socket.emit('restart-game') });
    actions.push({ label: '대기실로', style: 'btn-outline', onClick: () => socket.emit('back-to-lobby') });
  } else {
    actions.push({ label: '방장의 선택을 기다리는 중…', style: 'btn-text', onClick: () => {} });
  }
  openModal({
    kind: 'victory',
    image: 'win.jpg',
    title: '완벽한 승리!',
    body: `<p>모든 레벨을 클리어했습니다!</p><p>당신들은 진정 하나의 마음이었습니다.</p>`,
    actions,
  });
}

/* ===================== 액션 ===================== */
function playCard(card, el) {
  if (handLocked || !state || state.phase !== 'playing') return;
  handLocked = true;
  Sound.card();
  if (el) el.classList.add('playing');
  socket.emit('play-card', { card });
  setTimeout(() => { handLocked = false; }, 250);
}

/* ===================== 소켓 이벤트 ===================== */
socket.on('connect', () => {});

socket.on('joined', (d) => {
  roomId = d.roomId;
});

socket.on('error-msg', (msg) => toast(msg, true));

socket.on('state', (s) => {
  myId = s.myId;
  state = s;
  render();
});

socket.on('notify', (d) => {
  switch (d.type) {
    case 'player-joined':
    case 'player-left':
      toast(d.message);
      break;
    case 'game-start':
      banner('게임 시작', 'success');
      break;
    case 'card-played':
      pendingPileFx = 'flash';
      if (d.playerId !== myId) Sound.card();
      break;
    case 'mistake': {
      pendingPileFx = 'shake';
      const minCard = Math.min(...d.lowerCards.map((l) => l.card));
      const dmg = d.damage || 1;
      if (dmg > 1) {
        banner(`💀 실수! ${dmg}장 배제 → 목숨 -${dmg}! (최저: ${minCard})`, 'danger');
      } else {
        banner(`💥 실수! (최저 카드: ${minCard})`, 'danger');
      }
      Sound.mistake();
      toast(`💔 더 낮은 카드: ${d.lowerCards.map((l) => l.card).join(', ')}`, true, 3200);
      break;
    }
    case 'shuriken': {
      banner('🌟 표창!', '');
      Sound.shuriken();
      const cards = d.discarded.map((x) => x.card).sort((a, b) => a - b).join(', ');
      toast(`표창 사용 — 버린 카드: ${cards}`);
      break;
    }
    case 'level-complete':
      banner(`레벨 ${d.level} 클리어!`, 'success');
      Sound.level();
      if (d.bonusLife) setTimeout(() => toast('❤ 목숨 +1 보너스!'), 600);
      if (d.bonusShuriken) setTimeout(() => toast('★ 표창 +1 보너스!'), d.bonusLife ? 1400 : 600);
      break;
    case 'next-level':
      banner(d.message, 'success');
      break;
    case 'victory':
      banner('🏆 승리!', 'success');
      Sound.victory();
      break;
    case 'gameover':
      banner('게임 오버', 'danger');
      Sound.gameover();
      break;
  }
});

socket.on('disconnect', () => toast('서버와 연결이 끊겼습니다.', true, 5000));

socket.on('emoji', ({ playerId, emoji }) => {
  showFloatEmoji(playerId, emoji);
  Sound.emoji();
});

function showFloatEmoji(pid, emoji) {
  const seat = document.querySelector(`.seat[data-pid="${pid}"]`);
  if (!seat) return;
  const el = document.createElement('span');
  el.className = 'float-emoji';
  el.textContent = emoji;
  seat.appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

/* ===================== 설정값(클라 표시용) ===================== */
function configFor(n) {
  const C = {
    2: { maxLevels: 12, lives: 2, shurikens: 1 },
    3: { maxLevels: 10, lives: 3, shurikens: 1 },
    4: { maxLevels: 8, lives: 4, shurikens: 1 },
    5: { maxLevels: 7, lives: 4, shurikens: 1 },
    6: { maxLevels: 6, lives: 5, shurikens: 1 },
  };
  return C[n] || C[6];
}

/* ===================== 유틸 ===================== */
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ===================== UI 바인딩 ===================== */
$('btn-go-create').onclick = () => { show('create'); $('create-name').focus(); };
$('btn-go-join').onclick = () => { show('join'); };
$('btn-go-rules').onclick = () => showRules();

document.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => show('landing')));

$('btn-create-confirm').onclick = () => {
  const name = $('create-name').value.trim();
  if (!name) return toast('닉네임을 입력해주세요.', true);
  socket.emit('create-room', { name });
};
$('create-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-create-confirm').click(); });

$('btn-join-confirm').onclick = () => {
  const code = $('join-code').value.trim().toUpperCase();
  const name = $('join-name').value.trim();
  if (!code) return toast('방 코드를 입력해주세요.', true);
  if (!name) return toast('닉네임을 입력해주세요.', true);
  socket.emit('join-room', { roomId: code, name });
};
$('join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join-confirm').click(); });
$('join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

$('btn-copy-code').onclick = async () => {
  try {
    await navigator.clipboard.writeText(state.roomId);
    toast('방 코드를 복사했습니다.');
  } catch {
    toast('복사 실패 — 코드: ' + state.roomId);
  }
};

$('btn-start').onclick = () => socket.emit('start-game');
$('btn-leave-lobby').onclick = () => { socket.emit('leave-room'); show('landing'); };
$('btn-shuriken').onclick = () => socket.emit('vote-shuriken');

$('btn-level-down').onclick = () => {
  if (!state || !state.roomId) return;
  const current = state.startLevel || 1;
  if (current > 1) {
    socket.emit('set-start-level', { level: current - 1 });
  }
};

$('btn-level-up').onclick = () => {
  if (!state || !state.roomId) return;
  const current = state.startLevel || 1;
  const n = state.players.length;
  const cfg = configFor(n);
  if (current < cfg.maxLevels) {
    socket.emit('set-start-level', { level: current + 1 });
  } else {
    toast(`이 인원수에서의 최대 레벨은 ${cfg.maxLevels}입니다.`, true);
  }
};

const CARD_LIMITS = [100, 150, 200];

$('btn-card-down').onclick = () => {
  if (!state || !state.roomId) return;
  const current = state.maxCardVal || 100;
  let idx = CARD_LIMITS.indexOf(current);
  idx = (idx - 1 + CARD_LIMITS.length) % CARD_LIMITS.length;
  socket.emit('set-max-card', { maxCard: CARD_LIMITS[idx] });
};

$('btn-card-up').onclick = () => {
  if (!state || !state.roomId) return;
  const current = state.maxCardVal || 100;
  let idx = CARD_LIMITS.indexOf(current);
  idx = (idx + 1) % CARD_LIMITS.length;
  socket.emit('set-max-card', { maxCard: CARD_LIMITS[idx] });
};

$('btn-hardcore-toggle').onclick = () => {
  if (!state || !state.roomId) return;
  socket.emit('set-hardcore', { enabled: !state.hardcore });
};

$('btn-game-menu').onclick = () => {
  openModal({
    kind: 'menu',
    icon: '⚙️',
    title: '메뉴',
    body: '',
    actions: [
      { label: '게임 방법', style: 'btn-outline', onClick: () => showRules() },
      { label: '방 나가기', style: 'btn-outline', onClick: () => { socket.emit('leave-room'); closeModal(); show('landing'); } },
      { label: '닫기', style: 'btn-text', onClick: () => closeModal() },
    ],
  });
};

function showRules() {
  openModal({
    kind: 'rules',
    icon: '🧠',
    title: '게임 방법',
    body: `
      <div class="modal-rules">
        <p><b>The Mind</b>는 말 없이 마음을 모으는 협동 카드게임입니다.</p>
        <h3>목표</h3>
        <p>1~${state ? state.maxCardVal : 100}의 카드를 <b>오름차순</b>으로 모두 내면 레벨 클리어! 모든 레벨을 깨면 승리합니다.</p>
        <h3>규칙</h3>
        <ul>
          <li>레벨 N에서는 각자 카드를 N장씩 받습니다.</li>
          <li>가장 낮은 카드를 가진 사람부터 내야 합니다.</li>
          <li><b>숫자·신호로 소통 금지!</b> 오직 타이밍 감각으로.</li>
          <li>더 낮은 카드가 남아있을 때 카드를 내면 <b>목숨 ❤ -1</b>.</li>
          <li>목숨이 0이 되면 게임 오버.</li>
        </ul>
        <h3>표창 ★</h3>
        <p>전원이 표창에 투표하면, 각자 가진 <b>최저 카드</b>를 공개하고 버립니다. 위기 탈출용!</p>
      </div>
    `,
    actions: [{ label: '확인', onClick: () => closeModal() }],
  });
}

/* ===================== 사운드 & 이모티콘 ===================== */
const EMOJIS = ['👍', '😂', '😮', '😱', '🔥', '🎉', '🤔', '😎', '🤏', '🤚', '🖕', '🍌', '😐'];
const emojiTray = $('emoji-tray');
EMOJIS.forEach((e) => {
  const b = document.createElement('button');
  b.className = 'emoji-btn';
  b.textContent = e;
  b.onclick = () => {
    socket.emit('send-emoji', { emoji: e });
    Sound.emoji();
    emojiTray.hidden = true;
  };
  emojiTray.appendChild(b);
});
$('btn-emoji-toggle').onclick = () => {
  if (emojiTray.hasAttribute('hidden')) {
    emojiTray.removeAttribute('hidden');
  } else {
    emojiTray.setAttribute('hidden', '');
  }
};

$('btn-sound').onclick = () => {
  Sound.unlock();
  const muted = Sound.toggleMute();
  $('btn-sound').textContent = muted ? '🔇' : '🔊';
};

// 브라우저 자동재생 정책: 첫 사용자 입력에서 오디오 컨텍스트 활성화
document.addEventListener('pointerdown', () => Sound.unlock(), { once: true });

// 시작 화면
show('landing');
