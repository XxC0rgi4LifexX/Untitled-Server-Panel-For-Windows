const crypto = require("crypto");

const COOKIE_NAME = "usp_sid";

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return {
    salt,
    hash,
    value: `${salt}:${hash}`,
  };
}

function verifyPassword(password, storedValue) {
  if (!storedValue || typeof storedValue !== "string") {
    return false;
  }

  const [salt, hash] = storedValue.split(":");
  if (!salt || !hash) {
    return false;
  }

  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(candidate, "hex");

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function createSession(userId, ttlMs = 1000 * 60 * 60 * 24 * 14) {
  const token = crypto.randomBytes(32).toString("hex");
  return {
    token,
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) {
    return cookies;
  }

  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index === -1) {
      continue;
    }

    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    cookies[name] = decodeURIComponent(value);
  }

  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge != null) {
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }

  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  } else {
    parts.push("SameSite=Lax");
  }

  if (options.path) {
    parts.push(`Path=${options.path}`);
  } else {
    parts.push("Path=/");
  }

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  const { passwordHash, salt, ...safeUser } = user;
  return safeUser;
}

module.exports = {
  COOKIE_NAME,
  createSession,
  hashPassword,
  parseCookies,
  sanitizeUser,
  serializeCookie,
  verifyPassword,
};
