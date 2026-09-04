@echo off
chcp 65001 >nul
title K12 学习看板 - 本地服务

cd /d "%~dp0kanban"

echo ============================================
echo   李迦一 K12 学习看板 - 本地开发环境
echo ============================================
echo.

where python >nul 2>nul
if %errorlevel%==0 (
    set PY=python
) else (
    set PY=py -3
)

echo 服务地址: http://localhost:3000
echo 停止服务: 关闭本窗口，或按 Ctrl+C
echo.
echo 启动中...
echo.

%PY% app.py

echo.
echo 服务已停止。
pause
