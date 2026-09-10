@echo off
setlocal EnableExtensions
chcp 65001 >nul
title World Orogen 一键启动

cd /d "%~dp0"

if "%WORLD_OROGEN_HOST%"=="" set "WORLD_OROGEN_HOST=127.0.0.1"
if "%WORLD_OROGEN_PORT%"=="" set "WORLD_OROGEN_PORT=8000"
set "WORLD_OROGEN_URL=http://%WORLD_OROGEN_HOST%:%WORLD_OROGEN_PORT%/"

where.exe py >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=py -3"
    goto :check_port
)

where.exe python >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=python"
    goto :check_port
)

where.exe python3 >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=python3"
    goto :check_port
)

echo 未找到 Python 3，无法启动本地服务器。
echo 请先安装 Python 3，然后重新双击 start.bat。
echo.
pause
exit /b 1

:check_port
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = New-Object Net.Sockets.TcpClient; try { $c.Connect('%WORLD_OROGEN_HOST%', %WORLD_OROGEN_PORT%); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
    echo 检测到端口 %WORLD_OROGEN_PORT% 已有服务在运行。
    echo 正在打开：%WORLD_OROGEN_URL%
    start "" "%WORLD_OROGEN_URL%"
    echo.
    pause
    exit /b 0
)

echo 正在启动 World Orogen...
echo 项目目录：%CD%
echo 浏览器地址：%WORLD_OROGEN_URL%
echo 关闭此窗口或按 Ctrl+C 即可停止服务。
echo.

if /I not "%WORLD_OROGEN_NO_BROWSER%"=="1" (
    start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%WORLD_OROGEN_URL%'"
)

%PYTHON_CMD% "%~dp0local-server.py"

echo.
echo 服务已停止。
pause
