// When the desktop window's frame loop has to go on, and when it stops: Liv
// on the desktop costs nothing while nothing of it moves, and nothing while
// nobody sees it. No DOM here: the page says what is moving (main.ts).

/** How things stand with Liv's window. */
export interface PetScene {
  /** Liv is out and its window is on screen: not home, not parked for a full-screen app, not paused. */
  shown: boolean;
  /** It hovers (rest.ts): it moves all the time. */
  hovering: boolean;
  asleep: boolean;
}

/** What is moving in it. */
export interface PetWork {
  /** The window is on its way between the island and its spot. */
  travelling: boolean;
  /** Liv moves, or its lights are taking a colour (robot.ts: changing). */
  robotChanging: boolean;
}

/** Whether the window needs another frame. */
export function petNeedsFrame(scene: PetScene, work: PetWork): boolean {
  if (!scene.shown) return false;
  return work.travelling || work.robotChanging;
}

/**
 * Whether Liv's small signs of life (a blink, a glance) come from the page's
 * one timer: standing still on screen, awake. Hovering, the engine blinks on
 * its own clock; asleep or out of sight, nothing does.
 */
export function petLivesOnTimer(scene: PetScene): boolean {
  return scene.shown && !scene.hovering && !scene.asleep;
}
