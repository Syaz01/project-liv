// The music pill on the page: what src-tauri/src/spotify.rs reports (MPRIS
// on Linux, the system media controls on Windows), and the pure rules the views follow — ports of
// SpotifyController.swift and NowPlayingViews.swift. On Windows it is whatever
// plays, in Spotify or any other app; the names here are the ones it was
// saved under.

export const SPOTIFY_ID = "integration_spotify";
/** SpotifyController.green. */
export const SPOTIFY_GREEN = "#1DB954";

export interface SpotifyTrack {
  /** spotify:track:…, spotify:episode:…, spotify:ad:… */
  id: string;
  title: string;
  artist: string;
  album: string;
  /** Seconds. */
  duration: number;
  artUrl: string | null;
}

/** What the player takes: a control it does not is shown switched off. */
export interface SpotifyControls {
  playPause: boolean;
  next: boolean;
  previous: boolean;
  seek: boolean;
  shuffle: boolean;
  repeat: boolean;
  /** The app has a volume of its own to set. */
  volume: boolean;
  /** "Open" brings the app forward. */
  open: boolean;
}

export const ALL_CONTROLS: SpotifyControls = {
  playPause: true, next: true, previous: true, seek: true, shuffle: true, repeat: true, volume: true, open: true,
};

export interface SpotifyState {
  /** A player is there. */
  running: boolean;
  /** There is a Spotify to launch. */
  installed: boolean;
  /** The app the track plays in ("Spotify", "Chrome"); empty when nothing says. */
  source: string;
  can: SpotifyControls;
  track: SpotifyTrack | null;
  playing: boolean;
  /** Seconds at `positionAt` (Unix ms); while playing it runs on from there. */
  position: number;
  positionAt: number;
  shuffle: boolean;
  repeat: boolean;
  /** 0…100. */
  volume: number;
}

export const IDLE_SPOTIFY: SpotifyState = {
  running: false, installed: false, source: "", can: ALL_CONTROLS, track: null, playing: false,
  position: 0, positionAt: 0, shuffle: false, repeat: false, volume: 50,
};

/** The page's copy of the player, and the cover of the track that has one. */
export const Spotify = {
  state: { ...IDLE_SPOTIFY } as SpotifyState,
  artwork: null as { artUrl: string; dataUrl: string } | null,
};

/** The cover to show for the current track, if it has arrived. */
export function currentArtwork(s: SpotifyState = Spotify.state): string | null {
  const art = Spotify.artwork;
  return art && s.track?.artUrl && art.artUrl === s.track.artUrl ? art.dataUrl : null;
}

/** SpotifyController.position(at:): extrapolated while playing, capped at the end. */
export function spotifyPosition(s: SpotifyState, nowMs: number): number {
  const elapsed = s.playing ? Math.max(0, (nowMs - s.positionAt) / 1000) : 0;
  const p = s.position + elapsed;
  const d = s.track?.duration ?? 0;
  return d > 0 ? Math.min(p, d) : p;
}

/**
 * The clock frozen or restarted where it is now — what a play/pause click
 * does at once, before Spotify confirms it (SpotifyController.setPlaying).
 */
export function withPlaying(s: SpotifyState, playing: boolean, nowMs: number): SpotifyState {
  if (s.playing === playing) return s;
  return { ...s, position: spotifyPosition(s, nowMs), positionAt: nowMs, playing };
}

export function isAd(track: SpotifyTrack | null | undefined): boolean {
  return track?.id.startsWith("spotify:ad:") ?? false;
}

/** NowPlayingProgress.format: m:ss, or h:mm:ss past an hour. */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const pad = (n: number) => String(n).padStart(2, "0");
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** NowPlayingVolume.icon: 0 = muted, then one, two or three waves. */
export function volumeLevel(volume: number): 0 | 1 | 2 | 3 {
  if (volume <= 0) return 0;
  if (volume < 34) return 1;
  if (volume < 67) return 2;
  return 3;
}

/**
 * "Artist · Album · App": what the card says under the title. The app is
 * left out when it is Spotify, whose card this was first.
 */
export function trackSubtitle(track: SpotifyTrack, source: string): string {
  const app = source && source !== "Spotify" ? source : "";
  return [track.artist, track.album, app].filter((x) => x).join(" · ");
}

/** Music is playing on a declared music pill. */
export function musicPlaying(s: SpotifyState, activeIntegrations: readonly string[]): boolean {
  return s.playing && s.track != null && activeIntegrations.includes(SPOTIFY_ID);
}
