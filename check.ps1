# Проверки проекта Shake Icons
# Запуск: powershell -NoProfile -ExecutionPolicy Bypass -File .\check.ps1
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$root   = $PSScriptRoot
$port   = 8770
$url    = "http://127.0.0.1:$port/"

$script:fail = 0
function Check([string]$what, [bool]$ok, [string]$detail) {
  if (-not $ok) { $script:fail++ }
  "{0}  {1}{2}" -f $(if ($ok) { 'OK  ' } else { 'FAIL' }), $what, $(if ($detail) { "  [$detail]" } else { '' })
}

# Свой стенд вместо python -m http.server: под виртуальным временем Chrome
# не доводит транзакции IndexedDB до конца, и проверки проходят врань.
# Страницы отправляют результат на POST /__result, сервер кладёт его в один файл —
# страницы запускаются по очереди, так что файла достаточно одного.
$resultFile = Join-Path $env:TEMP 'si-result.txt'

$job = Start-Job -ScriptBlock {
  param($r, $p, $o)
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $r 'serve-test.ps1') `
      -Root $r -Port $p -OutFile $o -MaxSeconds 600
} -ArgumentList $root, $port, $resultFile

try {
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-WebRequest -Uri ($url + 'site/index.html') -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $ready) { throw 'Не удалось поднять локальный сервер' }

  # Запускает страницу и ждёт результат, который она отправляет на POST /__result
  function Invoke-Page([string]$path, [int]$TimeoutSec = 120) {
    if (Test-Path -LiteralPath $resultFile) { Remove-Item -LiteralPath $resultFile -Force }

    $name = [IO.Path]::GetFileNameWithoutExtension($path)
    $profileDir = Join-Path $env:TEMP ("si-chrome-" + $name)
    if (Test-Path -LiteralPath $profileDir) { Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue }

    $p = Start-Process $chrome -PassThru -ArgumentList @(
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      "--user-data-dir=$profileDir", ($url + $path)
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while (-not (Test-Path -LiteralPath $resultFile) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 400
    }
    Start-Sleep -Milliseconds 400

    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path -LiteralPath $resultFile)) { return $null }
    Get-Content -LiteralPath $resultFile -Raw -Encoding utf8
  }

  function Show-Result([string]$name, [string]$text) {
    if (-not $text) { Check $name $false 'страница не вернула результат'; return }
    ($text -split "`n") | Where-Object { $_ -match '^\s*(ok|FAIL|·)' } | ForEach-Object { "      $_" }
    $verdict = if ($text -match 'RESULT:\s*PASS') { $true } else { $false }
    $why = if ($verdict) { '' }
           elseif ($text -match 'RESULT:\s*выполняется') { 'прогон не завершился' }
           else { 'см. строки выше' }
    Check $name $verdict $why
  }

  # ── 1. Извлечение иконок из пары снимков
  Show-Result 'извлечение иконок' (Invoke-Page 'test-extract.html' 90)

  # ── 2. Сквозной сценарий: сборка сцены и физика
  Show-Result 'сквозной сценарий compose.html' (Invoke-Page 'test-e2e.html' 120)

  # ── 3. Страница загрузки: выбор файлов, сохранение, открытие вкладки
  Show-Result 'страница загрузки' (Invoke-Page 'test-upload.html' 150)

  # ── 4. Страницы отдаются без ошибок и содержат нужные элементы
  $dom = (Invoke-WebRequest -Uri ($url + 'site/index.html') -UseBasicParsing).Content
  Check 'index.html отдаётся' ($dom -match 'id="pick"') ''
  Check 'кнопка одна' ([regex]::Matches($dom, 'class="bigbtn"').Count -eq 1) ''
  Check 'ввод на два файла' ($dom -match 'id="files"[^>]*multiple') ''
  Check 'кнопка называется «Тестировать»' ($dom -match 'id="go"[^>]*>Тестировать<') ''

  $dom = (Invoke-WebRequest -Uri ($url + 'site/compose.html') -UseBasicParsing).Content
  Check 'compose.html отдаётся' ($dom -match 'id="screen"') ''
  Check 'кнопка гироскопа' ($dom -match 'id="gyro"') ''
  Check 'верхней панели нет' ($dom -notmatch 'class="topbar"') ''
  Check 'нижней панели нет' ($dom -notmatch 'class="hud"') ''
  Check 'меню настроек убрано' ($dom -notmatch 'id="knob"' -and $dom -notmatch 'id="panel"') ''

  $css = Get-Content -LiteralPath (Join-Path $root 'site\styles.css') -Raw
  Check 'снимок во всю страницу' ($css -match 'position: fixed' -and $css -match 'object-fit: cover') ''

  # ── 5. В коде есть гироскоп и гравитация по наклону
  $js = Get-Content -LiteralPath (Join-Path $root 'site\compose.js') -Raw
  $lib = Get-Content -LiteralPath (Join-Path $root 'site\lib.js') -Raw
  Check 'слушает deviceorientation' ($js -match "addEventListener\('deviceorientation'") ''
  Check 'спрашивает разрешение iOS' ($js -match 'requestPermission') ''
  Check 'тряска отпускает иконки' ($js -match 'jerk > sens' -and $js -match 'release\(jerk') ''
  Check 'тряска экрана убрана' ($js -notmatch 'addShake' -and $js -notmatch 'shakeAmp') ''
  Check 'иконки крутятся' ($js -match 'vrot' -and $js -match 'ctx\.rotate') ''
  Check 'вращение ограничено одним поворотом' ($js -match 'maxTurn' -and $js -match 'Math\.abs\(ic\.rot\) < maxTurn') ''
  Check 'края экрана срезают иконки' ($js -match 'OVERHANG') ''
  Check 'тап собирает иконки на места' ($js -match "pointerdown" -and $js -match 'function home') ''
  Check 'иконки не разгоняются сами' ($js -notmatch 'IDLE_KICK') ''
  Check 'нет автосбора по времени' ($js -notmatch 'SETTLE_TIME') ''
  Check 'иконки не засыпают' ($js -notmatch 'SLEEP_TIME' -and $js -notmatch 'slowT' -and $js -notmatch '\.rest\b') ''
  Check 'у иконок есть постоянное движение' ($js -match 'WANDER' -and $js -match 'WANDER_MIN') ''
  Check 'канва подгоняется под видимую область' ($js -match 'visualViewport' -and $js -match 'function fitScreen') ''
  Check 'интерфейс сверху не вырезается как иконки' ($lib -match 'function isInterface' -and $lib -match 'INTERFACE_AREA_FRAC') ''
  Check 'гравитация из beta/gamma' ($js -match 'Math\.sin\(b\)' -and $js -match 'Math\.sin\(g\)') ''

  $app = Get-Content -LiteralPath (Join-Path $root 'site\app.js') -Raw
  Check 'вкладка открывается до await' ($app -match "window\.open\('about:blank'") ''

  Check 'анализ по разнице снимков' ($lib -match 'function analyze') ''
  Check 'связные компоненты' ($lib -match 'function components') ''
  Check 'склейка близких частей' ($lib -match 'function mergeComponents') ''
  Check 'сборка спрайта' ($lib -match 'function makeSprite') ''
  Check 'createImageBitmap проверяется на наличие' ($lib -match "typeof createImageBitmap === 'function'") ''
}
finally {
  Stop-Job $job -ErrorAction SilentlyContinue
  Remove-Job $job -Force -ErrorAction SilentlyContinue
}

''
if ($script:fail -eq 0) { 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' } else { "ПРОВАЛЕНО ПРОВЕРОК: $script:fail" }
exit $script:fail