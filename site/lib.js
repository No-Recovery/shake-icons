'use strict';

/* Общие утилиты: хранилище вкладок и анализ пары скриншотов. */

/* ── Хранилище (IndexedDB) ──────────────────────────────── */

const DB_NAME = 'shake-icons';
const STORE = 'shots';

function openDB() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

async function idbPut(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const rq = tx.objectStore(STORE).get(key);
    rq.onsuccess = () => { db.close(); resolve(rq.result); };
    rq.onerror = () => { db.close(); reject(rq.error); };
  });
}

function newKey() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ── Загрузка изображений ───────────────────────────────── */

const MAX_SIDE = 1500;

/* createImageBitmap появляется только в Safari 15 и новее. В более старых
   браузерах обращения к нему нет вовсе, а это ReferenceError, а не отклонённый
   промис, поэтому .catch() не помогает и нужен отдельный путь. */
function loadViaImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('не удалось прочитать изображение'));
    };
    img.src = url;
  });
}

function loadBitmap(blob) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob).catch(() => loadViaImg(blob));
  }
  return loadViaImg(blob);
}

/* Размер анализа: длинная сторона не больше MAX_SIDE */
function analysisSize(img) {
  const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  return { w: Math.max(1, Math.round(img.width * k)), h: Math.max(1, Math.round(img.height * k)), k };
}

function toCanvas(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

/* ── Разница двух скриншотов ────────────────────────────── */

function luminance(d, i) {
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

/* Размывание маски по Box-blur, радиус r */
function boxBlur(src, w, h, r) {
  const tmp = new Uint8ClampedArray(src.length);
  const dst = new Uint8ClampedArray(src.length);
  const norm = 1 / (2 * r + 1);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * norm;
      sum -= src[row + Math.min(w - 1, Math.max(0, x - r))];
      sum += src[row + Math.min(w - 1, Math.max(0, x + r + 1))];
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * norm;
      sum -= tmp[Math.min(h - 1, Math.max(0, y - r)) * w + x];
      sum += tmp[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x];
    }
  }
  return dst;
}

/*
  Сравнивает два скриншота и возвращает:
    w, h      — размер анализа
    mask      — Uint8ClampedArray, сглаженная маска различий 0..255
    edgeA/B   — плотность границ внутри маски (для авто-выбора ролей)
*/
function analyze(imgA, imgB, threshold) {
  const th = threshold == null ? 26 : threshold;
  const a = analysisSize(imgA);
  const b = analysisSize(imgB);

  const cA = toCanvas(imgA, a.w, a.h);
  const cB = toCanvas(imgB, a.w, a.h);

  const px = a.w * a.h;
  const dA = cA.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, a.w, a.h).data;
  const dB = cB.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, a.w, a.h).data;

  const raw = new Uint8ClampedArray(px);
  for (let p = 0; p < px; p++) {
    const i = p * 4;
    const dr = Math.abs(dA[i] - dB[i]);
    const dg = Math.abs(dA[i + 1] - dB[i + 1]);
    const db = Math.abs(dA[i + 2] - dB[i + 2]);
    const d = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
    raw[p] = d > th ? 255 : 0;
  }

  const mask = boxBlur(raw, a.w, a.h, 1);
  for (let p = 0; p < px; p++) mask[p] = mask[p] > 60 ? 255 : 0;

  /* Плотность границ внутри маски: у картинки с иконками их больше */
  const edgeA = edgeDensity(dA, mask, a.w, a.h);
  const edgeB = edgeDensity(dB, mask, a.w, a.h);

  return { w: a.w, h: a.h, mask, edgeA, edgeB, canvasA: cA, canvasB: cB };
}

function edgeDensity(data, mask, w, h) {
  let sum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const p = row + x;
      if (!mask[p]) continue;
      const i = p * 4;
      const gx = luminance(data, i + 4) - luminance(data, i - 4);
      const gy = luminance(data, i + w * 4) - luminance(data, i - w * 4);
      sum += Math.min(255, Math.hypot(gx, gy));
      n++;
    }
  }
  return n ? sum / n : 0;
}

/* ── Компоненты маски ───────────────────────────────────── */

const MIN_SIDE_FRAC = 0.018;
const MIN_AREA_FRAC = 0.00022;
const MERGE_FRAC = 0.015;
const PAD = 3;
const MAX_ICONS = 2000;

/*
  Связные компоненты маски различий: каждая область — отдельная иконка.
  Мелкий шум (цифры часов, точки) отсеивается по размеру.
*/
function components(mask, w, h, minSide, minArea) {
  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const out = [];
  let nextId = 0;

  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || labels[seed] !== -1) continue;

    const id = nextId++;
    const px = [];
    let sp = 0;
    stack[sp++] = seed;
    labels[seed] = id;

    let minX = w, minY = h, maxX = -1, maxY = -1;

    while (sp > 0) {
      const q = stack[--sp];
      px.push(q);

      const x = q % w;
      const y = (q / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0     && mask[q - 1] && labels[q - 1] === -1) { labels[q - 1] = id; stack[sp++] = q - 1; }
      if (x < w - 1 && mask[q + 1] && labels[q + 1] === -1) { labels[q + 1] = id; stack[sp++] = q + 1; }
      if (y > 0     && mask[q - w] && labels[q - w] === -1) { labels[q - w] = id; stack[sp++] = q - w; }
      if (y < h - 1 && mask[q + w] && labels[q + w] === -1) { labels[q + w] = id; stack[sp++] = q + w; }
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (px.length < minArea || bw < minSide || bh < minSide) continue;

    out.push({ px, minX, minY, w: bw, h: bh });
  }

  /* порядок чтения: сверху вниз, слева направо */
  out.sort((a, b) => (a.minY - b.minY) || (a.minX - b.minX));
  return out;
}

/*
  Склеивает части, стоящие рядом: иконка с подписью становится одним
  объектом. Склейка идёт только при вертикальной близости И заметном
  перекрытии по X, поэтому соседние иконки в сетке не сливаются.
  components() обязана вернуть список, отсортированный по minY.
*/
function mergeComponents(comps, gap) {
  const n = comps.length;
  if (n < 2 || gap <= 0) return comps;

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = x => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };

  for (let i = 0; i < n; i++) {
    const A = comps[i];
    const aTop = A.minY;
    const aBot = A.minY + A.h;
    const aL = A.minX;
    const aR = A.minX + A.w;

    for (let j = i + 1; j < n; j++) {
      const B = comps[j];
      if (B.minY - gap > aBot) break;          /* список отсортирован по minY */

      /* горизонтальное перекрытие не меньше половины узкой части */
      const bL = B.minX;
      const bR = B.minX + B.w;
      const ov = Math.min(aR, bR) - Math.max(aL, bL);
      if (ov <= 0 || ov < 0.5 * Math.min(A.w, B.w)) continue;

      /* вертикальная близость */
      const vGap = Math.max(aTop, B.minY) - Math.min(aBot, B.minY + B.h);
      if (Math.max(aTop, B.minY) <= Math.min(aBot, B.minY + B.h)) {
        /* пересечение по вертикали — склеиваем */
      } else if (vGap > gap) {
        continue;
      }

      const ra = find(i), rb = find(j);
      if (ra !== rb) parent[rb] = ra;
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let list = groups.get(r);
    if (!list) { list = []; groups.set(r, list); }
    list.push(comps[i]);
  }

  const out = [];
  groups.forEach(list => {
    if (list.length === 1) { out.push(list[0]); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const px = [];
    for (const c of list) {
      if (c.minX < minX) minX = c.minX;
      if (c.minY < minY) minY = c.minY;
      if (c.minX + c.w > maxX) maxX = c.minX + c.w;
      if (c.minY + c.h > maxY) maxY = c.minY + c.h;
      for (let i = 0; i < c.px.length; i++) px.push(c.px[i]);
    }
    out.push({ px, minX, minY, w: maxX - minX, h: maxY - minY });
  });

  out.sort((a, b) => (a.minY - b.minY) || (a.minX - b.minX));
  return out;
}

/* Спрайт иконки: пиксели со снимка с иконками, альфа — по маске */
function makeSprite(comp, srcCanvas, boundsW, boundsH) {
  const x0 = Math.max(0, comp.minX - PAD);
  const y0 = Math.max(0, comp.minY - PAD);
  const x1 = Math.min(boundsW, comp.minX + comp.w + PAD);
  const y1 = Math.min(boundsH, comp.minY + comp.h + PAD);
  const w = x1 - x0;
  const h = y1 - y0;

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cx = c.getContext('2d');
  cx.drawImage(srcCanvas, x0, y0, w, h, 0, 0, w, h);

  const maskC = document.createElement('canvas');
  maskC.width = w;
  maskC.height = h;
  const mx = maskC.getContext('2d');
  const md = mx.createImageData(w, h);

  for (let i = 0; i < comp.px.length; i++) {
    const q = comp.px[i];
    const lx = (q % boundsW) - x0;
    const ly = ((q / boundsW) | 0) - y0;
    if (lx < 0 || ly < 0 || lx >= w || ly >= h) continue;
    const o = (ly * w + lx) * 4;
    md.data[o] = 255;
    md.data[o + 1] = 255;
    md.data[o + 2] = 255;
    md.data[o + 3] = 255;
  }
  mx.putImageData(md, 0, 0);

  cx.filter = 'blur(0.8px)';
  cx.globalCompositeOperation = 'destination-in';
  cx.drawImage(maskC, 0, 0);
  cx.filter = 'none';

  return { canvas: c, x: x0, y: y0, w, h };
}

/* Пороги отбора иконок для размера w×h */
function iconLimits(w, h) {
  const minDim = Math.min(w, h);
  return {
    minSide: Math.max(8, Math.round(minDim * MIN_SIDE_FRAC)),
    minArea: Math.max(160, Math.round(w * h * MIN_AREA_FRAC)),
    mergeGap: Math.max(6, Math.round(minDim * MERGE_FRAC))
  };
}