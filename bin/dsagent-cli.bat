@echo off
chcp 65001 > nul
REM dsagent-cli.bat
REM 先找打包的 Node.js，兜底用系统 node

set "SCRIPT_DIR=%~dp0"
set "CLI_JS=%SCRIPT_DIR%dsagent-cli.js"

if not exist "%CLI_JS%" (
    echo error: dsagent-cli.js not found
    pause
    exit /b 1
)

set "NODE_PATH="
if exist "%SCRIPT_DIR%..\resources\app\node_modules\electron\dist\node.exe" (
    set "NODE_PATH=%SCRIPT_DIR%..\resources\app\node_modules\electron\dist\node.exe"
) else if exist "%SCRIPT_DIR%node.exe" (
    set "NODE_PATH=%SCRIPT_DIR%node.exe"
) else if exist "%SCRIPT_DIR%..\node.exe" (
    set "NODE_PATH=%SCRIPT_DIR%..\node.exe"
)

if defined NODE_PATH (
    "%NODE_PATH%" "%CLI_JS%" %*
) else (
    node "%CLI_JS%" %*
)

exit /b %ERRORLEVEL%
