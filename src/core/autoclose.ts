// The island's own settings card offers a few auto-close delays to pick from.
// Settings → General takes any number of seconds, so the one in force may be
// none of them: it then joins the choices, and is the one shown as picked.

/** The delays always offered, in seconds. */
export const AUTO_CLOSE_PRESETS: readonly number[] = [10, 15, 30];

/** The delays the card offers while `current` seconds is the one in force, shortest first. */
export function autoCloseChoices(current: number): number[] {
  if (!Number.isFinite(current) || current <= 0 || AUTO_CLOSE_PRESETS.includes(current)) {
    return [...AUTO_CLOSE_PRESETS];
  }
  return [...AUTO_CLOSE_PRESETS, current].sort((a, b) => a - b);
}
