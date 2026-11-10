/* global fetch, AbortController, setTimeout, clearTimeout, Buffer */
// Live HTTP + SSE transport for the fake phones (phone-load.mjs). Only ever 127.0.0.1: the base url is built by the
// tool from its own --port, never from input. Streams reconnect like the apps: config streams after a fixed 5 s
// (rider api_rider_config_repository.dart:67, driver live_driver_config.dart:67), the offer and trip streams with
// 1, 2, 4 … 30 s (driver api_dispatch_repository.dart:332, api_driver_realtime.dart:79-80).
import { randomUUID } from "node:crypto";

export function httpTransport(port, counter, { timeoutMs = 10_000 } = {}) {
  const base = `http://127.0.0.1:${Number(port)}/api/v1`;
  return {
    async request(method, path, body, token, key) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const headers = { accept: "application/json" };
        if (token) headers.authorization = `Bearer ${token}`;
        if (body !== undefined) headers["content-type"] = "application/json";
        // The same Idempotency-Key when the app sends a request again (after a refresh or a lost answer).
        if (method !== "GET") headers["idempotency-key"] = key ?? `load-${randomUUID()}`;
        const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
        const json = await r.json().catch(() => null);
        return { status: r.status, json };
      } catch {
        return { status: 0, json: null };
      } finally {
        clearTimeout(timer);
      }
    },
    stream(path, auth, onEvent) {
      let closed = false;
      let ctl = null;
      let attempt = 0;
      const fixed = path.endsWith("/config/stream");
      const loop = async () => {
        while (!closed) {
          ctl = new AbortController();
          try {
            const r = await fetch(base + path, { headers: { authorization: `Bearer ${auth.access}`, accept: "text/event-stream" }, signal: ctl.signal });
            counter.bump("streams.opened");
            if (r.status === 401 && (await auth.refreshOnce())) continue;
            if (r.ok && r.body) {
              attempt = 0;
              let buf = "";
              for await (const chunk of r.body) {
                buf += Buffer.from(chunk).toString();
                let i;
                while ((i = buf.indexOf("\n\n")) >= 0) {
                  const block = buf.slice(0, i);
                  buf = buf.slice(i + 2);
                  const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("\n");
                  if (!data) continue;
                  try {
                    onEvent(JSON.parse(data));
                  } catch {
                    counter.bump("streams.badEvent");
                  }
                }
              }
            } else counter.bump(`streams.refused.${r.status}`);
          } catch {
            /* closed by us, or the connection dropped: reconnect below */
          }
          if (closed) break;
          counter.bump("streams.reconnect");
          const wait = fixed ? 5_000 : Math.min(30_000, 1_000 * 2 ** attempt++);
          await new Promise((res) => setTimeout(res, wait));
        }
      };
      void loop();
      return {
        close() {
          closed = true;
          ctl?.abort();
        },
      };
    },
  };
}
