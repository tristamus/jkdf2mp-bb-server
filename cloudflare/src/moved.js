// The site moved from its workers.dev address to its own domain (SITE and
// MOVED_FROM in wrangler.toml). A page load on the old address is sent to the
// same path and options on SITE, with "moved" added, so the page there offers
// to bring over what the browser saved under the old address (characters,
// settings, saved game files, mods, screenshots): a page can only read what
// was saved under its own address. A page load on www goes to SITE as it is.
//
// Two paths stay where they are on every address. /relay, because a browser
// fails a WebSocket that gets a redirect, and a tab opened on the old address
// before the move keeps reconnecting there: it's the same Worker, so the same
// lobby. And the page that hands the saved files over, which has to run on
// the old address to read them.

const STAY = new Set(["/relay", "/move-out", "/move-out.html"]);

// Where a request should go instead, or null to serve it here. site and from
// are origins ("https://jediknight.zone"); without site nothing moves.
export function movedTo(url, site, from) {
    if (!site || STAY.has(url.pathname))
        return null;
    const home = new URL(site);
    if (url.host === home.host)
        return null;
    let search = url.search;
    if (from && url.host === new URL(from).host)
        search += (search ? "&" : "?") + "moved";
    else if (url.host !== "www." + home.host)
        return null;
    return home.origin + url.pathname + search;
}

// MOVED_STATUS: 302 while the move is checked, then 301, which browsers keep
// for good.
export function movedStatus(text) {
    const status = Number(text);
    return [301, 302, 307, 308].includes(status) ? status : 302;
}
