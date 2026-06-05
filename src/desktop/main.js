const path = require("path");
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");

let mainWindow = null;
let panelServer = null;

function configureDesktopEnvironment() {
  process.env.HOST = "127.0.0.1";
  process.env.PORT = "0";
  process.env.USP_DATA_DIR = path.join(app.getPath("userData"), "data");
}

function buildMenu(panelUrl) {
  return Menu.buildFromTemplate([
    {
      label: "Panel",
      submenu: [
        {
          label: "Open in Browser",
          click: () => {
            shell.openExternal(panelUrl);
          },
        },
        { type: "separator" },
        {
          label: "Quit",
          role: "quit",
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ]);
}

async function createMainWindow() {
  configureDesktopEnvironment();

  const { startPanelServer } = require("../../server");
  panelServer = await startPanelServer({
    host: "127.0.0.1",
    port: 0,
    log: false,
  });

  Menu.setApplicationMenu(buildMenu(panelServer.url));

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: "Untitled Server Panel",
    backgroundColor: "#050505",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(panelServer.url);
}

app.whenReady().then(() => {
  createMainWindow().catch((error) => {
    dialog.showErrorBox("Unable to start panel", error.message);
    app.quit();
  });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow().catch((error) => {
      dialog.showErrorBox("Unable to start panel", error.message);
    });
  }
});

app.on("before-quit", async (event) => {
  if (!panelServer) {
    return;
  }

  event.preventDefault();
  const { stopPanelServer } = require("../../server");
  panelServer = null;
  await stopPanelServer();
  app.quit();
});

app.on("window-all-closed", () => {
  app.quit();
});
