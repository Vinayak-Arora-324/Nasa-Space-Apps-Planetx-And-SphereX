// Aladin Lite v3 context panel; fails gracefully when the CDN is unreachable.
// Pinned npm build (an ES module). The CDS "latest" URL used earlier now returns 404.
const SRC = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js';
// HiPS served by IRSA's mirror of the CDS surveys (CORS-enabled). Using full URLs avoids a
// MocServer lookup on alasky, which was unreachable/404 from the test environment.
export const SURVEYS = [
  ['https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color', 'DSS2 colour (optical)'],
  ['https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color', '2MASS (near-IR)'],
  ['https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1', 'AllWISE (mid-IR)'],
];
let aladin = null, overlay = null, loading = null;

function loadLib() {
  if (loading) return loading;
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
  loading = Promise.race([
    import(SRC).then(async (m) => { const A = m.default || window.A; await A.init; return A; }),
    timeout,
  ]).catch((e) => { loading = null; throw new Error(typeof e === 'string' ? e : (e?.message || 'blocked or offline')); });
  return loading;
}

export async function showContext(el, ra, dec, fov, corners, survey) {
  try {
    const A = await loadLib();
    if (!aladin) {
      el.innerHTML = '';
      aladin = A.aladin(el, { survey, log: false, target: `${ra} ${dec}`, fov: Math.max(fov * 4, 0.3), showReticle: false, showZoomControl: true, showFullscreenControl: false, showLayersControl: false, showGotoControl: false, showFrame: false, showCooGridControl: false, showProjectionControl: false, showSettingsControl: false, showShareControl: false, showStatusBar: false });
      overlay = A.graphicOverlay({ color: '#ffb454', lineWidth: 2 });
      aladin.addOverlay(overlay);
    } else {
      aladin.gotoRaDec(ra, dec); aladin.setFoV(Math.max(fov * 4, 0.3)); aladin.setImageSurvey(survey);
    }
    overlay.removeAll();
    overlay.add(A.polygon(corners));
    return true;
  } catch (e) {
    el.innerHTML = `<p class="muted pad">Context sky view unavailable (${e.message}). The viewer works without it.</p>`;
    aladin = null;
    return false;
  }
}
export const setSurvey = (id) => { if (aladin) aladin.setImageSurvey(id); };
