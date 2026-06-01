const http = require("http");
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");

const host = "0.0.0.0";
const port = Number(process.env.PORT || 8090);
const root = path.join(__dirname, "public");

const rooms = new Map();
let turnCache = { expires: 0, iceServers: null };

function room(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { controller: [], device: [], updated: Date.now() });
  }
  return rooms.get(id);
}

function sendJson(res, code, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function getIceServers() {
  const keyId = process.env.CF_TURN_KEY_ID;
  const token = process.env.CF_TURN_KEY_API_TOKEN;
  const fallback = [{ urls: "stun:stun.l.google.com:19302" }];
  if (!keyId || !token) return fallback;
  if (turnCache.iceServers && Date.now() < turnCache.expires) return turnCache.iceServers;

  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ttl: 86400 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`TURN credentials failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    return fallback;
  }
  const data = await res.json();
  const iceServers = data.iceServers || data.ice_servers || data;
  turnCache = { expires: Date.now() + 60 * 60 * 1000, iceServers };
  console.log(`TURN iceServers loaded count=${Array.isArray(iceServers) ? iceServers.length : 1}`);
  return iceServers;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let file = url.pathname === "/" ? "/control.html" : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(root, file);
  if (!full.startsWith(root)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = path.extname(full);
    const type = ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js" ? "text/javascript; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  });
}

function wsAcceptKey(key) {
  return crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

function safeIphoneIp(value) {
  const ip = String(value || process.env.IPHONE_IP || "192.168.31.72").trim();
  if (!/^[0-9a-fA-F:.]+$/.test(ip)) return "192.168.31.72";
  return ip;
}

function acceptBrowserWs(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return false;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`
  );
  return true;
}

function connectIphoneWs(ip, port, pathName, cb) {
  const upstream = net.createConnection({ host: ip, port });
  const key = crypto.randomBytes(16).toString("base64");
  let buf = Buffer.alloc(0);
  upstream.on("connect", () => {
    upstream.write(
      `GET ${pathName || "/"} HTTP/1.1\r\n` +
      `Host: ${ip}:${port}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${key}\r\n` +
      "Sec-WebSocket-Version: 13\r\n\r\n"
    );
  });
  upstream.on("data", function onHandshake(chunk) {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf("\r\n\r\n");
    if (idx < 0) return;
    const head = buf.subarray(0, idx).toString("latin1");
    upstream.off("data", onHandshake);
    if (!head.includes("101")) {
      upstream.destroy();
      cb(new Error(`iPhone ws handshake failed: ${head.split("\r\n")[0]}`));
      return;
    }
    cb(null, upstream, buf.subarray(idx + 4));
  });
  upstream.on("error", err => cb(err));
}

function bridgeWebSocket(req, socket, head, targetPort, label) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ip = safeIphoneIp(url.searchParams.get("ip"));
  if (!acceptBrowserWs(req, socket)) return;
  connectIphoneWs(ip, targetPort, "/", (err, upstream, rest) => {
    if (err) {
      console.error(`${label} upstream error ${err.message}`);
      socket.destroy();
      return;
    }
    console.log(`${label} connected ${ip}:${targetPort}`);
    if (head && head.length) upstream.write(head);
    if (rest && rest.length) socket.write(rest);
    socket.pipe(upstream);
    upstream.pipe(socket);
    const closeBoth = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on("error", closeBoth);
    upstream.on("error", closeBoth);
    socket.on("close", closeBoth);
    upstream.on("close", closeBoth);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/send" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const r = room(String(body.room || "default"));
      const to = body.to === "device" ? "device" : "controller";
      r[to].push({ type: body.type, data: body.data, t: Date.now() });
      r.updated = Date.now();
      console.log(`signal send room=${String(body.room || "default")} to=${to} type=${body.type} q=${r[to].length}`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/poll" && req.method === "GET") {
      const id = String(url.searchParams.get("room") || "default");
      const role = url.searchParams.get("role") === "device" ? "device" : "controller";
      const r = room(id);
      const q = r[role];
      r[role] = [];
      if (q.length) console.log(`signal poll room=${id} role=${role} got=${q.map(m => m.type).join(",")}`);
      sendJson(res, 200, { ok: true, messages: q });
      return;
    }

    if (url.pathname === "/api/reset" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const id = String(body.room || "default");
      rooms.set(id, { controller: [], device: [], updated: Date.now() });
      console.log(`signal reset room=${id}`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, rooms: rooms.size });
      return;
    }

    if (url.pathname === "/api/ice-servers") {
      sendJson(res, 200, { ok: true, iceServers: await getIceServers() });
      return;
    }

    if (url.pathname === "/screen-size") {
      const ip = safeIphoneIp(url.searchParams.get("ip"));
      const upstream = await fetch(`http://${ip}:58586/screenSize?_=${Date.now()}`, { cache: "no-store" });
      const text = await upstream.text();
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(text);
      return;
    }

    serveStatic(req, res);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(port, host, () => {
  console.log(`webrtc-relay listening on http://${host}:${port}`);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/h264") {
    bridgeWebSocket(req, socket, head, 58588, "h264");
    return;
  }
  if (url.pathname === "/control-ws") {
    bridgeWebSocket(req, socket, head, 58587, "control");
    return;
  }
  socket.destroy();
});
