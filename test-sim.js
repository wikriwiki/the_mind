// The Mind 멀티플레이 로직 시뮬레이션 테스트 (헤드리스)
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(name) {
  const sock = io(URL, { forceNew: true });
  const c = { name, sock, state: null, lastNotify: null, notifies: [], errors: [] };
  sock.on('state', (s) => { c.state = s; });
  sock.on('notify', (n) => { c.lastNotify = n; c.notifies.push(n); });
  sock.on('error-msg', (m) => { c.errors.push(m); });
  return c;
}
function sawNotify(clients, type) { return clients.some((c) => c.notifies.some((n) => n.type === type)); }
function waitConnect(c) { return new Promise((r) => c.sock.on('connect', r)); }

// 모든 클라이언트의 손패를 모아 전역 최저 카드를 가진 클라이언트를 찾음
function findLowestHolder(clients) {
  let best = null;
  for (const c of clients) {
    const cards = c.state?.myCards || [];
    for (const card of cards) {
      if (best === null || card < best.card) best = { client: c, card };
    }
  }
  return best;
}
function totalCards(clients) {
  return clients.reduce((s, c) => s + (c.state?.myCards?.length || 0), 0);
}

async function run() {
  console.log('\n=== The Mind 시뮬레이션 시작 ===\n');

  // --- 3인 게임 생성/참가 ---
  console.log('[1] 방 생성 & 참가 (3인)');
  const A = makeClient('Alice'), B = makeClient('Bob'), C = makeClient('Carol');
  await Promise.all([waitConnect(A), waitConnect(B), waitConnect(C)]);

  let roomId = null;
  A.sock.on('joined', (d) => { roomId = d.roomId; });
  A.sock.emit('create-room', { name: 'Alice' });
  await sleep(200);
  assert(roomId && roomId.length === 4, `방 코드 생성됨: ${roomId}`);
  assert(A.state?.phase === 'lobby', '방장 대기실 진입');

  B.sock.emit('join-room', { roomId, name: 'Bob' });
  C.sock.emit('join-room', { roomId, name: 'Carol' });
  await sleep(300);
  assert(A.state?.players.length === 3, '3명 입장 확인');
  assert(A.state?.players[0].isHost === true, 'Alice가 방장');

  // 중복 닉네임 거부
  const dup = makeClient('Bob2');
  await waitConnect(dup);
  dup.sock.emit('join-room', { roomId, name: 'Bob' });
  await sleep(200);
  assert(dup.errors.some((e) => e.includes('닉네임')), '중복 닉네임 거부됨');
  dup.sock.disconnect();
  await sleep(100);

  // --- 게임 시작 ---
  console.log('\n[2] 게임 시작 & 커스텀 시작 레벨/카드 범위 적용');
  // 비방장 시작 시도 → 거부
  B.sock.emit('start-game');
  await sleep(150);
  assert(B.errors.some((e) => e.includes('방장')), '비방장 시작 거부됨');

  // 방장이 옵션 변경 (시작 레벨 3, 최대 카드 150)
  A.sock.emit('set-start-level', { level: 3 });
  A.sock.emit('set-max-card', { maxCard: 150 });
  await sleep(250);
  assert(A.state?.startLevel === 3, '시작 레벨 3 설정 동기화');
  assert(A.state?.maxCardVal === 150, '최대 카드 범위 150 설정 동기화');

  A.sock.emit('start-game');
  await sleep(300);
  const clients = [A, B, C];
  assert(A.state?.phase === 'playing', '게임 playing 진입');
  assert(A.state?.level === 3, '레벨 3 시작 성공');
  assert(A.state?.lives === 3, '3인 시작 목숨 3');
  assert(totalCards(clients) === 9, '3레벨 시작: 총 9장 분배 (각 3장씩)');

  // 분배된 카드가 가변 카드 범위 [1, 150] 내에 존재하는지 단언
  const allInRange = clients.every((c) => (c.state?.myCards || []).every((card) => card >= 1 && card <= 150));
  assert(allInRange, '모든 분배 카드가 설정된 가변 범위 [1 ~ 150] 내에 존재함');

  // --- 완벽 플레이로 레벨 진행 ---
  console.log('\n[3] 완벽 플레이로 여러 레벨 클리어');
  let levelsCleared = 0;
  for (let guard = 0; guard < 500; guard++) {
    const phase = A.state?.phase;
    if (phase === 'playing') {
      if (totalCards(clients) === 0) { await sleep(120); continue; }
      const low = findLowestHolder(clients);
      if (!low) { await sleep(80); continue; }
      const livesBefore = A.state.lives;
      low.client.sock.emit('play-card', { card: low.card });
      await sleep(90);
      // 완벽 플레이이므로 목숨이 줄면 안 됨
      if (A.state.lives < livesBefore) {
        assert(false, `완벽 플레이인데 목숨 감소 (card ${low.card})`);
      }
    } else if (phase === 'level-complete') {
      levelsCleared++;
      clients.forEach((c) => c.sock.emit('ready-next'));
      await sleep(200);
    } else if (phase === 'victory') {
      break;
    } else if (phase === 'gameover') {
      assert(false, '완벽 플레이 중 게임오버 발생');
      break;
    }
  }
  assert(A.state?.phase === 'victory', `완벽 플레이로 승리 도달 (클리어 레벨 ${levelsCleared})`);
  assert(A.state?.lives === 3 || A.state?.lives > 3, '완벽 플레이 목숨 유지/증가');

  A.sock.disconnect(); B.sock.disconnect(); C.sock.disconnect();
  await sleep(200);

  // === 표창 테스트 (2인) — 레벨 시작 직후 카드가 있는 상태 ===
  console.log('\n[4] 표창 테스트 (2인)');
  const D = makeClient('Dan'), E = makeClient('Eve');
  await Promise.all([waitConnect(D), waitConnect(E)]);
  let rid2 = null;
  D.sock.on('joined', (d) => { rid2 = d.roomId; });
  D.sock.emit('create-room', { name: 'Dan' });
  await sleep(200);
  E.sock.emit('join-room', { roomId: rid2, name: 'Eve' });
  await sleep(200);
  D.sock.emit('start-game');
  await sleep(300);
  const two = [D, E];

  const shBefore = D.state.shurikens;
  assert(shBefore >= 1, `2인 시작 표창 ${shBefore}개`);
  D.sock.emit('vote-shuriken');
  await sleep(150);
  assert(D.state.shurikenVoteCount === 1, '표창 1표 (미발동)');
  assert(D.state.shurikens === shBefore, '한 명만 투표 시 표창 미소모');
  E.sock.emit('vote-shuriken');
  await sleep(250);
  assert(D.state.shurikens === shBefore - 1, `전원 투표로 표창 소모 (${shBefore}→${D.state.shurikens})`);
  assert(sawNotify(two, 'shuriken'), 'shuriken 알림 수신');

  // 레벨1 각 1장 → 표창 사용 시 "전체 중 가장 낮은 카드 단 1장"만 버려지므로, 여전히 진행 중(playing) 상태여야 함.
  await sleep(150);
  assert(D.state.phase === 'playing', '표창 사용 후 전체 중 1장만 버려져 여전히 playing 유지');
  
  // 남은 1장의 카드 마저 내어 레벨 완료시킴
  const remainingPlayer = two.find((c) => (c.state?.myCards || []).length > 0);
  if (remainingPlayer) {
    const card = remainingPlayer.state.myCards[0];
    remainingPlayer.sock.emit('play-card', { card });
  }
  await sleep(250);
  assert(D.state.phase === 'level-complete', '남은 카드 제출하여 레벨1 완료');

  // === 실수(목숨 감소) 테스트 — 레벨2로 진행 후 ===
  console.log('\n[5] 실수(목숨 감소) 테스트');
  two.forEach((c) => c.sock.emit('ready-next'));
  await sleep(250);
  assert(D.state.level === 2, '레벨 2 진입');
  assert(totalCards(two) === 4, '레벨2: 총 4장 (각 2장)');

  const livesStart = D.state.lives;
  const low = findLowestHolder(two);
  // 전역 최저보다 큰 카드를 가진 사람이 먼저 냄 → 실수 유발
  let mademistake = false;
  for (const c of two) {
    const higherCard = (c.state.myCards || []).find((card) => card > low.card);
    if (higherCard !== undefined) {
      c.sock.emit('play-card', { card: higherCard });
      mademistake = true;
      break;
    }
  }
  await sleep(250);
  if (mademistake) {
    assert(D.state.lives === livesStart - 1, `실수로 목숨 감소 (${livesStart}→${D.state.lives})`);
    assert(sawNotify(two, 'mistake'), 'mistake 알림 수신');
  } else {
    console.log('  (배분상 실수 케이스 없음 — 생략)');
  }

  D.sock.disconnect(); E.sock.disconnect();
  await sleep(200);

  // === 인원 제한 & 방 없음 ===
  console.log('\n[6] 예외 처리 테스트');
  const F = makeClient('F');
  await waitConnect(F);
  F.sock.emit('join-room', { roomId: 'ZZZZ', name: 'Ghost' });
  await sleep(200);
  assert(F.errors.some((e) => e.includes('찾을 수 없')), '없는 방 참가 거부');
  F.sock.disconnect();
  await sleep(100);

  console.log(`\n=== 결과: ${pass} 통과 / ${fail} 실패 ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error('테스트 오류:', e); process.exit(1); });
