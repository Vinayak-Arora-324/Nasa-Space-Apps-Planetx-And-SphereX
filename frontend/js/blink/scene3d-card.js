// Info card for a star or body in the 3D fly-through. DOM only (no WebGL); text goes in via textContent, never innerHTML.
import { TIER_INFO, TIERS, fmtValue } from './scene3d-physics.js';

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function addRow(doc, dl, label, text, tier, src, used) {
  const t = TIER_INFO[tier] ? tier : 'illustrative';
  used.add(t);
  const dt = el(doc, 'dt', null, label);
  const dd = el(doc, 'dd');
  const g = el(doc, 'span', `tier tier-${t}`, TIER_INFO[t].glyph);
  g.title = TIER_INFO[t].label + (src ? ' · ' + src : '');
  dd.appendChild(g);
  dd.appendChild(el(doc, 'span', 'num', ' ' + text));
  dl.appendChild(dt); dl.appendChild(dd);
}

const tierOf = (tier) => (TIER_INFO[tier] ? tier : 'illustrative');

/**
 * A compact list under the rows, e.g. the planets of a star: children = { title, items: [{ name, line, tier, onGo | null }], total, note }.
 * Each item has its tier glyph (the legend counts it) and, when onGo is a function, a small "Go there" button; `note` says why not.
 */
function addChildren(doc, root, children) {
  const box = el(doc, 'div', 'card-kids');
  // one list, or several (children.groups: [{ title, items }], a heading each, e.g. 'Exoplanets · 7' and 'Black holes · 1')
  const groups = children.groups && children.groups.length ? children.groups : [{ title: children.title, items: children.items }];
  for (const g of groups) addKidList(doc, box, g);
  if (children.note) box.appendChild(el(doc, 'p', 'card-note', children.note));
  root.appendChild(box);
}
function addKidList(doc, box, children) {
  box.appendChild(el(doc, 'div', 'card-kids-title', children.title || ''));
  const ul = el(doc, 'ul', 'card-kid-list');
  for (const it of children.items || []) {
    const t = tierOf(it.tier);
    const li = el(doc, 'li', 'card-kid');
    const g = el(doc, 'span', `tier tier-${t}`, TIER_INFO[t].glyph);
    g.title = TIER_INFO[t].label;
    const text = el(doc, 'span', 'card-kid-text');
    text.appendChild(el(doc, 'span', 'card-kid-name', it.name));
    if (it.line) text.appendChild(el(doc, 'span', 'card-kid-line num', it.line));
    li.appendChild(g); li.appendChild(text);
    if (typeof it.onGo === 'function') {
      const b = el(doc, 'button', 'btn card-kid-go', 'Go there');
      b.type = 'button'; b.title = `Go to ${it.name}`;
      b.addEventListener('click', it.onGo);
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
  box.appendChild(ul);
}

function finish(doc, root, dl, used, notes, onGo, loading, error, goLabel, children, goDisabled) {
  const kids = children && children.items && children.items.length ? children : null;
  if (kids) for (const it of kids.items) used.add(tierOf(it.tier));   // so the legend explains the list's glyphs too
  root.appendChild(dl);
  if (used.size) {
    const leg = el(doc, 'div', 'card-legend');
    TIERS.filter((t) => used.has(t)).forEach((t, i) => {
      if (i) leg.appendChild(doc.createTextNode('  '));
      leg.appendChild(el(doc, 'span', `tier tier-${t}`, TIER_INFO[t].glyph));
      leg.appendChild(doc.createTextNode(' ' + TIER_INFO[t].label));
    });
    root.appendChild(leg);
  }
  if (kids) addChildren(doc, root, kids);   // after the rows and the legend, before the notes
  (notes || []).forEach((n) => root.appendChild(el(doc, 'p', 'card-note', n)));
  if (loading) root.appendChild(el(doc, 'p', 'card-loading', 'Loading details…'));
  if (error) root.appendChild(el(doc, 'p', 'card-error', String(error)));
  if (onGo) {
    const b = el(doc, 'button', 'btn accent', goLabel || 'Go there');
    b.type = 'button';
    if (goDisabled) { b.disabled = true; b.title = goDisabled; }
    else b.addEventListener('click', onGo);
    root.appendChild(b);
  }
}

/** Fill `el` with a card for a star model (see starModel in scene3d-physics.js). */
/**
 * goLabel: the button's text (default 'Go there'). goDisabled: a reason string; the button is shown disabled with it as its title.
 * children: the list of a star's planets (see addChildren), after the rows and before the notes.
 */
export function renderStarCard(host, model, { title, subtitle, distFromCameraText, onGo, loading, error, goLabel, goDisabled, children, distRows } = {}) {
  const doc = host.ownerDocument;
  clear(host);
  host.appendChild(el(doc, 'h3', 'card-title', title || 'Star'));
  if (subtitle) host.appendChild(el(doc, 'div', 'card-sub', subtitle));
  const dl = el(doc, 'dl', 'card-rows'), used = new Set();
  const m = model || {};
  const row = (label, V, unit, digits) => { if (V && Number.isFinite(V.v)) addRow(doc, dl, label, fmtValue(V, unit, digits), V.tier, V.src, used); };
  row('Temperature', m.teff, 'K', 0);
  row('Radius', m.radiusRsun, 'R☉', m.radiusRsun && m.radiusRsun.v < 0.1 ? 3 : 2);
  row('Luminosity', m.lumLsun, 'L☉', m.lumLsun && m.lumLsun.v < 0.1 ? 4 : 2);
  row('Mass', m.massMsun, 'M☉', 2);
  row('Age', m.ageGyr, 'Gyr', 1);
  if (m.spectralType && m.spectralType.v) addRow(doc, dl, 'Spectral type', String(m.spectralType.v), m.spectralType.tier, m.spectralType.src, used);
  // distRows ([label, text, tier, src]): a curated distance (prefer_record) and its Gaia 'not used' row, in place of the catalogue's Distance row
  if (distRows && distRows.length) distRows.forEach(([label, text, tier, src]) => addRow(doc, dl, label, text, tier, src || '', used));
  else row('Distance from Sun', m.distPc, 'pc', 2);
  row('G', m.gMag, 'mag', 2);
  row('BP−RP', m.bpRp, 'mag', 2);
  if (distFromCameraText) addRow(doc, dl, 'From you', distFromCameraText, 'illustrative', 'distance from the camera right now', used);
  finish(doc, host, dl, used, m.notes, onGo, loading, error, goLabel, children, goDisabled);
}

/** Generic card: rows are [label, text, tier, src]; src (optional) goes into the tier's tooltip. goLabel: the button's text; goDisabled: see renderStarCard. */
export function renderBodyCard(host, { title, subtitle, rows = [], onGo, notes, goLabel, goDisabled } = {}) {
  const doc = host.ownerDocument;
  clear(host);
  host.appendChild(el(doc, 'h3', 'card-title', title || ''));
  if (subtitle) host.appendChild(el(doc, 'div', 'card-sub', subtitle));
  const dl = el(doc, 'dl', 'card-rows'), used = new Set();
  rows.forEach(([label, text, tier, src]) => addRow(doc, dl, label, text, tier, src || '', used));
  finish(doc, host, dl, used, notes, onGo, false, null, goLabel, null, goDisabled);
}

export const CARD_CSS = `
.card-panel, .star-card { background: rgba(10,12,20,.78); color: #e8e6e0; border: 1px solid rgba(255,255,255,.12);
  border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.4; backdrop-filter: blur(6px); max-width: 280px; }
.card-title { margin: 0 0 2px; font-size: 14px; font-weight: 600; }
.card-sub { opacity: .6; font-size: 11px; margin-bottom: 6px; }
.card-rows { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 6px 0; }
.card-rows dt { opacity: .65; }
.card-rows dd { margin: 0; text-align: right; }
.card-rows .num { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
.tier { display: inline-block; width: 1.1em; text-align: center; }
.tier-measured { color: #fff4e0; }
.tier-catalogue { color: #f0b04a; }
.tier-inferred { color: #8da0b8; }
.tier-illustrative { color: rgba(232,230,224,.45); border-bottom: 1px dashed rgba(232,230,224,.4); }
.card-legend { font-size: 10px; opacity: .7; margin: 4px 0; }
.card-note { font-size: 10px; opacity: .6; margin: 3px 0; }
.card-loading { font-size: 11px; opacity: .6; margin: 4px 0; }
.card-error { font-size: 11px; color: #f08a7a; margin: 4px 0; }
.card-kids { margin: 6px 0; }
.card-kids-title { opacity: .65; margin-bottom: 2px; }
.card-kid-list { list-style: none; margin: 0; padding: 0; }
.card-kid { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.card-kid-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.card-kid-line { opacity: .65; font-size: 11px; }
`;
