@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0.ai-bus\Portable-AI-Bus.ps1" start "%~1" "%~2" -Bus "Portable-AI-Bus" %3
