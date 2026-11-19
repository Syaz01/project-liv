// A download that finished → the island (src-tauri/src/downloads.rs). Rust
// tells its name and its size; here it becomes the download the card shows
// (views/views.ts: buildDownload), with Liv's "finished" sound, and the island
// opens on that card where an alert may take the screen (core/downloads.ts).
//
// Switched off in Settings, nothing is heard: Rust stops telling, and what
// might still arrive is passed over.

import { Bridge, onEvent } from "../core/bridge";
import {
  NO_DOWNLOADS, downloadGone, downloadOpensIsland, downloadTold, downloadsSeen, parseDownload, type DownloadsState,
} from "../core/downloads";
import type { IslandViewName } from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";

/** What a finished download needs from the island: to open it on a view, as an alert does. */
export interface DownloadsHost {
  alert(view: IslandViewName): void;
}

/** The downloads as the island holds them (the card reads this). */
export const Downloads: { state: DownloadsState } = { state: NO_DOWNLOADS };

const onScreen = () => State.mode === "expanded" && State.view === "download";

export function registerDownloadHandlers(host?: DownloadsHost) {
  void onEvent<unknown>("download", (raw) => onDownload(host, raw));
  // The card was on screen and no longer is: what comes next is counted afresh.
  let was = onScreen();
  State.subscribe(() => {
    const on = onScreen();
    if (was && !on) Downloads.state = downloadsSeen(Downloads.state);
    was = on;
  });
}

function onDownload(host: DownloadsHost | undefined, raw: unknown) {
  if (State.settings.downloadAlerts === false) return;
  const told = parseDownload(raw);
  if (!told) return;
  Downloads.state = downloadTold(Downloads.state, told);
  if (State.paused) return;
  Sound.play("finish");
  const opens = downloadOpensIsland({
    paused: State.paused,
    parked: State.parked,
    cardWaiting: State.pendingApproval != null,
    expanded: State.mode === "expanded",
    view: State.view,
  });
  if (host && opens) host.alert("download");
  else State.notify();
}

/**
 * One of the card's buttons: asks Rust for the download by its number. False
 * when the file is no longer there — the card then says so.
 */
export async function useDownload(what: "open" | "reveal" | "shelve", id: number): Promise<boolean> {
  const done =
    what === "open" ? await Bridge.downloadOpen(id)
    : what === "reveal" ? await Bridge.downloadReveal(id)
    : await Bridge.downloadShelve(id);
  if (!done) {
    Downloads.state = downloadGone(Downloads.state, id);
    State.notify();
  }
  return done === true;
}
