@echo off
setlocal
set TASK=%~1
set GOAL=%~2
powershell -ExecutionPolicy Bypass -File "%~dp0activate.ps1" -Task "%TASK%" -Goal "%GOAL%" -Watch
