﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿# Win32 API Helper - Operate native Windows windows
# Usage: powershell -NoProfile -NonInteractive -File winapi.ps1 < command.json

# 设置输出编码为 UTF-8，确保中文等 Unicode 字符不被截断
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -ReferencedAssemblies "System.Drawing.dll" @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
using System.Text;
using System.Diagnostics;

public class WinAPI {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    public const uint PW_CLIENTONLY = 0x00000001;

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out bool pvAttribute, int cbAttribute);
    public const int DWMWA_CLOAKED = 14;

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    public const int SW_RESTORE = 9;

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x; public int y; }

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, SendMessageTimeoutFlags fuFlags, uint uTimeout, out UIntPtr lpdwResult);

    [Flags]
    public enum SendMessageTimeoutFlags : uint {
        SMTO_NORMAL = 0, SMTO_BLOCK = 1, SMTO_ABORTIFHUNG = 2, SMTO_NOTIMEOUTIFNOTHUNG = 8
    }

    public const uint WM_LBUTTONDOWN = 0x201;
    public const uint WM_LBUTTONUP = 0x202;
    public const uint WM_LBUTTONDBLCLK = 0x203;
    public const uint WM_RBUTTONDOWN = 0x204;
    public const uint WM_RBUTTONUP = 0x205;
    public const uint WM_KEYDOWN = 0x100;
    public const uint WM_KEYUP = 0x101;
    public const uint WM_CHAR = 0x102;
    public const uint WM_SYSKEYDOWN = 0x104;
    public const uint WM_SYSKEYUP = 0x105;
    public const uint WM_SETTEXT = 0x000C;
    public const uint WM_GETTEXT = 0x000D;
    public const uint WM_GETTEXTLENGTH = 0x000E;
    public const uint WM_CLOSE = 0x0010;

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public MOUSEKEYBDHARDWAREINPUT mkhi;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct MOUSEKEYBDHARDWAREINPUT {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;
    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static string GetWindowTextValue(IntPtr hWnd) {
        int len = GetWindowTextLength(hWnd);
        if (len == 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string GetWindowClass(IntPtr hWnd) {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
}
"@

Add-Type -AssemblyName System.Windows.Forms

function Get-ProcessName($procId) {
    try { return (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { return "unknown" }
}

function Test-ValidWindow($hWnd) {
    # 检查是否 cloaked（UWP/Edge 后台标签页）
    $cloaked = $false
    $hr = [WinAPI]::DwmGetWindowAttribute($hWnd, [WinAPI]::DWMWA_CLOAKED, [ref]$cloaked, 4)
    if ($hr -eq 0 -and $cloaked) { return $false }
    # 检查坐标是否有效（但允许最小化窗口通过）
    $rect = New-Object WinAPI+RECT
    if (![WinAPI]::GetWindowRect($hWnd, [ref]$rect)) { return $false }
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    # 最小化窗口的坐标是 (-32000,-32000)，width/height 为 0，但依然有效
    $isMin = [WinAPI]::IsIconic($hWnd)
    # 非最小化窗口需要正尺寸和有效坐标
    if (!$isMin) {
        if ($w -le 0 -or $h -le 0) { return $false }
        if ($rect.Left -lt -10000 -or $rect.Top -lt -10000) { return $false }
    }
    return $true
}

function Get-WindowState($hWnd) {
    if ([WinAPI]::IsIconic($hWnd)) { return "minimized" }
    # 检测最大化：工作区尺寸匹配屏幕
    $rect = New-Object WinAPI+RECT
    [WinAPI]::GetWindowRect($hWnd, [ref]$rect)
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    $sw = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
    $sh = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
    if ($w -ge $sw -and $h -ge $sh) { return "maximized" }
    return "normal"
}

function Invoke-WinAPI {
    param($cmd)
    $action = $cmd.action
    $params = $cmd.params

    switch ($action) {
        "list" {
            $filter = $params.filter
            $result = @()
            $handles = New-Object System.Collections.ArrayList
            [WinAPI]::EnumWindows({
                param($hWnd, $lParam)
                if (Test-ValidWindow $hWnd) {
                    $title = [WinAPI]::GetWindowTextValue($hWnd)
                    if ($title -ne "") {
                        [void]$handles.Add($hWnd)
                    }
                }
                return 1
            }, [IntPtr]::Zero)

            foreach ($h in $handles) {
                $title = [WinAPI]::GetWindowTextValue($h)
                if ($filter -and $title -notmatch $filter) { continue }
                $rect = New-Object WinAPI+RECT
                [WinAPI]::GetWindowRect($h, [ref]$rect)
                $pidVal = 0
                [WinAPI]::GetWindowThreadProcessId($h, [ref]$pidVal)
                $cls = [WinAPI]::GetWindowClass($h)
                $procName = Get-ProcessName $pidVal
                $result += @{
                    id = $h.ToString()
                    title = $title
                    className = $cls
                    processId = $pidVal
                    processName = $procName
                    x = $rect.Left
                    y = $rect.Top
                    width = $rect.Right - $rect.Left
                    height = $rect.Bottom - $rect.Top
                    windowState = Get-WindowState $h
                }
            }
            return @{success=$true; windows=$result; count=$result.Count}
        }

        "info" {
            $hWnd = [IntPtr][int64]$params.id
            $rect = New-Object WinAPI+RECT
            [WinAPI]::GetWindowRect($hWnd, [ref]$rect)
            $title = [WinAPI]::GetWindowTextValue($hWnd)
            $cls = [WinAPI]::GetWindowClass($hWnd)
            $pidVal = 0
            [WinAPI]::GetWindowThreadProcessId($hWnd, [ref]$pidVal)
            $procName = Get-ProcessName $pidVal
            $visible = [WinAPI]::IsWindowVisible($hWnd)
            return @{
                success=$true
                window=@{
                    id = $hWnd.ToString()
                    title = $title
                    className = $cls
                    processId = $pidVal
                    processName = $procName
                    visible = $visible
                    x = $rect.Left
                    y = $rect.Top
                    width = $rect.Right - $rect.Left
                    height = $rect.Bottom - $rect.Top
                    windowState = Get-WindowState $hWnd
                }
            }
        }

        "focus" {
            $hWnd = [IntPtr][int64]$params.id
            # 线程附加 + 置前
            $targetTid = 0
            [WinAPI]::GetWindowThreadProcessId($hWnd, [ref]$targetTid)
            $foreHwnd = [WinAPI]::GetForegroundWindow()
            $foreTid = 0
            [WinAPI]::GetWindowThreadProcessId($foreHwnd, [ref]$foreTid)
            if ($foreTid -ne $targetTid) {
                [WinAPI]::AttachThreadInput($foreTid, $targetTid, $true) | Out-Null
            }
            $ok = [WinAPI]::SetForegroundWindow($hWnd)
            if ($foreTid -ne $targetTid) {
                [WinAPI]::AttachThreadInput($foreTid, $targetTid, $false) | Out-Null
            }
            return @{success=$ok; message=if($ok){"Window focused successfully"}else{"Failed to focus window"}}
        }

        "move" {
            $hWnd = [IntPtr][int64]$params.id
            $x = if ($null -ne $params.x) { $params.x } else { 0 }
            $y = if ($null -ne $params.y) { $params.y } else { 0 }
            $w = if ($null -ne $params.width) { $params.width } else { 800 }
            $h = if ($null -ne $params.height) { $params.height } else { 600 }
            $ok = [WinAPI]::MoveWindow($hWnd, $x, $y, $w, $h, $true)
            return @{success=$ok; message=if($ok){"Window moved/resized successfully"}else{"MoveWindow failed"}}
        }

        "click" {
            $hWnd = [IntPtr][int64]$params.id
            $clientX = $params.x
            $clientY = $params.y
            $btn = $params.button

            # 如果窗口最小化，先恢复
            $isMin = [WinAPI]::IsIconic($hWnd)
            if ($isMin) {
                [WinAPI]::ShowWindow($hWnd, [WinAPI]::SW_RESTORE) | Out-Null
                Start-Sleep -Milliseconds 200
            }

            # 线程附加：让本线程能设置目标窗口为前台
            $targetTid = 0
            [WinAPI]::GetWindowThreadProcessId($hWnd, [ref]$targetTid)
            $foreHwnd = [WinAPI]::GetForegroundWindow()
            $foreTid = 0
            [WinAPI]::GetWindowThreadProcessId($foreHwnd, [ref]$foreTid)
            if ($foreTid -ne $targetTid) {
                [WinAPI]::AttachThreadInput($foreTid, $targetTid, $true) | Out-Null
            }
            [WinAPI]::SetForegroundWindow($hWnd) | Out-Null
            Start-Sleep -Milliseconds 150
            if ($foreTid -ne $targetTid) {
                [WinAPI]::AttachThreadInput($foreTid, $targetTid, $false) | Out-Null
            }

            # 计算屏幕坐标
            $rect = New-Object WinAPI+RECT
            [WinAPI]::GetWindowRect($hWnd, [ref]$rect)
            $screenX = $rect.Left + $clientX
            $screenY = $rect.Top + $clientY

            # 检查屏幕有效性
            $sw = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
            $sh = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
            if ($screenX -lt 0 -or $screenX -gt $sw -or $screenY -lt 0 -or $screenY -gt $sh) {
                return @{success=$false; error="Click position ($screenX, $screenY) is outside screen bounds"}
            }

            # SendInput：绝对坐标移动鼠标
            $inputMouseMove = New-Object WinAPI+INPUT
            $inputMouseMove.type = [WinAPI]::INPUT_MOUSE
            $inputMouseMove.mkhi.mi = New-Object WinAPI+MOUSEINPUT
            $inputMouseMove.mkhi.mi.dx = [int]($screenX * 65535 / $sw)
            $inputMouseMove.mkhi.mi.dy = [int]($screenY * 65535 / $sh)
            $inputMouseMove.mkhi.mi.dwFlags = [WinAPI]::MOUSEEVENTF_ABSOLUTE -bor [WinAPI]::MOUSEEVENTF_MOVE
            [WinAPI]::SendInput(1, @($inputMouseMove), [System.Runtime.InteropServices.Marshal]::SizeOf($inputMouseMove)) | Out-Null
            Start-Sleep -Milliseconds 80

            # 鼠标按下/释放
            if ($btn -eq "right") {
                $downFlag = [WinAPI]::MOUSEEVENTF_RIGHTDOWN
                $upFlag = [WinAPI]::MOUSEEVENTF_RIGHTUP
            } else {
                $downFlag = [WinAPI]::MOUSEEVENTF_LEFTDOWN
                $upFlag = [WinAPI]::MOUSEEVENTF_LEFTUP
            }

            $inputDown = New-Object WinAPI+INPUT
            $inputDown.type = [WinAPI]::INPUT_MOUSE
            $inputDown.mkhi.mi = New-Object WinAPI+MOUSEINPUT
            $inputDown.mkhi.mi.dwFlags = $downFlag
            [WinAPI]::SendInput(1, @($inputDown), [System.Runtime.InteropServices.Marshal]::SizeOf($inputDown)) | Out-Null
            Start-Sleep -Milliseconds 50

            $inputUp = New-Object WinAPI+INPUT
            $inputUp.type = [WinAPI]::INPUT_MOUSE
            $inputUp.mkhi.mi = New-Object WinAPI+MOUSEINPUT
            $inputUp.mkhi.mi.dwFlags = $upFlag
            [WinAPI]::SendInput(1, @($inputUp), [System.Runtime.InteropServices.Marshal]::SizeOf($inputUp)) | Out-Null

            return @{success=$true; message="Clicked at ($clientX, $clientY) with $btn button"}
        }

        "input" {
            $hWnd = [IntPtr][int64]$params.id
            $text = $params.text

            # 如果最小化，先恢复
            if ([WinAPI]::IsIconic($hWnd)) {
                [WinAPI]::ShowWindow($hWnd, [WinAPI]::SW_RESTORE) | Out-Null
                Start-Sleep -Milliseconds 200
            }

            # 线程附加 + 置前
            $targetTid = 0
            [WinAPI]::GetWindowThreadProcessId($hWnd, [ref]$targetTid)
            $foreHwnd = [WinAPI]::GetForegroundWindow()
            $foreTid = 0
            [WinAPI]::GetWindowThreadProcessId($foreHwnd, [ref]$foreTid)
            if ($foreTid -ne $targetTid) {
                [WinAPI]::AttachThreadInput($foreTid, $targetTid, $true) | Out-Null
            }
            [WinAPI]::SetForegroundWindow($hWnd) | Out-Null
            Start-Sleep -Milliseconds 150
            if ($foreTid -ne $targetTid) {
                [WinAPI]::AttachThreadInput($foreTid, $targetTid, $false) | Out-Null
            }

            for ($i = 0; $i -lt $text.Length; $i++) {
                $ch = $text[$i]
                $inputDown = New-Object WinAPI+INPUT
                $inputDown.type = [WinAPI]::INPUT_KEYBOARD
                $inputDown.mkhi.ki = New-Object WinAPI+KEYBDINPUT
                $inputDown.mkhi.ki.wScan = [int][char]$ch
                $inputDown.mkhi.ki.dwFlags = 4
                [WinAPI]::SendInput(1, @($inputDown), [System.Runtime.InteropServices.Marshal]::SizeOf($inputDown)) | Out-Null

                $inputUp = New-Object WinAPI+INPUT
                $inputUp.type = [WinAPI]::INPUT_KEYBOARD
                $inputUp.mkhi.ki = New-Object WinAPI+KEYBDINPUT
                $inputUp.mkhi.ki.wScan = [int][char]$ch
                $inputUp.mkhi.ki.dwFlags = 4 -bor 2
                [WinAPI]::SendInput(1, @($inputUp), [System.Runtime.InteropServices.Marshal]::SizeOf($inputUp)) | Out-Null

                Start-Sleep -Milliseconds 10
            }

            $len = $text.Length
            return @{success=$true; message="Sent $len characters to window"}
        }

        "screenshot" {
            $hWnd = [IntPtr][int64]$params.id
            $savePath = $params.savePath

            $rect = New-Object WinAPI+RECT
            [WinAPI]::GetWindowRect($hWnd, [ref]$rect)
            $w = $rect.Right - $rect.Left
            $h = $rect.Bottom - $rect.Top

            if ($w -le 0 -or $h -le 0) {
                return @{success=$false; error="Invalid window size ($w x $h)"}
            }

            $bmp = New-Object System.Drawing.Bitmap($w, $h)
            $graphics = [System.Drawing.Graphics]::FromImage($bmp)
            $hdc = $graphics.GetHdc()
            [WinAPI]::PrintWindow($hWnd, $hdc, [WinAPI]::PW_CLIENTONLY) | Out-Null
            $graphics.ReleaseHdc($hdc)

            # 坐标网格叠加层（辅助 AI 定位）
            $grid = if ($null -ne $params.grid) { [int]$params.grid } else { 0 }
            if ($grid -gt 0) {
                $colors = @(
                    [System.Drawing.Brushes]::Red,
                    [System.Drawing.Brushes]::Blue,
                    [System.Drawing.Brushes]::Green,
                    [System.Drawing.Brushes]::Orange,
                    [System.Drawing.Brushes]::Purple
                )
                $font = New-Object System.Drawing.Font("Consolas", 9, [System.Drawing.FontStyle]::Bold)
                # 顶部坐标点
                for ($gx = 0; $gx -lt $w; $gx += $grid) {
                    $c = $colors[($gx / $grid) % $colors.Length]
                    $graphics.FillEllipse($c, $gx - 4, 0, 8, 8)
                    if ($gx % 100 -eq 0) {
                        $graphics.DrawString($gx.ToString(), $font, [System.Drawing.Brushes]::White, $gx + 4, 1)
                    }
                }
                # 左侧坐标点
                for ($gy = 0; $gy -lt $h; $gy += $grid) {
                    $c = $colors[($gy / $grid) % $colors.Length]
                    $graphics.FillEllipse($c, 0, $gy - 4, 8, 8)
                    if ($gy % 100 -eq 0) {
                        $graphics.DrawString($gy.ToString(), $font, [System.Drawing.Brushes]::White, 1, $gy + 4)
                    }
                }
            }

            $graphics.Dispose()

            $bmp.Save($savePath, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()

            return @{success=$true; path=$savePath; width=$w; height=$h}
        }

        "find" {
            $title = $params.title
            $procName = $params.processName
            $result = @()
            $handles = New-Object System.Collections.ArrayList
            [WinAPI]::EnumWindows({
                param($hWnd, $lParam)
                if (Test-ValidWindow $hWnd) {
                    $t = [WinAPI]::GetWindowTextValue($hWnd)
                    if ($t -ne "") { [void]$handles.Add($hWnd) }
                }
                return 1
            }, [IntPtr]::Zero)

            foreach ($h in $handles) {
                $t = [WinAPI]::GetWindowTextValue($h)
                $pidVal = 0
                [WinAPI]::GetWindowThreadProcessId($h, [ref]$pidVal)
                $pn = Get-ProcessName $pidVal
                if ($title -and $t -notmatch $title) { continue }
                if ($procName -and $pn -notmatch $procName) { continue }
                $rect = New-Object WinAPI+RECT
                [WinAPI]::GetWindowRect($h, [ref]$rect)
                $result += @{
                    id = $h.ToString()
                    title = $t
                    processName = $pn
                    processId = $pidVal
                    x = $rect.Left; y = $rect.Top
                    width = $rect.Right - $rect.Left
                    height = $rect.Bottom - $rect.Top
                    windowState = Get-WindowState $h
                }
            }
            return @{success=$true; windows=$result; count=$result.Count}
        }

        default {
            return @{success=$false; error="Unknown action: $action"}
        }
    }
}

try {
    $jsonContent = [Console]::In.ReadToEnd()
    $cmdObj = $jsonContent | ConvertFrom-Json
    # 抑制所有中间管道输出（EnumWindows 回调等），只取最后的返回结果
    $allOutput = Invoke-WinAPI -cmd $cmdObj
    $result = $allOutput | Select-Object -Last 1
    if ($result) {
        $result | ConvertTo-Json -Depth 10 -Compress
    } else {
        @{success=$false; error="No result returned"} | ConvertTo-Json -Depth 5 -Compress
    }
} catch {
    $err = @{success=$false; error=$_.Exception.Message}
    $err | ConvertTo-Json -Depth 5 -Compress
}