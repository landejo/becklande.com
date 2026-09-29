import { DurableObject } from "cloudflare:workers";
import { Firewalla } from "./firewalla.js";
import {
  planRevert,
  planStart,
  ruleLabel,
  validateConfig,
  validateMinutes,
} from "./logic.js";

const RETRY_MS = 2 * 60 * 1000;
const LOG_LIMIT = 100;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

// Block targets the setup screen offers (the first four are pre-ticked) (Firewalla rule target types/values).
export const HOMEWORK_TARGETS = [
  { type: "category", value: "games", label: "Games (category)" },
  { type: "app", value: "youtube", label: "YouTube" },
  { type: "app", value: "discord", label: "Discord" },
  { type: "category", value: "video", label: "Video (category)" },
  { type: "app", value: "roblox", label: "Roblox" },
  { type: "app", value: "fortnite", label: "Fortnite" },
  { type: "app", value: "twitch", label: "Twitch" },
  { type: "category", value: "social", label: "Social (category)" },
];

// One instance ("main") holds all state: config, the active session, the log and
// login throttling. Its alarm is what ends a session on time.
export class Controller extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.queue = Promise.resolve();
  }

  // Serialize mutating operations: they interleave external API calls.
  exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  fw() {
    return new Firewalla(this.env.MSP_DOMAIN, this.env.MSP_TOKEN);
  }

  async config() {
    return (await this.ctx.storage.get("config")) ?? { limitRuleIds: [], homeworkRuleIds: [] };
  }

  async session() {
    return (await this.ctx.storage.get("session")) ?? null;
  }

  async log(message, level = "info") {
    const log = (await this.ctx.storage.get("log")) ?? [];
    log.unshift({ ts: Date.now(), level, message });
    await this.ctx.storage.put("log", log.slice(0, LOG_LIMIT));
  }

  async status() {
    const [config, session, log] = await Promise.all([
      this.config(),
      this.session(),
      this.ctx.storage.get("log"),
    ]);
    let rules = [];
    let error = null;
    try {
      rules = await this.fw().listRules();
    } catch (e) {
      error = e.message;
    }
    const byId = new Map(rules.map((r) => [r.id, r]));
    const describe = (id) => {
      const r = byId.get(id);
      return {
        id,
        label: ruleLabel(r),
        status: r ? r.status ?? "active" : "missing",
        action: r?.action,
        timeUsage: r?.timeUsage ?? null,
      };
    };
    return {
      now: Date.now(),
      session,
      config,
      limits: config.limitRuleIds.map(describe),
      homework: config.homeworkRuleIds.map(describe),
      log: (log ?? []).slice(0, 30),
      error,
    };
  }

  async rules() {
    const rules = await this.fw().listRules();
    return {
      rules: rules.map((r) => ({
        id: r.id,
        gid: r.gid,
        label: ruleLabel(r),
        action: r.action,
        status: r.status ?? "active",
        target: r.target,
        scope: r.scope ?? null,
        schedule: r.schedule ?? null,
        timeUsage: r.timeUsage ?? null,
        notes: r.notes ?? "",
      })),
      config: await this.config(),
      homeworkTargets: HOMEWORK_TARGETS,
    };
  }

  saveConfig(input) {
    return this.exclusive(async () => {
      const session = await this.session();
      if (session) throw new Error("End the current session before changing setup");
      const config = validateConfig(input);
      await this.ctx.storage.put("config", config);
      await this.log(`Setup saved: ${config.limitRuleIds.length} limit rule(s), ${config.homeworkRuleIds.length} block rule(s)`);
      return config;
    });
  }

  start(kind, minutes, by = "web") {
    return this.exclusive(async () => {
      const mins = validateMinutes(minutes, kind);
      const config = await this.config();
      if (kind !== "block" && !config.limitRuleIds.length) throw new Error("Pick the limit rules in Setup first");
      if (kind !== "extend" && !config.homeworkRuleIds.length) {
        throw new Error("Pick or create the block rules in Setup first");
      }
      const fw = this.fw();
      const current = await this.session();
      const rules = await fw.listRules();
      const plan = planStart({ kind, config, rules, changes: current?.changes ?? [] });

      // Record intent before calling the API, so a crash midway still gets reverted.
      // Reverting a change that never landed is harmless: pause/resume are idempotent
      // and the revert only restores each rule's original state.
      const now = Date.now();
      const session = {
        kind,
        startedAt: current?.startedAt ?? now,
        endsAt: now + mins * 60_000,
        changes: plan.changes,
        errors: [],
      };
      await this.ctx.storage.put("session", session);
      await this.ctx.storage.setAlarm(session.endsAt);

      const failed = await this.apply(fw, plan.ops);
      if (failed.length) {
        // A change the plan dropped (homework block re-paused on switching to a plain
        // extension) that failed must stay tracked, or it would never be undone.
        for (const f of failed) {
          const prior = current?.changes.find((c) => c.id === f.id);
          if (prior && !session.changes.some((c) => c.id === f.id)) session.changes.push(prior);
        }
        session.errors = failed.map((f) => f.error);
        await this.ctx.storage.put("session", session);
      }

      const what = { extend: "Extension", homework: "Homework mode", block: "Fun blocked" }[kind];
      await this.log(`${what} for ${mins} min (by ${by}); ${plan.ops.length} rule change(s)`);
      if (plan.missing.length) await this.log(`Rules not found on Firewalla: ${plan.missing.join(", ")}`, "warn");
      for (const e of session.errors) await this.log(e, "error");
      return session;
    });
  }

  addTime(minutes, by = "web") {
    return this.exclusive(async () => {
      const session = await this.session();
      if (!session) throw new Error("No active session");
      const mins = validateMinutes(minutes, session.kind);
      session.endsAt = Math.max(session.endsAt, Date.now()) + mins * 60_000;
      await this.ctx.storage.put("session", session);
      await this.ctx.storage.setAlarm(session.endsAt);
      await this.log(`Added ${mins} min (by ${by})`);
      return session;
    });
  }

  end(by = "web") {
    return this.exclusive(() => this.revert(`Ended early (by ${by})`));
  }

  async alarm() {
    await this.exclusive(async () => {
      const session = await this.session();
      if (!session) return;
      if (Date.now() < session.endsAt) {
        await this.ctx.storage.setAlarm(session.endsAt);
        return;
      }
      await this.revert("Time's up; limits restored");
    });
  }

  // Safety net for the cron trigger: make sure an active session always has an alarm.
  async tick() {
    const session = await this.session();
    if (!session) return;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(Math.max(session.endsAt, Date.now() + 1000));
  }

  async revert(reason) {
    const session = await this.session();
    if (!session) return null;
    const ops = planRevert(session.changes);
    const failed = await this.apply(this.fw(), ops);
    if (failed.length) {
      // Keep only what still needs undoing and try again shortly.
      session.changes = session.changes.filter((c) => failed.some((f) => f.id === c.id));
      session.endsAt = Math.min(session.endsAt, Date.now());
      session.errors = failed.map((f) => f.error);
      session.reverting = true;
      await this.ctx.storage.put("session", session);
      await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
      for (const f of failed) await this.log(`Restore failed, retrying: ${f.error}`, "error");
      return session;
    }
    await this.ctx.storage.delete("session");
    await this.ctx.storage.deleteAlarm();
    await this.log(reason);
    return null;
  }

  async apply(fw, ops) {
    const failed = [];
    for (const { id, op } of ops) {
      try {
        await (op === "pause" ? fw.pause(id) : fw.resume(id));
      } catch (e) {
        failed.push({ id, op, error: `${op} ${id}: ${e.message}` });
      }
    }
    return failed;
  }

  // Creates block rules for the chosen targets, scoped like an existing rule (e.g. the
  // bedtime rule, which already targets Beck's devices), then pauses them so they only
  // switch on during homework or block-fun sessions.
  createHomeworkRules(templateRuleId, targetValues) {
    return this.exclusive(async () => {
      const session = await this.session();
      if (session) throw new Error("End the current session before changing setup");
      const fw = this.fw();
      const rules = await fw.listRules();
      const template = rules.find((r) => r.id === templateRuleId);
      if (!template) throw new Error("Template rule not found");
      if (!template.scope) throw new Error("Template rule has no scope; it would block every device");
      const wanted = HOMEWORK_TARGETS.filter((t) => targetValues.includes(`${t.type}:${t.value}`));
      if (!wanted.length) throw new Error("Pick at least one thing to block");

      const config = await this.config();
      const created = [];
      for (const t of wanted) {
        const rule = await fw.createRule({
          action: "block",
          direction: "bidirection",
          ...(template.gid ? { gid: template.gid } : {}),
          scope: template.scope,
          target: { type: t.type, value: t.value },
          notes: `Beck Control block: ${t.label}`,
        });
        if (!rule?.id) throw new Error(`Firewalla did not return an id for ${t.label}`);
        await fw.pause(rule.id);
        created.push(rule.id);
      }
      const next = validateConfig({
        limitRuleIds: config.limitRuleIds,
        homeworkRuleIds: [...config.homeworkRuleIds, ...created],
      });
      await this.ctx.storage.put("config", next);
      await this.log(`Created ${created.length} block rule(s) (paused)`);
      return { created, config: next };
    });
  }

  // Login throttling. Returns ms until unlocked, or 0.
  async loginLockedFor() {
    const s = (await this.ctx.storage.get("login")) ?? { failures: 0, lockedUntil: 0 };
    return Math.max(0, s.lockedUntil - Date.now());
  }

  async recordLogin(ok) {
    if (ok) {
      await this.ctx.storage.put("login", { failures: 0, lockedUntil: 0 });
      return;
    }
    const s = (await this.ctx.storage.get("login")) ?? { failures: 0, lockedUntil: 0 };
    s.failures += 1;
    if (s.failures >= LOGIN_MAX_FAILURES) {
      s.failures = 0;
      s.lockedUntil = Date.now() + LOGIN_LOCK_MS;
      await this.log("Too many wrong passcodes; login locked for 15 minutes", "warn");
    }
    await this.ctx.storage.put("login", s);
  }
}
