import test from 'node:test';
import assert from 'node:assert/strict';
import { streamFrames } from '../js/api.js';
import { Store } from '../js/data.js';

function record(meta, payload = new Uint8Array()) {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + json.length + payload.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4); out.set(payload, 4 + json.length);
  return out;
}
function response(parts, chunkSize) {
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { data.set(p, offset); offset += p.length; }
  return new Response(new ReadableStream({ start(ctl) {
    for (let i = 0; i < data.length; i += chunkSize) ctl.enqueue(data.slice(i, i + chunkSize));
    ctl.close();
  } }));
}

test('shuffled frames, failures and heartbeats survive every-byte chunk boundaries', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const pixels = new Uint8Array(8);
    const v = new DataView(pixels.buffer);
    v.setFloat32(0, 1.25, true); v.setUint32(4, 2, true);
    globalThis.fetch = async () => response([
      record({ type: 'start', npix: 1 }),
      record({ type: 'frame', ok: true, id: 'late', mjd: 61000 }, pixels),
      record({ type: 'progress', done: 1, total: 3 }),
      record({ type: 'frame', ok: false, id: 'failed', mjd: 60999, error: 'upstream unavailable' }),
      record({ type: 'frame', ok: true, id: 'early', mjd: 60998 }, pixels),
      record({ type: 'future-record', harmless: true }),
      record({ type: 'end', sent: 2, failed: 1 }),
    ], 1);
    const store = new Store();
    let progress, end;
    await streamFrames({}, {
      onFrame: (...args) => store.add(...args),
      onProgress: m => { progress = m; }, onEnd: m => { end = m; },
    });
    assert.deepEqual(store.frames.map(f => f.id), ['early', 'late']);
    assert.equal(store.frames[0].img[0], 1.25);
    assert.equal(store.frames[0].flags[0], 2);
    assert.equal(store.failed[0].error, 'upstream unavailable');
    assert.equal(progress.done, 1); assert.equal(end.failed, 1);
    assert.notEqual(store.frames[0].img.buffer, store.frames[1].img.buffer);
  } finally { globalThis.fetch = originalFetch; }
});

test('an interrupted stream cannot be reported as a completed load', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => response([record({ type: 'start', npix: 1 }), new Uint8Array([10, 0])], 3);
    await assert.rejects(streamFrames({}, {}), /ended before it was complete/);
  } finally { globalThis.fetch = originalFetch; }
});

test('model=1 streams carry background and leftover planes', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const pix = new Uint8Array(16), v = new DataView(pix.buffer);
    v.setFloat32(0, 1.5, true); v.setUint32(4, 7, true); v.setFloat32(8, 0.25, true); v.setFloat32(12, -0.5, true);
    globalThis.fetch = async () => response([
      record({ type: 'start', npix: 1, model: true }),
      record({ type: 'frame', ok: true, id: 'a', mjd: 1, model: { sources: [] } }, pix),
      record({ type: 'frame', ok: false, id: 'b', mjd: 2, error: 'x' }),
      record({ type: 'end', sent: 1, failed: 1 }),
    ], 2);
    const got = [];
    await streamFrames({}, { onFrame: (...a) => got.push(a) });
    assert.equal(got.length, 2);
    const [meta, img, flags, bg, left] = got[0];
    assert.deepEqual(meta.model, { sources: [] });
    assert.equal(img[0], 1.5); assert.equal(flags[0], 7); assert.equal(bg[0], 0.25); assert.equal(left[0], -0.5);
    assert.equal(got[1][1], null);
  } finally { globalThis.fetch = originalFetch; }
});

test('progressive streams send raw frames first and model planes later', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const frame = new Uint8Array(8), fv = new DataView(frame.buffer);
    fv.setFloat32(0, 1.5, true); fv.setUint32(4, 7, true);
    const model = new Uint8Array(8), mv = new DataView(model.buffer);
    mv.setFloat32(0, 0.25, true); mv.setFloat32(4, -0.5, true);
    globalThis.fetch = async () => response([
      record({ type: 'start', npix: 1, model: 'progressive' }),
      record({ type: 'frame', ok: true, id: 'a', mjd: 1 }, frame),
      record({ type: 'frame', ok: false, id: 'b', mjd: 2, error: 'x' }),
      record({ type: 'model', id: 'a', model: { sources: [{ x: 0, y: 0 }] } }, model),
      record({ type: 'end', sent: 1, failed: 1, models: 1 }),
    ], 1);
    const events = [];
    await streamFrames({ model: 'progressive' }, {
      onFrame: (...a) => events.push(['frame', a]),
      onModel: (meta, bg, left) => events.push(['model', meta, bg, left]),
    });
    assert.deepEqual(events.map(e => e[0]), ['frame', 'frame', 'model']);
    const [, frameArgs] = events[0];
    assert.equal(frameArgs.length, 3);
    assert.equal(frameArgs[1][0], 1.5); assert.equal(frameArgs[2][0], 7);
    const [, meta, bg, left] = events[2];
    assert.equal(meta.id, 'a'); assert.equal(meta.model.sources.length, 1);
    assert.equal(bg[0], 0.25); assert.equal(left[0], -0.5);
  } finally { globalThis.fetch = originalFetch; }
});

test('model records keep the parser in sync and onModel is optional', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const pix = new Uint8Array(16), v = new DataView(pix.buffer);
    v.setFloat32(0, 1.5, true); v.setUint32(4, 7, true); v.setFloat32(8, 0.25, true); v.setFloat32(12, -0.5, true);
    const model = new Uint8Array(8), mv = new DataView(model.buffer);
    mv.setFloat32(0, 3, true); mv.setFloat32(4, 4, true);
    const parts = () => [
      record({ type: 'start', npix: 1, model: true }),
      record({ type: 'frame', ok: true, id: 'a', mjd: 1, model: { sources: [] } }, pix),
      record({ type: 'model', id: 'a', model: { sources: [] } }, model),
      record({ type: 'frame', ok: true, id: 'b', mjd: 2, model: { sources: [] } }, pix),
      record({ type: 'end', sent: 2, failed: 0 }),
    ];
    globalThis.fetch = async () => response(parts(), 5);
    const frames = [], models = [];
    await streamFrames({}, { onFrame: (...a) => frames.push(a), onModel: (m, bg, left) => models.push([m.id, bg[0], left[0]]) });
    assert.deepEqual(frames.map(f => f[0].id), ['a', 'b']);
    assert.equal(frames[1][1][0], 1.5);
    assert.deepEqual(models, [['a', 3, 4]]);

    // Without an onModel callback the model record is skipped and the stream still completes.
    globalThis.fetch = async () => response(parts(), 5);
    let ended = null;
    await streamFrames({}, { onFrame: () => {}, onEnd: m => { ended = m; } });
    assert.equal(ended.sent, 2);
  } finally { globalThis.fetch = originalFetch; }
});
