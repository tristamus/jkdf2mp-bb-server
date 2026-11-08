// Stand-ins for the parts of the Cloudflare runtime that src/lobby.js uses, so
// its Lobby can run in plain Node.js (test/passwords.mjs imports lobby.js with
// cloudflare:workers pointed here). Not the real thing: no hibernation, and
// alarms are only kept, never run by themselves.

export class DurableObject {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
    }
}

// The lobby's end of a WebSocket. What the lobby sends piles up in sent.
export class FakeWs {
    constructor() {
        this.sent = [];
        this.att = null;
        this.closed = null;
    }
    send(data) {
        if (this.closed)
            throw new Error("closed");
        this.sent.push(data);
    }
    serializeAttachment(a) {
        this.att = JSON.parse(JSON.stringify(a));
    }
    deserializeAttachment() {
        return this.att && JSON.parse(JSON.stringify(this.att));
    }
    close(code, reason) {
        this.closed = this.closed || [code, reason];
    }
    // What it was sent since the last take.
    take() {
        const s = this.sent;
        this.sent = [];
        return s;
    }
}

globalThis.WebSocketPair = function () {
    return { 0: new FakeWs(), 1: new FakeWs() };
};
globalThis.WebSocketRequestResponsePair = function (request, response) {
    this.request = request;
    this.response = response;
};
// Node's own refuses status 101.
globalThis.Response = class {
    constructor(body, init) {
        this.body = body;
        Object.assign(this, init || {});
    }
};

// Durable Object storage, its values copied in and out as structured data.
export class FakeStorage {
    constructor() {
        this.m = new Map();
        this.alarm = null;
    }
    async get(key) {
        return this.m.get(key);
    }
    put(key, value) {
        const all = typeof key === "object" ? key : { [key]: value };
        for (const [k, v] of Object.entries(all))
            this.m.set(k, structuredClone(v));
        return Promise.resolve();
    }
    async list({ prefix }) {
        return new Map([...this.m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]));
    }
    delete(keys) {
        for (const k of [].concat(keys))
            this.m.delete(k);
        return Promise.resolve();
    }
    async getAlarm() {
        return this.alarm;
    }
    setAlarm(at) {
        this.alarm = at;
        return Promise.resolve();
    }
}

// The object's state: its storage and the sockets it accepted (a restart
// keeps them, an update closes them all).
export class FakeCtx {
    constructor(storage, sockets) {
        this.storage = storage;
        this.sockets = sockets || [];
        this.ready = null;
    }
    acceptWebSocket(ws) {
        this.sockets.push(ws);
    }
    getWebSockets() {
        return this.sockets.filter(ws => !ws.closed);
    }
    setWebSocketAutoResponse() {}
    getWebSocketAutoResponseTimestamp() {
        return null;
    }
    blockConcurrencyWhile(fn) {
        this.ready = fn();
        return this.ready;
    }
}
