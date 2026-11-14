// Hover card contents for the patch view.
import { el } from './util.js';
import { dirName } from './movers.js';

const ARCSEC_PER_RAD = 206264.806;
/** Integrated model flux (MJy/sr * px) -> mJy for pixels of `scale` arcsec. */
export const fluxMJy = (flux, scale) => flux * 1e9 * (scale / ARCSEC_PER_RAD) ** 2;
const fmtFlux = (mjy) => {
  const a = Math.abs(mjy);
  if (a >= 1000) return `${(mjy / 1000).toFixed(2)} Jy`;
  if (a >= 1) return `${mjy.toFixed(2)} mJy`;
  if (a >= 0.001) return `${(mjy * 1000).toFixed(1)} µJy`;
  return `${mjy.toExponential(1)} mJy`;
};
const fmtDist = (plx) => {
  const pc = 1000 / plx, ly = pc * 3.26156;
  const f = (v) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
  return `about ${f(ly)} light-years (${f(pc)} pc)`;
};
const row = (label, value) => el('div', { class: 'hc-row' }, `${label} `, el('b', { text: value }));

export function sourceType(s) {
  if (s.mover) return 'Moving object';
  if (s.saturated) return 'Very bright star';
  if (s.kind === 'extended') return 'Extended source (galaxy or nebula)';
  if (!s.cat) return 'Unmatched source';
  return 'Star';
}
export function sourceName(s) {
  if (s.cat && s.cat.id) return s.cat.id;
  if (s.saturated) return 'Bright source';
  return s.kind === 'extended' ? 'Extended source' : 'Source with no catalogue match';
}

function describeSource(s, scale) {
  const kids = [el('div', { class: 'hc-type', text: sourceType(s) }), el('div', { class: 'hc-name', text: sourceName(s) })];
  if (s.cat && s.cat.catalog) kids.push(row('Catalogue', String(s.cat.catalog).replace(/^gaia$/i, 'Gaia DR3').replace(/^catwise$/i, 'CatWISE')));
  if (isFinite(s.flux)) {
    const mj = fluxMJy(s.flux, scale), er = isFinite(s.flux_err) ? fluxMJy(s.flux_err, scale) : null;
    kids.push(row('Brightness', `${fmtFlux(mj)}${er !== null ? ` ± ${fmtFlux(er)}` : ''}${isFinite(s.snr) ? ` · S/N ${s.snr < 10 ? s.snr.toFixed(1) : Math.round(s.snr)}` : ''}`));
  }
  if (s.cat && isFinite(s.cat.mag)) kids.push(row('Catalogue magnitude', s.cat.mag.toFixed(1)));
  if (s.cat && s.cat.parallax_mas > 0) kids.push(row('Distance', fmtDist(s.cat.parallax_mas)));
  if (s.saturated) kids.push(el('div', { class: 'hc-row', text: 'Very bright — brightness is a lower limit.' }));
  return kids;
}
function describeMover(m) {
  const kids = [
    el('div', { class: 'hc-type', text: m.kind === 'known' ? 'Known asteroid' : m.kind === 'candidate' ? 'Unknown mover candidate' : 'Mover candidate' }),
    el('div', { class: 'hc-name', text: m.label }),
  ];
  if (isFinite(m.rate)) kids.push(row('Motion', `${m.rate.toFixed(2)}″ per hour${isFinite(m.pa) ? ` toward ${dirName(m.pa)} (PA ${Math.round(m.pa)}°)` : ''}`));
  if (m.vmag) kids.push(row('Predicted magnitude', m.vmag.toFixed(1)));
  if (isFinite(m.confidence)) kids.push(row('Confidence', `${Math.round(m.confidence * 100)}%`));
  return kids;
}

/** movers: mover objects under the cursor; srcs: fitted sources under the cursor (nearest first). */
export function buildCard(srcs, movers, scale) {
  const box = el('div');
  if (movers.length) box.append(...describeMover(movers[0]));
  else if (srcs.length) box.append(...describeSource(srcs[0], scale));
  const others = movers.length ? srcs : srcs.slice(1);
  const extra = movers.length > 1 ? movers.slice(1).map((m) => `${m.label} (moving object)`) : [];
  const names = [...extra, ...others.map((s) => (sourceName(s) === sourceType(s) ? sourceType(s) : `${sourceName(s)} · ${sourceType(s).toLowerCase()}`))];
  if (names.length) {
    const b = el('div', { class: 'hc-blend' }, el('div', { text: `Blend: ${names.length + 1} sources here` }));
    for (const n of names.slice(0, 5)) b.append(el('div', { text: `· ${n}` }));
    box.append(b);
  }
  return box;
}
