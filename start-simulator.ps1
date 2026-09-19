param(
    [switch]$RestartApi,
    [switch]$RestartSimulator,
    # Capture the simulator's console output to logs/simulator.*.log. Redirecting
    # its streams forces UseShellExecute=$false, and this build then starts with
    # no window (MainWindowHandle stays 0), so a level cannot be selected. Only
    # use this for headless debugging.
    [switch]$LogSimulator
)

$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
$logDir = Join-Path $projectDir 'logs'
$listenerPidFile = Join-Path $logDir 'listener.pid'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Stop-ListenerFromPidFile {
    if (-not (Test-Path -LiteralPath $listenerPidFile)) { return }
    $listenerPid = [int](Get-Content -LiteralPath $listenerPidFile -Raw)
    $listener = Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
    if ($listener -and $listener.ProcessName -eq 'node') {
        Stop-Process -Id $listenerPid -Force
        Start-Sleep -Milliseconds 500
    }
    Remove-Item -LiteralPath $listenerPidFile -Force -ErrorAction SilentlyContinue
}

if ($RestartApi) { Stop-ListenerFromPidFile }
if ($RestartSimulator) {
    Get-Process ParkingSimulator -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

$apiAlreadyRunning = $false
try {
    $health = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 2
    if ($health.status -ne 'ok') { throw 'Unexpected listener response' }
    $apiAlreadyRunning = $true
} catch {
    $listenerProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"' + (Join-Path $projectDir 'webhook-listener.cjs') + '"') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'listener.stdout.log') -RedirectStandardError (Join-Path $logDir 'listener.stderr.log') -PassThru
    Set-Content -LiteralPath $listenerPidFile -Value $listenerProcess.Id
    Start-Sleep -Seconds 1
    Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 5 | Out-Null
}

$simulatorProcess = Get-Process ParkingSimulator -ErrorAction SilentlyContinue
$simulatorApiHealthy = $false
if ($simulatorProcess) {
    try {
        $loginBody = '{"email":"admin","password":"admin"}'
        $login = Invoke-RestMethod 'http://127.0.0.1:9898/api/v1/auth/login' -Method Post -ContentType 'application/json' -Body $loginBody -TimeoutSec 3
        $simulatorApiHealthy = [bool]$login.token
    } catch {
        Write-Warning 'Simulator window exists but its REST API is unavailable; restarting it.'
        $simulatorProcess | Stop-Process -Force
        Start-Sleep -Milliseconds 500
        $simulatorProcess = $null
    }
}

if (-not $simulatorProcess) {
    $simDir = Join-Path $projectDir 'ParkingSimulator-win-x64'
    # This build enables the Windows Event Log provider even for a desktop run.
    # The current account cannot write that log, and Kestrel can otherwise stop
    # while the simulation window remains open. Disable only that logging sink
    # for the child process; simulator files and behavior are not modified.
    $previousEventLogLevel = $env:Logging__EventLog__LogLevel__Default
    try {
        $env:Logging__EventLog__LogLevel__Default = 'None'
        $simulatorExe = Join-Path $simDir 'ParkingSimulator.exe'
        if ($LogSimulator) {
            $simulatorProcess = Start-Process -FilePath $simulatorExe -WorkingDirectory $simDir -WindowStyle Normal -RedirectStandardOutput (Join-Path $logDir 'simulator.stdout.log') -RedirectStandardError (Join-Path $logDir 'simulator.stderr.log') -PassThru
        } else {
            # No redirection, so the simulator gets its normal window.
            $simulatorProcess = Start-Process -FilePath $simulatorExe -WorkingDirectory $simDir -WindowStyle Normal -PassThru
        }
    } finally {
        $env:Logging__EventLog__LogLevel__Default = $previousEventLogLevel
    }
}

if ($apiAlreadyRunning) {
    Write-Host 'Parking control API: already running (use -RestartApi after code changes)'
} else {
    Write-Host 'Parking control API: started'
}
if ($simulatorApiHealthy) {
    Write-Host 'Simulator:           already running and REST API is healthy'
} elseif ($LogSimulator) {
    Write-Host 'Simulator:           started headless (-LogSimulator); it has NO window'
} else {
    Write-Host 'Simulator:           started; select Level 1 in its window'
}
Write-Host 'Control API:         http://127.0.0.1:8080/api/v1'
Write-Host 'Simulator API:       http://127.0.0.1:9898/api/v1'
Write-Host 'Simulator webhook:   http://127.0.0.1:8080/webhook'
Write-Host "Logs: $logDir"
