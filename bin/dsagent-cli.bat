@echo off
REM dsagent-cli.bat — 包装脚本，在打包的 Electron 应用中调用 CLI
REM 查找打包后的 Node.js 运行时，执行 dsagent-cli.js

set "SCRIPT_DIR=%~dp0"
set "CLI_JS=%SCRIPT_DIR%dsagent-cli.js"

REM 检查 CLI 脚本是否存在
if not exist "%CLI_JS%" (
    REM 尝试在上级目录查找（开发模式）
    if exist "%SCRIPT_DIR%..\bin\dsagent-cli.js" (
        set "CLI_JS=%SCRIPT_DIR%..\bin\dsagent-cli.js"
    ) else (
        echo 错误: 找不到 dsagent-cli.js
        echo 当前位置: %SCRIPT_DIR%
        pause
        exit /b 1
    )
)

REM 查找 Electron 自带的 Node.js
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
    REM 兜底：用系统 PATH 中的 node
    node "%CLI_JS%" %*
)

exit /b %ERRORLEVEL%
