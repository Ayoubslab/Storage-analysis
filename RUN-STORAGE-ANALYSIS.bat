@echo off
setlocal
title Storage allocation-based scan

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-analysis.ps1" %*
set "runExit=%ERRORLEVEL%"

echo.
if not "%runExit%"=="0" (
  echo Analysis failed. Review the error shown above.
) else (
  echo Analysis finished successfully.
)
echo.
pause
exit /b %runExit%
