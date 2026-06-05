const http = require("http");
const https = require("https");
const net = require("net");

function parseHostPort(input, fallbackPort = 25565) {
  const raw = String(input || "").trim();

  if (!raw) {
    throw new Error("No address supplied");
  }

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    return {
      protocol: url.protocol.replace(":", ""),
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      path: `${url.pathname || "/"}${url.search || ""}`,
      raw,
    };
  }

  if (raw.startsWith("[")) {
    const closing = raw.indexOf("]");
    if (closing !== -1) {
      const host = raw.slice(1, closing);
      const remainder = raw.slice(closing + 1);
      const port = remainder.startsWith(":") ? Number(remainder.slice(1)) : fallbackPort;
      return {
        protocol: "tcp",
        host,
        port: Number.isFinite(port) && port > 0 ? port : fallbackPort,
        path: "/",
        raw,
      };
    }
  }

  const separator = raw.lastIndexOf(":");
  if (separator > -1 && raw.indexOf(":") === separator) {
    const maybePort = Number(raw.slice(separator + 1));
    if (Number.isFinite(maybePort) && maybePort > 0) {
      return {
        protocol: "tcp",
        host: raw.slice(0, separator),
        port: maybePort,
        path: "/",
        raw,
      };
    }
  }

  return {
    protocol: "tcp",
    host: raw,
    port: fallbackPort,
    path: "/",
    raw,
  };
}

function probeTcp(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host, port });

    const finish = (ok, message) => {
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch (error) {
        // Ignore shutdown noise.
      }

      resolve({
        ok,
        latencyMs: Date.now() - startedAt,
        message,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true, `Connected to ${host}:${port}`));
    socket.on("timeout", () => finish(false, `Timed out connecting to ${host}:${port}`));
    socket.on("error", (error) => finish(false, error.message));
  });
}

function probeHttp(urlInfo, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const client = urlInfo.protocol === "https" ? https : http;
    const request = client.request(
      {
        method: "GET",
        hostname: urlInfo.host,
        port: urlInfo.port,
        path: urlInfo.path || "/",
        timeout: timeoutMs,
        rejectUnauthorized: false,
      },
      (response) => {
        response.resume();
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 500,
          latencyMs: Date.now() - startedAt,
          message: `HTTP ${response.statusCode}`,
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error(`Timed out loading ${urlInfo.raw}`));
    });

    request.on("error", (error) => {
      resolve({
        ok: false,
        latencyMs: Date.now() - startedAt,
        message: error.message,
      });
    });

    request.end();
  });
}

async function probeAddress(address, protocol = "tcp", fallbackPort = 25565, timeoutMs = 2500) {
  if (!address) {
    return {
      ok: false,
      mode: protocol,
      message: "No public address configured",
      latencyMs: 0,
    };
  }

  const parsed = parseHostPort(address, fallbackPort);
  const mode = String(protocol || parsed.protocol || "tcp").toLowerCase();

  if (mode === "http" || mode === "https" || parsed.protocol === "http" || parsed.protocol === "https") {
    const httpInfo = {
      protocol: mode === "https" ? "https" : parsed.protocol === "https" ? "https" : "http",
      host: parsed.host,
      port: parsed.port || (mode === "https" ? 443 : 80),
      path: parsed.path,
      raw: parsed.raw,
    };

    return {
      ...(await probeHttp(httpInfo, timeoutMs)),
      mode: httpInfo.protocol,
    };
  }

  return {
    ...(await probeTcp(parsed.host, parsed.port || fallbackPort, timeoutMs)),
    mode: "tcp",
  };
}

module.exports = {
  parseHostPort,
  probeAddress,
};
