'use strict';

/* Синтетическая пара скриншотов для тестов: чистый экран и тот же экран с иконками. */

const TD = {
  W: 780,
  H: 1688,
  COLS: 4,
  ROWS: 4,
  ICON: 100,
  GAPX: 40,
  GAPY: 60,
  PADX: 60,
  PADY: 200,
  COLORS: ['#ff2d78', '#0a84ff', '#30d158', '#ffd60a',
           '#5e5ce6', '#ff9f0a', '#64d2ff', '#ff375f',
           '#32d74b', '#bf5af2', '#40c8e0', '#ff453a',
           '#66d4cf', '#ac8e68', '#d4a1ff', '#ffd426']
};

function tdWallpaper(c) {
  const g = c.createLinearGradient(0, 0, TD.W, TD.H);
  g.addColorStop(0, '#1b1035');
  g.addColorStop(0.55, '#0b0a14');
  g.addColorStop(1, '#140d24');
  c.fillStyle = g;
  c.fillRect(0, 0, TD.W, TD.H);

  c.fillStyle = 'rgba(255,255,255,.9)';
  c.font = '600 34px sans-serif';
  c.fillText('9:41', 90, 80);
}

function tdRoundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* Ожидаемые позиции иконок */
function tdExpected() {
  const out = [];
  for (let r = 0; r < TD.ROWS; r++) {
    for (let c = 0; c < TD.COLS; c++) {
      out.push({
        x: TD.PADX + c * (TD.ICON + TD.GAPX),
        y: TD.PADY + r * (TD.ICON + TD.GAPY),
        color: TD.COLORS[r * TD.COLS + c]
      });
    }
  }
  return out;
}

function tdIconBox(c, x, y, color) {
  c.fillStyle = color;
  tdRoundRect(c, x, y, TD.ICON, TD.ICON, 26);
  c.fill();
  c.fillStyle = 'rgba(255,255,255,.35)';
  tdRoundRect(c, x, y + TD.ICON - 26, TD.ICON, 26, 14);
  c.fill();
}

function tdIconLabel(c, x, y) {
  c.fillStyle = 'rgba(255,255,255,.55)';
  tdRoundRect(c, x + TD.ICON / 2 - 45, y + TD.ICON + 14, 90, 16, 8);
  c.fill();
}

function tdMakePair() {
  const clean = document.createElement('canvas');
  clean.width = TD.W;
  clean.height = TD.H;
  tdWallpaper(clean.getContext('2d'));

  const withIcons = document.createElement('canvas');
  withIcons.width = TD.W;
  withIcons.height = TD.H;
  const wc = withIcons.getContext('2d');
  tdWallpaper(wc);
  tdExpected().forEach(e => {
    tdIconBox(wc, e.x, e.y, e.color);
    tdIconLabel(wc, e.x, e.y);
  });

  /* мелкий шум, который должен быть отброшен по размеру */
  wc.fillStyle = '#fff';
  wc.fillRect(TD.W - 40, 120, 3, 3);
  wc.fillRect(TD.W - 60, 120, 3, 3);

  return { clean, withIcons, expected: tdExpected() };
}

function tdToBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}