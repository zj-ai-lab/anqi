'use strict';

function shouldPreventClose(platform, quitting) {
  return platform === 'darwin' && !quitting;
}

module.exports = { shouldPreventClose };
