'use strict';

/*
  Экран композиции: чистый скриншот + иконки, вырезанные по разнице
  со вторым снимком. Иконки свободно падают и летают по экрану
  в направлении, куда наклонён телефон (DeviceOrientation).
*/

const $ = (s) => document.querySelector(s);

const DEG = Math.PI / 180;
const FRICTION = 150;
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
let power = 1;
let sens = 14;

let beta = 0;
let gamma = 0;
let hasGyro = false;
let lastB = null;
let lastG = null;

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
  hintEl.textContent = 'Наклоните телефон — иконки поедут в его сторону';
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
      free: false
    };
  });

  statIcons.textContent = String(icons.length);
  if (!icons.length) {
    hintEl.textContent = 'Иконки не найдены — попробуйте скриншоты крупнее или с меньшим сходством.';
  }
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
    const s = 70 + Math.random() * 150 + strength * 9;
    ic.vx = (g.x / mag) * s + (Math.random() - 0.5) * s * 0.8;
    ic.vy = (g.y / mag) * s + (Math.random() - 0.5) * s * 0.8;
    ic.vrot = (Math.random() - 0.5) * 3.2;
  }
  if (changed) updateState();
}

function reset() {
  for (let i = 0; i < icons.length; i++) {
    const ic = icons[i];
    ic.free = false;
    ic.x = ic.homeX;
    ic.y = ic.homeY;
    ic.vx = ic.vy = ic.rot = ic.vrot = 0;
  }
  updateState();
}

function collide(ic) {
  const m = 3;
  const k = 0.45;

  if (ic.x < m) { ic.x = m; ic.vx = Math.abs(ic.vx) * k; ic.vrot += Math.abs(ic.vy) * 0.0016; }
  if (ic.x + ic.w > W - m) { ic.x = W - m - ic.w; ic.vx = -Math.abs(ic.vx) * k; ic.vrot -= Math.abs(ic.vy) * 0.0016; }
  if (ic.y < m) { ic.y = m; ic.vy = Math.abs(ic.vy) * k; ic.vrot -= Math.abs(ic.vx) * 0.0016; }
  if (ic.y + ic.h > H - m) { ic.y = H - m - ic.h; ic.vy = -Math.abs(ic.vy) * k; ic.vrot += Math.abs(ic.vx) * 0.0016; }
}

/* Трение покоя: на ровном столе иконки должны останавливаться,
   но при заметном наклоне гравитация всё равно сильнее. */
function applyFriction(v, dv) {
  if (v > dv) return v - dv;
  if (v < -dv) return v + dv;
  return 0;
}

function step(dt) {
  const g = gravity();
  const drag = Math.pow(0.35, dt);
  const spin = Math.pow(0.12, dt);
  const fr = FRICTION * dt;

  for (let i = 0; i < icons.length; i++) {
    const ic = icons[i];
    if (!ic.free) continue;

    ic.vx = applyFriction((ic.vx + g.x * dt) * drag, fr);
    ic.vy = applyFriction((ic.vy + g.y * dt) * drag, fr);
    ic.x += ic.vx * dt;
    ic.y += ic.vy * dt;
    ic.rot += ic.vrot * dt;
    ic.vrot *= spin;
    collide(ic);
  }
}

function render() {
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bg, 0, 0);

  for (let i = 0; i < icons.length; i++) {
    const ic = icons[i];
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
    ctx.drawImage(ic.sprite, -ic.w / 2, -ic.h / 2);
    ctx.restore();
  }

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
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

  if (lastB !== null) {
    const jerk = Math.hypot(nb - lastB, ng - lastG);
    if (jerk > sens) release(jerk * 0.5);
  }

  lastB = nb;
  lastG = ng;
  beta = nb;
  gamma = ng;
  updateTilt();
}

gyroBtn.addEventListener('click', async () => {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) {
    hintEl.textContent = 'Гироскоп недоступен — наклоняйте курсор мыши';
    gyroBtn.hidden = true;
    return;
  }
  if (typeof DOE.requestPermission === 'function') {
    try {
      const res = await DOE.requestPermission();
      if (res !== 'granted') {
        hintEl.textContent = 'Доступ к гироскопу не выдан';
        return;
      }
    } catch (err) {
      hintEl.textContent = 'Гироскоп требует HTTPS';
      return;
    }
  }
  window.addEventListener('deviceorientation', onOrientation);
  gyroBtn.hidden = true;
  hintEl.textContent = 'Тряхните телефон — иконки оторвутся от мест';
});

/* Настольный запасной вариант: наклон задаётся курсором */
canvas.addEventListener('pointermove', e => {
  if (hasGyro) return;
  const r = canvas.getBoundingClientRect();
  gamma = clamp(((e.clientX - r.left) / r.width * 2 - 1) * 60, -60, 60);
  beta = clamp(45 + ((e.clientY - r.top) / r.height * 2 - 1) * 35, 0, 85);
  updateTilt();
});

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  release(26);
});

/* ── Кнопки ─────────────────────────────────────────────── */

$('#shake').addEventListener('click', () => release(24));
$('#reset').addEventListener('click', reset);

$('#power').addEventListener('input', e => { power = Number(e.target.value) / 100; });
$('#sens').addEventListener('input', e => { sens = Number(e.target.value); });

/* ── Старт ──────────────────────────────────────────────── */

main()
  .then(() => requestAnimationFrame(frame))
  .catch(err => fatal(err.message || String(err)));
