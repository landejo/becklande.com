// Pure planning logic, kept free of Workers imports so it can be unit tested with node:test.
//
// Three kinds of session:
//   "extend"   – pause the limit rules (bedtime cutoff, daily time limit).
//   "homework" – same, plus turn ON the block rules (games, YouTube, Discord, video...).
//   "block"    – turn ON the block rules only; limits stay as they are.
//
// A session records only the changes it actually made, so ending it restores exactly
// what was there before and never touches a rule someone changed by hand.

export const KINDS = ["extend", "homework", "block"];
export const MAX_MINUTES = 240;
// Blocking can safely run longer (e.g. "until tomorrow morning").
export const MAX_BLOCK_MINUTES = 24 * 60;

const PAUSES_LIMITS = new Set(["extend", "homework"]);
const BLOCKS_ON = new Set(["homework", "block"]);

export function validateConfig(input) {
  const limitRuleIds = uniqueStrings(input?.limitRuleIds);
  const homeworkRuleIds = uniqueStrings(input?.homeworkRuleIds);
  const overlap = limitRuleIds.filter((id) => homeworkRuleIds.includes(id));
  if (overlap.length) {
    throw new Error(`A rule can't be both a limit and a block: ${overlap.join(", ")}`);
  }
  return { limitRuleIds, homeworkRuleIds };
}

export function validateMinutes(minutes, kind = "extend") {
  const max = kind === "block" ? MAX_BLOCK_MINUTES : MAX_MINUTES;
  const n = Number(minutes);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`Minutes must be a whole number from 1 to ${max}`);
  }
  return n;
}

// rules: array of Firewalla rule objects ({id, status, ...}).
// changes: the current session's recorded changes ([{id, did: "paused"|"resumed"}]), or [].
// Returns the API calls to make and the change list the session should hold afterwards.
export function planStart({ kind, config, rules, changes = [] }) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown session kind: ${kind}`);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const ops = [];
  const missing = [];
  let next = changes.map((c) => ({ ...c }));
  const touched = (id) => next.some((c) => c.id === id);

  // wantDid: the change this kind wants on the rule ("paused" limits / "resumed" blocks),
  // or null when the rule should be back in its original state.
  const reconcile = (ids, wantDid) => {
    const [fromStatus, op] = wantDid === "paused" ? ["active", "pause"] : ["paused", "resume"];
    for (const id of ids) {
      const rule = byId.get(id);
      if (!rule) { missing.push(id); continue; }
      const status = rule.status ?? "active";
      if (wantDid) {
        if (status === fromStatus && !touched(id)) {
          ops.push({ id, op });
          next.push({ id, did: wantDid });
        }
      } else {
        const mine = next.find((c) => c.id === id);
        if (mine) {
          // Switching modes: undo what the previous mode changed on this rule now.
          ops.push({ id, op: mine.did === "paused" ? "resume" : "pause" });
          next = next.filter((c) => c.id !== id);
        }
      }
    }
  };

  reconcile(config.limitRuleIds, PAUSES_LIMITS.has(kind) ? "paused" : null);
  reconcile(config.homeworkRuleIds, BLOCKS_ON.has(kind) ? "resumed" : null);
  return { ops, changes: next, missing };
}

export function planRevert(changes) {
  return changes.map((c) => ({ id: c.id, op: c.did === "paused" ? "resume" : "pause" }));
}

export function ruleLabel(rule) {
  if (!rule) return "(missing rule)";
  if (rule.name) return rule.name;
  if (rule.notes) return rule.notes;
  const t = rule.target || {};
  const what = t.type === "internet" ? "internet" : `${t.type}${t.value ? ` ${t.value}` : ""}`;
  if (rule.action === "timelimit") {
    const q = rule.timeUsage?.quota;
    return `Time limit on ${what}${q ? ` (${formatMinutes(q)}/day)` : ""}`;
  }
  return `${rule.action || "rule"} ${what}`;
}

export function formatMinutes(total) {
  const h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function uniqueStrings(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()))];
}
