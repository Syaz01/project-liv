// When the island's frame loop has to go on, and when it may stop: the island
// costs nothing while nothing in it moves, and nothing while nobody sees it.
// No DOM here: the island says what is moving, this says whether it counts.

import type { IslandMode } from "./layout";

/** Where the island is. */
export interface FrameScene {
  mode: IslandMode;
  /** The closed island shows Liv (core/closed.ts). */
  closedRobot: boolean;
  /** The window waits off-screen while another app is full screen. */
  parked: boolean;
  /** Liv is paused from the tray: nothing new is listened to. */
  paused: boolean;
}

/** What is moving in it. */
export interface FrameWork {
  /** The island's shape is still on its way to its size. */
  settling: boolean;
  /** Liv is still on its way to its place and size. */
  botMoving: boolean;
  /** Liv's lights are taking the state's colour, or it moves (a hop, a shake, a blink, a breath). */
  robotChanging: boolean;
  /** The drop sequence runs. */
  uploading: boolean;
  /** The view on screen animates (a ticker scrolling). */
  viewAnimating: boolean;
  /** The countdown bar is in view, shrinking towards the fold. */
  countingDown: boolean;
}

/**
 * How long before the open island folds its countdown bar comes into view,
 * in seconds: the last ten, or less for a short auto-close delay.
 */
export function countdownWindow(autoClose: number): number {
  return Math.min(10, autoClose * 0.6);
}

/**
 * How much of the countdown bar is left, 1 (whole) to 0, with `remaining`
 * seconds to go before the fold. 0 until the bar comes into view, and once
 * the time is up.
 */
export function countdownShare(remaining: number, autoClose: number): number {
  const inView = countdownWindow(autoClose);
  return remaining < inView ? Math.max(0, Math.min(1, remaining / inView)) : 0;
}

/**
 * Whether Liv breathes: the one thing in the island that moves all the time,
 * so only on the open island, in sight and not paused. While it does, the
 * frame loop runs; everywhere else the loop stops between two events.
 */
export function breathes(scene: FrameScene): boolean {
  return scene.mode === "expanded" && !scene.parked && !scene.paused;
}

/**
 * Whether Liv's small signs of life (a blink, a glance) come from the
 * island's one timer: closed with Liv in it, compact, or out in its pocket,
 * in sight and not paused. The timer wakes the frame loop for the event and
 * the loop stops again; nothing runs in between.
 */
export function livesOnTimer(scene: FrameScene): boolean {
  if (scene.parked || scene.paused) return false;
  return scene.mode === "compact" || scene.mode === "peek" || (scene.mode === "hidden" && scene.closedRobot);
}

/**
 * Whether Liv is in sight in the island: not parked off-screen, and not
 * folded into an island that shows no figure. A change of clothes is played
 * where somebody sees it; anywhere else Liv simply has the new thing on, and
 * nothing asks for a frame.
 */
export function livInSight(scene: FrameScene): boolean {
  return !scene.parked && (scene.mode !== "hidden" || scene.closedRobot);
}

/** Whether the island needs another frame. */
export function needsFrame(scene: FrameScene, work: FrameWork): boolean {
  // Parked off-screen, whatever the island's mode: it comes back with its
  // shape and Liv where they belong, and until then no figure, ticker or
  // drop sequence asks for a frame.
  if (scene.parked) return work.settling || work.botMoving;
  // Closed, only the folding — and Liv reaching its place in the closed
  // island and taking its state's lights and badge there.
  if (scene.mode === "hidden") {
    return work.settling || (scene.closedRobot && (work.botMoving || work.robotChanging));
  }
  // The countdown bar only exists under the open island.
  const countingDown = scene.mode === "expanded" && work.countingDown;
  return work.settling || work.botMoving || work.robotChanging || work.uploading || work.viewAnimating || countingDown;
}
