/* Shared by the dashboard and Node's local tests. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SSSVisibility = api;
})(globalThis, function () {
  'use strict';
  return {
    visibleServers: function (servers) {
      return (Array.isArray(servers) ? servers : []).filter(function (server) {
        return !!server && server.hidden !== true;
      });
    }
  };
});
