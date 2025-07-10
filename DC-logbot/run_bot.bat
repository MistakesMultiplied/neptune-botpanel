@echo off
echo ================================
echo  TF2 Chat Relay Discord Bot
echo ================================
echo.

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH
    echo Please install Python from https://python.org
    pause
    exit /b 1
)

REM Check if discord.py is installed
python -c "import discord" >nul 2>&1
if errorlevel 1 (
    echo Installing dependencies...
    pip install -r requirements.txt
    if errorlevel 1 (
        echo ERROR: Failed to install dependencies
        pause
        exit /b 1
    )
)

REM Check if config file exists
if not exist "config.json" (
    echo WARNING: config.json not found
    echo Running config fixer...
    python fix_config.py
    echo.
)

REM Check if bot is configured
python -c "import sys, os, json; sys.path.append(os.getcwd()); exec(open('check_config.py').read())" 2>nul
if errorlevel 1 (
    echo.
    echo ERROR: Bot configuration issue detected!
    echo Running config fixer to diagnose...
    echo.
    python fix_config.py
    echo.
    echo Please fix the configuration issues above and try again
    echo See README.md for setup instructions
    pause
    exit /b 1
)

echo Starting bot...
echo Press Ctrl+C to stop
echo.

python discord_chat_relay.py

echo.
echo Bot stopped.
pause 