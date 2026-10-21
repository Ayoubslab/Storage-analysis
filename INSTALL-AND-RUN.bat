@echo off
setlocal
title SSD Allocation-Based Scan - Install and Run

set "BOOTSTRAP=%TEMP%\SSD-Allocation-Based-Scan-bootstrap.ps1"
set "BOOTSTRAP_URL=https://raw.githubusercontent.com/Ayoubslab/Storage-analysis/main/bootstrap.ps1"

echo SSD Allocation-Based Scan
echo Downloading the verified project bootstrap...
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '%BOOTSTRAP_URL%' -OutFile '%BOOTSTRAP%'"
if errorlevel 1 (
  echo.
  echo Bootstrap download failed. Check the Internet connection and try again.
  echo Source: %BOOTSTRAP_URL%
  echo.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" %*
set "runExit=%ERRORLEVEL%"

echo.
if not "%runExit%"=="0" (
  echo Installation or analysis failed. Review the error shown above.
) else (
  echo Installation and analysis finished successfully.
)
echo.
pause
exit /b %runExit%
