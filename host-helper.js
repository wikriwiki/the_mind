const { spawn } = require('child_process');
const path = require('path');

console.log('==================================================');
console.log('        THE MIND - 배포 & 원격 호스팅 헬퍼');
console.log('==================================================\n');

// 1. 게임 서버 가동 (server.js)
console.log('[1/3] 로컬 게임 서버(Node.js server.js) 실행 중...');
const serverProc = spawn('node', ['server.js'], {
  cwd: __dirname,
  stdio: 'pipe'
});

serverProc.stdout.on('data', (data) => {
  const line = data.toString().trim();
  if (line) console.log(`[Game Server] ${line}`);
});

serverProc.stderr.on('data', (data) => {
  console.error(`[Game Server Error] ${data.toString().trim()}`);
});

// 2. cloudflared 터널 연결 실행
console.log('[2/3] Cloudflare 원격 터널 가동 중... (주소 생성 대기)');
const cfProc = spawn(path.join(__dirname, 'cloudflared.exe'), [
  'tunnel',
  '--url', 'http://localhost:3000',
  '--no-autoupdate'
], {
  cwd: __dirname,
  stdio: 'pipe'
});

let urlFound = false;

// cloudflared 로그는 주로 stderr로 출력됩니다.
cfProc.stderr.on('data', handleTunnelLog);
cfProc.stdout.on('data', handleTunnelLog);

function handleTunnelLog(data) {
  const log = data.toString();
  
  if (urlFound) return;

  // trycloudflare 도메인 추출 패턴
  const match = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match) {
    urlFound = true;
    const url = match[0];
    
    console.log('\n==================================================');
    console.log('🎉 원격 배포 성공! 친구들을 초대해 보세요.');
    console.log(`🌐 접속 주소: \x1b[36m${url}\x1b[0m`);
    console.log('==================================================\n');
    console.log('👉 주소가 자동으로 클립보드에 복사되었습니다. (Ctrl+V로 전송 가능)');
    console.log('👉 게임 페이지가 웹 브라우저에서 자동으로 열립니다.\n');
    console.log('※ 서버를 종료하려면 이 창에서 [Ctrl + C]를 누르세요.\n');

    // 1) 클립보드 복사 (윈도우 PowerShell 활용)
    const clipProc = spawn('powershell', ['-Command', `Set-Clipboard -Value '${url}'`]);
    clipProc.on('error', () => {
      // 예외 시 기본 clip 명령 활용 백업
      try {
        const fallbackClip = spawn('clip');
        fallbackClip.stdin.write(url);
        fallbackClip.stdin.end();
      } catch (e) {}
    });

    // 2) 브라우저 자동 연결
    spawn('cmd', ['/c', 'start', url]);
  }
}

// 스크립트 중단 시 하위 프로세스 강제 클린업
process.on('SIGINT', () => {
  console.log('\n\n[3/3] 게임 서버 및 Cloudflare 터널링 프로세스를 안전하게 정리합니다...');
  serverProc.kill('SIGINT');
  cfProc.kill('SIGINT');
  setTimeout(() => process.exit(0), 500);
});
