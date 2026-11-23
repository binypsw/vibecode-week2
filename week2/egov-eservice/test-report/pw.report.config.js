const base = require("../playwright.config.js")
module.exports = {
  ...base,
  testDir: "../tests",
  outputDir: "./artifacts",
  reporter: [["list"], ["json", { outputFile: "results.json" }], ["html", { outputFolder: "html", open: "never" }]],
  use: { ...base.use, video: { mode: "on", size: { width: 800, height: 450 } }, screenshot: "only-on-failure" },
}
