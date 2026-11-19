// The music pill: the page's rules in src/core/spotify.ts, the
// report handling in src/island/spotify.ts and the views in
// src/views/spotify.ts. The MPRIS side —
// metadata, position, the bus itself — is tested in src-tauri/src/spotify.rs.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { emit, sent } from "./tauri.mjs";
import { installFakeDom } from "./fakedom.mjs";
import {
  ALL_CONTROLS, IDLE_SPOTIFY, SPOTIFY_ID, Spotify, currentArtwork, formatTime, isAd,
  musicPlaying, spotifyPosition, trackSubtitle, volumeLevel, withPlaying,
} from "../src/core/spotify.ts";
import { registerSpotifyHandlers } from "../src/island/spotify.ts";
import { buildSpotifyCard, buildSpotifyPill } from "../src/views/spotify.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { lookup, setLanguage } from "../src/i18n/i18n.ts";

installFakeDom();

const track = (over = {}) => ({
  id: "spotify:track:abc", title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories",
  duration: 180, artUrl: "https://i.scdn.co/image/abc", ...over,
});

const playing = (over = {}) => ({
  ...IDLE_SPOTIFY, running: true, installed: true, track: track(), playing: true,
  position: 10, positionAt: 1_000, volume: 70, ...over,
});

// ── Position ──────────────────────────────────────────────────────────────────

test("the position runs on from its timestamp while playing, and stops at the end", () => {
  const s = playing();
  assert.equal(spotifyPosition(s, 1_000), 10);
  assert.equal(spotifyPosition(s, 3_500), 12.5);
  assert.equal(spotifyPosition(s, 0), 10, "a clock behind the anchor never moves it back");
  assert.equal(spotifyPosition(s, 1_000_000), 180, "capped at the track's length");
  assert.equal(spotifyPosition({ ...s, playing: false }, 60_000), 10, "paused, it stays put");
  assert.equal(spotifyPosition({ ...s, track: null }, 3_000), 12, "no length, no cap");
});

test("a play/pause click freezes or restarts the clock where it is", () => {
  const paused = withPlaying(playing(), false, 5_000);
  assert.equal(paused.playing, false);
  assert.equal(paused.position, 14);
  assert.equal(paused.positionAt, 5_000);
  assert.equal(spotifyPosition(paused, 9_000), 14);
  const again = withPlaying(paused, true, 9_000);
  assert.equal(spotifyPosition(again, 10_000), 15);
  const same = playing();
  assert.equal(withPlaying(same, true, 99), same, "no change, same object");
});

test("times read like the Mac's player", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(65.9), "1:05");
  assert.equal(formatTime(599), "9:59");
  assert.equal(formatTime(3725), "1:02:05");
  assert.equal(formatTime(-3), "0:00");
  assert.equal(formatTime(Number.NaN), "0:00");
});

test("the volume icon has the Mac's thresholds", () => {
  assert.deepEqual([0, 1, 33, 34, 66, 67, 100].map(volumeLevel), [0, 1, 1, 2, 2, 3, 3]);
});

test("ads are told by their id", () => {
  assert.ok(isAd(track({ id: "spotify:ad:123" })));
  assert.ok(!isAd(track()));
  assert.ok(!isAd(null));
});

test("a cover shows only on the track it belongs to", () => {
  Spotify.artwork = { artUrl: "https://i.scdn.co/image/abc", dataUrl: "data:image/jpeg;base64,AA" };
  assert.equal(currentArtwork(playing()), "data:image/jpeg;base64,AA");
  assert.equal(currentArtwork(playing({ track: track({ artUrl: "https://i.scdn.co/image/zzz" }) })), null);
  assert.equal(currentArtwork(playing({ track: null })), null);
  Spotify.artwork = null;
});

// ── When music counts ─────────────────────────────────────────────────────────

test("music counts only when it plays on a declared Spotify pill", () => {
  assert.ok(musicPlaying(playing(), [SPOTIFY_ID]));
  assert.ok(!musicPlaying(playing(), ["integration_n8n"]));
  assert.ok(!musicPlaying(playing({ playing: false }), [SPOTIFY_ID]));
  assert.ok(!musicPlaying(playing({ track: null }), [SPOTIFY_ID]));
});

// ── Reports from Rust ─────────────────────────────────────────────────────────

const island = { reveals: 0, revealSilently() { this.reveals += 1; } };
registerSpotifyHandlers(island);

beforeEach(() => {
  setLanguage("en");
  State.settings = { ...DEFAULT_SETTINGS, activeIntegrations: [SPOTIFY_ID] };
  State.tasks = [];
  State.focusId = null;
  State.mode = "hidden";
  State.view = "overview";
  State.paused = false;
  State.loadIntegrationTasks();
  Spotify.state = { ...IDLE_SPOTIFY };
  Spotify.artwork = null;
  island.reveals = 0;
});

const spotifyTask = () => State.tasks.find((t) => t.id === SPOTIFY_ID);

test("the pill wears the track's title, and its own name when nothing plays", () => {
  assert.equal(spotifyTask().name, "Music");
  emit("spotify", playing());
  assert.equal(Spotify.state.track.title, "Get Lucky");
  assert.equal(spotifyTask().name, "Get Lucky");
  emit("spotify", playing({ track: track({ id: "spotify:ad:1", title: "" }) }));
  assert.equal(spotifyTask().name, "Advertisement");
  emit("spotify", { ...IDLE_SPOTIFY, running: true });
  assert.equal(spotifyTask().name, "Music");
  // Any player's track: a title alone is a title, never an ad.
  emit("spotify", playing({ source: "Chrome", track: track({ id: "media:track:1", title: "A video", artist: "", album: "" }) }));
  assert.equal(spotifyTask().name, "A video");
  emit("spotify", { ...IDLE_SPOTIFY });
  setLanguage("es");
  State.notify();
  assert.equal(spotifyTask().name, "Música");
  setLanguage("en");
  State.notify();
  assert.equal(spotifyTask().name, "Music");
});

test("with the choice switched off in Settings, music starting leaves the closed island closed", () => {
  State.settings = { ...State.settings, musicReveal: false };
  emit("spotify", playing());
  assert.equal(island.reveals, 0);
  assert.equal(spotifyTask().name, "Get Lucky", "the pill still follows what plays");
  // Switched on again, the next start shows it.
  emit("spotify", { ...IDLE_SPOTIFY, running: true });
  State.settings = { ...State.settings, musicReveal: true };
  emit("spotify", playing());
  assert.equal(island.reveals, 1);
  // A settings file from before the choice: as it always was.
  emit("spotify", { ...IDLE_SPOTIFY, running: true });
  State.settings = { ...State.settings, musicReveal: undefined };
  emit("spotify", playing());
  assert.equal(island.reveals, 2);
});

test("music starting shows the hidden island once, silently; nothing when Spotify is not declared", () => {
  emit("spotify", playing({ playing: false }));
  assert.equal(island.reveals, 0);
  emit("spotify", playing());
  assert.equal(island.reveals, 1);
  emit("spotify", playing({ position: 30 }));
  assert.equal(island.reveals, 1, "only on not playing → playing");
  assert.ok(State.spotifyPlaying);

  // Not declared: nothing dances, nothing shows.
  emit("spotify", { ...IDLE_SPOTIFY });
  State.settings.activeIntegrations = [];
  emit("spotify", playing());
  assert.equal(island.reveals, 1);
  assert.ok(!State.spotifyPlaying);
});

test("the cover arrives on its own event", () => {
  emit("spotify", playing());
  emit("spotify-artwork", { artUrl: "https://i.scdn.co/image/abc", dataUrl: "data:image/png;base64,AA" });
  assert.equal(currentArtwork(), "data:image/png;base64,AA");
});

test("the card reads the player again each time it comes on screen", () => {
  const before = sent("spotify_refresh").length;
  State.mode = "expanded";
  State.view = "overview";
  State.setFocus(SPOTIFY_ID);
  assert.equal(sent("spotify_refresh").length, before + 1);
  State.notify();
  assert.equal(sent("spotify_refresh").length, before + 1, "not again while it stays");
  State.mode = "compact";
  State.notify();
  State.mode = "expanded";
  State.notify();
  assert.equal(sent("spotify_refresh").length, before + 2);
});

// ── Views ─────────────────────────────────────────────────────────────────────

test("the idle card: nothing playing, and Spotify one click away only when it is installed", () => {
  const card = buildSpotifyCard();
  Spotify.state = { ...IDLE_SPOTIFY, installed: true };
  card.sync();
  assert.match(card.el.textContent, /Music.*Integration.*Not playing.*Open Spotify/);
  const action = card.el.find("BUTTON")[0];
  assert.notEqual(action.style.display, "none");
  action.fire("click");
  assert.ok(sent("spotify_open").length > 0);

  // No Spotify: nothing is missing, any player will do. No link to get one.
  Spotify.state = { ...IDLE_SPOTIFY };
  card.sync();
  assert.equal(action.style.display, "none");
  assert.match(card.el.textContent, /Not playing/);

  setLanguage("es");
  card.sync();
  assert.ok(card.el.textContent.includes(lookup("Music", "es")));
  assert.ok(card.el.textContent.includes(lookup("Not playing", "es")));
  setLanguage("en");
});

test("another player: its name under the title, and only the controls it takes", () => {
  assert.equal(trackSubtitle(track(), "Spotify"), "Daft Punk · Random Access Memories");
  assert.equal(trackSubtitle(track(), ""), "Daft Punk · Random Access Memories");
  assert.equal(trackSubtitle(track({ album: "" }), "VLC"), "Daft Punk · VLC");
  assert.equal(trackSubtitle(track({ artist: "", album: "" }), "Chrome"), "Chrome");

  const card = buildSpotifyCard();
  const can = { ...ALL_CONTROLS, next: false, previous: false, seek: false, shuffle: false, repeat: false, volume: false, open: false };
  Spotify.state = playing({ source: "Chrome", can, track: track({ id: "media:track:1", title: "A video", artist: "Some Channel", album: "", duration: 0 }) });
  card.sync();
  assert.ok(card.el.textContent.includes("A video"));
  assert.ok(card.el.textContent.includes("Some Channel · Chrome"));
  assert.ok(!card.el.textContent.includes("Advertisement"));

  const [shuffle, prev, play, next, repeat] = card.el.querySelector("np-buttons").children;
  for (const off of [shuffle, prev, next, repeat]) {
    assert.equal(off.disabled, true);
    assert.equal(off.style.pointerEvents, "none");
  }
  assert.equal(play.disabled, false);
  assert.equal(card.el.querySelector("np-volume").style.display, "none");

  // A click that gets through anyway asks the player for nothing it refused.
  const before = sent("spotify_control").length;
  const opened = sent("spotify_open").length;
  shuffle.fire("click");
  prev.fire("click");
  next.fire("click");
  repeat.fire("click");
  card.el.querySelector("np-art").fire("click");
  assert.equal(sent("spotify_control").length, before);
  assert.equal(sent("spotify_open").length, opened);
  play.fire("click");
  assert.deepEqual(sent("spotify_control").slice(before), [{ action: "playPause", value: null }]);

  // Back on a player that takes them all, everything is on again.
  Spotify.state = playing();
  card.sync();
  assert.equal(shuffle.disabled, false);
  assert.equal(shuffle.style.pointerEvents, "");
  assert.notEqual(card.el.querySelector("np-volume").style.display, "none");

  // The pill offers on hover only what the player takes.
  const pill = buildSpotifyPill(spotifyTask(), () => {});
  Spotify.state = playing({ source: "Chrome", can });
  pill.el.fire("mouseenter");
  const [playBtn, nextBtn] = pill.el.querySelector("np-pill-controls").children;
  assert.ok(pill.el.classList.contains("controls"));
  assert.notEqual(playBtn.style.display, "none");
  assert.equal(nextBtn.style.display, "none");
  Spotify.state = playing({ source: "Chrome", can: { ...can, playPause: false } });
  pill.sync();
  assert.ok(!pill.el.classList.contains("controls"));
  pill.el.fire("mouseleave");
});

test("the playing card: title, artist · album, times, and the controls", () => {
  const card = buildSpotifyCard();
  Spotify.state = playing({ playing: false, shuffle: true });
  card.sync();
  const text = card.el.textContent;
  assert.ok(text.includes("Get Lucky"));
  assert.ok(text.includes("Daft Punk · Random Access Memories"));
  assert.ok(text.includes("0:10") && text.includes("-2:50"));

  const [shuffle, prev, play, next, repeat] = card.el.querySelector("np-buttons").children;
  assert.equal(shuffle.title, "Shuffle on");
  assert.equal(repeat.title, "Repeat off");
  assert.equal(play.title, "Play");
  const before = sent("spotify_control").length;
  shuffle.fire("click");
  repeat.fire("click");
  prev.fire("click");
  next.fire("click");
  play.fire("click");
  assert.deepEqual(sent("spotify_control").slice(before), [
    { action: "shuffle", value: 0 },
    { action: "repeat", value: 1 },
    { action: "previous", value: null },
    { action: "next", value: null },
    { action: "playPause", value: null },
  ]);
  // The page shows the clicks at once.
  assert.equal(Spotify.state.shuffle, false);
  assert.equal(Spotify.state.repeat, true);
  assert.equal(Spotify.state.playing, true);

  Spotify.state = playing({ track: track({ id: "spotify:ad:9", title: "x", artist: "", album: "" }) });
  card.sync();
  assert.ok(card.el.textContent.includes("Advertisement"));
});

test("the pill shows play/pause and next on hover, only with a track", () => {
  const task = spotifyTask();
  const pill = buildSpotifyPill(task, () => {});
  pill.el.fire("mouseenter");
  assert.ok(!pill.el.classList.contains("controls"), "nothing loaded: no controls");
  Spotify.state = playing();
  pill.sync();
  assert.ok(pill.el.classList.contains("controls"));
  const [playBtn] = pill.el.querySelector("np-pill-controls").children;
  assert.equal(playBtn.title, "Pause");
  const before = sent("spotify_control").length;
  playBtn.fire("click");
  assert.deepEqual(sent("spotify_control").slice(before), [{ action: "playPause", value: null }]);
  assert.equal(Spotify.state.playing, false);
  pill.el.fire("mouseleave");
  assert.ok(!pill.el.classList.contains("controls"));
});
