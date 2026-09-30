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

test("block turns on block rules and leaves limits alone", () => {
  const plan = planStart({ kind: "block", config, rules: rules() });
  assert.deepEqual(plan.ops.map((o) => `${o.op}:${o.id}`), ["resume:games", "resume:yt"]);
  assert.deepEqual(planRevert(plan.changes).map((o) => `${o.op}:${o.id}`), ["pause:games", "pause:yt"]);
});

test("block works with no limit rules configured", () => {
  const plan = planStart({ kind: "block", config: { limitRuleIds: [], homeworkRuleIds: ["games"] }, rules: rules() });
  assert.deepEqual(plan.ops, [{ id: "games", op: "resume" }]);
});

test("switching extend -> block restores limits now and turns blocks on", () => {
  const first = planStart({ kind: "extend", config, rules: rules() });
  const after = rules({ bed: { status: "paused" }, quota: { status: "paused" } });
  const second = planStart({ kind: "block", config, rules: after, changes: first.changes });
  assert.deepEqual(second.ops.map((o) => `${o.op}:${o.id}`), ["resume:bed", "resume:quota", "resume:games", "resume:yt"]);
  assert.deepEqual(second.changes, [
    { id: "games", did: "resumed" },
    { id: "yt", did: "resumed" },
  ]);
});

test("switching block -> homework keeps the blocks and pauses limits", () => {
  const first = planStart({ kind: "block", config, rules: rules() });
  const after = rules({ games: { status: "active" }, yt: { status: "active" } });
  const second = planStart({ kind: "homework", config, rules: after, changes: first.changes });
  assert.deepEqual(second.ops.map((o) => `${o.op}:${o.id}`), ["pause:bed", "pause:quota"]);
  assert.equal(second.changes.length, 4);
});

test("block sessions may run up to 24 hours; others 4", () => {
  assert.equal(validateMinutes(900, "block"), 900);
  assert.throws(() => validateMinutes(900, "extend"));
  assert.throws(() => validateMinutes(1441, "block"));
});

import { extraMinutesToday, nextExtraSince, startOfDay } from "../src/logic.js";

const TZ = "America/Los_Angeles";
// 2026-09-30 20:00 PDT = 2026-10-01 03:00 UTC
const EVENING = Date.UTC(2026, 9, 1, 3, 0, 0);
const MIN = 60_000;

test("startOfDay is local midnight", () => {
  assert.equal(startOfDay(EVENING, TZ), Date.UTC(2026, 8, 30, 7, 0, 0)); // 00:00 PDT
});

test("nextExtraSince: starts, carries over, and stops for Block fun", () => {
  assert.equal(nextExtraSince(null, "extend", 100), 100);
  assert.equal(nextExtraSince({ kind: "extend", extraSince: 50 }, "homework", 100), 50);
  assert.equal(nextExtraSince({ kind: "block" }, "extend", 100), 100);
  assert.equal(nextExtraSince({ kind: "extend", extraSince: 50 }, "block", 100), null);
});

test("extraMinutesToday sums closed and open intervals", () => {
  const intervals = [
    { from: EVENING - 90 * MIN, to: EVENING - 60 * MIN }, // 30m
    { from: EVENING - 15 * MIN, to: null }, // still running: 15m
  ];
  assert.equal(extraMinutesToday(intervals, EVENING, TZ), 45);
});

test("extraMinutesToday ignores time before local midnight", () => {
  const midnight = startOfDay(EVENING, TZ);
  const intervals = [
    { from: midnight - 60 * MIN, to: midnight + 20 * MIN }, // only 20m is today
    { from: midnight - 3 * 60 * MIN, to: midnight - 2 * 60 * MIN }, // yesterday
  ];
  assert.equal(extraMinutesToday(intervals, EVENING, TZ), 20);
});

import { bedtimeInfo, clockLabel } from "../src/logic.js";

const bedtime = { cronTime: "30 20 * * *", duration: 40500 }; // 8:30pm for 11h15m
const pdt = (h, m) => Date.UTC(2026, 8, 30, h + 7, m); // Sep 30 2026, h:m PDT

test("clockLabel", () => {
  assert.equal(clockLabel(20 * 60 + 30), "8:30pm");
  assert.equal(clockLabel(7 * 60 + 45 + 1440), "7:45am");
  assert.equal(clockLabel(0), "12am");
  assert.equal(clockLabel(12 * 60), "12pm");
});

test("bedtimeInfo labels and active window", () => {
  const evening = bedtimeInfo(bedtime, pdt(21, 0), TZ);
  assert.deepEqual([evening.start, evening.end, evening.active], ["8:30pm", "7:45am", true]);
  assert.equal(evening.endsAt, pdt(21, 0) + (10 * 60 + 45) * 60_000);
  assert.equal(bedtimeInfo(bedtime, pdt(6, 0), TZ).active, true); // early morning, still bedtime
  assert.equal(bedtimeInfo(bedtime, pdt(8, 0), TZ).active, false);
  assert.equal(bedtimeInfo(bedtime, pdt(20, 29), TZ).active, false);
});

test("bedtimeInfo respects weekdays and rejects unusual crons", () => {
  // Sep 30 2026 is a Wednesday (3); a Mon-Tue-only schedule is off tonight.
  assert.equal(bedtimeInfo({ ...bedtime, cronTime: "30 20 * * 1,2" }, pdt(21, 0), TZ).active, false);
  assert.equal(bedtimeInfo({ ...bedtime, cronTime: "30 20 * * 3" }, pdt(21, 0), TZ).active, true);
  assert.equal(bedtimeInfo({ cronTime: "*/5 * * * *", duration: 60 }, pdt(21, 0), TZ), null);
  assert.equal(bedtimeInfo(null, pdt(21, 0), TZ), null);
});

test("bedtimeInfo says whether it starts tonight", () => {
  // Wednesday: a Sun-Thu schedule applies tonight, a Fri-Sat one doesn't.
  assert.equal(bedtimeInfo({ cronTime: "30 20 * * 0,1,2,3,4", duration: 36000 }, pdt(12, 0), TZ).tonight, true);
  assert.equal(bedtimeInfo({ cronTime: "0 23 * * 5,6", duration: 30600 }, pdt(12, 0), TZ).tonight, false);
});
