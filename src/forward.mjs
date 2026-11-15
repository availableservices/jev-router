import http from "node:http";
import https from "node:https";
import { debug } from "./log.mjs";

/**
 * Sends `body` on to `target` as the same request `req` made, and hands the upstream response to
 * `onResponse`. Both proxies forward this way, so cancellation and failure handling live here.
 *
 * @param {string} input.target     upstream base URL; its path prefix is kept
 * @param {object} input.headers    headers to send (host and content-length are set here)
 * @param {(message: string) => object} input.errorBody  JSON body for a 502, in the CLI's own shape
 */
export function forward({ target, req, res, headers, body, onResponse, errorBody }) {
  const url = new URL(target);
  const transport = url.protocol === "http:" ? http : https;
  const { "content-length": _dropped, ...rest } = headers;
  const upstream = transport.request(
    {
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname.replace(/\/$/, "")}${req.url}`,
      method: req.method,
      headers: { ...rest, host: url.host },
    },
    onResponse,
  );
  // Esc in the CLI drops the client connection: stop the upstream request too, or the API keeps
  // generating (and billing) a response nobody is reading.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  upstream.on("error", (err) => {
    if (res.destroyed) return;
    debug(`upstream error: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify(errorBody(err.message)));
  });
  if (body.length) upstream.write(body);
  upstream.end();
}
