import { test } from "node:test";
import assert from "node:assert/strict";
import { planRevert, planStart, ruleLabel, validateConfig, validateMinutes } from "../src/logic.js";

const config = { limitRuleIds: ["bed", "quota"], homeworkRuleIds: ["games", "yt"] };
const rules = (overrides = {}) =>
  [
    { id: "bed", status: "active" },
    { id: "quota", status: "active", action: "timelimit" },
    { id: "games", status: "paused" },
    { id: "yt", status: "paused" },
  ].map((r) => ({ ...r, ...(overrides[r.id] ?? {}) }));

test("extend pauses active limit rules only", () => {
  const plan = planStart({ kind: "extend", config, rules: rules() });
  assert.deepEqual(plan.ops, [
    { id: "bed", op: "pause" },
    { id: "quota", op: "pause" },
  ]);
  assert.deepEqual(plan.changes, [
    { id: "bed", did: "paused" },
    { id: "quota", did: "paused" },
  ]);
});

test("a rule already paused by hand is left alone and not restored later", () => {
  const plan = planStart({ kind: "extend", config, rules: rules({ bed: { status: "paused" } }) });
  assert.deepEqual(plan.ops, [{ id: "quota", op: "pause" }]);
  assert.deepEqual(planRevert(plan.changes), [{ id: "quota", op: "resume" }]);
});

test("homework also switches on paused homework blocks", () => {
  const plan = planStart({ kind: "homework", config, rules: rules() });
  assert.deepEqual(plan.ops.map((o) => `${o.op}:${o.id}`), ["pause:bed", "pause:quota", "resume:games", "resume:yt"]);
  assert.deepEqual(planRevert(plan.changes).map((o) => `${o.op}:${o.id}`), [
    "resume:bed",
    "resume:quota",
    "pause:games",
    "pause:yt",
  ]);
});

test("homework block that is already on is not turned off at the end", () => {
  const plan = planStart({ kind: "homework", config, rules: rules({ games: { status: "active" } }) });
  assert.ok(!plan.changes.some((c) => c.id === "games"));
});

test("switching extend -> homework keeps earlier changes and adds blocks", () => {
  const first = planStart({ kind: "extend", config, rules: rules() });
  const after = rules({ bed: { status: "paused" }, quota: { status: "paused" } });
  const second = planStart({ kind: "homework", config, rules: after, changes: first.changes });
  assert.deepEqual(second.ops.map((o) => `${o.op}:${o.id}`), ["resume:games", "resume:yt"]);
  assert.equal(second.changes.length, 4);
});

test("switching homework -> extend re-pauses the blocks it turned on", () => {
  const first = planStart({ kind: "homework", config, rules: rules() });
  const after = rules({
    bed: { status: "paused" },
    quota: { status: "paused" },
    games: { status: "active" },
    yt: { status: "active" },
  });
  const second = planStart({ kind: "extend", config, rules: after, changes: first.changes });
  assert.deepEqual(second.ops.map((o) => `${o.op}:${o.id}`), ["pause:games", "pause:yt"]);
  assert.deepEqual(second.changes, [
    { id: "bed", did: "paused" },
    { id: "quota", did: "paused" },
  ]);
});

test("missing rules are reported, not fatal", () => {
  const plan = planStart({ kind: "extend", config, rules: rules().filter((r) => r.id !== "bed") });
  assert.deepEqual(plan.missing, ["bed"]);
  assert.deepEqual(plan.ops, [{ id: "quota", op: "pause" }]);
});

test("unknown kind is rejected", () => {
  assert.throws(() => planStart({ kind: "party", config, rules: rules() }));
});

test("config rejects a rule in both lists and dedupes", () => {
  assert.throws(() => validateConfig({ limitRuleIds: ["a"], homeworkRuleIds: ["a"] }));
  assert.deepEqual(validateConfig({ limitRuleIds: ["a", "a", " b "], homeworkRuleIds: null }), {
    limitRuleIds: ["a", "b"],
    homeworkRuleIds: [],
  });
});

test("minutes must be 1..240 whole numbers", () => {
  assert.equal(validateMinutes("30"), 30);
  for (const bad of [0, -5, 1.5, 241, "abc", undefined]) assert.throws(() => validateMinutes(bad));
});

test("labels", () => {
  assert.equal(ruleLabel({ name: "Bedtime" }), "Bedtime");
  assert.equal(
    ruleLabel({ action: "timelimit", target: { type: "internet" }, timeUsage: { quota: 150, used: 10 } }),
    "Time limit on internet (2h 30m/day)",
  );
  assert.equal(ruleLabel({ action: "block", target: { type: "app", value: "youtube" } }), "block app youtube");
  assert.equal(ruleLabel(undefined), "(missing rule)");
});
