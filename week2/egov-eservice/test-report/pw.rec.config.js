const base = require("../playwright.config.js")
module.exports = { ...base, testDir: "../.tests-rec", outputDir: "./artifacts-rec", reporter: [["list"]] }
