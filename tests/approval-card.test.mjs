// The approval card's command box (src/core/layout.ts): when what is being
// approved fits on the box's one line and the card stays as it was, and when
// it needs the taller card. The card itself, on the island, is in
// island.test.mjs; what never gets a card, in hooks.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_LINE_W, APPROVAL_LONG_H, EXPANDED_W, QUESTION_PICKER_H, VIEW_LAYOUTS, commandNeedsRoom,
} from "../src/core/layout.ts";

/** A font where every character is `px` wide. */
const mono = (px) => (text) => text.length * px;

test("the line is what is left of the open island inside the card and the box", () => {
  // 640 less the content's padding and the card's border (11 a side), the
  // stack's padding (116 and 16) and the box's padding and border (11 a side).
  assert.equal(EXPANDED_W, 640);
  assert.equal(APPROVAL_LINE_W, 464);
});

test("a command that fits on the line keeps the card; a wider one, or one of several lines, needs room", () => {
  const cascadia = mono(7.03125); // Cascadia Mono at 12px
  // 65 characters are 457 px: on the line.
  assert.equal(commandNeedsRoom("x".repeat(65), cascadia), false);
  assert.equal(commandNeedsRoom("Bash · npm test", cascadia), false);
  assert.equal(commandNeedsRoom("", cascadia), false);
  // 66 are 464.06: one too many.
  assert.equal(commandNeedsRoom("x".repeat(66), cascadia), true);
  // The pixel kept for rounding: 463 fits, 463.5 does not.
  assert.equal(commandNeedsRoom("x", () => APPROVAL_LINE_W - 1), false);
  assert.equal(commandNeedsRoom("x", () => APPROVAL_LINE_W - 0.5), true);
  // A narrower font fits more on the same line.
  assert.equal(commandNeedsRoom("x".repeat(70), mono(6.6)), false);
  // A line break or a tab takes more than the line, however short the text.
  for (const text of ["a\nb", "a\r\nb", "ls\n", "a\tb"]) {
    assert.equal(commandNeedsRoom(text, cascadia), true, JSON.stringify(text));
  }
});

test("the taller approval card is a height of its own, and no layout changed for it", () => {
  assert.equal(APPROVAL_LONG_H, 200);
  assert.equal(VIEW_LAYOUTS.approval.height, 160);
  assert.equal(VIEW_LAYOUTS.question.height, 160);
  assert.equal(QUESTION_PICKER_H, 200);
});
