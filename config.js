exports.host = process.env.BLHOST || "brainlife.io";
exports.ssl = process.env.BLSSL !== "false";

exports.api = {
    auth: (exports.ssl ? "https" : "http") + "://" + exports.host + "/api/auth",
    amaretti:
        (exports.ssl ? "https" : "http") +
        "://" +
        exports.host +
        "/api/amaretti",
    warehouse:
        (exports.ssl ? "https" : "http") +
        "://" +
        exports.host +
        "/api/warehouse",
    event_ws:
        (exports.ssl ? "wss" : "ws") + "://" + exports.host + "/api/event",
};
exports.api.wf = exports.api.amaretti; //deprecated .. use api.amaretti

exports.path = {
    jwt: process.env.HOME + "/.config/" + exports.host.split(":")[0] + "/.jwt",
};
