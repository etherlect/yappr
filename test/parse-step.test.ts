import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStep } from "../src/reply/agent.js";

// parseStep turns the model's per-turn JSON into a typed step. It has to be lenient
// (models mislabel `action`) but never invent a skill call out of malformed input.

test("a reply step", () => {
  assert.deepEqual(parseStep('{"action":"reply","text":"hi"}'), { action: "reply", text: "hi", mediaIds: undefined });
});

test("a reply with comma-separated media ids", () => {
  assert.deepEqual(parseStep('{"action":"reply","text":"","media_id":"1,2"}'), { action: "reply", text: "", mediaIds: ["1", "2"] });
});

test("reply media is capped at 4", () => {
  const s = parseStep('{"action":"reply","text":"x","media_id":"1,2,3,4,5"}');
  assert.deepEqual(s?.mediaIds, ["1", "2", "3", "4"]);
});

test("a use_skill step", () => {
  assert.deepEqual(
    parseStep('{"action":"use_skill","skill":"x-read","params":{"q":"x"}}'),
    { action: "use_skill", skill: "x-read", params: { q: "x" }, thought: undefined },
  );
});

test("a mislabeled action is accepted when an explicit skill is present", () => {
  const s = parseStep('{"action":"generate_image","skill":"generate-image","params":{}}');
  assert.equal(s?.action, "use_skill");
  assert.equal(s?.skill, "generate-image");
});

test("invalid JSON is rejected", () => {
  assert.equal(parseStep("not json"), null);
});

test("a skill call with no skill field is rejected", () => {
  assert.equal(parseStep('{"action":"use_skill","params":{}}'), null);
});

test("a skill call with non-object params is rejected", () => {
  assert.equal(parseStep('{"action":"use_skill","skill":"x","params":[]}'), null);
});
