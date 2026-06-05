const fs = require("fs");
const path = require("path");

function ensureDirSync(dirPath) {
  if (!dirPath) {
    return;
  }

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJsonSync(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      return typeof fallback === "function" ? fallback() : fallback;
    }

    return JSON.parse(raw);
  } catch (error) {
    return typeof fallback === "function" ? fallback() : fallback;
  }
}

function writeJsonSync(filePath, value) {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

module.exports = {
  ensureDirSync,
  readJsonSync,
  writeJsonSync,
};
