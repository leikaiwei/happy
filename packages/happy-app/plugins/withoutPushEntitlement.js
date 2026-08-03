const { withEntitlementsPlist } = require("@expo/config-plugins");

// A free Apple Account ("Personal Team") cannot sign the Push Notifications
// capability, and expo-notifications writes aps-environment unconditionally,
// so automatic signing fails outright. Strip the key so a locally signed
// build can be produced. Remote push stops working; local notifications,
// which need no entitlement, keep working.
module.exports = function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (config) => {
    delete config.modResults["aps-environment"];
    return config;
  });
};
