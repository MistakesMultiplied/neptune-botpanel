@echo off
title neptune Panel
cls
echo ===================================
echo    Starting neptune Panel...
echo ===================================
echo.

rem Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Error: Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

rem Check if required npm packages are installed
if not exist "node_modules" (
    echo Installing required dependencies...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo Error: Failed to install dependencies.
        pause
        exit /b 1
    )
)

rem Make sure chalk is installed (required for start.js)
if not exist "node_modules\chalk" (
    echo Installing chalk package...
    call npm install chalk
)

rem Make sure open is installed (for browser opening)
if not exist "node_modules\open" (
    echo Installing open package...
    call npm install open
)

rem Start the panel
node start.js

rem If node.js exits with an error, pause so user can see
if %ERRORLEVEL% neq 0 (
    echo.
    echo Panel exited with an error.
    pause
) 