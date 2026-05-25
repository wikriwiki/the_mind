@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules (
  echo [준비중] 의존성(node_modules)을 설치하는 중입니다...
  call npm install
)
if not exist cloudflared.exe (
  echo [준비중] cloudflared.exe를 다운로드하는 중입니다...
  powershell -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'cloudflared.exe'"
)

cls
node host-helper.js
