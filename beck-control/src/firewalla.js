// Minimal Firewalla MSP API v2 client.
// Docs: https://docs.firewalla.net/api-reference/rule/
//
// Notes on measured behavior (see README "Firewalla API notes"):
// - POST /v2/rules/{id}/pause takes no duration. A paused rule stays paused
//   until /resume is called, so this app owns the timer.
// - Pause/resume are idempotent and return the JSON string "ok".

export class FirewallaError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class Firewalla {
  constructor(domain, token, fetchImpl = fetch) {
    if (!domain || !token) throw new FirewallaError("MSP_DOMAIN and MSP_TOKEN must be set", 500);
    // A bare domain gets https://; a full URL is used as-is (lets local dev point at a mock).
    const origin = /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
    this.base = `${origin.replace(/\/+$/, "")}/v2`;
    this.token = token;
    this.fetch = (...args) => fetchImpl(...args); // unbound: Workers fetch rejects a foreign `this`
  }

  async request(method, path, body) {
    const res = await this.fetch(this.base + path, {
      method,
      headers: {
        Authorization: `Token ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new FirewallaError(`Firewalla ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }

  async listRules() {
    const data = await this.request("GET", "/rules");
    return Array.isArray(data) ? data : data?.results ?? [];
  }

  pause(id) {
    return this.request("POST", `/rules/${encodeRuleId(id)}/pause`);
  }

  resume(id) {
    return this.request("POST", `/rules/${encodeRuleId(id)}/resume`);
  }

  createRule(rule) {
    return this.request("POST", "/rules", rule);
  }
}

// Rule ids look like "<box gid>:<n>". The colon is sent as-is (measured to work);
// anything that could change the path is rejected.
function encodeRuleId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9:_-]+$/.test(id)) {
    throw new FirewallaError(`Invalid rule id: ${id}`, 400);
  }
  return id;
}
