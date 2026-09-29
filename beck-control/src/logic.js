// Pure planning logic, kept free of Workers imports so it can be unit tested with node:test.
//
// Two kinds of session:
//   "extend"   – pause the limit rules (bedtime cutoff, daily time limit).
//   "homework" – same, plus turn ON the homework block rules (games, YouTube, Discord...).
//
// A session records only the changes it actually made, so ending it restores exactly
// what was there before and never touches a rule someone changed by hand.

export const KINDS = ["extend", "homework"];
export const MAX_MINUTES = 240;

export function validateConfig(input) {
  const limitRuleIds = uniqueStrings(input?.limitRuleIds);
  const homeworkRuleIds = uniqueStrings(input?.homeworkRuleIds);
  const overlap = limitRuleIds.filter((id) => homeworkRuleIds.includes(id));
  if (overlap.length) {
    throw new Error(`A rule can't be both a limit and a homework block: ${overlap.join(", ")}`);
  }
  return { limitRuleIds, homeworkRuleIds };
}

export function validateMinutes(minutes) {
  const n = Number(minutes);
  if (!Number.isInteger(n) || n < 1 || n > MAX_MINUTES) {
    throw new Error(`Minutes must be a whole number from 1 to ${MAX_MINUTES}`);
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

  for (const id of config.limitRuleIds) {
    const rule = byId.get(id);
    if (!rule) { missing.push(id); continue; }
    if (rule.status !== "paused" && !touched(id)) {
      ops.push({ id, op: "pause" });
      next.push({ id, did: "paused" });
    }
  }

  for (const id of config.homeworkRuleIds) {
    const rule = byId.get(id);
    if (!rule) { missing.push(id); continue; }
    if (kind === "homework") {
      if (rule.status === "paused" && !touched(id)) {
        ops.push({ id, op: "resume" });
        next.push({ id, did: "resumed" });
      }
    } else if (next.some((c) => c.id === id && c.did === "resumed")) {
      // Switching homework -> plain extension: put the homework blocks back to paused now.
      ops.push({ id, op: "pause" });
      next = next.filter((c) => c.id !== id);
    }
  }

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
