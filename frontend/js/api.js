// Thin client for the backend API contract.
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && !isFinite(v))) p.set(k, String(v));
  return p.toString();
};

async function httpError(res) {
  let msg = `${res.status} ${res.statusText}`;
  try { const j = await res.json(); if (j && j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch (_) { /* ignore */ }
  const e = new Error(msg); e.status = res.status; return e;
}

async function getJSON(path, params, signal) {
  const res = await fetch(`${path}?${qs(params || {})}`, { signal });
  if (!res.ok) throw await httpError(res);
  return res.json();
}

export const resolve = (q, signal) => getJSON('/api/resolve', { q }, signal);
export const getFrames = (ra, dec, signal) => getJSON('/api/frames', { ra, dec }, signal);
export const getCatalog = (cat, ra, dec, radius, signal) => getJSON('/api/catalog', { cat, ra, dec, radius }, signal);
export const getSpectrum = (params, signal) => getJSON('/api/spectrum', params, signal);
export const health = () => getJSON('/api/health');

/**
 * Stream frames. Records: u32le N | N bytes JSON | optional payload.
 * Payload (ok frames): npix*npix float32 LE image + npix*npix uint32 LE flags.
 *
 * Model modes (request `model=`):
 * - `model=1`: the start record has `model: true` and every ok frame carries two more float32
 *   planes after the flags, background and leftover; onFrame(meta, img, flags, background, leftover).
 * - `model=progressive`: the start record has `model: "progressive"`. Ok frames are raw only
 *   (image + flags; onFrame(meta, img, flags)) and the fitted model follows later in
 *   `{type: "model", id, model}` records. Their payload is background + leftover float32 planes,
 *   delivered as onModel(meta, background, leftover). A model record always comes after its frame
 *   record, failed frames never get one, and the end record may carry `models` (the count).
 * - no model: image + flags only.
 * Payload bytes are COPIED into fresh typed arrays (no alignment assumptions).
 */
export async function streamFrames(params, { signal, onStart, onFrame, onEnd, onProgress, onModel }) {
  const res = await fetch(`/api/stream?${qs(params)}`, { signal });
  if (!res.ok) throw await httpError(res);
  if (!res.body) throw new Error('Streaming is not supported by this browser');
  const reader = res.body.getReader();
  const td = new TextDecoder();
  let buf = new Uint8Array(1 << 16), len = 0, pos = 0, npix = 0, ended = false, planes = 2;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (len + value.length > buf.length) {
      if (pos > 0) { buf.copyWithin(0, pos, len); len -= pos; pos = 0; }
      if (len + value.length > buf.length) {
        const nb = new Uint8Array(Math.max(buf.length * 2, len + value.length));
        nb.set(buf.subarray(0, len)); buf = nb;
      }
    }
    buf.set(value, len); len += value.length;

    for (;;) {
      if (len - pos < 4) break;
      const n = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
      if (len - pos < 4 + n) break;
      const meta = JSON.parse(td.decode(buf.subarray(pos + 4, pos + 4 + n)));
      let payload = 0;
      if (meta.type === 'frame' && meta.ok) payload = npix * npix * 4 * planes;
      else if (meta.type === 'model') payload = npix * npix * 8;
      if (len - pos < 4 + n + payload) break;
      const a = pos + 4 + n;
      pos += 4 + n + payload;
      if (meta.type === 'start') { npix = meta.npix; planes = meta.model === true ? 4 : 2; onStart && onStart(meta); }
      else if (meta.type === 'frame') {
        let img = null, flags = null, background, leftover;
        if (meta.ok) {
          const np = npix * npix;
          img = new Float32Array(np); new Uint8Array(img.buffer).set(buf.subarray(a, a + np * 4));
          flags = new Uint32Array(np); new Uint8Array(flags.buffer).set(buf.subarray(a + np * 4, a + np * 8));
          if (planes === 4) {  // model=1: background and leftover planes follow the flags
            background = new Float32Array(np); new Uint8Array(background.buffer).set(buf.subarray(a + np * 8, a + np * 12));
            leftover = new Float32Array(np); new Uint8Array(leftover.buffer).set(buf.subarray(a + np * 12, a + np * 16));
          }
        }
        if (planes === 4) onFrame && onFrame(meta, img, flags, background, leftover);
        else onFrame && onFrame(meta, img, flags);
      } else if (meta.type === 'model') {
        if (onModel) {  // progressive: background and leftover planes for an earlier frame
          const np = npix * npix;
          const background = new Float32Array(np); new Uint8Array(background.buffer).set(buf.subarray(a, a + np * 4));
          const leftover = new Float32Array(np); new Uint8Array(leftover.buffer).set(buf.subarray(a + np * 4, a + np * 8));
          onModel(meta, background, leftover);
        }
      } else if (meta.type === 'end') { ended = true; onEnd && onEnd(meta); }
      else if (meta.type === 'progress') onProgress && onProgress(meta);
    }
  }
  if (!ended || pos !== len) throw new Error('The frame stream ended before it was complete. Retry to load the remaining frames.');
}
/** 3D fly-through payload: stars (Gaia cone) and solar system. Cold cache can take 30 to 90 s. */
export const getScene3D = (params, signal) => getJSON('/api/scene3d', params, signal);
export const getSystem = (id, signal) => getJSON(`/api/system/${encodeURIComponent(id)}`, {}, signal);
