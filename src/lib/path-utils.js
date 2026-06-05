const path = require("path");

function resolveInside(rootPath, targetPath = ".") {
  const absoluteRoot = path.resolve(rootPath);
  const resolved = path.resolve(absoluteRoot, targetPath);
  const relative = path.relative(absoluteRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes the allowed root");
  }

  return resolved;
}

function toDisplayPath(rootPath, absolutePath) {
  const absoluteRoot = path.resolve(rootPath);
  const relative = path.relative(absoluteRoot, absolutePath);
  return relative || ".";
}

module.exports = {
  resolveInside,
  toDisplayPath,
};
