const app = document.getElementById("app");

const state = {
  bootstrapped: false,
  loading: true,
  me: null,
  settings: {
    siteName: "Untitled Server Panel",
    subtitle: "",
    allowRegistration: true,
  },
  summary: null,
  publicOverview: {
    siteName: "Untitled Server Panel",
    subtitle: "",
    allowRegistration: true,
    servers: [],
  },
  servers: [],
  users: [],
  playitAgent: {
    settings: {
      enabled: false,
      command: "",
      workingDirectory: "",
      note: "",
    },
    runtime: {
      running: false,
      lines: [],
    },
  },
  selectedServerId: null,
  selectedTab: "console",
  files: {
    loading: false,
    saving: false,
    directoryPath: ".",
    entries: [],
    selectedPath: "",
    content: "",
    info: null,
    loadedFor: null,
  },
  toasts: [],
};

let renderQueued = false;
let bootstrapPromise = null;
let filesRequestSerial = 0;
let globalStream = null;
let serverStream = null;
let playitStream = null;
let refreshTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value) {
  if (!value) {
    return "Never";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];

  if (days) {
    parts.push(`${days}d`);
  }
  if (hours || parts.length) {
    parts.push(`${hours}h`);
  }
  parts.push(`${minutes}m`);

  return parts.join(" ");
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) {
    return "--";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = value;
  let index = 0;

  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }

  const digits = index === 0 ? 0 : current >= 100 ? 0 : current >= 10 ? 1 : 2;
  return `${current.toFixed(digits)} ${units[index]}`;
}

function formatLatency(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "--";
  }
  return `${Number(value)} ms`;
}

function formatFileSize(value) {
  if (value == null) {
    return "--";
  }
  return formatBytes(value);
}

function humanizeServerState(server) {
  return server?.running ? "RUNNING" : "STOPPED";
}

function humanizePlayitState(playit) {
  if (!playit?.enabled) {
    return "DISABLED";
  }
  return playit.reachable ? "REACHABLE" : "OFFLINE";
}

function serverById(id) {
  return state.servers.find((server) => server.id === id) || null;
}

function selectedServer() {
  return serverById(state.selectedServerId);
}

function hydrateServer(server) {
  const logs = Array.isArray(server?.logs) ? server.logs.slice() : [];
  const runtime = server?.runtime
    ? {
        ...server.runtime,
        lines: Array.isArray(server.runtime.lines)
          ? server.runtime.lines.slice()
          : logs.slice(),
      }
    : {
        running: Boolean(server?.running),
        pid: server?.pid || null,
        startedAt: server?.startedAt || null,
        finishedAt: server?.finishedAt || null,
        exitCode: server?.exitCode ?? null,
        exitSignal: server?.exitSignal ?? null,
        lines: logs.slice(),
      };

  return {
    ...server,
    logs,
    runtime,
    playit: {
      enabled: Boolean(server?.playit?.enabled),
      publicAddress: String(server?.playit?.publicAddress || ""),
      protocol: String(server?.playit?.protocol || "tcp"),
      fallbackPort: Number(server?.playit?.fallbackPort || 25565),
      label: String(server?.playit?.label || ""),
      note: String(server?.playit?.note || ""),
      lastProbeAt: server?.playit?.lastProbeAt || null,
      lastProbeOk: typeof server?.playit?.lastProbeOk === "boolean" ? server.playit.lastProbeOk : null,
      lastProbeMessage: String(server?.playit?.lastProbeMessage || ""),
      lastProbeLatencyMs: server?.playit?.lastProbeLatencyMs ?? null,
      reachable: Boolean(server?.playit?.reachable),
    },
  };
}

function applyBootstrapPayload(payload) {
  state.bootstrapped = true;
  state.loading = false;
  state.me = payload.me || null;
  state.settings = payload.settings || state.settings;
  state.summary = payload.summary || null;
  state.publicOverview = payload.publicOverview || state.publicOverview;
  state.servers = (payload.servers || []).map(hydrateServer);
  state.users = payload.users || [];

  if (payload.playitAgent) {
    state.playitAgent = {
      settings: payload.playitAgent.settings || state.playitAgent.settings,
      runtime: payload.playitAgent.runtime || state.playitAgent.runtime,
    };
  } else if (payload.summary?.playitAgent) {
    state.playitAgent.runtime = payload.summary.playitAgent;
  }

  if (state.me?.role === "admin") {
    if (!state.selectedServerId && state.servers.length) {
      state.selectedServerId = state.servers[0].id;
    }
    if (state.selectedServerId && !state.servers.some((server) => server.id === state.selectedServerId)) {
      state.selectedServerId = state.servers[0]?.id || null;
    }
  } else {
    state.selectedServerId = null;
    state.selectedTab = "console";
  }

  if (state.selectedServerId) {
    const server = selectedServer();
    if (server && !server.runtime) {
      server.runtime = { lines: Array.isArray(server.logs) ? server.logs.slice() : [] };
    }
  }

  scheduleRender();
}

function mergeServerFromSnapshot(snapshot) {
  const next = hydrateServer(snapshot.server || snapshot);
  const index = state.servers.findIndex((server) => server.id === next.id);

  if (index === -1) {
    state.servers.push(next);
  } else {
    const existing = state.servers[index];
    state.servers[index] = {
      ...existing,
      ...next,
      runtime: next.runtime || existing.runtime,
    };
  }

  if (state.selectedServerId === next.id) {
    const selected = selectedServer();
    if (selected && next.runtime) {
      selected.runtime = next.runtime;
    }
    if (selected && next.logs) {
      selected.logs = next.logs;
    }
  }

  scheduleRender();
}

function appendServerLog(serverId, entry) {
  const server = serverById(serverId);
  if (!server) {
    return;
  }

  if (!server.runtime) {
    server.runtime = { lines: [] };
  }

  if (!Array.isArray(server.runtime.lines)) {
    server.runtime.lines = [];
  }

  server.runtime.lines.push(entry);
  if (server.runtime.lines.length > 250) {
    server.runtime.lines.shift();
  }
  server.logs = server.runtime.lines.slice(-50);
  scheduleRender();
}

function mergePlayitAgentSnapshot(snapshot) {
  state.playitAgent = {
    settings: snapshot.settings || state.playitAgent.settings,
    runtime: snapshot.runtime || state.playitAgent.runtime,
  };
  scheduleRender();
}

function setSelectedServer(serverId) {
  state.selectedServerId = serverId;
  state.selectedTab = "console";
  state.files = {
    loading: false,
    saving: false,
    directoryPath: ".",
    entries: [],
    selectedPath: "",
    content: "",
    info: null,
    loadedFor: null,
  };
  scheduleRender();
  if (state.me?.role === "admin" && serverId) {
    loadDirectory(".").catch((error) => notify("Files", error.message, "bad"));
  }
  connectStreams();
}

function setSelectedTab(tab) {
  state.selectedTab = tab;
  scheduleRender();
  if (tab === "files") {
    const server = selectedServer();
    if (server && !state.files.loading) {
      if (!state.files.entries.length || state.files.directoryPath === ".") {
        loadDirectory(state.files.directoryPath || ".").catch((error) => notify("Files", error.message, "bad"));
      }
    }
  }
}

function notify(title, message, tone = "info") {
  const id = `toast-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  state.toasts.push({ id, title, message, tone });
  if (state.toasts.length > 4) {
    state.toasts.shift();
  }
  scheduleRender();

  window.setTimeout(() => {
    state.toasts = state.toasts.filter((toast) => toast.id !== id);
    scheduleRender();
  }, 4200);
}

function scheduleRender() {
  if (renderQueued) {
    return;
  }

  renderQueued = true;
  window.requestAnimationFrame(() => {
    renderQueued = false;
    renderApp();
  });
}

function scheduleBootstrapRefresh() {
  if (refreshTimer) {
    window.clearTimeout(refreshTimer);
  }

  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    refreshBootstrap({ silent: true }).catch((error) => {
      notify("Refresh", error.message, "bad");
    });
  }, 180);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: {
      ...(options.json ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return payload;
}

function formToObject(form) {
  const data = {};
  for (const element of Array.from(form.elements)) {
    if (!element.name || element.disabled) {
      continue;
    }

    if (element.type === "checkbox") {
      data[element.name] = element.checked;
      continue;
    }

    if (element.type === "number") {
      data[element.name] = element.value === "" ? null : Number(element.value);
      continue;
    }

    data[element.name] = element.value;
  }
  return data;
}

function closeStream(stream) {
  if (stream) {
    try {
      stream.close();
    } catch (error) {
      // Ignore.
    }
  }
}

function openGlobalStream() {
  closeStream(globalStream);
  globalStream = new EventSource("/api/stream/global");
  globalStream.addEventListener("snapshot", (event) => {
    applyBootstrapPayload(JSON.parse(event.data));
  });
  globalStream.addEventListener("state", () => {
    scheduleBootstrapRefresh();
  });
}

function openServerStream(serverId) {
  closeStream(serverStream);
  if (!state.me || state.me.role !== "admin" || !serverId) {
    return;
  }

  serverStream = new EventSource(`/api/servers/${encodeURIComponent(serverId)}/stream`);
  serverStream.addEventListener("snapshot", (event) => {
    const payload = JSON.parse(event.data);
    mergeServerFromSnapshot(payload);
  });
  serverStream.addEventListener("log", (event) => {
    const entry = JSON.parse(event.data);
    appendServerLog(serverId, entry);
  });
  serverStream.addEventListener("state", () => {
    scheduleBootstrapRefresh();
  });
}

function openPlayitStream() {
  closeStream(playitStream);
  if (!state.me || state.me.role !== "admin") {
    return;
  }

  playitStream = new EventSource("/api/playit/agent/stream");
  playitStream.addEventListener("snapshot", (event) => {
    mergePlayitAgentSnapshot(JSON.parse(event.data));
  });
  playitStream.addEventListener("log", (event) => {
    const entry = JSON.parse(event.data);
    if (!state.playitAgent.runtime) {
      state.playitAgent.runtime = { lines: [] };
    }
    if (!Array.isArray(state.playitAgent.runtime.lines)) {
      state.playitAgent.runtime.lines = [];
    }
    state.playitAgent.runtime.lines.push(entry);
    if (state.playitAgent.runtime.lines.length > 250) {
      state.playitAgent.runtime.lines.shift();
    }
    scheduleRender();
  });
  playitStream.addEventListener("state", () => {
    scheduleBootstrapRefresh();
  });
}

function connectStreams() {
  openGlobalStream();
  if (state.me?.role === "admin" && state.selectedServerId) {
    openServerStream(state.selectedServerId);
    openPlayitStream();
  } else {
    closeStream(serverStream);
    closeStream(playitStream);
    serverStream = null;
    playitStream = null;
  }
}

async function refreshBootstrap({ silent = false } = {}) {
  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    if (!silent) {
      state.loading = true;
      scheduleRender();
    }

    const payload = await fetchJson("/api/bootstrap");
    applyBootstrapPayload(payload);
    connectStreams();
    return payload;
  })()
    .catch((error) => {
      if (!silent) {
        notify("Bootstrap", error.message, "bad");
      }
      throw error;
    })
    .finally(() => {
      state.loading = false;
      bootstrapPromise = null;
      scheduleRender();
    });

  return bootstrapPromise;
}

async function loadDirectory(directoryPath = ".") {
  const server = selectedServer();
  if (!server) {
    return;
  }

  const token = ++filesRequestSerial;
  state.files.loading = true;
  scheduleRender();

  try {
    const payload = await fetchJson(`/api/servers/${encodeURIComponent(server.id)}/files?path=${encodeURIComponent(directoryPath)}`);
    if (token !== filesRequestSerial) {
      return;
    }

    state.files = {
      ...state.files,
      loading: false,
      directoryPath: payload.path || directoryPath,
      entries: payload.entries || [],
      selectedPath: "",
      content: "",
      info: null,
      loadedFor: {
        serverId: server.id,
        path: payload.path || directoryPath,
      },
    };
    scheduleRender();
  } catch (error) {
    if (token !== filesRequestSerial) {
      return;
    }
    state.files.loading = false;
    scheduleRender();
    throw error;
  }
}

async function loadFile(filePath) {
  const server = selectedServer();
  if (!server) {
    return;
  }

  state.files.loading = true;
  scheduleRender();

  try {
    const payload = await fetchJson(
      `/api/servers/${encodeURIComponent(server.id)}/file?path=${encodeURIComponent(filePath)}`
    );
    state.files = {
      ...state.files,
      loading: false,
      selectedPath: payload.path,
      content: payload.content,
      info: payload,
      loadedFor: {
        serverId: server.id,
        path: state.files.directoryPath || ".",
      },
    };
    scheduleRender();
  } catch (error) {
    state.files.loading = false;
    scheduleRender();
    throw error;
  }
}

async function saveFileContent(form) {
  const server = selectedServer();
  if (!server) {
    return;
  }

  const payload = formToObject(form);
  if (!payload.path) {
    notify("Files", "Select a file first", "bad");
    return;
  }

  state.files.saving = true;
  scheduleRender();

  try {
    const result = await fetchJson(`/api/servers/${encodeURIComponent(server.id)}/file`, {
      method: "PUT",
      json: true,
      body: {
        path: payload.path,
        content: payload.content,
      },
    });

    state.files = {
      ...state.files,
      saving: false,
      selectedPath: result.file.path,
      content: result.file.content,
      info: result.file,
    };
    notify("Files", `Saved ${result.file.path}`, "good");
    scheduleBootstrapRefresh();
  } catch (error) {
    state.files.saving = false;
    notify("Files", error.message, "bad");
  } finally {
    scheduleRender();
  }
}

function scrollConsoleToBottom() {
  window.requestAnimationFrame(() => {
    const consoleNode = document.querySelector('[data-role="server-console-output"]');
    if (consoleNode) {
      consoleNode.scrollTop = consoleNode.scrollHeight;
    }
    const agentNode = document.querySelector('[data-role="agent-console-output"]');
    if (agentNode) {
      agentNode.scrollTop = agentNode.scrollHeight;
    }
  });
}

function renderToastStack() {
  if (!state.toasts.length) {
    return "";
  }

  return `
    <div class="toast-stack">
      ${state.toasts
        .map(
          (toast) => `
            <article class="toast">
              <strong>${escapeHtml(toast.title)}</strong>
              <p>${escapeHtml(toast.message)}</p>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderBrandCard(contextLabel = "LOCAL PANEL") {
  return `
    <div class="brand">
      <div class="brand-top">
        <div>
          <div class="eyebrow">${escapeHtml(contextLabel)}</div>
          <h1>${escapeHtml(state.settings.siteName || "Untitled Server Panel")}</h1>
        </div>
        <div class="chip chip--quiet">${state.me?.role === "admin" ? "ADMIN" : state.me ? "MEMBER" : "GUEST"}</div>
      </div>
      <p>${escapeHtml(state.settings.subtitle || "Local Minecraft server control")}</p>
      <div class="status-stack">
        <span class="chip chip--good">Servers ${escapeHtml(String(state.summary?.totalServers || 0))}</span>
        <span class="chip chip--good">Running ${escapeHtml(String(state.summary?.runningServers || 0))}</span>
        <span class="chip ${state.summary?.allowRegistration ? "chip--good" : "chip--bad"}">
          Registration ${state.summary?.allowRegistration ? "OPEN" : "CLOSED"}
        </span>
      </div>
    </div>
  `;
}

function renderSummaryMetrics() {
  const summary = state.summary || {};
  return `
    <div class="hero-metrics">
      <div class="metric">
        <div class="value">${escapeHtml(String(summary.totalServers || 0))}</div>
        <div class="label">Servers</div>
      </div>
      <div class="metric">
        <div class="value">${escapeHtml(String(summary.runningServers || 0))}</div>
        <div class="label">Running</div>
      </div>
      <div class="metric">
        <div class="value">${escapeHtml(formatBytes(summary.memory?.rss || 0))}</div>
        <div class="label">Memory</div>
      </div>
      <div class="metric">
        <div class="value">${escapeHtml(formatDuration(summary.uptime || 0))}</div>
        <div class="label">Uptime</div>
      </div>
    </div>
  `;
}

function renderServerList() {
  if (!state.servers.length) {
    return `
      <div class="empty-state">
        No servers yet. Add one below and start the party, mate.
      </div>
    `;
  }

  return `
    <div class="server-list">
      ${state.servers
        .map((server, index) => {
          const active = server.id === state.selectedServerId;
          return `
            <button
              type="button"
              class="server-item ${active ? "is-active" : ""}"
              data-action="select-server"
              data-server-id="${escapeHtml(server.id)}"
              style="animation-delay:${index * 35}ms"
            >
              <div class="server-item-top">
                <div>
                  <h3>${escapeHtml(server.name)}</h3>
                  <p>${escapeHtml(server.notes || "No notes added")}</p>
                </div>
                <span class="dot ${server.running ? "is-on" : ""}"></span>
              </div>
              <div class="server-item-meta">
                <span class="badge">${server.running ? "RUNNING" : "STOPPED"}</span>
                <span class="badge">${server.playit.enabled ? (server.playit.reachable ? "PLAYIT ON" : "PLAYIT WAIT") : "PLAYIT OFF"}</span>
                ${server.publicListing ? `<span class="badge">PUBLIC</span>` : ""}
              </div>
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderAddServerCard() {
  return `
    <div class="sidebar-section">
      <div class="sidebar-heading">
        <h2>Main Menu / Server Adder</h2>
        <span class="chip chip--quiet">ADD</span>
      </div>
      <form class="form-grid" data-form="create-server">
        <div class="field">
          <label for="server-name">Server name</label>
          <input class="input" id="server-name" name="name" placeholder="Survival Realm" required />
        </div>
        <div class="field">
          <label for="server-directory">Working directory</label>
          <input class="input" id="server-directory" name="directory" placeholder="C:\\Minecraft\\Server" required />
        </div>
        <div class="field">
          <label for="server-command">Start command</label>
          <input class="input" id="server-command" name="startCommand" value="java -jar server.jar nogui" />
        </div>
        <div class="field">
          <label for="server-stop">Stop command</label>
          <input class="input" id="server-stop" name="stopCommand" value="stop" />
        </div>
        <div class="field">
          <label for="server-notes">Notes</label>
          <textarea id="server-notes" name="notes" placeholder="Optional notes about the instance."></textarea>
        </div>
        <label class="check-row">
          <input type="checkbox" name="publicListing" />
          <span>Show on public website</span>
        </label>
        <div class="actions">
          <button class="button button--primary" type="submit">CREATE SERVER</button>
        </div>
      </form>
    </div>
  `;
}

function renderSettingsCard() {
  if (!state.me || state.me.role !== "admin") {
    return "";
  }

  return `
    <div class="panel">
      <div class="panel-top">
        <div>
          <div class="eyebrow">Website Panel</div>
          <h3 class="panel-title">Public portal settings</h3>
          <p>Control the public-facing website, account creation, and the vibe people see when they land.</p>
        </div>
        <span class="chip chip--quiet">SETTINGS</span>
      </div>
      <form class="form-grid" data-form="update-settings">
        <div class="field">
          <label for="site-name">Site name</label>
          <input class="input" id="site-name" name="siteName" value="${escapeHtml(state.settings.siteName || "")}" />
        </div>
        <div class="field">
          <label for="site-subtitle">Subtitle</label>
          <textarea id="site-subtitle" name="subtitle">${escapeHtml(state.settings.subtitle || "")}</textarea>
        </div>
        <label class="check-row">
          <input type="checkbox" name="allowRegistration" ${state.settings.allowRegistration ? "checked" : ""} />
          <span>Allow new account registration</span>
        </label>
        <div class="actions">
          <button class="button button--primary" type="submit">SAVE SETTINGS</button>
        </div>
      </form>
    </div>
  `;
}

function renderUsersCard() {
  if (!state.me || state.me.role !== "admin") {
    return "";
  }

  const rows = state.users
    .map((user) => {
      const isMe = state.me && user.id === state.me.id;
      return `
        <tr>
          <td>
            <strong>${escapeHtml(user.username)}</strong>
            <div class="muted small">${isMe ? "You" : escapeHtml(user.id)}</div>
          </td>
          <td>
            <form class="stack" data-form="update-user-role" data-user-id="${escapeHtml(user.id)}">
              <select class="input" name="role">
                <option value="user" ${user.role === "user" ? "selected" : ""}>user</option>
                <option value="admin" ${user.role === "admin" ? "selected" : ""}>admin</option>
              </select>
              <button class="button button--ghost" type="submit">Save</button>
            </form>
          </td>
          <td>${escapeHtml(formatDateTime(user.createdAt))}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="panel">
      <div class="panel-top">
        <div>
          <div class="eyebrow">Users</div>
          <h3 class="panel-title">Website accounts</h3>
          <p>People who register through the public portal will appear here.</p>
        </div>
        <span class="chip chip--quiet">${state.users.length} USERS</span>
      </div>
      ${state.users.length
        ? `
          <table class="table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Role</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        `
        : `<div class="empty-state">No accounts yet.</div>`}
    </div>
  `;
}

function renderPlayitAgentCard() {
  if (!state.me || state.me.role !== "admin") {
    return "";
  }

  const settings = state.playitAgent.settings || {};
  const runtime = state.playitAgent.runtime || { lines: [] };
  const lines = Array.isArray(runtime.lines) ? runtime.lines : [];

  return `
    <div class="panel">
      <div class="panel-top">
        <div>
          <div class="eyebrow">Playit Agent</div>
          <h3 class="panel-title">Global agent control</h3>
          <p>Launch the Playit agent from here if you want the panel to manage the local process.</p>
        </div>
        <span class="badge ${runtime.running ? "badge--good" : "badge--bad"}">${runtime.running ? "RUNNING" : "STOPPED"}</span>
      </div>
      <form class="form-grid" data-form="update-playit-agent">
        <label class="check-row">
          <input type="checkbox" name="enabled" ${settings.enabled ? "checked" : ""} />
          <span>Keep Playit agent enabled</span>
        </label>
        <div class="field">
          <label for="playit-agent-command">Agent command</label>
          <input class="input" id="playit-agent-command" name="command" value="${escapeHtml(settings.command || "")}" placeholder="playit.exe" />
        </div>
        <div class="field">
          <label for="playit-agent-cwd">Working directory</label>
          <input class="input" id="playit-agent-cwd" name="workingDirectory" value="${escapeHtml(settings.workingDirectory || "")}" placeholder="C:\\Playit" />
        </div>
        <div class="field">
          <label for="playit-agent-note">Note</label>
          <textarea id="playit-agent-note" name="note">${escapeHtml(settings.note || "")}</textarea>
        </div>
        <div class="actions">
          <button class="button button--primary" type="submit">SAVE AGENT</button>
          <button class="button" type="button" data-action="playit-agent-start">RUN</button>
          <button class="button button--ghost" type="button" data-action="playit-agent-stop">STOP</button>
        </div>
      </form>
      <div class="status-line">
        <span class="chip">${runtime.running ? "ENGINE ACTIVE" : "ENGINE IDLE"}</span>
        <span class="chip chip--quiet">Command: ${escapeHtml(settings.command || "not set")}</span>
      </div>
      <pre class="console-output console-output--compact" data-role="agent-console-output">${lines
        .map((line) => `[${formatDateTime(line.ts)}] [${line.source}] ${line.message}`)
        .map(escapeHtml)
        .join("\n")}</pre>
    </div>
  `;
}

function renderServerConsole(server) {
  const runtimeLines = Array.isArray(server?.runtime?.lines) && server.runtime.lines.length
    ? server.runtime.lines
    : Array.isArray(server?.logs)
      ? server.logs
      : [];

  return `
    <div class="console-shell">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="field-title">Live console</div>
            <p class="card-subtitle">Raw console output is preserved so you can layer in Minecraft color-code or MiniMessage styling however you like.</p>
          </div>
          <span class="badge ${server.running ? "badge--good" : "badge--bad"}">${server.running ? "ONLINE" : "OFFLINE"}</span>
        </div>
        <pre class="console-output" data-role="server-console-output">${runtimeLines
          .map((line) => `[${formatDateTime(line.ts)}] [${line.source}] ${line.message}`)
          .map(escapeHtml)
          .join("\n") || "No logs yet."}</pre>
      </div>
      <form class="card form-grid" data-form="send-command">
        <div class="field">
          <label for="console-command">Send command</label>
          <input class="input" id="console-command" name="command" placeholder="say hello" />
        </div>
        <div class="actions">
          <button class="button button--primary" type="submit">SEND</button>
          <button class="button button--ghost" type="button" data-action="server-restart">RESTART</button>
        </div>
      </form>
    </div>
  `;
}

function renderFileBreadcrumb() {
  const pathValue = state.files.directoryPath || ".";
  const normalized = pathValue === "." ? "" : pathValue.replaceAll("\\", "/");
  const pieces = normalized.split("/").filter((piece) => piece && piece !== ".");
  const crumbs = [
    `<button type="button" data-action="load-directory" data-path=".">root</button>`,
    ...pieces.map((piece, index) => {
      const partial = pieces.slice(0, index + 1).join("/");
      return `<button type="button" data-action="load-directory" data-path="${escapeHtml(partial)}">${escapeHtml(piece)}</button>`;
    }),
  ];

  return crumbs.join(" / ");
}

function renderFileList() {
  if (state.files.loading) {
    return `<div class="empty-state">Loading files...</div>`;
  }

  if (!state.files.entries.length) {
    return `<div class="empty-state">This directory is empty.</div>`;
  }

  return `
    <div class="file-list">
      ${state.files.entries
        .map((entry) => `
          <button
            type="button"
            class="file-entry"
            data-action="${entry.isDirectory ? "load-directory" : "open-file"}"
            data-path="${escapeHtml(entry.path)}"
          >
            <div>
              <strong>${escapeHtml(entry.name)}</strong>
              <span>${entry.isDirectory ? "Folder" : `${formatFileSize(entry.size)} - ${formatDateTime(entry.modifiedAt)}`}</span>
            </div>
            <span class="badge">${entry.isDirectory ? "DIR" : "FILE"}</span>
          </button>
        `)
        .join("")}
    </div>
  `;
}

function renderFilesTab(server) {
  return `
    <div class="file-shell">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="field-title">Files</div>
            <p class="card-subtitle">Browse the server folder, open configs, and save changes in place.</p>
          </div>
          <span class="badge">ROOT</span>
        </div>
        <div class="breadcrumb">${renderFileBreadcrumb()}</div>
        <div class="actions" style="margin-top: 14px;">
          <button class="button button--ghost" type="button" data-action="load-directory" data-path=".">Root</button>
          <button class="button button--ghost" type="button" data-action="load-directory" data-path="${escapeHtml(parentPath(state.files.directoryPath || "."))}">Up</button>
          <button class="button" type="button" data-action="refresh-files">Refresh</button>
        </div>
      </div>
      <div class="split">
        <div class="card">
          <div class="card-head">
            <div>
              <div class="field-title">Directory listing</div>
              <p class="card-subtitle">Folders first, then files. Click one to navigate or edit.</p>
            </div>
          </div>
          ${renderFileList()}
        </div>
        <div class="card">
          <div class="card-head">
            <div>
              <div class="field-title">Editor</div>
              <p class="card-subtitle">${state.files.selectedPath ? escapeHtml(state.files.selectedPath) : "Choose a file to edit."}</p>
            </div>
            <span class="badge">${state.files.info ? "OPEN" : "IDLE"}</span>
          </div>
          ${state.files.selectedPath
            ? `
              <form class="form-grid" data-form="save-file">
                <input type="hidden" name="path" value="${escapeHtml(state.files.selectedPath)}" />
                <div class="field">
                  <label for="file-content">File content</label>
                  <textarea class="input" id="file-content" name="content">${escapeHtml(state.files.content || "")}</textarea>
                </div>
                <div class="actions">
                  <button class="button button--primary" type="submit">${state.files.saving ? "SAVING..." : "SAVE FILE"}</button>
                </div>
              </form>
            `
            : `<div class="empty-state">Select a file from the directory list to start editing.</div>`}
        </div>
      </div>
    </div>
  `;
}

function parentPath(pathValue) {
  const clean = String(pathValue || ".").replaceAll("\\", "/");
  if (clean === "." || clean === "") {
    return ".";
  }
  const parts = clean.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return ".";
  }
  return parts.slice(0, -1).join("/");
}

function renderPlayitTab(server) {
  const playit = server.playit || {};
  const runtime = state.playitAgent.runtime || { lines: [] };
  const agentSettings = state.playitAgent.settings || {};
  const lines = Array.isArray(runtime.lines) ? runtime.lines : [];

  return `
    <div class="grid">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="field-title">Public Playit.gg tunnel</div>
            <p class="card-subtitle">This panel does not invent tunnels for you. It monitors the public address you configure, so you can see if the domain is reachable.</p>
          </div>
          <span class="badge ${playit.enabled ? (playit.reachable ? "badge--good" : "badge--bad") : "badge--quiet"}">${humanizePlayitState(playit)}</span>
        </div>
        <form class="form-grid" data-form="update-server-playit">
          <label class="check-row">
            <input type="checkbox" name="enabled" ${playit.enabled ? "checked" : ""} />
            <span>Enable tunnel monitoring</span>
          </label>
          <div class="field-row">
            <div class="field">
              <label for="playit-public-address">Public address</label>
              <input class="input" id="playit-public-address" name="publicAddress" value="${escapeHtml(playit.publicAddress || "")}" placeholder="playit.example.gg:25565" />
            </div>
            <div class="field">
              <label for="playit-label">Label</label>
              <input class="input" id="playit-label" name="label" value="${escapeHtml(playit.label || "")}" placeholder="Main Java tunnel" />
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="playit-protocol">Probe protocol</label>
              <select class="input" id="playit-protocol" name="protocol">
                <option value="tcp" ${String(playit.protocol || "tcp") === "tcp" ? "selected" : ""}>tcp</option>
                <option value="http" ${String(playit.protocol || "") === "http" ? "selected" : ""}>http</option>
                <option value="https" ${String(playit.protocol || "") === "https" ? "selected" : ""}>https</option>
              </select>
            </div>
            <div class="field">
              <label for="playit-port">Fallback port</label>
              <input class="input" id="playit-port" name="fallbackPort" type="number" min="1" value="${escapeHtml(String(playit.fallbackPort || 25565))}" />
            </div>
          </div>
          <div class="field">
            <label for="playit-note">Notes</label>
            <textarea id="playit-note" name="note">${escapeHtml(playit.note || "")}</textarea>
          </div>
          <div class="actions">
            <button class="button button--primary" type="submit">SAVE TUNNEL</button>
            <button class="button" type="button" data-action="probe-playit">PROBE NOW</button>
          </div>
        </form>
        <div class="status-line">
          <span class="chip">Status: ${humanizePlayitState(playit)}</span>
          <span class="chip chip--quiet">Last check: ${escapeHtml(formatDateTime(playit.lastProbeAt))}</span>
          <span class="chip chip--quiet">Latency: ${escapeHtml(formatLatency(playit.lastProbeLatencyMs))}</span>
        </div>
        <div class="card" style="margin-top: 14px;">
          <div class="card-head">
            <div>
              <div class="field-title">Probe result</div>
              <p class="card-subtitle">${escapeHtml(playit.lastProbeMessage || "No probe run yet.")}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head">
          <div>
            <div class="field-title">Playit Agent</div>
            <p class="card-subtitle">If you want this panel to launch the local Playit process, configure the command here.</p>
          </div>
          <span class="badge ${runtime.running ? "badge--good" : "badge--bad"}">${runtime.running ? "RUNNING" : "STOPPED"}</span>
        </div>
        <form class="form-grid" data-form="update-playit-agent">
          <label class="check-row">
            <input type="checkbox" name="enabled" ${agentSettings.enabled ? "checked" : ""} />
            <span>Keep agent enabled</span>
          </label>
          <div class="field">
            <label for="agent-command">Agent command</label>
            <input class="input" id="agent-command" name="command" value="${escapeHtml(agentSettings.command || "")}" placeholder="playit.exe" />
          </div>
          <div class="field">
            <label for="agent-cwd">Working directory</label>
            <input class="input" id="agent-cwd" name="workingDirectory" value="${escapeHtml(agentSettings.workingDirectory || "")}" placeholder="C:\\Playit" />
          </div>
          <div class="field">
            <label for="agent-note">Note</label>
            <textarea id="agent-note" name="note">${escapeHtml(agentSettings.note || "")}</textarea>
          </div>
          <div class="actions">
            <button class="button button--primary" type="submit">SAVE AGENT</button>
            <button class="button" type="button" data-action="playit-agent-start">RUN</button>
            <button class="button button--ghost" type="button" data-action="playit-agent-stop">STOP</button>
          </div>
        </form>
        <pre class="console-output console-output--compact" data-role="agent-console-output">${lines
          .map((line) => `[${formatDateTime(line.ts)}] [${line.source}] ${line.message}`)
          .map(escapeHtml)
          .join("\n") || "No agent logs yet."}</pre>
      </div>
    </div>
  `;
}

function renderStatsTab(server) {
  const runtime = server.runtime || { lines: [] };
  const lines = Array.isArray(runtime.lines) ? runtime.lines : [];

  return `
    <div class="grid grid--three">
      <div class="card">
        <div class="field-title">Process</div>
        <h3 class="card-title">${escapeHtml(humanizeServerState(server))}</h3>
        <p class="card-subtitle">PID: ${escapeHtml(String(runtime.pid || server.pid || "--"))}</p>
      </div>
      <div class="card">
        <div class="field-title">Directory</div>
        <h3 class="card-title">${escapeHtml(server.directory)}</h3>
        <p class="card-subtitle">${escapeHtml(server.directoryLabel || "root")}</p>
      </div>
      <div class="card">
        <div class="field-title">Command</div>
        <h3 class="card-title">${escapeHtml(server.startCommand)}</h3>
        <p class="card-subtitle">Stop command: ${escapeHtml(server.stopCommand)}</p>
      </div>
      <div class="card">
        <div class="field-title">Playit</div>
        <h3 class="card-title">${escapeHtml(humanizePlayitState(server.playit))}</h3>
        <p class="card-subtitle">${escapeHtml(server.playit.lastProbeMessage || "No probe message yet")}</p>
      </div>
      <div class="card">
        <div class="field-title">Created</div>
        <h3 class="card-title">${escapeHtml(formatDateTime(server.createdAt))}</h3>
        <p class="card-subtitle">Updated ${escapeHtml(formatDateTime(server.updatedAt))}</p>
      </div>
      <div class="card">
        <div class="field-title">Console lines</div>
        <h3 class="card-title">${escapeHtml(String(lines.length))}</h3>
        <p class="card-subtitle">Current console buffer length in the panel.</p>
      </div>
    </div>
  `;
}

function renderServerDetail() {
  const server = selectedServer();

  if (!server) {
    return `
      <div class="panel">
        <div class="empty-state">
          Select a server from the list on the left, or add one to get started.
        </div>
      </div>
    `;
  }

  const tabs = [
    { id: "console", label: "Console" },
    { id: "files", label: "Files" },
    { id: "playit", label: "Playit.gg" },
    { id: "stats", label: "Stats" },
  ];

  return `
    <div class="panel">
      <div class="panel-top">
        <div>
          <div class="eyebrow">Server Console / Status</div>
          <h3 class="panel-title">${escapeHtml(server.name)}</h3>
          <p>${escapeHtml(server.notes || "No notes added yet.")}</p>
        </div>
        <div class="status-stack">
          <span class="badge ${server.running ? "badge--good" : "badge--bad"}">${humanizeServerState(server)}</span>
          <span class="badge ${server.playit.enabled ? (server.playit.reachable ? "badge--good" : "badge--bad") : "badge--quiet"}">${humanizePlayitState(server.playit)}</span>
          ${server.publicListing ? `<span class="badge badge--good">PUBLIC</span>` : `<span class="badge badge--quiet">PRIVATE</span>`}
        </div>
      </div>

      <div class="status-line">
        <span class="chip chip--quiet">Directory: ${escapeHtml(server.directory)}</span>
        <span class="chip chip--quiet">Start: ${escapeHtml(server.startCommand)}</span>
        <span class="chip chip--quiet">Updated: ${escapeHtml(formatDateTime(server.updatedAt))}</span>
      </div>

      <div class="actions" style="margin-top: 16px;">
        <button class="button button--primary" type="button" data-action="server-start">START</button>
        <button class="button" type="button" data-action="server-stop">STOP</button>
        <button class="button button--ghost" type="button" data-action="server-restart">RESTART</button>
      </div>

      <div class="tab-bar">
        ${tabs
          .map(
            (tab) => `
              <button
                type="button"
                class="tab ${state.selectedTab === tab.id ? "is-active" : ""}"
                data-action="select-tab"
                data-tab="${escapeHtml(tab.id)}"
              >
                ${escapeHtml(tab.label)}
              </button>
            `
          )
          .join("")}
      </div>

      ${state.selectedTab === "console"
        ? renderServerConsole(server)
        : state.selectedTab === "files"
          ? renderFilesTab(server)
          : state.selectedTab === "playit"
            ? renderPlayitTab(server)
            : renderStatsTab(server)}
    </div>
  `;
}

function renderSidebarAdmin() {
  return `
    ${renderBrandCard("MAIN MENU")}
    ${renderAddServerCard()}
    <div class="sidebar-section">
      <div class="sidebar-heading">
        <h2>Servers</h2>
        <span class="chip chip--quiet">${state.servers.length}</span>
      </div>
      ${renderServerList()}
    </div>
  `;
}

function renderSidebarPublic() {
  const overviewServers = state.publicOverview?.servers || [];

  return `
    ${renderBrandCard("PUBLIC WEBSITE")}
    <div class="sidebar-section">
      <div class="sidebar-heading">
        <h2>Public servers</h2>
        <span class="chip chip--quiet">${overviewServers.length}</span>
      </div>
      ${overviewServers.length
        ? `
          <div class="server-list">
            ${overviewServers
              .map(
                (server) => `
                  <div class="server-item">
                    <div class="server-item-top">
                      <div>
                        <h3>${escapeHtml(server.name)}</h3>
                        <p>${escapeHtml(server.notes || "Public listing")}</p>
                      </div>
                      <span class="dot ${server.running ? "is-on" : ""}"></span>
                    </div>
                    <div class="server-item-meta">
                      <span class="badge">${server.running ? "RUNNING" : "STOPPED"}</span>
                      <span class="badge">${server.playit.enabled ? (server.playit.reachable ? "REACHABLE" : "CHECKING") : "PRIVATE"}</span>
                    </div>
                  </div>
                `
              )
              .join("")}
          </div>
        `
        : `<div class="empty-state">No public servers are listed yet.</div>`}
    </div>
  `;
}

function renderAuthForms() {
  const registrationsOpen = state.summary?.allowRegistration ?? true;

  return `
    <div class="split">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="field-title">Sign in</div>
            <p class="card-subtitle">Already have an account? Jump back in.</p>
          </div>
        </div>
        <form class="form-grid" data-form="login">
          <div class="field">
            <label for="login-username">Username</label>
            <input class="input" id="login-username" name="username" required />
          </div>
          <div class="field">
            <label for="login-password">Password</label>
            <input class="input" id="login-password" name="password" type="password" required />
          </div>
          <div class="actions">
            <button class="button button--primary" type="submit">SIGN IN</button>
          </div>
        </form>
      </div>
      <div class="card">
        <div class="card-head">
          <div>
            <div class="field-title">Create account</div>
            <p class="card-subtitle">${registrationsOpen ? "Registration is open." : "Registration is currently closed."}</p>
          </div>
        </div>
        <form class="form-grid" data-form="register">
          <div class="field">
            <label for="register-username">Username</label>
            <input class="input" id="register-username" name="username" required />
          </div>
          <div class="field">
            <label for="register-password">Password</label>
            <input class="input" id="register-password" name="password" type="password" required />
          </div>
          <div class="actions">
            <button class="button button--primary" type="submit" ${registrationsOpen ? "" : "disabled"}>${registrationsOpen ? "CREATE ACCOUNT" : "REGISTER CLOSED"}</button>
          </div>
        </form>
        ${registrationsOpen
          ? `<p class="card-subtitle" style="margin-top: 12px;">The first account becomes the admin account automatically.</p>`
          : `<p class="card-subtitle" style="margin-top: 12px;">Ask an admin to reopen registration in the Website Panel settings.</p>`}
      </div>
    </div>
  `;
}

function renderPublicPortalMain() {
  const publicServers = state.publicOverview?.servers || [];
  const signedIn = Boolean(state.me);

  return `
    <div class="hero">
      <div class="hero-copy">
        <div class="eyebrow">Public Website Panel</div>
        <h2>${escapeHtml(state.settings.siteName || "Untitled Server Panel")}</h2>
        <p>${escapeHtml(
          state.settings.subtitle ||
            "A public, account-enabled portal for your local Minecraft servers. Clean monochrome, live status, and a simple web surface."
        )}</p>
      </div>
      <div class="hero-side">
        ${renderSummaryMetrics()}
        <div class="status-stack">
          <span class="chip">${signedIn ? `Signed in as ${state.me.username}` : "Guest access"}</span>
          <span class="chip">${signedIn ? state.me.role.toUpperCase() : "PUBLIC"}</span>
        </div>
      </div>
    </div>

    <div class="workspace">
      <div class="panel">
        <div class="panel-top">
          <div>
            <div class="eyebrow">Public Servers</div>
            <h3 class="panel-title">Visible status cards</h3>
            <p>Only servers you mark public will appear here.</p>
          </div>
        </div>
        ${publicServers.length
          ? `
            <div class="grid grid--two">
              ${publicServers
                .map(
                  (server) => `
                    <article class="card">
                      <div class="card-head">
                        <div>
                          <div class="field-title">${escapeHtml(server.name)}</div>
                          <p class="card-subtitle">${escapeHtml(server.notes || "Public listing")}</p>
                        </div>
                        <span class="badge ${server.running ? "badge--good" : "badge--bad"}">${server.running ? "RUNNING" : "STOPPED"}</span>
                      </div>
                      <div class="status-line">
                        <span class="chip">${server.playit.enabled ? (server.playit.reachable ? "REACHABLE" : "CHECKING") : "PRIVATE"}</span>
                        <span class="chip chip--quiet">${escapeHtml(server.playit.publicAddress || "No address")}</span>
                      </div>
                    </article>
                  `
                )
                .join("")}
            </div>
          `
          : `<div class="empty-state">There are no public servers visible yet.</div>`}
      </div>

      <div class="panel">
        <div class="panel-top">
          <div>
            <div class="eyebrow">${signedIn ? "Account" : "Access"}</div>
            <h3 class="panel-title">${signedIn ? `Welcome, ${state.me.username}` : "Sign in or create an account"}</h3>
            <p>${signedIn ? "Your account is ready. Use the logout button below if you want to switch identities." : "Use the forms below to access the public portal."}</p>
          </div>
          ${signedIn ? `<button class="button button--ghost" type="button" data-action="logout">LOG OUT</button>` : `<span class="badge">PUBLIC</span>`}
        </div>
        ${signedIn
          ? `
            <div class="card">
              <div class="field-title">Current account</div>
              <h3 class="card-title">${escapeHtml(state.me.username)}</h3>
              <p class="card-subtitle">Role: ${escapeHtml(state.me.role)}</p>
              <div class="status-line">
                <span class="chip">Created ${escapeHtml(formatDateTime(state.me.createdAt))}</span>
                <span class="chip chip--quiet">Access level ${escapeHtml(state.me.role.toUpperCase())}</span>
              </div>
            </div>
          `
          : renderAuthForms()}
      </div>
    </div>
  `;
}

function renderAdminPortalMain() {
  const server = selectedServer();

  return `
    <div class="hero">
      <div class="hero-copy">
        <div class="eyebrow">Admin Control Room</div>
        <h2>${escapeHtml(state.settings.siteName || "Untitled Server Panel")}</h2>
        <p>${escapeHtml(state.settings.subtitle || "Control local Minecraft servers, monitor Playit tunnels, and keep the public site tidy.")}</p>
      </div>
      <div class="hero-side">
        ${renderSummaryMetrics()}
        <div class="status-stack">
          <span class="chip">${state.me ? `Signed in as ${state.me.username}` : "Not signed in"}</span>
          <span class="chip">Selected: ${escapeHtml(server ? server.name : "none")}</span>
        </div>
      </div>
    </div>

    <div class="workspace">
      <div class="panel">
        ${renderServerDetail()}
      </div>
      <div class="stack">
        ${renderSettingsCard()}
        ${renderUsersCard()}
        ${renderPlayitAgentCard()}
      </div>
    </div>
  `;
}

function renderPublicShell() {
  return `
    <div class="shell">
      <aside class="sidebar">
        ${renderSidebarPublic()}
      </aside>
      <section class="main">
        ${renderPublicPortalMain()}
      </section>
    </div>
  `;
}

function renderAdminShell() {
  return `
    <div class="shell">
      <aside class="sidebar">
        ${renderSidebarAdmin()}
      </aside>
      <section class="main">
        ${renderAdminPortalMain()}
      </section>
    </div>
  `;
}

function renderLoading() {
  return `
    <section class="loading-screen">
      <div class="loading-card">
        <div class="loading-label">BOOTING</div>
        <h1>${escapeHtml(state.settings.siteName || "Untitled Server Panel")}</h1>
        <p>Loading the local control room...</p>
      </div>
    </section>
  `;
}

function renderApp() {
  document.title = state.settings.siteName || "Untitled Server Panel";

  let body = "";
  if (!state.bootstrapped || state.loading) {
    body = renderLoading();
  } else if (!state.me) {
    body = renderPublicShell();
  } else if (state.me.role === "admin") {
    body = renderAdminShell();
  } else {
    body = renderPublicShell();
  }

  app.innerHTML = `${body}${renderToastStack()}`;

  if (state.selectedTab === "console" || state.selectedTab === "playit") {
    scrollConsoleToBottom();
  }

  if (state.me?.role === "admin" && state.selectedServerId && state.selectedTab === "files" && !state.files.entries.length && !state.files.loading) {
    const currentServerId = state.selectedServerId;
    const currentPath = state.files.directoryPath || ".";
    const loadedFor = state.files.loadedFor;
    if (!loadedFor || loadedFor.serverId !== currentServerId || loadedFor.path !== currentPath) {
      loadDirectory(currentPath).catch((error) => notify("Files", error.message, "bad"));
    }
  }
}

async function handleLogin(form) {
  const payload = formToObject(form);
  await fetchJson("/api/login", {
    method: "POST",
    json: true,
    body: payload,
  });
  notify("Login", "Welcome back.", "good");
  await refreshBootstrap();
}

async function handleRegister(form) {
  const payload = formToObject(form);
  await fetchJson("/api/register", {
    method: "POST",
    json: true,
    body: payload,
  });
  notify("Account", "Account created.", "good");
  await refreshBootstrap();
}

async function handleCreateServer(form) {
  const payload = formToObject(form);
  payload.publicListing = Boolean(payload.publicListing);
  await fetchJson("/api/servers", {
    method: "POST",
    json: true,
    body: payload,
  });
  notify("Server", "Server created.", "good");
  await refreshBootstrap();
}

async function handleUpdateSettings(form) {
  const payload = formToObject(form);
  payload.allowRegistration = Boolean(payload.allowRegistration);
  await fetchJson("/api/settings", {
    method: "PATCH",
    json: true,
    body: payload,
  });
  notify("Website Panel", "Settings saved.", "good");
  await refreshBootstrap();
}

async function handleUpdateUserRole(form) {
  const userId = form.dataset.userId;
  const payload = formToObject(form);
  await fetchJson(`/api/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    json: true,
    body: payload,
  });
  notify("Users", "Account updated.", "good");
  await refreshBootstrap({ silent: true });
}

async function handleUpdatePlayitAgent(form) {
  const payload = formToObject(form);
  payload.enabled = Boolean(payload.enabled);
  await fetchJson("/api/playit/agent", {
    method: "PATCH",
    json: true,
    body: payload,
  });
  notify("Playit Agent", "Agent settings saved.", "good");
  await refreshBootstrap({ silent: true });
}

async function handleUpdateServerPlayit(form) {
  const payload = formToObject(form);
  payload.enabled = Boolean(payload.enabled);
  await fetchJson(`/api/servers/${encodeURIComponent(state.selectedServerId)}/playit`, {
    method: "PATCH",
    json: true,
    body: payload,
  });
  notify("Playit", "Tunnel settings saved.", "good");
  await refreshBootstrap({ silent: true });
}

async function handleSendCommand(form) {
  const payload = formToObject(form);
  if (!payload.command) {
    notify("Console", "Type a command first.", "bad");
    return;
  }

  await fetchJson(`/api/servers/${encodeURIComponent(state.selectedServerId)}/command`, {
    method: "POST",
    json: true,
    body: payload,
  });
  form.reset();
  notify("Console", "Command sent.", "good");
}

async function handleSaveFile(form) {
  await saveFileContent(form);
}

async function handleServerControl(action) {
  const id = state.selectedServerId;
  if (!id) {
    return;
  }

  const url = `/api/servers/${encodeURIComponent(id)}/${action}`;
  await fetchJson(url, {
    method: "POST",
    json: true,
    body: {},
  });
  notify("Server", action === "start" ? "Server starting." : action === "stop" ? "Server stopping." : "Restart queued.", "good");
  await refreshBootstrap({ silent: true });
}

async function handlePlayitAgentControl(action) {
  const url = `/api/playit/agent/${action}`;
  await fetchJson(url, {
    method: "POST",
    json: true,
    body: {},
  });
  notify("Playit Agent", action === "start" ? "Agent starting." : "Agent stopping.", "good");
  await refreshBootstrap({ silent: true });
}

async function handlePlayitProbe() {
  const id = state.selectedServerId;
  if (!id) {
    return;
  }

  const payload = await fetchJson(`/api/servers/${encodeURIComponent(id)}/playit/probe`, {
    method: "POST",
    json: true,
    body: {},
  });
  notify("Playit", payload.result?.message || "Probe complete.", payload.result?.ok ? "good" : "bad");
  await refreshBootstrap({ silent: true });
}

async function handleLogout() {
  await fetchJson("/api/logout", {
    method: "POST",
    json: true,
    body: {},
  });
  notify("Session", "Logged out.", "good");
  await refreshBootstrap();
}

async function handleActionButton(actionEl) {
  const action = actionEl.dataset.action;

  switch (action) {
    case "select-server":
      setSelectedServer(actionEl.dataset.serverId);
      return;
    case "select-tab":
      setSelectedTab(actionEl.dataset.tab);
      return;
    case "server-start":
      await handleServerControl("start");
      return;
    case "server-stop":
      await handleServerControl("stop");
      return;
    case "server-restart":
      await handleServerControl("restart");
      return;
    case "refresh-files":
      await loadDirectory(state.files.directoryPath || ".");
      return;
    case "load-directory": {
      const pathValue = actionEl.dataset.path || ".";
      await loadDirectory(pathValue);
      return;
    }
    case "open-file":
      await loadFile(actionEl.dataset.path);
      return;
    case "logout":
      await handleLogout();
      return;
    case "playit-agent-start":
      await handlePlayitAgentControl("start");
      return;
    case "playit-agent-stop":
      await handlePlayitAgentControl("stop");
      return;
    case "probe-playit":
      await handlePlayitProbe();
      return;
    default:
      return;
  }
}

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) {
    return;
  }

  event.preventDefault();

  try {
    const formName = form.dataset.form;
    switch (formName) {
      case "login":
        await handleLogin(form);
        break;
      case "register":
        await handleRegister(form);
        break;
      case "create-server":
        await handleCreateServer(form);
        break;
      case "update-settings":
        await handleUpdateSettings(form);
        break;
      case "update-user-role":
        await handleUpdateUserRole(form);
        break;
      case "update-playit-agent":
        await handleUpdatePlayitAgent(form);
        break;
      case "update-server-playit":
        await handleUpdateServerPlayit(form);
        break;
      case "send-command":
        await handleSendCommand(form);
        break;
      case "save-file":
        await handleSaveFile(form);
        break;
      default:
        break;
    }
  } catch (error) {
    notify("Error", error.message, "bad");
  }
});

document.addEventListener("click", async (event) => {
  const actionEl = event.target.closest("[data-action]");
  if (!actionEl) {
    return;
  }

  event.preventDefault();

  try {
    await handleActionButton(actionEl);
  } catch (error) {
    notify("Error", error.message, "bad");
  }
});

document.addEventListener("input", (event) => {
  if (event.target.matches('[data-role="file-editor"]')) {
    state.files.content = event.target.value;
  }
});

async function bootstrap() {
  try {
    await refreshBootstrap();
  } catch (error) {
    state.loading = false;
    state.bootstrapped = true;
    notify("Bootstrap", error.message, "bad");
    scheduleRender();
  }

  if (state.me?.role === "admin" && state.selectedTab === "files" && state.selectedServerId) {
    try {
      await loadDirectory(".");
    } catch (error) {
      notify("Files", error.message, "bad");
    }
  }
}

bootstrap();
