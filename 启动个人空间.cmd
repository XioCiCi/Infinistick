@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
set "PYTHONUTF8=1"
if not defined STICKERS_PORT set "STICKERS_PORT=8787"
set "STICKERS_PY=python"
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" set "STICKERS_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
"%STICKERS_PY%" -c "from server import Store; import sys; sys.exit(0 if Store('data').has_password() else 1)"
if errorlevel 1 (
  "%STICKERS_PY%" server.py --init
  if errorlevel 1 exit /b 1
)
"%STICKERS_PY%" -c "print('\u6253\u5f00 http://127.0.0.1:%STICKERS_PORT% \uff0c\u4f7f\u7528\u81ea\u5df1\u7684\u5bc6\u7801\u767b\u5f55\u3002'); print('\u5173\u95ed\u6b64\u7a97\u53e3\u5373\u53ef\u505c\u6b62\u670d\u52a1\u3002')"
"%STICKERS_PY%" server.py --port "%STICKERS_PORT%"
if errorlevel 1 pause
