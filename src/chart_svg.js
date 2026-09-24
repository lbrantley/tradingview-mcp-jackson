/**
 * CANDLE CHARTS FOR THE REVIEWS.
 *
 * The daily and weekly reviews are markdown, committed to GitHub, and read on a
 * phone through a Pushover link. That delivery path decides everything here:
 *
 *   - GitHub SANITISES inline <svg> in markdown, so a chart has to be a FILE
 *     referenced as an image, not markup in the document.
 *   - A sanitised, camo-proxied image resolves no CSS variables, no external
 *     fonts and no external anything. Every colour is a literal, every font a
 *     generic stack, and the image paints its own background instead of
 *     inheriting one.
 *   - GitHub has no candlestick renderer -- mermaid draws lines and bars only --
 *     so these are hand-drawn.
 *
 * The light card reads on both GitHub themes: a self-contained image carries its
 * own ground, so it does not invert under the dark reader.
 *
 * An order block IS a candle -- its zone is that candle's own high and low -- so
 * these are candlesticks, never a close line. Hollow closed up, filled closed
 * down, which keeps colour free for the zone and the limit.
 */

const C = {
  bg: '#FFFFFF', ink: '#12171A', muted: '#667078', hair: '#E6EBEE', line: '#CBD4D9',
  accent: '#0E6E6B', zone: '#0E6E6B1F', zoneEdge: '#0E6E6B55',
  long: '#1E7A4C', short: '#A83A2E', warn: '#9A6510',
};
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const SANS = 'system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n1 = v => Number(v).toFixed(1);

/**
 * Slice the two windows a block needs. One chart cannot do both jobs: most live
 * blocks are months old, so a window wide enough to reach the origin candle
 * squashes the candles to hairlines, and one tight enough to read them cannot
 * see it.
 *
 *   origin  the candles that MADE the block -- the block bar, the run off it,
 *           and the CHoCH that validated it.
 *   recent  where price is now against the zone.
 */
export function blockWindows(bars, block, tf, recentBars = 60) {
  const iB = bars.findIndex(x => x.time === block.blockTime);
  const iC = bars.findIndex(x => x.time === block.chochTime);
  if (iB < 0 || iC < 0) return null;
  const oStart = Math.max(0, iB - 3);
  const oEnd = Math.min(bars.length - 1, iC + 2);
  const rStart = Math.max(0, bars.length - recentBars);
  const ohlc = x => [+x.open, +x.high, +x.low, +x.close];
  const stamp = x => tf === 'D'
    ? x.time.slice(5, 10)
    : `${x.time.slice(5, 10)} ${x.time.slice(11, 13)}h`;
  return {
    origin: bars.slice(oStart, oEnd + 1).map(ohlc),
    originT: bars.slice(oStart, oEnd + 1).map(stamp),
    oBlock: iB - oStart, oChoch: iC - oStart,
    recent: bars.slice(rStart).map(ohlc),
    recentT: bars.slice(rStart).map(stamp),
  };
}

function makeScale(bars, extra, box) {
  let lo = Math.min(...bars.map(b => b[2]), ...extra);
  let hi = Math.max(...bars.map(b => b[1]), ...extra);
  const pad = (hi - lo) * 0.08 || 1e-6;
  lo -= pad; hi += pad;
  const n = bars.length;
  const plotW = box.w - box.pl - box.pr;
  return {
    X: i => box.x + box.pl + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW),
    Y: p => box.y + box.pt + (1 - (p - lo) / (hi - lo)) * (box.h - box.pt - box.pb),
    step: plotW / Math.max(1, n - 1),
  };
}

function candles(bars, s, w) {
  let out = '';
  for (let i = 0; i < bars.length; i++) {
    const [o, h, l, c] = bars[i];
    const x = s.X(i), up = c >= o;
    const top = s.Y(Math.max(o, c)), bot = s.Y(Math.min(o, c));
    out += `<line x1="${n1(x)}" y1="${n1(s.Y(h))}" x2="${n1(x)}" y2="${n1(s.Y(l))}" stroke="${C.ink}" stroke-width="1"/>`;
    out += `<rect x="${n1(x - w / 2)}" y="${n1(top)}" width="${n1(w)}" height="${n1(Math.max(1, bot - top))}"`
      + ` fill="${up ? C.bg : C.ink}" stroke="${C.ink}" stroke-width="1"/>`;
  }
  return out;
}

/** Time axis. Without one a price chart is just a shape. */
function axis(times, s, box, every) {
  const yb = box.y + box.h - 16;
  let out = `<line x1="${n1(box.x + 2)}" y1="${n1(yb)}" x2="${n1(box.x + box.w - box.pr + 2)}" y2="${n1(yb)}" stroke="${C.hair}" stroke-width="1"/>`;
  for (let i = 0; i < times.length; i += every) {
    const x = s.X(i);
    const anchor = i === 0 ? 'start' : (i >= times.length - every ? 'end' : 'middle');
    out += `<line x1="${n1(x)}" y1="${n1(yb)}" x2="${n1(x)}" y2="${n1(yb + 3)}" stroke="${C.line}" stroke-width="1"/>`
      + `<text x="${n1(x)}" y="${n1(yb + 12)}" fill="${C.muted}" text-anchor="${anchor}"`
      + ` font-family="${MONO}" font-size="9.5">${esc(times[i])}</text>`;
  }
  return out;
}

const hline = (p, s, box, col, dash) =>
  `<line x1="${n1(box.x + 2)}" y1="${n1(s.Y(p))}" x2="${n1(box.x + box.w - box.pr + 2)}" y2="${n1(s.Y(p))}"`
  + ` stroke="${col}" stroke-width="1.4"${dash ? ' stroke-dasharray="4 3"' : ''}/>`;

const plabel = (p, text, s, box, col) =>
  `<text x="${n1(box.x + box.w - box.pr + 6)}" y="${n1(s.Y(p) + 3.4)}" fill="${col}"`
  + ` font-family="${MONO}" font-size="10">${esc(text)}</text>`;

/**
 * One self-contained image per block: how it formed on the left, where price is
 * now on the right, with a legend baked in — markdown alt text cannot carry a
 * key, so the image has to explain itself.
 */
export function blockChart(b, win) {
  const W = 880, H = 258, d = b.decimals;
  const f = v => Number(v).toFixed(d);
  const dirCol = b.dir > 0 ? C.long : C.short;
  const TOP = 46;
  const boxO = { x: 8, y: TOP, w: 330, h: 168, pl: 12, pr: 58, pt: 12, pb: 34 };
  const boxR = { x: 352, y: TOP, w: 520, h: 168, pl: 8, pr: 62, pt: 12, pb: 34 };

  const sO = makeScale(win.origin, [b.zoneLow, b.zoneHigh, b.swing, b.entry], boxO);
  const sR = makeScale(win.recent, [b.zoneLow, b.zoneHigh, b.stop, b.entry, b.live], boxR);
  const wO = Math.min(11, Math.max(3, sO.step * 0.6));
  const wR = Math.min(7, Math.max(1.6, sR.step * 0.62));

  const zoneRect = (s, box) => {
    const t = s.Y(b.zoneHigh), bt = s.Y(b.zoneLow);
    return `<rect x="${n1(box.x + 2)}" y="${n1(t)}" width="${n1(box.w - box.pr)}"`
      + ` height="${n1(Math.max(2, bt - t))}" fill="${C.zone}"/>`;
  };
  const bx = sO.X(win.oBlock), zT = sO.Y(b.zoneHigh), zB = sO.Y(b.zoneLow);

  const legend = [
    [`<line x1="0" y1="4" x2="16" y2="4" stroke="${C.accent}" stroke-width="2"/>`, 'limit (zone edge)'],
    [`<line x1="0" y1="4" x2="16" y2="4" stroke="${dirCol}" stroke-width="2" stroke-dasharray="4 3"/>`, 'stop'],
    [`<line x1="0" y1="4" x2="16" y2="4" stroke="${C.muted}" stroke-width="1" stroke-dasharray="1 3"/>`, 'swing the CHoCH took out'],
    [`<rect x="1" y="0" width="14" height="9" fill="${C.zone}" stroke="${C.zoneEdge}"/>`, 'block zone'],
    [`<rect x="2" y="-1" width="11" height="11" fill="none" stroke="${C.accent}" stroke-width="1.6" rx="2"/>`, 'block candle'],
    [`<rect x="4" y="-2" width="7" height="12" fill="${C.bg}" stroke="${C.ink}" stroke-width="1.3"/>`, 'closed up'],
    [`<rect x="4" y="-2" width="7" height="12" fill="${C.ink}" stroke="${C.ink}" stroke-width="1.3"/>`, 'closed down'],
    [`<circle cx="8" cy="4" r="3.6" fill="${C.ink}"/>`, 'price now'],
  ];
  let lx = 10, legendSvg = '';
  for (const [mark, label] of legend) {
    legendSvg += `<g transform="translate(${n1(lx)},${H - 16})">${mark}`
      + `<text x="22" y="8" fill="${C.muted}" font-family="${SANS}" font-size="10.5">${esc(label)}</text></g>`;
    lx += 34 + label.length * 5.4;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"`
    + ` aria-label="${esc(b.sym)} ${b.dir > 0 ? 'long' : 'short'} order block: the candles that formed it, and where price is now">`
    + `<rect width="${W}" height="${H}" fill="${C.bg}"/>`
    + `<text x="10" y="22" fill="${C.ink}" font-family="${SANS}" font-size="15" font-weight="700">${esc(b.sym)}`
    + ` <tspan fill="${dirCol}" font-size="12">${b.dir > 0 ? 'LONG' : 'SHORT'}</tspan>`
    + ` <tspan fill="${C.muted}" font-size="12">${b.tf === 'D' ? 'daily' : '4-hour'} block</tspan></text>`
    + `<text x="10" y="38" fill="${C.muted}" font-family="${MONO}" font-size="11">`
    + `limit ${esc(f(b.entry))} · stop ${esc(f(b.stop))} · ${Math.round(b.riskPips)}p = 1R · `
    + `${Math.abs(b.distanceR).toFixed(2)}R away · waited ${b.age}d</text>`
    + `<text x="${boxO.x + 12}" y="${TOP - 4}" fill="${C.muted}" font-family="${SANS}" font-size="10" font-weight="600">`
    + `HOW IT FORMED · ${esc(b.blockTime)}</text>`
    + `<text x="${boxR.x + 8}" y="${TOP - 4}" fill="${C.muted}" font-family="${SANS}" font-size="10" font-weight="600">`
    + `WHERE PRICE IS NOW</text>`
    // --- origin panel
    + zoneRect(sO, boxO)
    + hline(b.swing, sO, boxO, C.muted, false).replace('stroke-width="1.4"', 'stroke-width="1" stroke-dasharray="1 3"')
    + hline(b.entry, sO, boxO, C.accent, false)
    + candles(win.origin, sO, wO)
    + `<rect x="${n1(bx - wO / 2 - 3)}" y="${n1(zT - 3)}" width="${n1(wO + 6)}"`
    + ` height="${n1(Math.max(8, zB - zT + 6))}" fill="none" stroke="${C.accent}" stroke-width="1.6" rx="2"/>`
    + `<text x="${n1(sO.X(win.oChoch))}" y="${TOP + 19}" fill="${C.accent}" text-anchor="middle"`
    + ` font-family="${MONO}" font-size="10" font-weight="700">C</text>`
    + axis(win.originT, sO, boxO, win.origin.length > 10 ? 3 : 2)
    + plabel(b.entry, f(b.entry), sO, boxO, C.accent)
    + plabel(b.swing, f(b.swing), sO, boxO, C.muted)
    // --- recent panel
    + zoneRect(sR, boxR)
    + candles(win.recent, sR, wR)
    + hline(b.entry, sR, boxR, C.accent, false)
    + hline(b.stop, sR, boxR, dirCol, true)
    + `<circle cx="${n1(sR.X(win.recent.length - 1))}" cy="${n1(sR.Y(b.live))}" r="3.6" fill="${C.ink}"/>`
    + axis(win.recentT, sR, boxR, 15)
    + plabel(b.entry, f(b.entry), sR, boxR, C.accent)
    + plabel(b.stop, f(b.stop), sR, boxR, dirCol)
    + plabel(b.live, f(b.live), sR, boxR, C.ink)
    + legendSvg
    + '</svg>';
}
