# Проверки проекта Shake Icons
# Запуск: powershell -NoProfile -ExecutionPolicy Bypass -File .\check.ps1
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$root   = $PSScriptRoot
$port   = 8731
$url    = "http://127.0.0.1:$port/"

$script:fail = 0
function Check([string]$what, [bool]$ok, [string]$detail) {
  if (-not $ok) { $script:fail++ }
  "{0}  {1}{2}" -f $(if ($ok) { 'OK  ' } else { 'FAIL' }), $what, $(if ($detail) { "  [$detail]" } else { '' })
}

function Show-Result([string]$name, [string]$dom) {
  $body = ''
  if ($dom -match '(?s)<pre id="out">(.*?)</pre>') { $body = $matches[1] }
  $body -split "`n" | Where-Object { $_ -match '^\s*(ok|FAIL)' } | ForEach-Object { "      $_" }
  $verdict = if ($dom -match 'RESULT:\s*PASS') { $true } else { $false }
  Check $name $verdict $(if ($verdict) { '' } else { 'см. строки выше' })
}

# ── Локальный сервер: IndexedDB не работает на file://
$job = Start-Job -ScriptBlock {
  param($r, $p)
  Set-Location $r
  python -m http.server $p --bind 127.0.0.1
} -ArgumentList $root, $port

try {
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $r = Invoke-WebRequest -Uri ($url + 'site/index.html') -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $ready) { throw 'Не удалось поднять локальный сервер' }

  function Get-Dom([string]$path, [int]$budget = 20000) {
    $o = Join-Path $env:TEMP ("si-" + [IO.Path]::GetFileName($path) + ".html")
    $ErrorActionPreference = 'Continue'
    & $chrome --headless=new --disable-gpu --no-first-run `
              --virtual-time-budget=$budget --dump-dom ($url + $path) 2>$null |
      Out-File -FilePath $o -Encoding utf8
    $ErrorActionPreference = 'Stop'
    Get-Content -LiteralPath $o -Raw -Encoding utf8
  }

  # ── 1. Извлечение иконок из пары снимков
  Show-Result 'извлечение иконок' (Get-Dom 'test-extract.html')

  # ── 2. Сквозной сценарий: загрузка → новая вкладка → физика
  Show-Result 'сквозной сценарий compose.html' (Get-Dom 'test-e2e.html' 40000)

  # ── 3. Страницы отдаются без ошибок и содержат нужные элементы
  $dom = Get-Dom 'site/index.html' 8000
  Check 'index.html отдаётся' ($dom -match 'id="pick"') ''
  Check 'кнопка одна' ([regex]::Matches($dom, 'class="bigbtn"').Count -eq 1) ''
  Check 'ввод на два файла' ($dom -match 'id="files"[^>]*multiple') ''

  $dom = Get-Dom 'site/compose.html' 8000
  Check 'compose.html отдаётся' ($dom -match 'id="screen"') ''
  Check 'кнопка гироскопа' ($dom -match 'id="gyro"') ''
  Check 'кнопка тряски' ($dom -match 'id="shake"') ''
  Check 'кнопка возврата' ($dom -match 'id="reset"') ''
  Check 'слайдер силы' ($dom -match 'id="power"') ''

  # ── 4. В коде есть гироскоп и гравитация по наклону
  $js = Get-Content -LiteralPath (Join-Path $root 'site\compose.js') -Raw
  Check 'слушает deviceorientation' ($js -match "addEventListener\('deviceorientation'") ''
  Check 'спрашивает разрешение iOS' ($js -match 'requestPermission') ''
  Check 'сила тряски зависит от наклона' ($js -match 'release\(jerk') ''
  Check 'гравитация из beta/gamma' ($js -match 'Math\.sin\(b\)' -and $js -match 'Math\.sin\(g\)') ''

  $lib = Get-Content -LiteralPath (Join-Path $root 'site\lib.js') -Raw
  Check 'анализ по разнице снимков' ($lib -match 'function analyze') ''
  Check 'связные компоненты' ($lib -match 'function components') ''
  Check 'склейка близких частей' ($lib -match 'function mergeComponents') ''
  Check 'сборка спрайта' ($lib -match 'function makeSprite') ''
}
finally {
  Stop-Job $job -ErrorAction SilentlyContinue
  Remove-Job $job -Force -ErrorAction SilentlyContinue
}

''
if ($script:fail -eq 0) { 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' } else { "ПРОВАЛЕНО ПРОВЕРОК: $script:fail" }
exit $script:fail