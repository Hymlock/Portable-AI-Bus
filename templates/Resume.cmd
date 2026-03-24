@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0.ai-bus\Portable-AI-Bus.ps1" resume -Bus "Portable-AI-Bus"
