import { Controller } from "./controller.js";
import PAGE from "./ui.html";
import ICON from "./apple-touch-icon.png";
import FAVICON_PNG from "./favicon-32.png";
import FAVICON_SVG from "./favicon.svg";

export { Controller };

const COOKIE = "bc_session";
const SESSION_DAYS = 90;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return new Response(PAGE, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy":
              "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      // Icons: home screen, browser tabs and bookmarks.
      const icons = {
        "/apple-touch-icon.png": [ICON, "image/png"],
        "/favicon.svg": [FAVICON_SVG, "image/svg+xml"],
        "/favicon-32.png": [FAVICON_PNG, "image/png"],
        "/favicon.ico": [FAVICON_PNG, "image/png"],
      };
      if (request.method === "GET" && icons[url.pathname]) {
        const [body, type] = icons[url.pathname];
        return new Response(body, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400" } });
      }
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      return new Response("Not found", { status: 404 });
    } catch (e) {
      // Errors thrown inside the Durable Object arrive here without a status; the
      // message is what the UI shows.
      return json({ error: e.message || String(e) }, e.status || 400);
    }
  },

  // Cron safety net: re-arms the session alarm if it ever went missing.
  async scheduled(_event, env) {
    await controller(env).tick();
  },
};

function controller(env) {
  return env.CONTROLLER.get(env.CONTROLLER.idFromName("main"));
}

async function api(request, env, url) {
  const route = `${request.method} ${url.pathname}`;
  const ctl = controller(env);

  if (request.method === "POST") {
    // Cross-site forms can't send a JSON content type without a CORS preflight,
    // which this API never grants. Together with SameSite=Strict this blocks CSRF.
    const type = request.headers.get("Content-Type") || "";
    if (!type.startsWith("application/json")) return json({ error: "Expected JSON" }, 415);
  }

  if (route === "POST /api/login") {
    const locked = await ctl.loginLockedFor();
    if (locked) return json({ error: `Too many attempts. Try again in ${Math.ceil(locked / 60000)} min.` }, 429);
    const { passcode } = await body(request);
    const ok = await safeEqual(String(passcode ?? ""), requireSecret(env, "APP_PASSCODE"));
    await ctl.recordLogin(ok);
    if (!ok) return json({ error: "Wrong passcode" }, 401);
    const exp = Date.now() + SESSION_DAYS * 86_400_000;
    const token = `${exp}.${await sign(env, String(exp))}`;
    return json({ ok: true }, 200, {
      "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`,
    });
  }

  if (route === "POST /api/logout") {
    return json({ ok: true }, 200, {
      "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    });
  }

  const who = await authenticate(request, env);
  if (!who) return json({ error: "Not signed in" }, 401);

  switch (route) {
    case "GET /api/status":
      return json(await ctl.status());
    case "GET /api/rules":
      return json(await ctl.rules());
    case "POST /api/config":
      return json(await ctl.saveConfig(await body(request)));
    case "POST /api/start": {
      const { kind, minutes } = await body(request);
      return json(await ctl.start(kind, minutes, who));
    }
    case "POST /api/add": {
      const { minutes } = await body(request);
      return json(await ctl.addTime(minutes, who));
    }
    case "POST /api/end":
      return json({ session: await ctl.end(who) });
    case "POST /api/homework-rules": {
      const { templateRuleId, targets } = await body(request);
      return json(await ctl.createHomeworkRules(templateRuleId, Array.isArray(targets) ? targets : []));
    }
    default:
      return json({ error: "Not found" }, 404);
  }
}

// Returns who is calling ("web" or "shortcut"), or null.
async function authenticate(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (env.API_TOKEN && auth.startsWith("Bearer ")) {
    return (await safeEqual(auth.slice(7), env.API_TOKEN)) ? "shortcut" : null;
  }
  const cookie = (request.headers.get("Cookie") || "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE}=`));
  if (!cookie) return null;
  const [exp, mac] = cookie.slice(COOKIE.length + 1).split(".");
  if (!exp || !mac || Number(exp) < Date.now()) return null;
  return (await safeEqual(mac, await sign(env, exp))) ? "web" : null;
}

async function sign(env, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(requireSecret(env, "SESSION_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]);
}

// Constant-time comparison: hash both sides so lengths match, then compare.
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function requireSecret(env, name) {
  const v = env[name];
  if (!v) throw Object.assign(new Error(`${name} is not set (wrangler secret put ${name})`), { status: 500 });
  return v;
}

async function body(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    return {};
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
