const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const os = require("os");
const { parseCommandLine } = require("./command-parser");

function createRuntime() {
  return {
    process: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    exitSignal: null,
    lines: [],
    lineBuffer: "",
  };
}

function pushLine(runtime, source, message) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ts: new Date().toISOString(),
    source,
    message,
  };

  runtime.lines.push(entry);
  if (runtime.lines.length > 500) {
    runtime.lines.shift();
  }

  return entry;
}

function wireStream(runtime, source, chunkHandler, onLine) {
  return (chunk) => {
    runtime.lineBuffer += chunk.toString("utf8");
    const pieces = runtime.lineBuffer.split(/\r?\n/);
    runtime.lineBuffer = pieces.pop() || "";

    for (const piece of pieces) {
      onLine(pushLine(runtime, source, piece));
    }
  };
}

class ProcessManager extends EventEmitter {
  constructor() {
    super();
    this.runtimes = new Map();
  }

  ensureRuntime(key) {
    if (!this.runtimes.has(key)) {
      this.runtimes.set(key, createRuntime());
    }

    return this.runtimes.get(key);
  }

  getSnapshot(key) {
    const runtime = this.ensureRuntime(key);
    return {
      running: Boolean(runtime.process),
      pid: runtime.process ? runtime.process.pid : null,
      startedAt: runtime.startedAt,
      finishedAt: runtime.finishedAt,
      exitCode: runtime.exitCode,
      exitSignal: runtime.exitSignal,
      lines: runtime.lines.slice(-250),
    };
  }

  start(key, options) {
    const runtime = this.ensureRuntime(key);

    if (runtime.process) {
      return {
        ok: false,
        message: "Already running",
      };
    }

    if (!options || !options.command) {
      return {
        ok: false,
        message: "Missing command",
      };
    }

    const parsed = parseCommandLine(options.command);
    const cwd = options.cwd || process.cwd();
    const env = {
      ...process.env,
      ...(options.env || {}),
    };

    const child = spawn(parsed.command, parsed.args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    runtime.process = child;
    runtime.startedAt = new Date().toISOString();
    runtime.finishedAt = null;
    runtime.exitCode = null;
    runtime.exitSignal = null;
    runtime.lineBuffer = "";

    pushLine(runtime, "system", `Launching ${parsed.command} ${parsed.args.join(" ")}`.trim());
    this.emit("log", { key, entry: runtime.lines[runtime.lines.length - 1] });
    this.emit("change", { key, snapshot: this.getSnapshot(key) });

    const onStdout = wireStream(runtime, "stdout", runtime, (entry) => {
      this.emit("log", { key, entry });
    });
    const onStderr = wireStream(runtime, "stderr", runtime, (entry) => {
      this.emit("log", { key, entry });
    });

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);

    child.on("error", (error) => {
      pushLine(runtime, "system", error.message);
      runtime.process = null;
      runtime.finishedAt = new Date().toISOString();
      this.emit("log", { key, entry: runtime.lines[runtime.lines.length - 1] });
      this.emit("change", { key, snapshot: this.getSnapshot(key) });
    });

    child.on("exit", (code, signal) => {
      pushLine(runtime, "system", `Process exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`);
      runtime.process = null;
      runtime.finishedAt = new Date().toISOString();
      runtime.exitCode = code;
      runtime.exitSignal = signal;
      this.emit("log", { key, entry: runtime.lines[runtime.lines.length - 1] });
      this.emit("change", { key, snapshot: this.getSnapshot(key) });
    });

    return {
      ok: true,
      pid: child.pid,
      message: `Started ${parsed.command}`,
    };
  }

  stop(key, options = {}) {
    const runtime = this.ensureRuntime(key);

    if (!runtime.process) {
      return {
        ok: false,
        message: "Not running",
      };
    }

    const graceMs = options.graceMs || 10000;
    const stopCommand = options.stopCommand || "stop";

    try {
      if (runtime.process.stdin.writable) {
        runtime.process.stdin.write(`${stopCommand}${os.EOL}`);
      }
    } catch (error) {
      // If stdin has gone away, fall back to a kill below.
    }

    const child = runtime.process;
    setTimeout(() => {
      if (runtime.process === child) {
        try {
          child.kill();
        } catch (error) {
          // No-op: the process may already be gone.
        }
      }
    }, graceMs);

    return {
      ok: true,
      message: "Stop signal sent",
    };
  }

  sendInput(key, input) {
    const runtime = this.ensureRuntime(key);
    if (!runtime.process || !runtime.process.stdin.writable) {
      return {
        ok: false,
        message: "Process is not accepting input",
      };
    }

    runtime.process.stdin.write(`${input}${os.EOL}`);
    return {
      ok: true,
      message: "Command sent",
    };
  }
}

module.exports = {
  ProcessManager,
};
