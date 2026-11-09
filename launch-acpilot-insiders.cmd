@echo off
setlocal
set "CLI=%ProgramFiles%\Microsoft VS Code Insiders\bin\code-insiders.cmd"
if not exist "%CLI%" (
  echo VS Code Insiders CLI not found: %CLI% 1>&2
  exit /b 1
)
call "%CLI%" --enable-proposed-api wlxms.acpilot %*
