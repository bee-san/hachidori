// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { captureNetflixPreview } from "../extension/netflix-preview.js";

const URL_WATCH = "https://www.netflix.com/watch/81000001?trackId=123";
const IMAGE = [255, 216, 255, 224, 0, 16, 255, 217];
const DATA_URL = `data:image/jpeg;base64,${Buffer.from(IMAGE).toString("base64")}`;

function fixture() {
  const times = [];
  const player = { getMovieId: () => 81000001, getCurrentTime: () => 1250,
    getTrickPlayFrame: time => { times.push(time); return { image: IMAGE, width: 320, height: 180 }; } };
  const players = new Map([["preview", {}], ["watch-1", player]]);
  const api = { getAllPlayerSessionIds: () => [...players.keys()], getVideoPlayerBySessionId: id => players.get(id) };
  const window = { location: { href: URL_WATCH }, netflix: { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: api }) } } } } };
  const element = {};
  const document = { querySelector: selector => selector === ".watch-video" ? { contains: node => node === element } : { currentTime: 2.5 } };
  // Chrome serializes the function without its module scope.
  const capture = runInNewContext(`(${captureNetflixPreview.toString()})`, { window, document, URL, btoa, ArrayBuffer, Uint8Array });
  return { capture: () => capture(URL_WATCH), player, players, times, window, element };
}

test("the standalone preview helper reads the current watch player's JPEG at its millisecond time", async () => {
  const f = fixture();
  f.players.set("watch-other", { getMovieId: () => 999, getTrickPlayFrame() { throw new Error("wrong episode"); } });
  assert.equal((await f.capture()).dataUrl, DATA_URL);
  assert.deepEqual(f.times, [1250]);
  delete f.player.getCurrentTime;
  assert.equal((await f.capture()).dataUrl, DATA_URL);
  assert.deepEqual(f.times, [1250, 2500], "only the video element's seconds are converted to milliseconds");
});

test("the player attached to the visible watch root wins over another session of the same episode", async () => {
  const f = fixture();
  f.player.getElement = () => f.element;
  f.players.set("watch-preloaded", { ...f.player, getElement: () => ({}),
    getTrickPlayFrame() { throw new Error("preloaded player must not supply the preview"); } });
  assert.equal((await f.capture()).dataUrl, DATA_URL);
  delete f.player.getMovieId;
  assert.match((await f.capture()).error, /no seek preview/u, "attachment does not establish the episode's identity during a route change");
  f.player.getMovieId = () => 81000001;
  f.player.getElement = () => ({});
  assert.match((await f.capture()).error, /no seek preview/u);
});

test("preview image arrays, buffers, byte views and iterables preserve their JPEG bytes", async () => {
  const f = fixture();
  const padded = new Uint8Array([0, ...IMAGE, 0]);
  for (const image of [IMAGE, new Uint8Array(IMAGE), new Uint8Array(IMAGE).buffer,
    padded.subarray(1, padded.length - 1), { *[Symbol.iterator]() { yield* IMAGE; } }]) {
    f.player.getTrickPlayFrame = () => ({ image });
    assert.equal((await f.capture()).dataUrl, DATA_URL);
  }
});

test("missing, ambiguous or invalid previews return useful errors instead of viewport captures", async () => {
  const f = fixture();
  for (const image of [undefined, [], [1, 2, 3], [255, 216, 255, -1], [255, 216, 255, "x"]]) {
    f.player.getTrickPlayFrame = () => ({ image });
    const result = await f.capture();
    assert.match(result.error, /^Netflix preview screenshot:/u);
    assert.equal(result.dataUrl, undefined);
  }
  delete f.player.getMovieId;
  assert.match((await f.capture()).error, /no seek preview/u, "a lone watch session without an episode or element identity is rejected");
  f.player.getMovieId = () => 81000001;
  f.players.set("watch-2", f.player);
  assert.match((await f.capture()).error, /no seek preview/u);
  f.players.clear();
  assert.match((await f.capture()).error, /no seek preview/u);
});

test("a preview is rejected when its episode, watch session or player changes while it is read", async () => {
  for (const change of [
    f => { f.window.location.href = "https://www.netflix.com/watch/999"; },
    f => { f.players.delete("watch-1"); f.players.set("watch-2", f.player); },
    f => { f.players.set("watch-1", { ...f.player }); },
    f => { f.player.getMovieId = () => 999; },
    f => { f.window.netflix.appContext.state.playerApp.getAPI = () => ({}); },
  ]) {
    const f = fixture();
    let resolve;
    f.player.getTrickPlayFrame = () => new Promise(done => { resolve = done; });
    const pending = f.capture();
    change(f);
    resolve({ image: IMAGE });
    assert.match((await pending).error, /changed while the preview/u);
  }
});
