// Use Workers' native streams instead of ExcelJS's browser stream shim.
module.exports = require('node:stream')
