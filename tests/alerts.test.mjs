// When an alert of a pill may take the island's screen (src/core/alerts.ts):
// every combination of who asks, what the island shows and what is waiting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { alertShows } from "../src/core/alerts.ts";
import { VIEW_LAYOUTS } from "../src/core/layout.ts";

const VIEWS = Object.keys(VIEW_LAYOUTS);
/** The cards that only show how things stand: an alert may take their place. */
const REPLACEABLE = ["overview", "finished", "error", "empty"];
const BOTH = [false, true];

const scene = (over = {}) => ({
  focused: true, waitsForYou: false, alertsFromAllPills: false, cardWaiting: false, expanded: true, view: "overview",
  ...over,
});

/** Every scene there is: 2 × 2 × 2 × 2 × 2 × the views. */
function* scenes() {
  for (const focused of BOTH) for (const waitsForYou of BOTH) for (const alertsFromAllPills of BOTH) {
    for (const cardWaiting of BOTH) for (const expanded of BOTH) for (const view of VIEWS) {
      yield { focused, waitsForYou, alertsFromAllPills, cardWaiting, expanded, view };
    }
  }
}

test("the rule, over every scene", () => {
  let seen = 0;
  for (const s of scenes()) {
    const mayReplace = !s.expanded || REPLACEABLE.includes(s.view);
    const entitled = s.focused || s.waitsForYou || s.alertsFromAllPills;
    assert.equal(alertShows(s), !s.cardWaiting && mayReplace && entitled, JSON.stringify(s));
    seen++;
  }
  assert.equal(seen, 32 * VIEWS.length);
  assert.ok(VIEWS.length >= 16, "every view of the island is covered");
});

test("a card waiting for an answer is never covered, whoever asks", () => {
  for (const s of scenes()) {
    if (s.cardWaiting) assert.equal(alertShows(s), false, JSON.stringify(s));
  }
});

test("the pill in front no longer cuts off what is being typed", () => {
  // The chat, the launch card, the settings, a dropped file, the recap…
  for (const view of VIEWS.filter((v) => !REPLACEABLE.includes(v))) {
    for (const waitsForYou of BOTH) for (const alertsFromAllPills of BOTH) {
      assert.equal(alertShows(scene({ view, waitsForYou, alertsFromAllPills })), false, view);
      assert.equal(alertShows(scene({ view, waitsForYou, alertsFromAllPills, focused: false })), false, view);
    }
  }
  // The same view on an island that is not open is nobody's work in progress.
  assert.equal(alertShows(scene({ view: "prompt", expanded: false })), true);
  assert.equal(alertShows(scene({ view: "launch", expanded: false })), true);
});

test("the pill in front shows its alerts over the cards that only show how things stand", () => {
  for (const view of REPLACEABLE) assert.equal(alertShows(scene({ view })), true, view);
});

test("another pill shows its alerts only when they wait for you, or with alerts from all pills", () => {
  const other = (over) => alertShows(scene({ focused: false, ...over }));
  assert.equal(other({}), false);
  assert.equal(other({ expanded: false }), false);
  assert.equal(other({ alertsFromAllPills: true }), true);
  assert.equal(other({ waitsForYou: true }), true);
  assert.equal(other({ waitsForYou: true, expanded: false, view: "settings" }), true);
  assert.equal(other({ waitsForYou: true, alertsFromAllPills: true, view: "settings" }), false);
});
