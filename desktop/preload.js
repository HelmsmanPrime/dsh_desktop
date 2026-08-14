// DSH Desktop — preload 脚本(上下文隔离)
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("dshDesktop", {
  version: "0.1.0",
  platform: process.platform,
});
