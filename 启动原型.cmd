@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24 或以上版本。
  pause
  exit /b 1
)
if not exist node_modules\ws (
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo 原型地址：http://127.0.0.1:3088
echo 保持此终端运行，在浏览器中打开上述地址。
call npm start
pause
