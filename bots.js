// 테스트용 봇: 지정한 방에 입장. 손패를 파일에 기록하고, 옵션에 따라 자동 플레이/표창 투표.
// 사용법: node bots.js <ROOMCODE> <봇수> [mode]
//   mode 없음 : 대기만
//   mode=auto : playing이면 8초 뒤 자신의 최저 카드 자동 제출(디바운스)
//   mode=shuriken : 표창에 자동 투표
const fs = require('fs');
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const code = (process.argv[2] || '').toUpperCase();
const count = Math.max(1, parseInt(process.argv[3] || '2', 10));
const mode = process.argv[4] || 'wait';
const NAMES = ['민준', '서연', '하준', '지우', '도윤'];
const LOG = require('path').join(__dirname, 'bots-hands.json');

if (!code) { console.error('방 코드를 입력하세요'); process.exit(1); }

const bots = [];
function dump() {
  const snap = bots.map((b) => ({ name: b.name, cards: b.state?.myCards || [], phase: b.state?.phase, level: b.state?.level }));
  try { fs.writeFileSync(LOG, JSON.stringify(snap, null, 2)); } catch {}
}

for (let i = 0; i < count; i++) {
  const sock = io(URL, { forceNew: true });
  const bot = { name: NAMES[i], sock, state: null, timer: null };
  sock.on('connect', () => sock.emit('join-room', { roomId: code, name: bot.name }));
  sock.on('state', (s) => {
    bot.state = s;
    dump();
    if (mode === 'auto' && s.phase === 'playing' && (s.myCards || []).length > 0) {
      clearTimeout(bot.timer);
      bot.timer = setTimeout(() => {
        const cur = bot.state;
        if (cur?.phase === 'playing' && (cur.myCards || []).length > 0) {
          const lowest = Math.min(...cur.myCards);
          sock.emit('play-card', { card: lowest });
          console.log(`[${bot.name}] 자동 제출: ${lowest}`);
        }
      }, 8000);
    }
    if (mode === 'shuriken' && s.phase === 'playing' && (s.myCards || []).length > 0) {
      const me = s.players.find((p) => p.name === bot.name);
      if (me && !me.shurikenVote && s.shurikens > 0) {
        sock.emit('vote-shuriken');
        console.log(`[${bot.name}] 표창 투표`);
      }
    }
    // 레벨 완료 시 자동 준비 (auto 모드)
    if (mode === 'auto' && s.phase === 'level-complete') {
      const me = s.players.find((p) => p.name === bot.name);
      if (me && !me.readyVote) {
        setTimeout(() => sock.emit('ready-next'), 500);
        console.log(`[${bot.name}] 준비 완료`);
      }
    }
  });
  sock.on('error-msg', (m) => console.log(`[${bot.name}] 오류: ${m}`));
  bots.push(bot);
}
console.log(`${count}개 봇이 방 ${code} 입장 (mode=${mode})`);

process.on('SIGINT', () => { bots.forEach((b) => b.sock.disconnect()); process.exit(0); });
