const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

const { COOKIE_NAME, createSession, hashPassword, parseCookies, sanitizeUser, serializeCookie, verifyPassword } = require("./src/lib/auth");
const { ensureDirSync, readJsonSync, writeJsonSync } = require("./src/lib/json-store");
const { resolveInside, toDisplayPath } = require("./src/lib/path-utils");
const { probeAddress } = require("./src/lib/probe");
const { ProcessManager } = require("./src/lib/process-manager");

const ROOT_DIR = __dirname;
const DATA_DIR = process.env.USP_DATA_DIR ? path.resolve(process.env.USP_DATA_DIR) : path.join(ROOT_DIR, "data");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const SERVERS_FILE = path.join(DATA_DIR, "servers.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const SERVER_KEY_PREFIX = "server:";
const PLAYIT_AGENT_KEY = "playit-agent";
const DEFAULT_PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

ensureDirSync(DATA_DIR);
ensureDirSync(PUBLIC_DIR);

function defaultSettings() {
  return {
    siteName: "Untitled Server Panel",
    subtitle: "Local Minecraft server control with monochrome swagger",
    allowRegistration: true,
    playitAgent: {
      enabled: false,
      command: "",
      workingDirectory: "",
      note: "",
    },
  };
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeUser(user) {
  if (!user || typeof user !== "object") {
    return null;
  }

  const username = String(user.username || "").trim();
  const normalized = {
    id: user.id || createId("user"),
    username,
    usernameLower: user.usernameLower || username.toLowerCase(),
    role: user.role === "admin" ? "admin" : "user",
    createdAt: user.createdAt || new Date().toISOString(),
    updatedAt: user.updatedAt || user.createdAt || new Date().toISOString(),
    passwordHash: user.passwordHash || "",
  };

  return normalized;
}

function normalizeSession(session) {
  if (!session || typeof session !== "object") {
    return null;
  }

  return {
    token: session.token || createId("sid"),
    userId: session.userId || "",
    createdAt: session.createdAt || new Date().toISOString(),
    expiresAt: session.expiresAt || new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString(),
  };
}

function normalizeServer(server) {
  if (!server || typeof server !== "object") {
    return null;
  }

  const playit = server.playit || {};
  const directory = path.resolve(String(server.directory || ROOT_DIR));
  const createdAt = server.createdAt || new Date().toISOString();
  const updatedAt = server.updatedAt || createdAt;

  return {
    id: server.id || createId("srv"),
    name: String(server.name || "Minecraft Server").trim(),
    directory,
    startCommand: String(server.startCommand || "java -jar server.jar nogui").trim(),
    stopCommand: String(server.stopCommand || "stop").trim(),
    publicListing: Boolean(server.publicListing),
    notes: String(server.notes || "").trim(),
    playit: {
      enabled: Boolean(playit.enabled),
      publicAddress: String(playit.publicAddress || "").trim(),
      protocol: String(playit.protocol || "tcp").toLowerCase(),
      fallbackPort: Number.isFinite(Number(playit.fallbackPort)) ? Number(playit.fallbackPort) : 25565,
      label: String(playit.label || "").trim(),
      note: String(playit.note || "").trim(),
      lastProbeAt: playit.lastProbeAt || null,
      lastProbeOk: typeof playit.lastProbeOk === "boolean" ? playit.lastProbeOk : null,
      lastProbeMessage: String(playit.lastProbeMessage || "").trim(),
      lastProbeLatencyMs: Number.isFinite(Number(playit.lastProbeLatencyMs)) ? Number(playit.lastProbeLatencyMs) : null,
    },
    createdAt,
    updatedAt,
  };
}

function normalizeSettings(settings) {
  const base = defaultSettings();
  const input = settings && typeof settings === "object" ? settings : {};
  const playitAgent = {
    ...base.playitAgent,
    ...(input.playitAgent && typeof input.playitAgent === "object" ? input.playitAgent : {}),
  };

  return {
    ...base,
    ...input,
    playitAgent,
  };
}

let users = readJsonSync(USERS_FILE, []);
let sessions = readJsonSync(SESSIONS_FILE, []);
let servers = readJsonSync(SERVERS_FILE, []);
let settings = normalizeSettings(readJsonSync(SETTINGS_FILE, defaultSettings()));

users = users.map(normalizeUser).filter(Boolean);
sessions = sessions.map(normalizeSession).filter(Boolean);
servers = servers.map(normalizeServer).filter(Boolean);

function persistUsers() {
  writeJsonSync(USERS_FILE, users);
}

function persistSessions() {
  writeJsonSync(SESSIONS_FILE, sessions);
}

function persistServers() {
  writeJsonSync(SERVERS_FILE, servers);
}

function persistSettings() {
  writeJsonSync(SETTINGS_FILE, settings);
}

function persistAll() {
  persistUsers();
  persistSessions();
  persistServers();
  persistSettings();
}

persistAll();

const userById = new Map();
const serverById = new Map();
const sessionByToken = new Map();

function rebuildIndexes() {
  userById.clear();
  serverById.clear();
  sessionByToken.clear();

  for (const user of users) {
    userById.set(user.id, user);
  }

  for (const server of servers) {
    serverById.set(server.id, server);
  }

  for (const session of sessions) {
    sessionByToken.set(session.token, session);
  }
}

rebuildIndexes();

const processManager = new ProcessManager();
const streamSubscribers = new Map();
const probeLocks = new Map();
let startedInfo = null;
let pruneInterval = null;
let probeInterval = null;

function serviceKeyForServer(serverId) {
  return `${SERVER_KEY_PREFIX}${serverId}`;
}

function pruneExpiredSessions() {
  const now = Date.now();
  const before = sessions.length;
  sessions = sessions.filter((session) => {
    const expiresAt = Date.parse(session.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > now;
  });

  if (sessions.length !== before) {
    persistSessions();
    rebuildIndexes();
  }
}

function findSessionFromRequest(req) {
  pruneExpiredSessions();

  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[COOKIE_NAME];
  if (!token) {
    return null;
  }

  const session = sessionByToken.get(token);
  if (!session) {
    return null;
  }

  const expiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return null;
  }

  const user = userById.get(session.userId);
  if (!user) {
    return null;
  }

  return {
    session,
    user,
  };
}

function getCurrentUser(req) {
  const found = findSessionFromRequest(req);
  return found ? sanitizeUser(found.user) : null;
}

function requireAuth(req, res) {
  const currentUser = getCurrentUser(req);
  if (!currentUser) {
    sendJson(res, 401, { error: "Authentication required" });
    return null;
  }

  return currentUser;
}

function requireAdmin(req, res) {
  const currentUser = requireAuth(req, res);
  if (!currentUser) {
    return null;
  }

  if (currentUser.role !== "admin") {
    sendJson(res, 403, { error: "Admin access required" });
    return null;
  }

  return currentUser;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
      if (chunks.reduce((sum, piece) => sum + piece.length, 0) > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(text);
}

function serveAsset(res, filePath, contentType) {
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(content);
}

function getRequestBaseUrl(req) {
  const host = req.headers.host || `${HOST}:${DEFAULT_PORT}`;
  return `http://${host}`;
}

function uuidLike(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function validateUsername(username) {
  const trimmed = String(username || "").trim();
  if (trimmed.length < 3 || trimmed.length > 24) {
    return "Username must be between 3 and 24 characters";
  }

  if (!/^[a-zA-Z0-9_ -]+$/.test(trimmed)) {
    return "Username can only contain letters, numbers, spaces, underscores, and dashes";
  }

  return null;
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 6) {
    return "Password must be at least 6 characters";
  }

  return null;
}

function getUserByUsername(username) {
  const lookup = String(username || "").trim().toLowerCase();
  return users.find((user) => user.usernameLower === lookup) || null;
}

function upsertServer(updatedServer) {
  const normalized = normalizeServer(updatedServer);
  const index = servers.findIndex((server) => server.id === normalized.id);

  if (index === -1) {
    servers.push(normalized);
  } else {
    servers[index] = normalized;
  }

  serverById.set(normalized.id, normalized);
  persistServers();
  return normalized;
}

function upsertUser(updatedUser) {
  const normalized = normalizeUser(updatedUser);
  const index = users.findIndex((user) => user.id === normalized.id);

  if (index === -1) {
    users.push(normalized);
  } else {
    users[index] = normalized;
  }

  userById.set(normalized.id, normalized);
  persistUsers();
  return normalized;
}

function createSessionAndCookie(res, userId) {
  const session = createSession(userId);
  sessions.push(normalizeSession(session));
  persistSessions();
  rebuildIndexes();

  const cookie = serializeCookie(COOKIE_NAME, session.token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
  });

  res.setHeader("Set-Cookie", cookie);
}

function clearSessionCookie(res, req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[COOKIE_NAME];
  if (token) {
    sessions = sessions.filter((session) => session.token !== token);
    persistSessions();
    rebuildIndexes();
  }

  res.setHeader(
    "Set-Cookie",
    serializeCookie(COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 0,
    })
  );
}

function sanitizeServerForAdmin(server) {
  const runtime = processManager.getSnapshot(serviceKeyForServer(server.id));
  return {
    id: server.id,
    name: server.name,
    directory: server.directory,
    directoryLabel: path.basename(server.directory) || server.directory,
    startCommand: server.startCommand,
    stopCommand: server.stopCommand,
    publicListing: server.publicListing,
    notes: server.notes,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    running: runtime.running,
    pid: runtime.pid,
    startedAt: runtime.startedAt,
    finishedAt: runtime.finishedAt,
    exitCode: runtime.exitCode,
    exitSignal: runtime.exitSignal,
    logs: runtime.lines.slice(-50),
    playit: {
      ...server.playit,
      reachable: Boolean(server.playit.lastProbeOk),
    },
  };
}

function sanitizeServerForPublic(server) {
  if (!server.publicListing) {
    return null;
  }

  const runtime = processManager.getSnapshot(serviceKeyForServer(server.id));
  return {
    id: server.id,
    name: server.name,
    notes: server.notes,
    running: runtime.running,
    playit: {
      enabled: server.playit.enabled,
      publicAddress: server.playit.publicAddress,
      protocol: server.playit.protocol,
      reachable: Boolean(server.playit.lastProbeOk),
      message: server.playit.lastProbeMessage,
      latencyMs: server.playit.lastProbeLatencyMs,
      lastProbeAt: server.playit.lastProbeAt,
    },
  };
}

function buildSummary() {
  const serverSnapshots = servers.map((server) => ({
    id: server.id,
    running: processManager.getSnapshot(serviceKeyForServer(server.id)).running,
    playitEnabled: server.playit.enabled,
    playitReachable: Boolean(server.playit.lastProbeOk),
  }));

  const runningServers = serverSnapshots.filter((item) => item.running).length;
  const publicServers = servers.filter((server) => server.publicListing).length;

  return {
    siteName: settings.siteName,
    subtitle: settings.subtitle,
    allowRegistration: settings.allowRegistration,
    totalServers: servers.length,
    runningServers,
    publicServers,
    totalUsers: users.length,
    adminUsers: users.filter((user) => user.role === "admin").length,
    playitAgent: processManager.getSnapshot(PLAYIT_AGENT_KEY),
    serverSnapshots,
    memory: {
      rss: process.memoryUsage().rss,
      heapUsed: process.memoryUsage().heapUsed,
    },
    uptime: process.uptime(),
  };
}

function buildPublicOverview() {
  return {
    siteName: settings.siteName,
    subtitle: settings.subtitle,
    allowRegistration: settings.allowRegistration,
    servers: servers.map(sanitizeServerForPublic).filter(Boolean),
  };
}

function buildBootstrapPayload(currentUser) {
  const payload = {
    me: currentUser ? sanitizeUser(currentUser) : null,
    summary: buildSummary(),
    publicOverview: buildPublicOverview(),
    settings: {
      siteName: settings.siteName,
      subtitle: settings.subtitle,
      allowRegistration: settings.allowRegistration,
    },
  };

  if (currentUser && currentUser.role === "admin") {
    payload.servers = servers.map(sanitizeServerForAdmin);
    payload.users = users.map(sanitizeUser);
    payload.playitAgent = {
      settings: {
        ...settings.playitAgent,
      },
      runtime: processManager.getSnapshot(PLAYIT_AGENT_KEY),
    };
  }

  return payload;
}

function createSseConnection(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("\n");

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25000);

  const close = () => {
    clearInterval(heartbeat);
    try {
      res.end();
    } catch (error) {
      // Ignore closed sockets.
    }
  };

  return close;
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function subscribeStream(key, res) {
  if (!streamSubscribers.has(key)) {
    streamSubscribers.set(key, new Set());
  }

  const bucket = streamSubscribers.get(key);
  bucket.add(res);
  res.on("close", () => {
    bucket.delete(res);
  });
}

function emitToStream(key, event, data) {
  const bucket = streamSubscribers.get(key);
  if (!bucket || !bucket.size) {
    return;
  }

  for (const res of bucket) {
    try {
      sseSend(res, event, data);
    } catch (error) {
      bucket.delete(res);
    }
  }
}

function emitGlobalState(reason = "state") {
  emitToStream("global", "state", {
    reason,
    timestamp: new Date().toISOString(),
  });
}

function emitServerState(serverId, reason = "state") {
  emitToStream(serviceKeyForServer(serverId), "state", {
    reason,
    timestamp: new Date().toISOString(),
  });
}

function emitPlayitAgentState(reason = "state") {
  emitToStream(PLAYIT_AGENT_KEY, "state", {
    reason,
    timestamp: new Date().toISOString(),
  });
}

processManager.on("log", ({ key, entry }) => {
  emitToStream(key, "log", entry);
});

processManager.on("change", ({ key }) => {
  if (key === PLAYIT_AGENT_KEY) {
    emitPlayitAgentState("process-change");
  } else if (key.startsWith(SERVER_KEY_PREFIX)) {
    emitServerState(key.slice(SERVER_KEY_PREFIX.length), "process-change");
  }
  emitGlobalState("process-change");
});

async function refreshServerPlayit(server, options = {}) {
  if (!server || !server.playit || !server.playit.enabled) {
    server.playit.lastProbeAt = new Date().toISOString();
    server.playit.lastProbeOk = false;
    server.playit.lastProbeMessage = "Playit disabled";
    server.playit.lastProbeLatencyMs = 0;
    server.updatedAt = new Date().toISOString();
    persistServers();
    emitServerState(server.id, "playit-disabled");
    emitGlobalState("playit-disabled");
    return {
      ok: false,
      message: "Playit disabled",
    };
  }

  if (!server.playit.publicAddress) {
    server.playit.lastProbeAt = new Date().toISOString();
    server.playit.lastProbeOk = false;
    server.playit.lastProbeMessage = "No public address configured";
    server.playit.lastProbeLatencyMs = 0;
    server.updatedAt = new Date().toISOString();
    persistServers();
    emitServerState(server.id, "playit-missing-address");
    emitGlobalState("playit-missing-address");
    return {
      ok: false,
      message: "No public address configured",
    };
  }

  const lockKey = server.id;
  if (probeLocks.has(lockKey)) {
    return probeLocks.get(lockKey);
  }

  const promise = (async () => {
    const result = await probeAddress(server.playit.publicAddress, server.playit.protocol, server.playit.fallbackPort, options.timeoutMs || 2500);
    server.playit.lastProbeAt = new Date().toISOString();
    server.playit.lastProbeOk = Boolean(result.ok);
    server.playit.lastProbeMessage = result.message;
    server.playit.lastProbeLatencyMs = Number.isFinite(result.latencyMs) ? result.latencyMs : null;
    server.updatedAt = new Date().toISOString();
    persistServers();
    emitServerState(server.id, "playit-probe");
    emitGlobalState("playit-probe");
    return result;
  })()
    .catch((error) => {
      server.playit.lastProbeAt = new Date().toISOString();
      server.playit.lastProbeOk = false;
      server.playit.lastProbeMessage = error.message;
      server.playit.lastProbeLatencyMs = null;
      server.updatedAt = new Date().toISOString();
      persistServers();
      emitServerState(server.id, "playit-probe-error");
      emitGlobalState("playit-probe-error");
      return {
        ok: false,
        message: error.message,
      };
    })
    .finally(() => {
      probeLocks.delete(lockKey);
    });

  probeLocks.set(lockKey, promise);
  return promise;
}

async function refreshAllPlayitProbes() {
  const activeServers = servers.filter((server) => server.playit.enabled && server.playit.publicAddress);
  for (const server of activeServers) {
    // Run probes sequentially to keep local network usage gentle.
    // We intentionally await each one.
    // eslint-disable-next-line no-await-in-loop
    await refreshServerPlayit(server);
  }
}

function getServerOrThrow(serverId) {
  const server = serverById.get(serverId);
  if (!server) {
    throw Object.assign(new Error("Server not found"), { statusCode: 404 });
  }

  return server;
}

function getUserOrThrow(userId) {
  const user = userById.get(userId);
  if (!user) {
    throw Object.assign(new Error("User not found"), { statusCode: 404 });
  }

  return user;
}

function readDirectoryEntries(rootDirectory, relativePath = ".") {
  const absoluteDirectory = resolveInside(rootDirectory, relativePath);
  const stats = fs.statSync(absoluteDirectory);
  if (!stats.isDirectory()) {
    throw Object.assign(new Error("Path is not a directory"), { statusCode: 400 });
  }

  const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true }).map((entry) => {
    const entryPath = path.join(absoluteDirectory, entry.name);
    const entryStats = fs.statSync(entryPath);
    return {
      name: entry.name,
      path: toDisplayPath(rootDirectory, entryPath),
      isDirectory: entry.isDirectory(),
      size: entryStats.size,
      modifiedAt: entryStats.mtime.toISOString(),
    };
  });

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
  });

  return {
    path: toDisplayPath(rootDirectory, absoluteDirectory),
    entries,
  };
}

function readTextFile(rootDirectory, relativePath) {
  const absolutePath = resolveInside(rootDirectory, relativePath);
  const stats = fs.statSync(absolutePath);
  if (!stats.isFile()) {
    throw Object.assign(new Error("Path is not a file"), { statusCode: 400 });
  }

  if (stats.size > 1024 * 1024) {
    throw Object.assign(new Error("File is too large to edit in the browser"), { statusCode: 413 });
  }

  return {
    path: toDisplayPath(rootDirectory, absolutePath),
    content: fs.readFileSync(absolutePath, "utf8"),
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };
}

function writeTextFile(rootDirectory, relativePath, content) {
  const absolutePath = resolveInside(rootDirectory, relativePath);
  ensureDirSync(path.dirname(absolutePath));
  fs.writeFileSync(absolutePath, String(content ?? ""), "utf8");
  return readTextFile(rootDirectory, relativePath);
}

async function handleAuthRegister(req, res) {
  const body = await readBody(req);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  const usernameError = validateUsername(username);
  if (usernameError) {
    sendJson(res, 400, { error: usernameError });
    return;
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    sendJson(res, 400, { error: passwordError });
    return;
  }

  if (!settings.allowRegistration && users.length > 0) {
    sendJson(res, 403, { error: "Registration is currently disabled" });
    return;
  }

  if (getUserByUsername(username)) {
    sendJson(res, 409, { error: "Username already exists" });
    return;
  }

  const hashed = hashPassword(password);
  const user = upsertUser({
    id: createId("user"),
    username,
    usernameLower: username.toLowerCase(),
    role: users.length === 0 ? "admin" : "user",
    passwordHash: hashed.value,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  createSessionAndCookie(res, user.id);
  emitGlobalState("auth-register");
  sendJson(res, 201, { user: sanitizeUser(user) });
}

async function handleAuthLogin(req, res) {
  const body = await readBody(req);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const user = getUserByUsername(username);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    sendJson(res, 401, { error: "Invalid username or password" });
    return;
  }

  createSessionAndCookie(res, user.id);
  sendJson(res, 200, { user: sanitizeUser(user) });
}

function handleAuthLogout(req, res) {
  clearSessionCookie(res, req);
  sendJson(res, 200, { ok: true });
}

function handleBootstrap(req, res) {
  const currentUser = getCurrentUser(req);
  sendJson(res, 200, buildBootstrapPayload(currentUser));
}

function handlePublicOverview(req, res) {
  sendJson(res, 200, buildPublicOverview());
}

function handleSummary(req, res) {
  const currentUser = getCurrentUser(req);
  if (!currentUser) {
    sendJson(res, 401, { error: "Authentication required" });
    return;
  }

  if (currentUser.role !== "admin") {
    sendJson(res, 403, { error: "Admin access required" });
    return;
  }

  sendJson(res, 200, buildSummary());
}

function handleUsersList(req, res) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  sendJson(res, 200, {
    users: users.map(sanitizeUser),
  });
}

async function handleUsersPatch(req, res, userId) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const target = getUserOrThrow(userId);
  const body = await readBody(req);
  const role = body.role === "admin" ? "admin" : "user";

  if (target.id === currentUser.id && role !== "admin") {
    sendJson(res, 400, { error: "You cannot remove your own admin role" });
    return;
  }

  target.role = role;
  target.updatedAt = new Date().toISOString();
  upsertUser(target);
  emitGlobalState("users-updated");
  sendJson(res, 200, { user: sanitizeUser(target) });
}

function handleServersList(req, res) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  sendJson(res, 200, {
    servers: servers.map(sanitizeServerForAdmin),
  });
}

async function handleServersCreate(req, res) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const body = await readBody(req);
  const name = String(body.name || "").trim();
  const directoryInput = String(body.directory || "").trim();
  const startCommand = String(body.startCommand || "java -jar server.jar nogui").trim();
  const stopCommand = String(body.stopCommand || "stop").trim();
  const publicListing = Boolean(body.publicListing);
  const notes = String(body.notes || "").trim();
  const playit = body.playit && typeof body.playit === "object" ? body.playit : {};

  if (!name) {
    sendJson(res, 400, { error: "Server name is required" });
    return;
  }

  if (!directoryInput) {
    sendJson(res, 400, { error: "Working directory is required" });
    return;
  }

  const directory = path.resolve(directoryInput);
  ensureDirSync(directory);

  const server = upsertServer({
    id: createId("srv"),
    name,
    directory,
    startCommand,
    stopCommand,
    publicListing,
    notes,
    playit: {
      enabled: Boolean(playit.enabled),
      publicAddress: String(playit.publicAddress || "").trim(),
      protocol: String(playit.protocol || "tcp").toLowerCase(),
      fallbackPort: Number.isFinite(Number(playit.fallbackPort)) ? Number(playit.fallbackPort) : 25565,
      label: String(playit.label || "").trim(),
      note: String(playit.note || "").trim(),
      lastProbeAt: null,
      lastProbeOk: null,
      lastProbeMessage: "",
      lastProbeLatencyMs: null,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  if (server.playit.enabled && server.playit.publicAddress) {
    await refreshServerPlayit(server, { timeoutMs: 2000 });
  }

  emitGlobalState("server-created");
  sendJson(res, 201, { server: sanitizeServerForAdmin(server) });
}

async function handleServerDetail(req, res, serverId) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const server = getServerOrThrow(serverId);
  const runtime = processManager.getSnapshot(serviceKeyForServer(server.id));
  sendJson(res, 200, {
    server: {
      ...sanitizeServerForAdmin(server),
      runtime,
    },
  });
}

async function handleServerUpdate(req, res, serverId) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const server = getServerOrThrow(serverId);
  const body = await readBody(req);
  let nextName = server.name;
  let nextDirectory = server.directory;
  let nextStartCommand = server.startCommand;
  let nextStopCommand = server.stopCommand;
  let nextNotes = server.notes;
  let nextPublicListing = server.publicListing;

  if (typeof body.name === "string") {
    const value = body.name.trim();
    if (!value) {
      sendJson(res, 400, { error: "Server name cannot be blank" });
      return;
    }

    nextName = value;
  }

  if (typeof body.directory === "string") {
    const trimmed = body.directory.trim();
    if (!trimmed) {
      sendJson(res, 400, { error: "Directory cannot be blank" });
      return;
    }

    nextDirectory = path.resolve(trimmed);
  }

  if (typeof body.startCommand === "string") {
    const value = body.startCommand.trim();
    if (!value) {
      sendJson(res, 400, { error: "Start command cannot be blank" });
      return;
    }
    nextStartCommand = value;
  }

  if (typeof body.stopCommand === "string") {
    const value = body.stopCommand.trim();
    if (value) {
      nextStopCommand = value;
    }
  }

  if (typeof body.notes === "string") {
    nextNotes = body.notes.trim();
  }

  if (typeof body.publicListing === "boolean") {
    nextPublicListing = body.publicListing;
  }

  ensureDirSync(nextDirectory);
  server.name = nextName;
  server.directory = nextDirectory;
  server.startCommand = nextStartCommand;
  server.stopCommand = nextStopCommand;
  server.notes = nextNotes;
  server.publicListing = nextPublicListing;
  server.updatedAt = new Date().toISOString();
  upsertServer(server);
  emitGlobalState("server-updated");
  sendJson(res, 200, { server: sanitizeServerForAdmin(server) });
}

async function handleServerStart(req, res, serverId) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const server = getServerOrThrow(serverId);
  const result = processManager.start(serviceKeyForServer(server.id), {
    command: server.startCommand,
    cwd: server.directory,
  });

  if (!result.ok) {
    sendJson(res, 400, result);
    return;
  }

  emitGlobalState("server-start");
  sendJson(res, 200, result);
}

async function handleServerStop(req, res, serverId) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const server = getServerOrThrow(serverId);
  const result = processManager.stop(serviceKeyForServer(server.id), {
    stopCommand: server.stopCommand || "stop",
    graceMs: 12000,
  });

  if (!result.ok) {
    sendJson(res, 400, result);
    return;
  }

  emitGlobalState("server-stop");
  sendJson(res, 200, result);
}

async function handleServerRestart(req, res, serverId) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const server = getServerOrThrow(serverId);
  const serviceKey = serviceKeyForServer(server.id);
  const stopResult = processManager.stop(serviceKeyForServer(server.id), {
    stopCommand: server.stopCommand || "stop",
    graceMs: 10000,
  });

  if (!stopResult.ok && stopResult.message !== "Not running") {
    sendJson(res, 400, stopResult);
    return;
  }

  let attempts = 0;
  const watcher = setInterval(() => {
    attempts += 1;
    const snapshot = processManager.getSnapshot(serviceKey);
    if (!snapshot.running) {
      clearInterval(watcher);
      processManager.start(serviceKey, {
        command: server.startCommand,
        cwd: server.directory,
      });
      emitGlobalState("server-restart");
      return;
    }

    if (attempts >= 20) {
      clearInterval(watcher);
      emitGlobalState("server-restart-timeout");
    }
  }, 1000);

  sendJson(res, 200, { ok: true, message: "Restart queued" });
}

async function handleServerCommand(req, res, serverId) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const server = getServerOrThrow(serverId);
  const body = await readBody(req);
  const command = String(body.command || "").trim();

  if (!command) {
    sendJson(res, 400, { error: "Command cannot be blank" });
    return;
  }

  const result = processManager.sendInput(serviceKeyForServer(server.id), command);
  if (!result.ok) {
    sendJson(res, 400, result);
    return;
  }

  sendJson(res, 200, result);
}

function handleServerStream(req, res, serverId) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const server = getServerOrThrow(serverId);
  const close = createSseConnection(res);
  subscribeStream(serviceKeyForServer(server.id), res);
  sseSend(res, "snapshot", {
    runtime: processManager.getSnapshot(serviceKeyForServer(server.id)),
    server: sanitizeServerForAdmin(server),
  });
  res.on("close", close);
}

function handleServerFilesList(req, res, serverId, query) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const server = getServerOrThrow(serverId);
  const relative = String(query.get("path") || ".");

  try {
    const listing = readDirectoryEntries(server.directory, relative);
    sendJson(res, 200, listing);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message });
  }
}

function handleServerFileRead(req, res, serverId, query) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const server = getServerOrThrow(serverId);
  const relative = String(query.get("path") || "");

  if (!relative) {
    sendJson(res, 400, { error: "Path is required" });
    return;
  }

  try {
    const file = readTextFile(server.directory, relative);
    sendJson(res, 200, file);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message });
  }
}

async function handleServerFileWrite(req, res, serverId) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const server = getServerOrThrow(serverId);
  const body = await readBody(req);
  const relative = String(body.path || "").trim();
  const content = String(body.content || "");

  if (!relative) {
    sendJson(res, 400, { error: "Path is required" });
    return;
  }

  try {
    const saved = writeTextFile(server.directory, relative, content);
    server.updatedAt = new Date().toISOString();
    upsertServer(server);
    emitGlobalState("file-written");
    sendJson(res, 200, { file: saved });
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message });
  }
}

async function handleServerPlayitUpdate(req, res, serverId) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const server = getServerOrThrow(serverId);
  const body = await readBody(req);

  if (typeof body.enabled === "boolean") {
    server.playit.enabled = body.enabled;
  }

  if (typeof body.publicAddress === "string") {
    server.playit.publicAddress = body.publicAddress.trim();
  }

  if (typeof body.protocol === "string") {
    server.playit.protocol = body.protocol.trim().toLowerCase();
  }

  if (body.fallbackPort != null) {
    const value = Number(body.fallbackPort);
    if (Number.isFinite(value) && value > 0) {
      server.playit.fallbackPort = value;
    }
  }

  if (typeof body.label === "string") {
    server.playit.label = body.label.trim();
  }

  if (typeof body.note === "string") {
    server.playit.note = body.note.trim();
  }

  server.updatedAt = new Date().toISOString();
  upsertServer(server);
  emitGlobalState("playit-update");

  if (server.playit.enabled && server.playit.publicAddress) {
    await refreshServerPlayit(server, { timeoutMs: 2000 });
  }

  sendJson(res, 200, {
    playit: {
      ...server.playit,
      reachable: Boolean(server.playit.lastProbeOk),
    },
  });
}

function handleServerPlayitRead(req, res, serverId) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const server = getServerOrThrow(serverId);
  sendJson(res, 200, {
    playit: {
      ...server.playit,
      reachable: Boolean(server.playit.lastProbeOk),
    },
    runtime: processManager.getSnapshot(serviceKeyForServer(server.id)),
  });
}

async function handleServerPlayitProbe(req, res, serverId) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const server = getServerOrThrow(serverId);
  const result = await refreshServerPlayit(server, { timeoutMs: 2000 });
  sendJson(res, 200, { result, playit: server.playit });
}

function handlePlayitAgentRead(req, res) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  sendJson(res, 200, {
    settings: {
      ...settings.playitAgent,
    },
    runtime: processManager.getSnapshot(PLAYIT_AGENT_KEY),
  });
}

async function handlePlayitAgentUpdate(req, res) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const body = await readBody(req);
  const next = {
    enabled: settings.playitAgent.enabled,
    command: settings.playitAgent.command,
    workingDirectory: settings.playitAgent.workingDirectory,
    note: settings.playitAgent.note,
  };

  if (typeof body.enabled === "boolean") {
    next.enabled = body.enabled;
  }

  if (typeof body.command === "string") {
    next.command = body.command.trim();
  }

  if (typeof body.workingDirectory === "string") {
    next.workingDirectory = body.workingDirectory.trim();
  }

  if (typeof body.note === "string") {
    next.note = body.note.trim();
  }

  if (next.enabled && !next.command) {
    sendJson(res, 400, { error: "Playit agent command is required when enabled" });
    return;
  }

  settings.playitAgent = next;
  persistSettings();
  emitGlobalState("playit-agent-update");

  if (!settings.playitAgent.enabled) {
    processManager.stop(PLAYIT_AGENT_KEY, { graceMs: 3000 });
  } else if (settings.playitAgent.command) {
    if (!processManager.getSnapshot(PLAYIT_AGENT_KEY).running) {
      const result = processManager.start(PLAYIT_AGENT_KEY, {
        command: settings.playitAgent.command,
        cwd: settings.playitAgent.workingDirectory || ROOT_DIR,
      });
      if (!result.ok) {
        settings.playitAgent.enabled = false;
        persistSettings();
        sendJson(res, 400, result);
        return;
      }
    }
  }

  sendJson(res, 200, {
    settings: {
      ...settings.playitAgent,
    },
    runtime: processManager.getSnapshot(PLAYIT_AGENT_KEY),
  });
}

function handlePlayitAgentStart(req, res) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  if (!settings.playitAgent.command) {
    sendJson(res, 400, { error: "Playit agent command is not configured" });
    return;
  }

  settings.playitAgent.enabled = true;
  persistSettings();
  const result = processManager.start(PLAYIT_AGENT_KEY, {
    command: settings.playitAgent.command,
    cwd: settings.playitAgent.workingDirectory || ROOT_DIR,
  });

  if (!result.ok) {
    settings.playitAgent.enabled = false;
    persistSettings();
    sendJson(res, 400, result);
    return;
  }

  emitGlobalState("playit-agent-start");
  sendJson(res, 200, result);
}

function handlePlayitAgentStop(req, res) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  settings.playitAgent.enabled = false;
  persistSettings();
  const result = processManager.stop(PLAYIT_AGENT_KEY, { graceMs: 3000 });
  emitGlobalState("playit-agent-stop");
  sendJson(res, 200, result);
}

function handlePlayitAgentStream(req, res) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const close = createSseConnection(res);
  subscribeStream(PLAYIT_AGENT_KEY, res);
  sseSend(res, "snapshot", {
    runtime: processManager.getSnapshot(PLAYIT_AGENT_KEY),
    settings: settings.playitAgent,
  });
  res.on("close", close);
}

async function handleSettingsRead(req, res) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  sendJson(res, 200, {
    settings: {
      siteName: settings.siteName,
      subtitle: settings.subtitle,
      allowRegistration: settings.allowRegistration,
    },
  });
}

async function handleSettingsUpdate(req, res) {
  const currentUser = requireAdmin(req, res);
  if (!currentUser) {
    return;
  }

  const body = await readBody(req);

  if (typeof body.siteName === "string") {
    settings.siteName = body.siteName.trim() || settings.siteName;
  }

  if (typeof body.subtitle === "string") {
    settings.subtitle = body.subtitle.trim();
  }

  if (typeof body.allowRegistration === "boolean") {
    settings.allowRegistration = body.allowRegistration;
  }

  persistSettings();
  emitGlobalState("settings-update");
  sendJson(res, 200, {
    settings: {
      siteName: settings.siteName,
      subtitle: settings.subtitle,
      allowRegistration: settings.allowRegistration,
    },
  });
}

function handleGlobalStream(req, res) {
  const currentUser = getCurrentUser(req);
  const close = createSseConnection(res);
  subscribeStream("global", res);
  sseSend(res, "snapshot", buildBootstrapPayload(currentUser));
  res.on("close", close);
}

function serveIndexHtml(res) {
  serveAsset(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
}

function serveStyles(res) {
  serveAsset(res, path.join(PUBLIC_DIR, "styles.css"), "text/css; charset=utf-8");
}

function serveAppJs(res) {
  serveAsset(res, path.join(PUBLIC_DIR, "app.js"), "application/javascript; charset=utf-8");
}

function serveManifestIfNeeded(res) {
  sendJson(res, 404, { error: "Not found" });
}

async function routeApi(req, res, url) {
  const currentUser = getCurrentUser(req);
  const segments = url.pathname.split("/").filter(Boolean);

  try {
    if (url.pathname === "/api/bootstrap" && req.method === "GET") {
      handleBootstrap(req, res);
      return;
    }

    if (url.pathname === "/api/public/overview" && req.method === "GET") {
      handlePublicOverview(req, res);
      return;
    }

    if (url.pathname === "/api/summary" && req.method === "GET") {
      handleSummary(req, res);
      return;
    }

    if (url.pathname === "/api/register" && req.method === "POST") {
      await handleAuthRegister(req, res);
      return;
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      await handleAuthLogin(req, res);
      return;
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      handleAuthLogout(req, res);
      return;
    }

    if (url.pathname === "/api/users" && req.method === "GET") {
      handleUsersList(req, res);
      return;
    }

    if (segments[1] === "users" && segments.length === 3 && req.method === "PATCH") {
      await handleUsersPatch(req, res, segments[2]);
      return;
    }

    if (url.pathname === "/api/servers" && req.method === "GET") {
      handleServersList(req, res);
      return;
    }

    if (url.pathname === "/api/servers" && req.method === "POST") {
      await handleServersCreate(req, res);
      return;
    }

    if (segments[1] === "servers" && segments.length >= 3) {
      const serverId = segments[2];

      if (segments.length === 3 && req.method === "GET") {
        await handleServerDetail(req, res, serverId);
        return;
      }

      if (segments.length === 3 && req.method === "PATCH") {
        await handleServerUpdate(req, res, serverId);
        return;
      }

      if (segments.length === 4 && segments[3] === "start" && req.method === "POST") {
        await handleServerStart(req, res, serverId);
        return;
      }

      if (segments.length === 4 && segments[3] === "stop" && req.method === "POST") {
        await handleServerStop(req, res, serverId);
        return;
      }

      if (segments.length === 4 && segments[3] === "restart" && req.method === "POST") {
        await handleServerRestart(req, res, serverId);
        return;
      }

      if (segments.length === 4 && segments[3] === "command" && req.method === "POST") {
        await handleServerCommand(req, res, serverId);
        return;
      }

      if (segments.length === 4 && segments[3] === "stream" && req.method === "GET") {
        handleServerStream(req, res, serverId);
        return;
      }

      if (segments.length === 4 && segments[3] === "files" && req.method === "GET") {
        handleServerFilesList(req, res, serverId, url.searchParams);
        return;
      }

      if (segments.length === 4 && segments[3] === "file" && req.method === "GET") {
        handleServerFileRead(req, res, serverId, url.searchParams);
        return;
      }

      if (segments.length === 4 && segments[3] === "file" && req.method === "PUT") {
        await handleServerFileWrite(req, res, serverId);
        return;
      }

      if (segments.length === 4 && segments[3] === "playit" && req.method === "GET") {
        handleServerPlayitRead(req, res, serverId);
        return;
      }

      if (segments.length === 4 && segments[3] === "playit" && req.method === "PATCH") {
        await handleServerPlayitUpdate(req, res, serverId);
        return;
      }

      if (segments.length === 5 && segments[3] === "playit" && segments[4] === "probe" && req.method === "POST") {
        await handleServerPlayitProbe(req, res, serverId);
        return;
      }
    }

    if (url.pathname === "/api/playit/agent" && req.method === "GET") {
      handlePlayitAgentRead(req, res);
      return;
    }

    if (url.pathname === "/api/playit/agent" && req.method === "PATCH") {
      await handlePlayitAgentUpdate(req, res);
      return;
    }

    if (url.pathname === "/api/playit/agent/start" && req.method === "POST") {
      handlePlayitAgentStart(req, res);
      return;
    }

    if (url.pathname === "/api/playit/agent/stop" && req.method === "POST") {
      handlePlayitAgentStop(req, res);
      return;
    }

    if (url.pathname === "/api/playit/agent/stream" && req.method === "GET") {
      handlePlayitAgentStream(req, res);
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
      await handleSettingsRead(req, res);
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "PATCH") {
      await handleSettingsUpdate(req, res);
      return;
    }

    if (url.pathname === "/api/heartbeat" && req.method === "GET") {
      sendJson(res, 200, { ok: true, ts: new Date().toISOString() });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "API endpoint not found" });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      error: status === 500 ? "Internal server error" : error.message,
    });
  }
}

function maybeStartPlayitAgentOnBoot() {
  if (!settings.playitAgent.enabled || !settings.playitAgent.command) {
    return;
  }

  processManager.start(PLAYIT_AGENT_KEY, {
    command: settings.playitAgent.command,
    cwd: settings.playitAgent.workingDirectory || ROOT_DIR,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, getRequestBaseUrl(req));

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (url.pathname === "/styles.css" && req.method === "GET") {
      serveStyles(res);
      return;
    }

    if (url.pathname === "/app.js" && req.method === "GET") {
      serveAppJs(res);
      return;
    }

    if (url.pathname === "/manifest.json" && req.method === "GET") {
      serveManifestIfNeeded(res);
      return;
    }

    if (url.pathname === "/api/stream/global" && req.method === "GET") {
      handleGlobalStream(req, res);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url);
      return;
    }

    if (req.method === "GET") {
      serveIndexHtml(res);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: "Internal server error" });
    console.error(error);
  }
});

function startBackgroundTasks() {
  maybeStartPlayitAgentOnBoot();
  refreshAllPlayitProbes().catch((error) => {
    console.error("Initial Playit probe failed:", error);
  });

  if (!pruneInterval) {
    pruneInterval = setInterval(() => {
      pruneExpiredSessions();
    }, 1000 * 60 * 5);
  }

  if (!probeInterval) {
    probeInterval = setInterval(() => {
      refreshAllPlayitProbes().catch((error) => {
        console.error("Scheduled Playit probe failed:", error);
      });
    }, 1000 * 20);
  }
}

function stopBackgroundTasks() {
  if (pruneInterval) {
    clearInterval(pruneInterval);
    pruneInterval = null;
  }

  if (probeInterval) {
    clearInterval(probeInterval);
    probeInterval = null;
  }
}

function stopManagedProcesses() {
  processManager.stop(PLAYIT_AGENT_KEY, { graceMs: 1000 });
  for (const serverEntry of servers) {
    processManager.stop(serviceKeyForServer(serverEntry.id), {
      stopCommand: serverEntry.stopCommand,
      graceMs: 1000,
    });
  }
}

function startPanelServer(options = {}) {
  if (startedInfo) {
    return Promise.resolve(startedInfo);
  }

  const host = options.host || HOST;
  const port = options.port == null ? DEFAULT_PORT : Number(options.port);

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      const actualPort = address && typeof address === "object" ? address.port : port;
      const url = `http://${host}:${actualPort}`;

      startBackgroundTasks();

      startedInfo = {
        server,
        host,
        port: actualPort,
        url,
      };

      if (options.log !== false) {
        console.log(`Untitled Server Panel running at ${url}`);
      }

      resolve(startedInfo);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function stopPanelServer() {
  stopBackgroundTasks();
  stopManagedProcesses();

  return new Promise((resolve) => {
    if (!startedInfo) {
      resolve();
      return;
    }

    server.close(() => {
      startedInfo = null;
      resolve();
    });
  });
}

if (require.main === module) {
  startPanelServer().catch((error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${DEFAULT_PORT} is already in use on ${HOST}.`);
      console.error(`If the panel is already running, open http://${HOST}:${DEFAULT_PORT}`);
      console.error("Command Prompt alternate port: set PORT=3001 && npm start");
      console.error("PowerShell alternate port: $env:PORT=3001; npm start");
      process.exit(1);
    }

    console.error(error);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    stopPanelServer().finally(() => {
      process.exit(0);
    });
  });
}

module.exports = {
  startPanelServer,
  stopPanelServer,
};
