@echo off
setlocal enabledelayedexpansion

if not defined AGENT_CONDA_ENV set "AGENT_CONDA_ENV="

REM ---- Activate Python/Conda FIRST ----
if not defined CONDA_DEFAULT_ENV (
    where conda >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        for /f "delims=" %%C in ('where conda 2^>nul') do set "CONDA_CMD=%%C"
        for %%I in ("!CONDA_CMD!") do set "CONDABIN_DIR=%%~dpI"
        set "CONDABIN_DIR=!CONDABIN_DIR:~0,-1!"
        for %%I in ("!CONDABIN_DIR!") do set "CONDA_ROOT=%%~dpI"
        set "CONDA_ROOT=!CONDA_ROOT:~0,-1!"

        if exist "!CONDA_ROOT!\condabin\conda_hook.bat" (
            call "!CONDA_ROOT!\condabin\conda_hook.bat"
        )

        if defined AGENT_CONDA_ENV (
            echo Activating conda environment: !AGENT_CONDA_ENV!
            call conda activate !AGENT_CONDA_ENV!
            if !ERRORLEVEL! EQU 0 (
                echo Conda environment activated successfully.
            ) else (
                echo WARNING: conda activate failed for !AGENT_CONDA_ENV!; continuing with PATH Python if available.
            )
        )
    ) else (
        echo WARNING: conda not found in PATH.
    )
)

echo Python check:
where python >nul 2>&1 && (python --version 2>&1) || (echo WARNING: Python still not in PATH)

echo ========================================
echo iEEG Agent Runtime
echo ========================================
echo.

set SERVER_PORT=8001
if not defined PYHFO_AGENT_SERVICE_TOKEN if not defined AGENT_SERVICE_TOKEN (
    echo Set AGENT_SERVICE_TOKEN in this shell before starting the runtime.
    exit /b 1
)

cd /d %~dp0
echo Working directory: %CD%
echo.

if defined CONDA_DEFAULT_ENV (
    echo Already in conda environment: %CONDA_DEFAULT_ENV%
    goto :run_server
)

where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Using system Python
    python --version
    echo.
    goto :run_server
)

echo ========================================
echo ERROR: Python not found!
echo ========================================
echo.
echo Please install Python or conda:
echo   - Conda: https://www.anaconda.com/
echo   - Python: https://www.python.org/downloads/
echo.
echo Or activate your conda environment manually:
echo   conda activate YOUR_ENV
echo   cd ieeg-agent
echo   python -m uvicorn runtime.main:app --reload --port %SERVER_PORT%
echo.
pause
exit /b 1

:run_server
echo ========================================
echo Installing/Checking dependencies...
echo ========================================
echo.

if exist requirements.txt (
    pip install -r requirements.txt --exists-action i
    if %ERRORLEVEL% EQU 0 (
        echo Dependencies installed successfully
    ) else (
        echo Warning: Some dependencies may not have installed correctly
        echo Continuing anyway...
    )
) else (
    echo Warning: requirements.txt not found
)
echo.

echo ========================================
echo Starting Agent Server
echo ========================================
echo.
echo Server will run at: http://localhost:%SERVER_PORT%
echo Health check: http://localhost:%SERVER_PORT%/health
echo Internal API: http://localhost:%SERVER_PORT%/internal/agent/v1/health
echo JWT secret bootstrap: IEEG_JWT_SECRET_KEY or AGENT_JWT_SECRET_KEY should be set for this session
echo Sensitive internal debug switch: IEEG_ALLOW_INTERNAL_DEBUG_DETAILS=%IEEG_ALLOW_INTERNAL_DEBUG_DETAILS%
echo.
echo Press Ctrl+C to stop the server
echo ========================================
echo.

python -m uvicorn runtime.main:app --reload --port %SERVER_PORT% --host 127.0.0.1

echo.
echo Agent server stopped.
pause
