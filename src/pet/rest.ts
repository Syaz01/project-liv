// Liv's rest on the desktop: when it hovers, when it stands still, and when
// it falls asleep. It hovers while the pointer is near and for a few seconds
// after anything happens to it; left alone it is a still picture that blinks
// now and then; and after two minutes of that it sleeps — its eyes shut, its
// antenna off, nothing moving — until the pointer comes near or its state
// changes. Pure: the page (main.ts) keeps the clock and says where the
// pointer is.

/** A pointer this close to the head's centre is near, page px. */
export const NEAR_PX = 180;
/** It goes on hovering this long after the last thing that happened to it, ms. */
export const LINGER_MS = 4000;
/** Left alone this long, it falls asleep, ms. */
export const SLEEP_AFTER_MS = 120_000;

export interface Presence {
  /** The pointer is near. */
  near: boolean;
  /**
   * How long since anything last happened to it, ms: a click, a drag, a
   * landing, a change of what it shows — or the pointer being near.
   */
  quietMs: number;
}

/** Whether the pointer, `distance` px from the head's centre (null: nobody knows where), is near. */
export function pointerNear(distance: number | null): boolean {
  return distance != null && distance <= NEAR_PX;
}

/** Whether Liv hovers: the one thing on the desktop that moves all the time. */
export function hovers(p: Presence): boolean {
  return p.near || p.quietMs < LINGER_MS;
}

/** Whether Liv is asleep. Anything that happens to it sets `quietMs` back to 0: it wakes. */
export function sleeps(p: Presence): boolean {
  return !p.near && p.quietMs >= SLEEP_AFTER_MS;
}

/**
 * The quiet time at which something next changes by itself, ms: the hover
 * ending, then sleep. Null when nothing will: the pointer is near, or Liv
 * already sleeps. Then no timer runs.
 */
export function nextChangeAt(p: Presence): number | null {
  if (p.near) return null;
  if (p.quietMs < LINGER_MS) return LINGER_MS;
  if (p.quietMs < SLEEP_AFTER_MS) return SLEEP_AFTER_MS;
  return null;
}
