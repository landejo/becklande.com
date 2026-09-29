// Tiny stand-in for the Firewalla MSP API, for local end-to-end testing:
//   node scripts/mock-msp.js            (listens on :8799)
//   MSP_DOMAIN=http://localhost:8799 in .dev.vars, then `npm run dev`
import http from "node:http";

const TOKEN = process.env.MOCK_TOKEN || "test-token";
const GID = "00000000-0000-0000-0000-000000000001";
const beck = { type: "user", value: "beck-user-id" };
let next = 10;
const rules = [
  { id: `${GID}:1`, gid: GID, action: "block", target: { type: "internet" }, scope: beck, status: "active", notes: "Beck bedtime 8:30pm", schedule: { cronTime: "30 20 * * *", duration: 36000 } },
  { id: `${GID}:2`, gid: GID, action: "timelimit", target: { type: "internet" }, scope: beck, status: "active", timeUsage: { quota: 150, used: 131 } },
  { id: `${GID}:3`, gid: GID, action: "block", target: { type: "category", value: "porn" }, status: "active" },
];

http
  .createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Token ${TOKEN}`) return send(401, { error: "bad token" });
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      console.log(req.method, url.pathname, raw);
      if (req.method === "GET" && url.pathname === "/v2/rules") return send(200, { count: rules.length, results: rules });
      if (req.method === "POST" && url.pathname === "/v2/rules") {
        const rule = { ...JSON.parse(raw || "{}"), id: `${GID}:${next++}`, status: "active", ts: Date.now() / 1000 };
        rules.push(rule);
        return send(200, rule);
      }
      const m = url.pathname.match(/^\/v2\/rules\/([^/]+)\/(pause|resume)$/);
      if (req.method === "POST" && m) {
        const rule = rules.find((r) => r.id === decodeURIComponent(m[1]));
        if (!rule) return send(403, { error: { title: "Forbidden" } });
        rule.status = m[2] === "pause" ? "paused" : "active";
        return send(200, "ok");
      }
      send(404, { error: "not found" });
    });
  })
  .listen(Number(process.env.PORT || 8799), () => console.log("mock MSP listening"));
