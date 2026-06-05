const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("desktopPanel", {
  platform: process.platform,
  isDesktop: true,
});
