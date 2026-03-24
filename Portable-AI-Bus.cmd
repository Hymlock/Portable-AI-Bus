@echo off
setlocal
set CMD=%~1
set ARG1=%~2
set ARG2=%~3
set ARG3=%~4
set ARG4=%~5

if /I "%CMD%"=="install" (
  powershell -ExecutionPolicy Bypass -File "%~dp0Portable-AI-Bus.ps1" install "%ARG1%" "%ARG2%" -Bus "%ARG3%" %ARG4%
  exit /b %errorlevel%
)

if /I "%CMD%"=="start" (
  powershell -ExecutionPolicy Bypass -File "%~dp0Portable-AI-Bus.ps1" start "%ARG1%" "%ARG2%" -Bus "%ARG3%" %ARG4%
  exit /b %errorlevel%
)

powershell -ExecutionPolicy Bypass -File "%~dp0Portable-AI-Bus.ps1" %CMD%
