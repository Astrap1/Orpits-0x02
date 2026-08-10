@echo off
setlocal EnableExtensions

title x2pad Python and C++ setup

echo ============================================================
echo  x2pad optional Python and C++ code support
echo ============================================================
echo.
echo This helper installs tools used by x2pad code boxes when they
echo are not already available on this computer:
echo.
echo   Python: Python 3.14 from the Python Software Foundation
echo   C++:    WinLibs GCC/MinGW-w64 (POSIX threads, UCRT)
echo.
echo Windows Package Manager (winget) downloads and installs them.
echo They are separate third-party programs, not part of x2pad.
echo Review their terms before continuing:
echo   https://docs.python.org/3/license.html
echo   https://winlibs.com/#license
echo.

call :check_python
if errorlevel 1 (
  set "NEED_PYTHON=1"
  echo [MISSING] Python 3
) else (
  set "NEED_PYTHON=0"
  echo [OK] Python 3 is already available.
)

call :check_cpp
if errorlevel 1 (
  set "NEED_CPP=1"
  echo [MISSING] A supported C++ compiler
) else (
  set "NEED_CPP=0"
  echo [OK] A supported C++ compiler is already available.
)

echo.
if "%NEED_PYTHON%%NEED_CPP%"=="00" (
  echo Nothing needs to be installed. x2pad code support is ready.
  goto :success
)

where winget.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Windows Package Manager was not found.
  echo Install or update "App Installer" from the Microsoft Store,
  echo then run this helper again:
  echo https://apps.microsoft.com/detail/9nblggh4nns1
  goto :failure
)

choice /C YN /N /M "Download and install the missing tools now? [Y/N]: "
if errorlevel 2 (
  echo.
  echo Setup cancelled. No packages were installed by this helper.
  goto :cancelled
)

if "%NEED_PYTHON%"=="1" (
  echo.
  echo Installing Python 3.14...
  winget install --id Python.Python.3.14 --exact --source winget --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo [ERROR] Python installation did not complete successfully.
    set "INSTALL_FAILED=1"
  )
)

if "%NEED_CPP%"=="1" (
  echo.
  echo Installing the WinLibs C++ toolchain...
  winget install --id BrechtSanders.WinLibs.POSIX.UCRT --exact --source winget --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo [ERROR] C++ toolchain installation did not complete successfully.
    set "INSTALL_FAILED=1"
  )
)

rem WinGet exposes portable package commands through this directory.
rem Add it for verification in this process; newly opened apps receive
rem the persistent PATH registered by the installers and WinGet.
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"

echo.
echo Verifying tools...
call :check_python
if errorlevel 1 (
  echo [WARNING] Python is not visible in this terminal yet.
  set "VERIFY_FAILED=1"
) else (
  echo [OK] Python 3 is ready.
)

call :check_cpp
if errorlevel 1 (
  echo [WARNING] The C++ compiler is not visible in this terminal yet.
  set "VERIFY_FAILED=1"
) else (
  echo [OK] The C++ compiler is ready.
)

if defined INSTALL_FAILED goto :failure

echo.
echo Installation finished. Close and reopen x2pad before running code.
if defined VERIFY_FAILED (
  echo If x2pad still cannot find a tool after reopening, restart Windows
  echo once so all PATH changes take effect.
)
goto :success

:check_python
where py.exe >nul 2>&1
if not errorlevel 1 (
  py -3 -c "import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)" >nul 2>&1
  if not errorlevel 1 exit /b 0
)
where python.exe >nul 2>&1
if not errorlevel 1 (
  python -c "import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)" >nul 2>&1
  if not errorlevel 1 exit /b 0
)
exit /b 1

:check_cpp
where g++.exe >nul 2>&1
if not errorlevel 1 (
  g++ --version >nul 2>&1
  if not errorlevel 1 exit /b 0
)
where clang++.exe >nul 2>&1
if not errorlevel 1 (
  clang++ --version >nul 2>&1
  if not errorlevel 1 exit /b 0
)
where cl.exe >nul 2>&1
if not errorlevel 1 (
  cl >nul 2>&1
  if not errorlevel 1 exit /b 0
)
exit /b 1

:success
echo.
pause
exit /b 0

:cancelled
echo.
pause
exit /b 2

:failure
echo.
echo Setup was not completed. Review the messages above and try again.
echo You can also install Python 3 and a supported C++ compiler manually.
echo.
pause
exit /b 1
