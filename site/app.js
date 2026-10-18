'use strict';

/* ── Экран загрузки: принимаем два скриншота и открываем новую вкладку. */

const $ = (s) => document.querySelector(s);

const pickBtn = $('#pick');
const fileInp = $('#files');
const hint = $('#hint');
const pair = $('#pair');
const status = $('#status');
const actions = $('#actions');
const goBtn = $('#go');
const errorBox = $('#error');
const swapBtn = $('#swap');
const replaceBtn = $('#replace');

const GO_LABEL = 'Тестировать';

let cleanBlob = null;
let iconsBlob = null;
let storeKey = null;

/* ── Ошибки ─────────────────────────────────────────────── */

function showError(msg) {
  errorBox.hidden = false;
  errorBox.textContent = msg;
}
function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

window.addEventListener('error', e => showError('Ошибка скрипта: ' + e.message));

/* ── Загрузка файлов ────────────────────────────────────── */

pickBtn.addEventListener('click', () => fileInp.click());
replaceBtn.addEventListener('click', () => fileInp.click());

fileInp.addEventListener('change', async () => {
  clearError();
  const files = Array.from(fileInp.files || []);
  if (files.length !== 2) {
    showError('Нужно выбрать ровно два изображения.');
    fileInp.value = '';
    return;
  }
  if (!files.every(f => /^image\//.test(f.type))) {
    showError('Оба файла должны быть изображениями.');
    fileInp.value = '';
    return;
  }

  await setup(files);
  fileInp.value = '';
});

/* Проверка, что пара похожа на скриншоты домашнего экрана iPhone:
   оба вертикальные, одного размера, с «айфонным» соотношением сторон
   и достаточным разрешением. Левые фото (альбомные, квадратные, разные
   размеры) отсекаются до анализа. */
function validateShots(w0, h0, w1, h1) {
  if (h0 <= w0 || h1 <= w1) {
    return 'Нужны вертикальные скриншоты — этот экран работает только с ними.';
  }
  if (Math.abs(w0 - w1) > w0 * 0.02 || Math.abs(h0 - h1) > h0 * 0.02) {
    return 'Скриншоты разного размера — нужны два снимка одного экрана.';
  }
  const ratio = w0 / h0;
  if (ratio < 0.40 || ratio > 0.60) {
    return 'Похоже, это не скриншот iPhone: не подходит соотношение сторон.';
  }
  if (Math.min(w0, h0) < 500) {
    return 'Слишком маленькое разрешение — нужен настоящий скриншот с телефона.';
  }
  return null;
}

async function setup(files) {
  hint.textContent = 'Анализируем…';
  pair.hidden = true;
  actions.hidden = true;
  goBtn.hidden = true;
  status.hidden = true;

  try {
    const bitmaps = await Promise.all(files.map(f => loadBitmap(f)));

    const shotErr = validateShots(bitmaps[0].width, bitmaps[0].height,
                                  bitmaps[1].width, bitmaps[1].height);
    if (shotErr) {
      hint.textContent = 'Выберите два скриншота одного экрана: без иконок и с иконками';
      showError(shotErr);
      return;
    }

    /* Какое фото с иконками: там плотнее границы внутри зоны различий */
    const res = analyze(bitmaps[0], bitmaps[1]);
    const iconsFirst = res.edgeA > res.edgeB;

    const pct = Math.round(100 * res.mask.reduce((s, v) => s + (v ? 1 : 0), 0) / res.mask.length);
    if (pct < 1) {
      hint.textContent = 'Выберите два скриншота одного экрана: без иконок и с иконками';
      showError('Скриншоты почти одинаковые — на одном из них должны быть иконки.');
      return;
    }
    if (pct > 60) {
      hint.textContent = 'Выберите два скриншота одного экрана: без иконок и с иконками';
      showError('Слишком много различий — это похоже на две разные картинки, а не скриншоты одного экрана.');
      return;
    }

    cleanBlob = iconsFirst ? files[1] : files[0];
    iconsBlob = iconsFirst ? files[0] : files[1];

    paint(bitmaps[iconsFirst ? 1 : 0], bitmaps[iconsFirst ? 0 : 1]);

    hint.textContent = 'Готово. Откроется новая вкладка с этим экраном.';
    status.hidden = false;
    status.innerHTML = 'Зона различий: <b>' + pct + '%</b> · иконки определены на '
      + '<b>' + (iconsFirst ? 'первом' : 'втором') + '</b> фото';

    pair.hidden = false;
    actions.hidden = false;
    goBtn.hidden = false;
    goBtn.disabled = false;
  } catch (err) {
    hint.textContent = 'Выберите два скриншота одного экрана: без иконок и с иконками';
    showError('Не удалось прочитать изображения: ' + err.message);
  }
}

function paint(cleanImg, iconsImg) {
  const slots = document.querySelectorAll('.slot');
  [[slots[0], cleanImg], [slots[1], iconsImg]].forEach(([slot, img]) => {
    const c = slot.querySelector('canvas');
    const k = Math.min(200 / img.height, 180 / img.width);
    c.width = Math.round(img.width * k) || 1;
    c.height = Math.round(img.height * k) || 1;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  });
}

swapBtn.addEventListener('click', async () => {
  const a = cleanBlob;
  cleanBlob = iconsBlob;
  iconsBlob = a;
  try {
    const bitmaps = await Promise.all([cleanBlob, iconsBlob].map(f => loadBitmap(f)));
    paint(bitmaps[0], bitmaps[1]);
  } catch (err) {
    showError('Не удалось поменять местами: ' + err.message);
  }
});

/* ── Новая вкладка ──────────────────────────────────────── */

/* Вкладку открываем синхронно, прямо в обработчике клика: после любого await
   жест пользователя считается протухшим и блокировщик не даёт открыть окно. */
goBtn.addEventListener('click', () => {
  goBtn.disabled = true;
  goBtn.textContent = 'Готовим…';

  const tab = window.open('about:blank', '_blank');
  if (!tab) {
    goBtn.disabled = false;
    goBtn.textContent = GO_LABEL;
    showError('Браузер заблокировал новую вкладку. Разрешите всплывающие окна для этого сайта.');
    return;
  }

  (async () => {
    try {
      if (!storeKey) storeKey = newKey();
      await idbPut(storeKey, { clean: cleanBlob, icons: iconsBlob, at: Date.now() });
      tab.location.replace('compose.html#' + storeKey);
      goBtn.textContent = GO_LABEL;
      goBtn.disabled = false;
      hint.textContent = 'Вкладка с этим экраном открыта в соседней вкладке.';
    } catch (err) {
      tab.close();
      showError('Не удалось сохранить изображения: ' + err.message);
      goBtn.disabled = false;
      goBtn.textContent = GO_LABEL;
    }
  })();
});