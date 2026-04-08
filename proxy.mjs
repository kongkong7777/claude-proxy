#!/usr/bin/env node
/**
 * OpenClaw Sanitize Proxy
 *
 * Transparent reverse proxy that sits between Nginx and CLIProxyAPI.
 * - Claude models: bidirectional text sanitization (outbound obfuscate, inbound restore)
 * - Other models (GPT, Gemini, etc.): passthrough without modification
 *
 * Zero dependencies. Pure Node.js http module.
 */

import http from "http";

const LISTEN_PORT = parseInt(process.env.SANITIZE_PORT || "18802", 10);
const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || "18801", 10);

// ─── Sanitization Rules ─────────────────────────────────────────────────────
// Outbound: replace platform identifiers with opaque codes
// IMPORTANT: longer strings MUST come before shorter ones (prevents partial match)
// IMPORTANT: lowercase replacements must be path-safe (no spaces)
const SANITIZE_OUT = [
  // Tool names (longest first)
  ["sessions_yield_interrupt", "t_a05"],
  ["sessions_spawn", "t_a01"],
  ["sessions_list", "t_a02"],
  ["sessions_history", "t_a03"],
  ["sessions_send", "t_a04"],
  ["sessions_yield", "t_a06"],
  ["sessions_store", "t_a07"],
  // Brand names
  ["OpenClaw", "Xp7m"],
  ["openclaw", "xp7m"],
  ["Clawdbot", "Xb2k"],
  ["clawdbot", "xb2k"],
  ["ClawHub", "Kh3r"],
  ["clawhub", "kh3r"],
  // Signals & commands
  ["HEARTBEAT_OK", "SG_b01"],
  ["oc-tool", "xt-cmd"],
  ["SOUL.md", "INST.md"],
  // Phrases
  ["running inside", "operating within"],
  // URLs (OpenClaw)
  ["gateway.openclaw.ai", "endpoint.local"],
  ["docs.openclaw.ai", "docs.local"],
  ["discord.gg/clawd", ""],
  // ─── LobeChat / LobeHub ───
  // Brand names
  ["LobeChat", "Lc8n"],
  ["lobechat", "lc8n"],
  ["LobeHub", "Lh9k"],
  ["lobehub", "lh9k"],
  ["Lobe", "Lb4x"],
  ["lobe", "lb4x"],
  // Tool names (lobe-gtd system)
  ["lobe-gtd___createPlan___builtin", "t_b01"],
  ["lobe-gtd___updatePlan___builtin", "t_b02"],
  ["lobe-gtd___createTodos___builtin", "t_b03"],
  ["lobe-gtd___updateTodos___builtin", "t_b04"],
  ["lobe-gtd___completeTodos___builtin", "t_b05"],
  ["lobe-gtd___removeTodos___builtin", "t_b06"],
  ["lobe-gtd___clearTodos___builtin", "t_b07"],
  ["lobe-gtd___execTask___builtin", "t_b08"],
  ["lobe-gtd___execTasks___builtin", "t_b09"],
  // Tool names (lobe-notebook system)
  ["lobe-notebook___createDocument___builtin", "t_c01"],
  ["lobe-notebook___updateDocument___builtin", "t_c02"],
  ["lobe-notebook___getDocument___builtin", "t_c03"],
  ["lobe-notebook___deleteDocument___builtin", "t_c04"],
  // Generic lobe tool prefixes
  ["lobe-gtd", "xt-gtd"],
  ["lobe-notebook", "xt-note"],
  // ─── NextChat / ChatGPT-Next-Web ───
  ["ChatGPT-Next-Web", "Nw5j"],
  ["NextChat", "Nc6m"],
  ["nextchat", "nc6m"],
];

// Inbound: reverse mapping (skip deletions)
const SANITIZE_IN = SANITIZE_OUT
  .filter(([, v]) => v !== "")
  .map(([k, v]) => [v, k]);

// Metadata tag regex
const META_TAG_RE = /\[openclaw:[^\]]*\]|\[lobechat:[^\]]*\]|\[lobe:[^\]]*\]/g;
const VERSION_RE = /v2026\.\d+\.\d+/g;

function sanitizeOutbound(text) {
  let r = text;
  r = r.replace(META_TAG_RE, "");
  r = r.replace(VERSION_RE, "");
  for (const [find, replace] of SANITIZE_OUT) {
    r = r.split(find).join(replace);
  }
  return r;
}

function sanitizeInbound(text) {
  let r = text;
  for (const [find, replace] of SANITIZE_IN) {
    r = r.split(find).join(replace);
  }
  return r;
}

function isClaudeModel(body) {
  try {
    const match = body.match(/"model"\s*:\s*"([^"]+)"/);
    return match && match[1].toLowerCase().includes("claude");
  } catch {
    return false;
  }
}

// ─── Proxy Server ───────────────────────────────────────────────────────────
const server = http.createServer((clientReq, clientRes) => {
  let requestBody = [];

  clientReq.on("data", (chunk) => requestBody.push(chunk));

  clientReq.on("end", () => {
    let bodyStr = Buffer.concat(requestBody).toString();
    const needsSanitize = isClaudeModel(bodyStr);

    // Outbound: sanitize request body for Claude models
    if (needsSanitize && bodyStr.length > 0) {
      bodyStr = sanitizeOutbound(bodyStr);
    }

    const bodyBuf = Buffer.from(bodyStr);

    // Forward to CLIProxyAPI
    const proxyReq = http.request(
      {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: clientReq.url,
        method: clientReq.method,
        headers: {
          ...clientReq.headers,
          host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
          "content-length": bodyBuf.length,
        },
      },
      (proxyRes) => {
        const isSSE = (proxyRes.headers["content-type"] || "").includes("text/event-stream");

        // Copy response headers
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);

        if (!needsSanitize) {
          // Non-Claude: pipe through directly
          proxyRes.pipe(clientRes);
          return;
        }

        if (isSSE) {
          // SSE streaming: sanitize each chunk
          proxyRes.on("data", (chunk) => {
            const text = chunk.toString();
            clientRes.write(sanitizeInbound(text));
          });
          proxyRes.on("end", () => clientRes.end());
        } else {
          // Buffered response: collect, sanitize, send
          let respBody = [];
          proxyRes.on("data", (chunk) => respBody.push(chunk));
          proxyRes.on("end", () => {
            let respStr = Buffer.concat(respBody).toString();
            respStr = sanitizeInbound(respStr);
            clientRes.end(respStr);
          });
        }
      }
    );

    proxyReq.on("error", (err) => {
      console.error(`[Proxy] Upstream error: ${err.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "application/json" });
      }
      clientRes.end(JSON.stringify({ error: { message: `Upstream error: ${err.message}` } }));
    });

    // Set upstream timeout
    proxyReq.setTimeout(600000, () => {
      proxyReq.destroy(new Error("Upstream timeout"));
    });

    proxyReq.write(bodyBuf);
    proxyReq.end();
  });

  clientReq.on("error", (err) => {
    console.error(`[Proxy] Client error: ${err.message}`);
  });
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`[Sanitize Proxy] Listening on 127.0.0.1:${LISTEN_PORT}`);
  console.log(`[Sanitize Proxy] Upstream: ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  console.log(`[Sanitize Proxy] Claude models: sanitize | Others: passthrough`);
});
