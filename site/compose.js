'use strict';

/*
  Экран композиции: чистый скриншот во всю страницу + иконки, вырезанные
  по разнице со вторым снимком. Пока телефон не потрясли, иконки держат
  свои места. Тряска их отпускает, и дальше они живут по-настоящему: падают
  по направлению наклона, крутятся от ударов, бьются о края и друг о друга,
  вылезают за края экрана и укладываются в штабель. Картинка остаётся на
  месте — тряски экрана нет. Тап по экрану собирает иконки обратно.
*/

const $ = (s) => document.querySelector(s);

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
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
const sens = 12;          /* порог тряски, градусы между событиями */
const bounce = 0.28;      /* упругость удара */
const friction = 60;      /* трение, px/с²: чем меньше, тем дольше скользят */
const floorFriction = 90; /* трение о пол: иначе штабель разъезжается */
const FIXED_DT = 1 / 60;  /* шаг физики, на который считается трение о пол */

/* По видео с твиком иконки у края экрана не отскакивают от невидимой стены,
   а спокойно уезжают за край наполовину и дальше. Поэтому держим их
   мягкие границы: за край можно вылезти, но не вылететь совсем. */
const OVERHANG = 0.5;     /* насколько иконка может вылезти за край, доля */

/* Вращение: в ролике иконки крутятся, но заметно и недолго — это лёгкий
   поворот, а не юла. Раскрутку даёт толчок при отпускании, дальше её
   раскручивают удары о соседей и края, а трение гасит. */
const spinKick = 2.6;      /* начальная раскрутка при отпускании, рад/с */
const spinFromHit = 0.16;  /* доля касательной скорости, переходящая во вращение */
const spinFriction = 3.2;  /* торможение вращения, 1/с */
const maxSpin = 6;         /* быстрее иконка превращается в кашу */
const maxTurn = 1.6;       /* суммарный поворот за полёт, рад (~90°) */

/* Возврат на места по тапу: иконки примерно за 0.7 с собираются обратно
   в сетку. Само по себе время ничего не собирает: в ролике штабель лежит
   сколько угодно, пока не ткнёшь. */
const RETURN_TIME = 0.7;  /* длительность возврата, с */

/* Постоянная часть силы тяжести. Экран всегда висит вертикально, поэтому даже
   при нулевом наклоне иконки медленно сползают вниз, а не замирают. */
const BASE_G = 0.22;
const MAX_SPEED = 2600;   /* выше иконки уже не летят, а «каша» */
const REST_SPEED = 12;    /* медленнее этого — считаем, что иконка лежит */
const BOUNCE_EPS = 60;    /* слабее удара не отскакиваем, а просто гасим */
const WAKE_V = 30;        /* удар сильнее этого будит лежащую иконку */
const SLEEP_TIME = 0.25; /* сколько секунд почти без движения — иконка спит */
const SLEEP_V = 80;      /* медленнее этого — иконка считается уснувшей */
const CELL = 110;         /* сторона клетки сетки для поиска пар */

let beta = 0;
let gamma = 0;
let hasGyro = false;
let released = false;
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

  /* Просим гироскоп сразу, не дожидаясь нажатия. На iOS это не пройдёт
     без жеста — тогда останется кнопка, но на Android и десктопе
     разрешение берётся молча. */
  enableGyro(false);
}

function defaultHint() {
  if (!icons.length) {
    return 'Иконки не найдены — попробуйте скриншоты крупнее или с меньшим сходством.';
  }
  return 'Тряхните телефон — иконки разлетятся, тап соберёт их обратно';
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
      /* сборка обратно: доля пути, оставшаяся до исходного места */
      back: 1,
      rot0: 0,
      /* сколько секунд иконка почти не двигается */
      slowT: 0
    };
  });

  statIcons.textContent = String(icons.length);
  updateState();
  hintEl.textContent = defaultHint();
}

/* ── Гравитация по наклону ───────────────────────────────── */

function screenAngle() {
  const a = screen.orientation && screen.orientation.angle;
  return typeof a === 'number' ? a : (window.orientation || 0);
}

/* Направление силы тяжести задаёт наклон телефона. Но телефон может лежать
   плашмя, и тогда наклон равен нулю — иконки перестали бы двигаться совсем.
   Поэтому добавляем постоянную тягу вниз: по вертикали экран всегда «висит»,
   и картинка никогда не замирает мёртво. */
function gravity() {
  const b = clamp(beta, -90, 90) * DEG;
  const g = clamp(gamma, -90, 90) * DEG;

  let gx = Math.sin(g);
  let gy = Math.sin(b) * 0.85 + BASE_G;

  const a = screenAngle() * DEG;
  if (a) {
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    const nx = gx * cs - gy * sn;
    const ny = gx * sn + gy * cs;
    gx = nx;
    gy = ny;
  }

  /* длина не должна превышать единицу: на двойном наклоне иконки
     иначе улетают с огромной скоростью */
  const len = Math.hypot(gx, gy);
  if (len > 1) { gx /= len; gy /= len; }

  /* 900 даёт терминальную скорость ≈870 px/с: экран пролетается за ~0.8 с */
  const K = 900 * power;
  return { x: gx * K, y: gy * K };
}

/* ── Физика ──────────────────────────────────────────────── */

/* Иконки оживают по тряске телефона: срываются со своих мест и получают толчок
   по направлению наклона. Разброс небольшой — с сильным разбросом иконки сразу
   рассыпаются в кашу и не собираются в читаемый штабель. */
function release(strength) {
  const g = gravity();
  const mag = Math.hypot(g.x, g.y) || 1;

  for (let i = 0; i < icons.length; i++) {
    const ic = icons[i];
    const wasFree = ic.free;
    ic.free = true;
    ic.rest = false;
    ic.back = 1;
    ic.slowT = 0;

    /* Уже летящие иконки только подталкиваются, а не срываются заново:
       иначе повторная тряска телепортировала бы их обратно на сетку. */
    const s = (wasFree ? 40 + strength * 4 : 70 + Math.random() * 110 + strength * 7);
    ic.vx += (g.x / mag) * s + (Math.random() - 0.5) * s * 0.45;
    ic.vy += (g.y / mag) * s + (Math.random() - 0.5) * s * 0.45;

    /* Лёгкий поворот при отпускании: в ролике иконки крутятся заметно,
       но это не юла. */
    ic.vrot += (Math.random() - 0.5) * 2 * spinKick;
  }
  wake();
  released = true;
  updateState();
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
    ic.back = 1;
    ic.slowT = 0;
    ic.x = ic.homeX;
    ic.y = ic.homeY;
    ic.vx = ic.vy = 0;
    ic.rot = 0;
    ic.vrot = 0;
  }
  settling = false;
  released = false;
  updateState();
  hintEl.textContent = defaultHint();
}

/* Возврат на места по тапу: в ролике иконки не телепортируются, а за
   RETURN_TIME плавно уезжают на свои позиции, вставая ровно, как стояли.
   Поворот при этом домотается до ближайшего целого оборота. */
function home() {
  let any = false;
  for (let i = 0; i < icons.length; i++) {
    const ic = icons[i];
    if (!ic.free || ic.back < 1) continue;
    any = true;
    ic.back = 0;
    ic.slowT = 0;
    /* берём ближайший полный оборот, чтобы не делать лишний круг */
    ic.rot0 = Math.round(ic.rot / TAU) * TAU;
    ic.rest = false;
  }
  if (!any) return;
  settling = true;
  updateState();
  hintEl.textContent = defaultHint();
}

/* Иконка, трущаясь о боковую стену, теряет скорость по вертикали:
   Без этого иконка, вылезшая наполовину за край, бесконечно соскальзывает
   по стене: её подпирает иконка снизу, та выталкивает наружу, и она
   возвращается — штабель дрожит вечно и никогда не успокаивается. */
const wallFriction = 0.6;  /* доля трения о пол для боковых стен */

/* Удары о края экрана. В ролике иконка не отскакивает от невидимой стены
   на самом краю: она выезжает за границу примерно наполовину, и края
   экрана её срезают. Габариты поворота в расчёт не берём — иначе иконка,
   крутящаяся у стены, каждый кадр прыгала бы на разную глубину. */
function collide(ic) {
  const k = bounce;

  /* Мягкие границы: за край иконка выезжает, но не исчезает совсем.
     Чем быстрее она летит, тем дальше может вылезти, а чем медленнее —
     тем меньше ей остаётся снаружи. Так иконка может на лету вылететь
     за край наполовину (его срезает край экрана), но не может повиснуть
     там навсегда: её вечно выталкивал бы штабель, и картинка бы дрожала. */
  const allow = OVERHANG * clamp(Math.hypot(ic.vx, ic.vy) / 500, 0, 1);
  const minX = -ic.w * allow;
  const maxX = W - ic.w + ic.w * allow;
  const minY = -ic.h * allow;
  /* пол — это низ экрана: по нему иконки собираются в штабель */
  const floor = H - ic.h;
  const wallFr = floorFriction * FIXED_DT * wallFriction;

  if (ic.x < minX) {
    ic.x = minX;
    ic.touch = true;
    if (ic.vx < 0) {
      ic.vx = -ic.vx * k;
      /* удар о вертикальную стену подкручивает вращение */
      ic.vrot += ic.vy / Math.max(1, ic.h) * spinFromHit;
    }
    ic.vy = applyFriction(ic.vy, wallFr);
    ic.vrot *= 1 - Math.min(1, wallFr * spinFriction * 0.6);
  }
  if (ic.x > maxX) {
    ic.x = maxX;
    ic.touch = true;
    if (ic.vx > 0) {
      ic.vx = -ic.vx * k;
      ic.vrot -= ic.vy / Math.max(1, ic.h) * spinFromHit;
    }
    ic.vy = applyFriction(ic.vy, wallFr);
    ic.vrot *= 1 - Math.min(1, wallFr * spinFriction * 0.6);
  }
  if (ic.y < minY) {
    ic.y = minY;
    ic.touch = true;
    if (ic.vy < 0) {
      ic.vy = -ic.vy * k;
      ic.vrot -= ic.vx / Math.max(1, ic.w) * spinFromHit;
    }
  }
  if (ic.y > floor) {
    ic.y = floor;
    ic.touch = true;
    if (ic.vy > 0) {
      /* слабое касание не отскакивает, иначе штабель вечно подрагивает */
      ic.vy = ic.vy < BOUNCE_EPS ? 0 : -ic.vy * k;
      /* удар о пол подбрасывает вращение */
      ic.vrot += ic.vx / Math.max(1, ic.w) * spinFromHit;
    }
    /* По полу иконки не скользят: без этого штабель разъезжается
       в стороны и никогда не собирается. */
    ic.vx = applyFriction(ic.vx, floorFriction * FIXED_DT);
    /* и по полу же гасится вращение — трутся в пыли */
    ic.vrot *= 1 - Math.min(1, floorFriction * FIXED_DT * spinFriction * 0.6);
  }

  /* вращение не должно раскручиваться до бесконечности */
  if (ic.vrot > maxSpin) ic.vrot = maxSpin;
  if (ic.vrot < -maxSpin) ic.vrot = -maxSpin;
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
   СЃРІРµСЂС…Сѓ Рё Р±РѕР»СЊС€Рµ РЅРµ РїСЂРѕС…РѕРґРёС‚ СЃРєРІРѕР·СЊ РЅРµС‘. РРєРѕРЅРєРё РЅР° СЃРІРѕРёС… РјРµСЃС‚Р°С… вЂ”
   бесконечная масса: их не сдвинуть, на них можно упасть. */
function resolvePair(a, b) {
  if (!a.free && !b.free) return;

  /* Иконка, которая уже собрана обратно на место, больше не участвует
     в раскладке: её путь задан напрямую, иначе соседи сбивали бы её. */
  if (a.back < 1 || b.back < 1) return;

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

    /* удар выводит из покоя: иначе штабель проглатывал бы падающие иконки */
    if (-vn > WAKE_V) { a.rest = false; b.rest = false; }
    a.back = b.back = 1;
  }

  /* гасим скольжение вдоль поверхности — иначе штабель разъезжается */
  const tx = -ny;
  const ty = nx;
  const vt = (bvx - avx) * tx + (bvy - avy) * ty;
  const jt = -vt * 0.3 / inv;
  if (a.free) { a.vx -= tx * jt; a.vy -= ty * jt; }
  if (b.free) { b.vx += tx * jt; b.vy += ty * jt; }

  /* Касательное скольжение раскручивает иконки: в ролике они вертятся
     всё время, пока толкаются друг о друга. */
  const spin = -vt * spinFromHit / inv;
  if (a.free) a.vrot += spin * (Math.min(a.w, a.h) / Math.max(b.w, b.h));
  if (b.free) b.vrot -= spin * (Math.min(b.w, b.h) / Math.max(a.w, a.h));
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

/* ── Шаг физики ──────────────────────────────────────────── */

let prevGX = 0;
let prevGY = 0;
let settling = false;  /* идёт сборка обратно по тапу */

function step(dt) {
  const g = gravity();
  const drag = Math.pow(0.35, dt);
  const fr = friction * dt;

  /* Наклон заметно изменился — лежащие иконки должны снова поехать.
     Пока гравитация примерно та же, они спят, иначе штабель дрожит. */
  if (Math.hypot(g.x - prevGX, g.y - prevGY) > 40) wake();
  prevGX = g.x;
  prevGY = g.y;

  /* Порог засыпания должен быть выше прироста скорости за один кадр,
     иначе иконка, упёршаяся в пол, никогда не остановится.
     SLEEP_V нужен и для зажатых в штабеле иконок: соседи слегка
     подталкивают их туда-сюда на несколько десятков px/с, и без
     запаса по порогу они не уснут никогда. */
  const restV = Math.max(REST_SPEED, SLEEP_V, Math.hypot(g.x, g.y) * dt * 2.5);

  for (let i = 0; i < icons.length; i++) {
    const ic = icons[i];
    if (!ic.free) continue;
    ic.touch = false;

    /* Сборка обратно на места: тап отменил физику, и иконка сама
       доезжает до исходной точки за RETURN_TIME. */
    if (ic.back < 1) {
      ic.back = Math.min(1, ic.back + dt / RETURN_TIME);
      const e = 1 - Math.pow(1 - ic.back, 3);
      ic.x += (ic.homeX - ic.x) * e;
      ic.y += (ic.homeY - ic.y) * e;
      ic.rot = ic.rot0 * e;
      ic.vrot = 0;
      if (ic.back >= 1) {
        ic.x = ic.homeX;
        ic.y = ic.homeY;
        ic.rot = 0;
        ic.rest = false;
        ic.free = false;
        ic.vx = ic.vy = 0;
        if (settling) {
          settling = false;
          updateState();
        }
      }
      continue;
    }

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

    /* Вращение: раскручивается ударами и быстро затихает само. */
    ic.vrot *= Math.max(0, 1 - spinFriction * dt);
    if (ic.rest) ic.vrot *= Math.max(0, 1 - spinFriction * 2 * dt);

    /* Больше maxTurn за полёт иконка не доворачивается: в ролике это
       короткий доворот, а не непрерывное кручение. */
    if (Math.abs(ic.rot) < maxTurn) {
      ic.rot += ic.vrot * dt;
      if (Math.abs(ic.rot) > maxTurn) {
        ic.rot = ic.rot < 0 ? -maxTurn : maxTurn;
        ic.vrot = 0;
      }
    } else {
      ic.vrot = 0;
    }

    ic.x += ic.vx * dt;
    ic.y += ic.vy * dt;

    collide(ic);

    /* Засыпаем, когда под ноги есть опора. Если опоры нет, но иконка всё
       равно почти не двигается — она зажата в штабеле, и без этого
       правила такие иконки никогда не успокоились бы. Замирать в
       воздухе им не грозит: там скорость растёт сразу. */
    if (slow) {
      ic.slowT += dt;
      if (ic.support || ic.slowT > SLEEP_TIME) ic.rest = true;
    } else {
      ic.slowT = 0;
      if (ic.rest && !ic.support) ic.rest = false;
    }
  }

  solveOverlaps();

  /* Последнее слово — после раскладки пар. Иконка, упёршаясь в опору,
     не должна набирать скорость вдавливания в себя и не должна
     успокаиваться: иначе штабель понемногу разгонялся бы. */
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
}

/* ── Отрисовка ───────────────────────────────────────────── */

let drawOrder = [];

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

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

    /* Поворот вокруг центра: в ролике иконки крутятся, и центр при
       этом остаётся на месте. */
    if (ic.rot) {
      ctx.save();
      ctx.translate(ic.x + ic.w / 2, ic.y + ic.h / 2);
      ctx.rotate(ic.rot);
      ctx.drawImage(ic.sprite, -ic.w / 2, -ic.h / 2, ic.w, ic.h);
      ctx.restore();
    } else {
      ctx.drawImage(ic.sprite, ic.x, ic.y, ic.w, ic.h);
    }
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

  /* Наклон задаёт направление силы тяжести. А резкое движение телефона —
   это тряска, и именно она отпускает иконки. */
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
      hintEl.textContent = 'Коснитесь «Разрешить гироскоп» — без него наклон не сработает';
      return false;
    }
  }

  window.addEventListener('deviceorientation', onOrientation);
  gyroBtn.hidden = true;
  if (!released) hintEl.textContent = defaultHint();
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

/* Тап по экрану собирает иконки обратно на места. Отпускать их может
   только тряска телефона — как в ролике. */
canvas.addEventListener('pointerdown', () => home());

/* ── Старт ──────────────────────────────────────────────── */

main()
  .then(() => requestAnimationFrame(frame))
  .catch(err => fatal(err.message || String(err)));