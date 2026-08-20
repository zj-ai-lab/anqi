'use strict';

const { basename } = require('node:path');

module.exports = {
  basename: basename(__filename.replace(/\.cjs$/u, '.mjs')),
};
