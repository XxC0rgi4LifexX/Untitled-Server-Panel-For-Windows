function parseCommandLine(commandLine) {
  if (!commandLine || !String(commandLine).trim()) {
    throw new Error("Command cannot be empty");
  }

  const input = String(commandLine).trim();
  const parts = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === "\"" || char === "'") && (!quote || quote === char)) {
      quote = quote === char ? null : char;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current.length) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (current.length) {
    parts.push(current);
  }

  if (!parts.length) {
    throw new Error("Command cannot be empty");
  }

  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

module.exports = {
  parseCommandLine,
};
