import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReply, replyToScreenName } from "../src/reply/gating.js";
import type { Tweet } from "../src/x/types.js";

// Positional mention gating — decides whether a mention is actually directed at us.
// Pure logic, security-relevant (avoid replying when X auto-prepends our handle into
// an unrelated reply chain), so it's worth pinning down with cases.

const H = "yapprbot";

test("replies when the handle is in the body", () => {
  assert.equal(shouldReply("hey @yapprbot what's up", H), true);
});

test("replies when the handle is the last of the leading mentions", () => {
  assert.equal(shouldReply("@alice @yapprbot do the thing", H), true);
});

test("replies (handle is the only leading mention)", () => {
  assert.equal(shouldReply("@yapprbot hello", H), true);
});

test("matches the handle case-insensitively", () => {
  assert.equal(shouldReply("yo @YapprBot", H), true);
});

test("ignores when the handle is a middle leading mention", () => {
  assert.equal(shouldReply("@alice @yapprbot @bob hi", H), false);
});

test("ignores when the handle isn't mentioned at all", () => {
  assert.equal(shouldReply("@alice @bob hello", H), false);
});

test("handle is first leading mention, replying TO the handle -> reply", () => {
  assert.equal(shouldReply("@yapprbot @alice hi", H, H), true);
});

test("handle is first leading mention, replying to someone else -> ignore", () => {
  assert.equal(shouldReply("@yapprbot @alice hi", H, "alice"), false);
});

test("handle is first leading mention, no reply target -> reply", () => {
  assert.equal(shouldReply("@yapprbot @alice hi", H), true);
});

test("replyToScreenName reads in_reply_to_screen_name off the tweet", () => {
  assert.equal(replyToScreenName({ in_reply_to_screen_name: "alice" } as Tweet), "alice");
  assert.equal(replyToScreenName({} as Tweet), undefined);
});
