'use strict';

/*
  Экран композиции: чистый скриншот + иконки, вырезанные по разнице
  со вторым снимком. Пока телефон не потрясли, иконки держат свои места.
  После тряски они отрываются, падают по направлению наклона, бьются
  о края и друг о друга и укладываются в штабель, а экран вздрагивает
  от каждого удара.
*/

const $ = (s) => document.querySelector(s);

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const canvas = $('#screen');
const ctx = canvas.getContext('2d');

const statIcons = $('#statIcons');
const statState = $('#statState');
const tiltEl = $('#tilt');
const hintEl = $('#hint');
const gyroBtn = $('#gyro');

let W = 0;
let H = 0;
let bg = null;
let icons = [];

const power = 1;          /* множитель гравитации */
const sens = 14;          /* порог тряски, градусы между событиями */
const bounce = 0.28;      /* упругость удара */
const friction = 150;     /* трение, px/с² */
const shakeGain = 1;      /* амплитуда тряски экрана */

const MAX_SPEED = 2600;   /* выше иконки уже не летят, а «каша» */
const REST_SPEED = 12;    /* медленнее этого — считаем, что иконка лежит */
const BOUNCE_EPS = 60;    /* слабее удара не отскакиваем, а просто гасим */
const WAKE_V = 30;        /* удар сильнее этого будит лежащую иконку */
const CELL = 110;         /* сторона клетки сетки для поиска пар */
const QUARTER = Math.PI / 2;

let beta = 0;
let gamma = 0;
let hasGyro = false;
let lastB = null;
let lastG = null;
let everReleased = false;

/* ── Загрузка ───────────────────────────────────────────── */

function fatal(msg) {
  const box = $('#fatal');
  box.hidden = false;
  box.textContent = msg;
  $('#loader').hidden = true;
}

window.addEventListener('error', e => {
  /* первый сбой важнее последующих: сохраняем стек */
  if (!document.documentElement.dataset.jsError) {
    document.documentElement.dataset.jsError = (e.error && e.error.stack) || e.message;
  }
  fatal('Ошибка скрипта: ' + e.message);
});

async function main() {
  const key = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
  if (!key) {
    fatal('Нет данных. Откройте главную страницу и загрузите два фото.');
    return;
  }

  let rec;
  try {
    rec = await idbGet(key);
  } catch (err) {
    fatal('Хранилище недоступно: ' + err.message);
    return;
  }
  if (!rec || !rec.clean || !rec.icons) {
    fatal('Скриншоты не найдены. Загрузите их заново на главной странице.');
    return;
  }

  const cleanImg = await loadBitmap(rec.clean);
  const iconsImg = await loadBitmap(rec.icons);

  build(cleanImg, iconsImg);

  $('#loader').hidden = true;

  /* Просим гироскоп сразу, не дожидаясь нажатия. На iOS это не пройдёт
     без жеста — тогда останется кнопка, но на Android и десктопе
     разрешение берётся молча. */
  enableGyro(false);
}

function defaultHint() {
  if (!icons.length) {
    return 'Иконки не найдены — попробуйте скриншоты крупнее или с меньшим сходством.';
  }
  if (!hasGyro) return 'Тряхните телефон — иконки разлетятся';
  return 'Тряхните телефон — иконки разлетятся';
}

/* ── Сборка сцены ───────────────────────────────────────── */

function build(cleanImg, iconsImg) {
  const res = analyze(cleanImg, iconsImg);
  W = res.w;
  H = res.h;

  canvas.width = W;
  canvas.height = H;

  /* чистый экран — фон */
  bg = res.canvasA;

  const lim = iconLimits(W, H);
  const comps = mergeComponents(
    components(res.mask, W, H, lim.minSide, lim.minArea), lim.mergeGap
  ).slice(0, MAX_ICONS);

  icons = comps.map(c => {
    const sp = makeSprite(c, res.canvasB, W, H);
    return {
      sprite: sp.canvas,
      x: sp.x,
      y: sp.y,
      w: sp.w,
      h: sp.h,
      homeX: sp.x,
      homeY: sp.y,
      vx: 0,
      vy: 0,
      rot: 0,
      vrot: 0,
      free: false,
      rest: false,
      touch: false,
      support: false,
      still: 0
    };
  });

  statIcons.textContent = String(icons.length);
  hintEl.textContent = defaultHint();
  showChrome();
}

/* ── Гравитация по наклону ───────────────────────────────── */

function screenAngle() {
  const a = screen.orientation && screen.orientation.angle;
  return typeof a === 'number' ? a : (window.orientation || 0);
}

function gravity() {
  const b = clamp(beta, -90, 90) * DEG;
  const g = clamp(gamma, -90, 90) * DEG;

  let gx = Math.sin(g);
  let gy = Math.sin(b);

  const a = screenAngle() * DEG;
  if (a) {
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    const nx = gx * cs - gy * sn;
    const ny = gx * sn + gy * cs;
    gx = nx;
    gy = ny;
  }

  /* 900 даёт терминальную скорость ≈870 px/с: экран пролетается за ~0.8 с */
  const K = 900 * power;
  return { x: gx * K, y: gy * K };
}

/* ── Физика ──────────────────────────────────────────────── */

function release(strength) {
  const g = gravity();
  const mag = Math.hypot(g.x, g.y) || 1;
  let changed = false;

  for (let i = 0; i < icons.length; i++) {
    const ic = icons[i];
    if (ic.free) continue;
    ic.free = true;
    changed = true;
    /* разброс меньше прежнего, иначе иконки сразу рассыпаются в кашу */
    const s = 70 + Math.random() * 110 + strength * 7;
    ic.vx = (g.x / mag) * s + (Math.random() - 0.5) * s * 0.45;
    ic.vy = (g.y / mag) * s + (Math.random() - 0.5) * s * 0.45;
    ic.vrot = (Math.random() - 0.5) * 2.2;
  }
  wake();
  if (changed) {
    everReleased = true;
    updateState();
    if (!hasGyro) hintEl.textContent = 'Иконки в движении';
  }
}

/* Будим всё, что лежало: наклон изменился или пришёл новый удар. */
function wake() {
  for (let i = 0; i < icons.length; i++) icons[i].rest = false;
}

function reset() {
  for (let i = 0; i < icons.length; i++) {
    const ic = icons[i];
    ic.free = false;
    ic.rest = false;
    ic.touch = false;
    ic.support = false;
    ic.still = 0;
    ic.x = ic.homeX;
    ic.y = ic.homeY;
    ic.vx = ic.vy = ic.rot = ic.vrot = 0;
  }
  everReleased = false;
  shakeAmp = 0;
  updateState();
  hintEl.textContent = defaultHint();
}

function collide(ic) {
  const m = 3;
  const k = bounce;
  let hit = 0;

  if (ic.x < m) {
    ic.x = m;
    ic.touch = true;
    if (ic.vx < 0) { hit = Math.max(hit, -ic.vx); ic.vx = -ic.vx * k; }
    ic.vrot += Math.abs(ic.vy) * 0.0016;
  }
  if (ic.x + ic.w > W - m) {
    ic.x = W - m - ic.w;
    ic.touch = true;
    if (ic.vx > 0) { hit = Math.max(hit, ic.vx); ic.vx = -ic.vx * k; }
    ic.vrot -= Math.abs(ic.vy) * 0.0016;
  }
  if (ic.y < m) {
    ic.y = m;
    ic.touch = true;
    if (ic.vy < 0) { hit = Math.max(hit, -ic.vy); ic.vy = -ic.vy * k; }
    ic.vrot -= Math.abs(ic.vx) * 0.0016;
  }
  if (ic.y + ic.h > H - m) {
    ic.y = H - m - ic.h;
    ic.touch = true;
    if (ic.vy > 0) {
      hit = Math.max(hit, ic.vy);
      /* слабое касание не отскакивает, иначе штабель вечно подрагивает */
      ic.vy = ic.vy < BOUNCE_EPS ? 0 : -ic.vy * k;
    }
    ic.vrot += Math.abs(ic.vx) * 0.0016;
  }

  if (hit) addShake(Math.min(22, hit * 0.045) * Math.min(1, (ic.w * ic.h) / 9000));
}

/* Трение покоя: на ровном столе иконки должны останавливаться,
   но при заметном наклоне гравитация всё равно сильнее. */
function applyFriction(v, dv) {
  if (v > dv) return v - dv;
  if (v < -dv) return v + dv;
  return 0;
}

/* ── Столкновения иконок между собой ────────────────────── */

const grid = new Map();

function gridBuild() {
  grid.clear();
  for (let i = 0; i < icons.length; i++) {
    const ic = icons[i];
    const cx0 = Math.floor(ic.x / CELL);
    const cx1 = Math.floor((ic.x + ic.w) / CELL);
    const cy0 = Math.floor(ic.y / CELL);
    const cy1 = Math.floor((ic.y + ic.h) / CELL);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = cx + ':' + cy;
        let cell = grid.get(k);
        if (!cell) grid.set(k, cell = []);
        cell.push(i);
      }
    }
  }
}

/* Раскладывает иконки по клеткам: иконка, долетевшая до другой, ложится
   сверху и больше не проходит сквозь неё. Иконки на своих местах —
   бесконечная масса: их не сдвинуть, на них можно упасть. */
function resolvePair(a, b) {
  if (!a.free && !b.free) return;

  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  if (ox <= 0) return;
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (oy <= 0) return;

  /* раздвигаем по оси наименьшего проникновения */
  const dx = (b.x + b.w / 2) - (a.x + a.w / 2);
  const dy = (b.y + b.h / 2) - (a.y + a.h / 2);
  let nx = 0;
  let ny = 0;
  if (ox < oy) nx = dx >= 0 ? 1 : -1;
  else ny = dy >= 0 ? 1 : -1;

  const inv = (a.free ? 1 : 0) + (b.free ? 1 : 0);
  if (!inv) return;

  /* Раздвигаем по оси наименьшего проникновения */
  const push = (Math.min(ox, oy) + 0.5) / inv;
  if (a.free) { a.x -= nx * push; a.y -= ny * push; }
  if (b.free) { b.x += nx * push; b.y += ny * push; }

  /* Кто сверху, тот имеет опору снизу и может уснуть */
  if (ny !== 0) {
    if (ny > 0) a.touch = true;
    else b.touch = true;
  } else {
    a.touch = true;
    b.touch = true;
  }

  const avx = a.free ? a.vx : 0;
  const avy = a.free ? a.vy : 0;
  const bvx = b.free ? b.vx : 0;
  const bvy = b.free ? b.vy : 0;
  const vn = (bvx - avx) * nx + (bvy - avy) * ny;

  /* удар отражается только если иконки реально сближались */
  if (vn < 0) {
    /* слабое касание гасится вместо отскока: иначе иконки в штабеле
       непрерывно подпрыгивают и никогда не успокаиваются */
    const e = -vn < BOUNCE_EPS ? 0 : bounce;
    const imp = -(1 + e) * vn / inv;
    if (a.free) { a.vx -= nx * imp; a.vy -= ny * imp; }
    if (b.free) { b.vx += nx * imp; b.vy += ny * imp; }
    const area = (a.w * a.h + b.w * b.h) / 26000;
    addShake(Math.min(16, -vn * 0.035) * Math.min(1.4, area));

    /* удар выводит из покоя: иначе штабель проглатывал бы падающие иконки */
    if (-vn > WAKE_V) { a.rest = false; b.rest = false; }
  }

  /* гасим скольжение вдоль поверхности — иначе штабель разъезжается */
  const tx = -ny;
  const ty = nx;
  const vt = (bvx - avx) * tx + (bvy - avy) * ty;
  const jt = -vt * 0.3 / inv;
  if (a.free) { a.vx -= tx * jt; a.vy -= ty * jt; }
  if (b.free) { b.vx += tx * jt; b.vy += ty * jt; }

  a.still = 0;
  b.still = 0;
}

function solveOverlaps() {
  if (icons.length < 2) return;
  gridBuild();

  for (let i = 0; i < icons.length; i++) {
    const ic = icons[i];
    const cx0 = Math.floor(ic.x / CELL);
    const cx1 = Math.floor((ic.x + ic.w) / CELL);
    const cy0 = Math.floor(ic.y / CELL);
    const cy1 = Math.floor((ic.y + ic.h) / CELL);

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = grid.get(cx + ':' + cy);
        if (!cell) continue;

        /* своя клетка — пары с большим индексом, соседние — со всеми */
        if (cx === cx0 && cy === cy0) {
          for (let a = 0; a < cell.length; a++) {
            for (let b = a + 1; b < cell.length; b++) {
              resolvePair(icons[cell[a]], icons[cell[b]]);
            }
          }
          continue;
        }
        for (let a = 0; a < cell.length; a++) resolvePair(ic, icons[cell[a]]);
      }
    }
  }
}

/* ── Тряска экрана ───────────────────────────────────────── */

let shakeAmp = 0;
let shakeT = 0;

function addShake(amount) {
  const a = amount * shakeGain;
  if (a > shakeAmp) shakeAmp = a > 26 ? 26 : a;
}

function stepShake(dt) {
  shakeT += dt;
  shakeAmp *= Math.pow(0.02, dt);
  if (shakeAmp < 0.05) shakeAmp = 0;
}

/* ── Шаг физики ──────────────────────────────────────────── */

let prevGX = 0;
let prevGY = 0;

function step(dt) {
  const g = gravity();
  const drag = Math.pow(0.35, dt);
  const spin = Math.pow(0.12, dt);
  const fr = friction * dt;

  /* Наклон заметно изменился — лежащие иконки должны снова поехать.
     Пока гравитация примерно та же, они спят, иначе штабель дрожит. */
  if (Math.hypot(g.x - prevGX, g.y - prevGY) > 40) wake();
  prevGX = g.x;
  prevGY = g.y;

  /* Порог засыпания должен быть выше прироста скорости за один кадр,
     иначе иконка, упёршаяся в пол, никогда не остановится. */
  const restV = Math.max(REST_SPEED, Math.hypot(g.x, g.y) * dt * 2.5);

  for (let i = 0; i < icons.length; i++) {
    const ic = icons[i];
    if (!ic.free) continue;
    ic.touch = false;

    let slow = false;

    if (ic.rest) {
      /* лежит: гравитация не давит, движение только гасится */
      ic.vx = applyFriction(ic.vx, fr * 3);
      ic.vy = applyFriction(ic.vy, fr * 3);
      if (Math.hypot(ic.vx, ic.vy) > REST_SPEED) {
        ic.rest = false;
      } else {
        ic.vx = 0;
        ic.vy = 0;
      }
    } else {
      ic.vx = applyFriction((ic.vx + g.x * dt) * drag, fr);
      ic.vy = applyFriction((ic.vy + g.y * dt) * drag, fr);

      /* потолок скорости: без него при большой силе иконки слипаются в кашу */
      const sp = Math.hypot(ic.vx, ic.vy);
      if (sp > MAX_SPEED) {
        ic.vx = (ic.vx / sp) * MAX_SPEED;
        ic.vy = (ic.vy / sp) * MAX_SPEED;
      }
      slow = sp < restV;
    }

    ic.x += ic.vx * dt;
    ic.y += ic.vy * dt;
    ic.rot += ic.vrot * dt;
    ic.vrot *= spin;

    /* Медленные иконки доворачиваются до прямого угла и прилипают:
       так штабель выглядит сложенным, а не перемешанным. */
    if (Math.hypot(ic.vx, ic.vy) < 70) {
      ic.still += dt;
      const target = Math.round(ic.rot / QUARTER) * QUARTER;
      ic.rot += (target - ic.rot) * Math.min(1, dt * 9);
      if (ic.still > 0.25) ic.vrot *= Math.pow(0.001, dt);
    } else {
      ic.still = 0;
    }

    collide(ic);

    /* Засыпаем, только если под ноги есть опора: иначе иконка зависнет
       в воздухе. support — это touch с прошлого кадра: раскладку пар
       мы делаем ниже, поэтому в этом же кадре она ещё неизвестна. */
    if (slow) {
      if (ic.support) ic.rest = true;
    } else if (ic.rest && !ic.support) {
      ic.rest = false;
    }
  }

  solveOverlaps();

  /* Последнее слово — после раскладки пар. Иконка, упёршаяся в опору,
     не должна набирать скорость вдавливания: иначе штабель понемногу
     разгоняется сам у себя и никогда не успокаивается. */
  const gl = Math.hypot(g.x, g.y);
  if (gl > 1) {
    const ux = g.x / gl;
    const uy = g.y / gl;
    const creep = gl * dt * 2.5;
    for (let i = 0; i < icons.length; i++) {
      const ic = icons[i];
      if (!ic.free || !ic.support) continue;

      if (ic.rest) {
        ic.vx = 0;
        ic.vy = 0;
        ic.vrot = 0;
        continue;
      }
      const along = ic.vx * ux + ic.vy * uy;
      if (along > 0 && along < creep) {
        ic.vx -= ux * along;
        ic.vy -= uy * along;
      }
    }
  }

  for (let i = 0; i < icons.length; i++) icons[i].support = icons[i].touch;

  stepShake(dt);
}

/* ── Отрисовка ───────────────────────────────────────────── */

let drawOrder = [];

function render() {
  /* Тряска двигает весь экран целиком. Чтобы не показывать пустые края,
     слегка увеличиваем кадр. */
  const amp = shakeAmp;
  const dx = Math.sin(shakeT * 71) * amp;
  const dy = Math.cos(shakeT * 89) * amp * 0.85;
  const dr = Math.sin(shakeT * 53) * amp * 0.0004;
  const zoom = 1 + amp * 0.0016;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2 + dx, H / 2 + dy);
  ctx.rotate(dr);
  ctx.scale(zoom, zoom);
  ctx.translate(-W / 2, -H / 2);

  ctx.drawImage(bg, 0, 0);

  /* Иконки на местах — часть экрана, рисуем первыми. Летящие сортируем
     снизу вверх: та, что ниже, рисуется поверх и выглядит лежащей сверху. */
  drawOrder.length = 0;
  for (let i = 0; i < icons.length; i++) if (!icons[i].free) drawOrder.push(icons[i]);
  const flying = [];
  for (let i = 0; i < icons.length; i++) if (icons[i].free) flying.push(icons[i]);
  flying.sort((a, b) => a.y - b.y);
  for (let i = 0; i < flying.length; i++) drawOrder.push(flying[i]);

  for (let i = 0; i < drawOrder.length; i++) {
    const ic = drawOrder[i];
    if (ic.free) {
      ctx.shadowColor = 'rgba(0,0,0,.5)';
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 7;
    } else {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
    ctx.save();
    ctx.translate(ic.x + ic.w / 2, ic.y + ic.h / 2);
    if (ic.rot) ctx.rotate(ic.rot);
    ctx.drawImage(ic.sprite, -ic.w / 2, -ic.h / 2, ic.w, ic.h);
    ctx.restore();
  }

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.restore();
}

let last = 0;
function frame(now) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
  last = now;
  step(dt);
  render();
  requestAnimationFrame(frame);
}

function updateState() {
  let n = 0;
  for (let i = 0; i < icons.length; i++) if (icons[i].free) n++;
  statState.textContent = n ? ('в движении ' + n) : 'на местах';
}

function updateTilt() {
  tiltEl.textContent = 'β ' + Math.round(beta) + '° γ ' + Math.round(gamma) + '°';
}

/* ── Гироскоп ───────────────────────────────────────────── */

function onOrientation(e) {
  if (e.beta == null && e.gamma == null) return;
  hasGyro = true;

  const nb = e.beta || 0;
  const ng = e.gamma || 0;

  /* Тряска — резкое изменение наклона между соседними событиями.
     На готовом экране именно она отпускает иконки. */
  if (lastB !== null) {
    const jerk = Math.hypot(nb - lastB, ng - lastG);
    if (jerk > sens) {
      release(jerk * 0.5);
      if (!everReleased) return;
    }
  }

  lastB = nb;
  lastG = ng;
  beta = nb;
  gamma = ng;
  updateTilt();
}

/* Просит доступ. Без жеста iOS всё равно откажет — тогда показываем кнопку,
   но на Android и десктопе разрешение берётся молча при загрузке. */
async function enableGyro(fromGesture) {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) {
    hintEl.textContent = 'Гироскоп недоступен — наклоняйте курсор мыши';
    gyroBtn.hidden = true;
    return false;
  }

  if (typeof DOE.requestPermission === 'function') {
    let res;
    try {
      res = await Promise.race([
        DOE.requestPermission(),
        new Promise(r => setTimeout(() => r('timeout'), 2000))
      ]);
    } catch (err) {
      res = 'error';
    }
    if (res !== 'granted') {
      gyroBtn.hidden = false;
      hintEl.textContent = 'Коснитесь «Разрешить гироскоп» — иначе тряска не сработает';
      return false;
    }
  }

  window.addEventListener('deviceorientation', onOrientation);
  gyroBtn.hidden = true;
  if (!everReleased) hintEl.textContent = defaultHint();
  return true;
}

gyroBtn.addEventListener('click', () => enableGyro(true));

/* Настольный запасной вариант: наклон задаётся курсором */
canvas.addEventListener('pointermove', e => {
  if (hasGyro) return;
  const r = canvas.getBoundingClientRect();
  gamma = clamp(((e.clientX - r.left) / r.width * 2 - 1) * 60, -60, 60);
  beta = clamp(45 + ((e.clientY - r.top) / r.height * 2 - 1) * 35, 0, 85);
  updateTilt();
});

canvas.addEventListener('pointerdown', e => {
  showChrome();
  canvas.setPointerCapture(e.pointerId);
  release(26);
});

/* ── Прячем панели ───────────────────────────────────────── */

/* Панели лежат поверх снимка и мешают им смотреть, поэтому через несколько
   секунд без действия сами собой прячутся. Кнопка разрешения гироскопа
   не даёт им скрыться: пока её не нажали, прятать нечего. */
let hideTimer = 0;

function showChrome() {
  document.body.classList.remove('is-bare');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!gyroBtn.hidden) return;
    document.body.classList.add('is-bare');
  }, 3500);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) showChrome();
});

canvas.addEventListener('pointermove', showChrome);

/* ── Кнопки ─────────────────────────────────────────────── */

$('#shake').addEventListener('click', () => release(24));
$('#reset').addEventListener('click', reset);

/* ── Старт ──────────────────────────────────────────────── */

main()
  .then(() => requestAnimationFrame(frame))
  .catch(err => fatal(err.message || String(err)));