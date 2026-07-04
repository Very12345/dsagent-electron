<#
.SYNOPSIS
    dsagent-cli.ps1 — 向运行中的 dsagent-electron 发送请求（纯 PowerShell，无需 Node.js）
.DESCRIPTION
    用法:
        dsagent-cli.ps1 -p "prompt" [-Model "deepseek.fast"] [-Token "xxx"]
    环境变量:
        DSAGENT_TOKEN    API token
        DSAGENT_PORT     API 端口（默认 5858）
#>

param(
    [string]$p = "",
    [string]$Model = "",
    [string]$Token = "",
    [switch]$DeepThink = $false,
    [switch]$Help = $false,
    [switch]$TokenInfo = $false
)

$PORT = if ($env:DSAGENT_PORT) { $env:DSAGENT_PORT } else { "5858" }
$HOST = if ($env:DSAGENT_HOST) { $env:DSAGENT_HOST } else { "127.0.0.1" }
$TOKEN_FILE = "$env:USERPROFILE\.dsa\api-token.json"

function Get-Token {
    if ($Token) { return $Token }
    if ($env:DSAGENT_TOKEN) { return $env:DSAGENT_TOKEN }
    if (Test-Path $TOKEN_FILE) {
        try { return (Get-Content $TOKEN_FILE -Raw | ConvertFrom-Json).token } catch {}
    }
    return ""
}

function Invoke-ApiRequest {
    param([string]$Method, [string]$Path, $Body)
    try {
        $json = $Body | ConvertTo-Json -Compress
        $resp = Invoke-WebRequest -Uri "http://${HOST}:${PORT}${Path}" -Method $Method -Body $json -ContentType "application/json" -TimeoutSec 180 -UseBasicParsing
        return @{ StatusCode = $resp.StatusCode; Data = ($resp.Content | ConvertFrom-Json) }
    } catch {
        if ($_.Exception.InnerException -and $_.Exception.InnerException.Message -match "No connection") {
            return @{ Error = "ECONNREFUSED" }
        }
        return @{ Error = $_.Exception.Message }
    }
}

function Ensure-ServerRunning {
    try {
        Invoke-WebRequest -Uri "http://${HOST}:${PORT}/api/ping" -TimeoutSec 3 -UseBasicParsing | Out-Null
        return $true
    } catch {
        Write-Warning "dsagent-electron 未运行，正在启动..."
        $exePaths = @(
            "$PSScriptRoot\dsagent-electron.exe",
            "$PSScriptRoot\..\dsagent-electron.exe",
            "$PSScriptRoot\..\..\dsagent-electron.exe"
        )
        $exe = $null
        foreach ($ep in $exePaths) { if (Test-Path $ep) { $exe = $ep; break } }
        if (-not $exe) { return $false }

        Start-Process -FilePath $exe -WindowStyle Hidden
        $deadline = (Get-Date).AddSeconds(60)
        do {
            Start-Sleep -Seconds 3
            try {
                Invoke-WebRequest -Uri "http://${HOST}:${PORT}/api/ping" -TimeoutSec 2 -UseBasicParsing | Out-Null
                return $true
            } catch {}
        } while ((Get-Date) -lt $deadline)
        return $false
    }
}

# 帮助
if ($Help -or (-not $p -and -not $TokenInfo)) {
    Write-Host @"
dsagent-cli — 向运行中的 dsagent-electron 发送请求
用法:
  dsagent-cli.ps1 -p "prompt" [-Model modelId] [-Token xxxxxx]
  dsagent-cli.ps1 -TokenInfo
  dsagent-cli.ps1 -Help
环境变量:
  DSAGENT_TOKEN    API token
"@
    exit 0
}

# Token 信息
if ($TokenInfo) {
    if (-not (Ensure-ServerRunning)) { Write-Error "无法启动 dsagent-electron"; exit 1 }
    $token = Get-Token
    if (-not $token) { Write-Error "无法获取 token"; exit 1 }
    $result = Invoke-ApiRequest -Method POST -Path "/api/request" -Body @{ token = $token; action = "ping" }
    if ($result.StatusCode -eq 200) { Write-Host "✅ 连接成功`nHOST: $HOST`nPORT: $PORT`nTOKEN: $token" }
    elseif ($result.StatusCode -eq 403) { Write-Error "Token 无效"; exit 1 }
    else { Write-Error "连接失败: $($result.Error)"; exit 1 }
    exit 0
}

# 获取 token
$token = Get-Token
if (-not $token) {
    # 自动启动 + 读取 token 文件
    if (-not (Ensure-ServerRunning)) { Write-Error "无法启动 dsagent-electron"; exit 1 }
    Start-Sleep -Seconds 2
    $token = Get-Token
    if (-not $token) { Write-Error "无法获取 API token"; exit 1 }
}

# 构造请求
$agentId = "cli-" + [DateTime]::Now.Ticks + "-" + (Get-Random -Maximum 999999)
$payload = @{
    agentId = $agentId
    token = $token
    message = @{ text = $p }
    deepThink = $DeepThink
    forceNew = $true
}
if ($Model) {
    $payload.clusterConfig = @{
        templateId = "minimal"
        roles = @{ main = @{ modelId = $Model } }
        subagentDefaults = @{ modelId = $Model }
    }
}

# 发送请求
$result = Invoke-ApiRequest -Method POST -Path "/api/request" -Body $payload
if ($result.Error -eq "ECONNREFUSED") {
    Write-Error "连接失败：dsagent-electron 未运行"
    exit 1
}
if ($result.StatusCode -eq 200 -and $result.Data) {
    if ($result.Data.success) {
        $output = $result.Data.data.markdown
        if ($result.Data.data.think) {
            $output = "> " + ($result.Data.data.think -replace "`n", "`n> ") + "`n`n" + $output
        }
        Write-Host $output
        exit 0
    } else {
        Write-Error "错误: $($result.Data.error)"
        exit 1
    }
} elseif ($result.StatusCode -eq 403) {
    Write-Error "Token 无效"
    exit 1
} else {
    Write-Error "HTTP $($result.StatusCode): $($result.Error)"
    exit 1
}
