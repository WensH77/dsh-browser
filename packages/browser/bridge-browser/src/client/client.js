// dsh-bridge-browser — browser half: mark the session that holds the browser.
//
// The dsh Web GUI's session list marks a session that currently owns a
// controlled Chrome tab, so the user can see at a glance which conversation is
// driving the browser (and which one to switch back to).
//
// Why a DOM attribute and a pseudo-element instead of a slot:
// `sidebar.session.row.leading` is mounted only while the session is idle — a
// non-idle row puts its state dot (the spinner) in that seat instead, and an
// archived row keeps it blank (dsh-client-ui-workspace, SessionNodeItem). The
// indicator has to stay visible in both states and may sit on top of the
// spinner, so the row element itself is tagged and the glyph is drawn with CSS.
// React maintains only the props it declared, so an extra `data-*` attribute
// survives re-renders; a MutationObserver re-tags a row that React recreates.
//
// Data comes from the plugin's own route (`GET /bridge-browser/bindings`),
// which serves the last report the extension sent over `bridge.bindings`.
// Polling is deliberately modest: bindings change on a bind, an unbind, or a
// tab close — never per model step.
//
// Scope: the sidebar's session rows only. The search-results list renders its
// own row element without `data-row-key`, so a pinned session is not marked
// while the user is searching; the marker returns with the session list.
window.__ModuleLoader__.load({
  id: "dsh-bridge-browser",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** Route the host plugin registers for this snapshot. */
    const ROUTE = "/bridge-browser/bindings";
    /** Marks a row whose session currently holds a controlled tab. */
    const ATTR = "data-dsh-browser-bound";
    /** Row selector: the dsh session list keys every session row this way. */
    const ROW = '[data-row-key^="session:"]';
    /** Steady poll interval; bindings are low-frequency. */
    const POLL_MS = 5000;
    /** Backoff ceiling after repeated failures. */
    const MAX_MS = 30000;
    /** Coalescing window for re-tagging after a DOM change. */
    const SYNC_DEBOUNCE_MS = 200;
    /** One poll must not hang forever on a stuck connection. */
    const REQUEST_TIMEOUT_MS = 4000;

    // The indicator glyph (a globe: outer ring, three spokes, central dot),
    // rendered as an alpha mask so its colour comes from a theme token
    // (`background-image` cannot use `currentColor`).
    const GLYPH = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none'%3E%3Cpath d='M24 15C28.9706 15 33 19.0294 33 24C33 28.9706 28.9706 33 24 33C19.0294 33 15 28.9706 15 24C15 19.0294 19.0294 15 24 15ZM24 15H41.8654M17 42.7408L29.6439 31M6 15.2717L16.8751 29.552M24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z' stroke='%23000' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

    // The badge sits in the row's leading cell: 16x20, centred at
    // `8px + indent + 8px` horizontally and at the 32px row's midpoint.
    //
    // 9px keeps the glyph inside the running row's 14px spinner (outer radius
    // ~6.1px, stroke ~1.2px, so the free inner diameter is ~9.9px) instead of
    // covering it: no background disc, and the ring stays visible around the
    // glyph.
    //
    // The colour follows the state the row's own status dot already encodes —
    // read off the dot's `data-state`, so no extra data channel is involved:
    // idle/running keep the brand accent, a pending approval/question is amber,
    // completion green, failure red.
    const css = [
      ROW + "{position:relative}",
      ROW + "[" + ATTR + "]::after{content:\"\";position:absolute;pointer-events:none;inset-inline-start:calc(8px + var(--dsh-workspace-indent,0px) + 8px);top:16px;transform:translate(-50%,-50%);width:9px;height:9px;background-color:var(--dsw-alias-state-business-primary);-webkit-mask:" + GLYPH + " center/contain no-repeat;mask:" + GLYPH + " center/contain no-repeat}",
      ROW + "[" + ATTR + "]:has(> span:first-child > span[data-state=\"warning\"])::after{background-color:var(--dsw-alias-state-warn-primary)}",
      ROW + "[" + ATTR + "]:has(> span:first-child > span[data-state=\"done\"])::after{background-color:var(--dsw-alias-state-success-primary)}",
      ROW + "[" + ATTR + "]:has(> span:first-child > span[data-state=\"error\"])::after{background-color:var(--dsw-alias-state-error-primary)}",
    ].join("");

    const tagId = "dsh-bridge-browser/session-badge.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-bridge-browser";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /**
     * Session ids out of one route response.
     *
     * A malformed or unsupported response yields an empty set rather than an
     * error: no extension, an extension too old to report, and "nothing bound"
     * all look the same to this surface, and none of them should leave a stale
     * marker behind.
     *
     * @param payload - parsed JSON body.
     * @returns the session ids holding a tab.
     */
    function boundSessionIds(payload) {
      const ids = new Set();
      if (payload === null || typeof payload !== "object" || !Array.isArray(payload.bindings)) return ids;
      for (const entry of payload.bindings) {
        if (entry === null || typeof entry !== "object") continue;
        if (typeof entry.sessionId === "string" && entry.sessionId !== "") ids.add(entry.sessionId);
      }
      return ids;
    }

    /**
     * Mount the badge: poll the host route, tag matching rows, and re-tag after
     * the list re-renders.
     *
     * @param ctx - client root context (unused: this surface reads no service).
     * @returns teardown for HMR and plugin unload.
     */
    function apply(ctx) {
      let bound = new Set();
      let timer;
      let syncTimer;
      let controller;
      let timeoutTimer;
      let delay = POLL_MS;
      let inFlight = false;
      let stopped = false;

      /** One batched pass: tag bound rows, clear the rest. Compares before writing. */
      const sync = () => {
        if (stopped || typeof document === "undefined") return;
        for (const row of document.querySelectorAll(ROW)) {
          const key = row.getAttribute("data-row-key") ?? "";
          const want = bound.has(key.slice("session:".length));
          if (want === row.hasAttribute(ATTR)) continue;
          if (want) row.setAttribute(ATTR, "");
          else row.removeAttribute(ATTR);
        }
      };

      // Coalesce a burst of DOM work into one pass. The observer watches the
      // whole body (rows are created deep in the sidebar), and a streaming
      // conversation mutates it continuously, so scanning once per frame would
      // spend work on a list that changes far less often than the chat does.
      const scheduleSync = () => {
        if (syncTimer !== undefined || stopped || typeof document === "undefined") return;
        syncTimer = setTimeout(() => {
          syncTimer = undefined;
          sync();
        }, SYNC_DEBOUNCE_MS);
      };

      const arm = (ms) => {
        if (stopped) return;
        timer = setTimeout(load, ms);
      };

      const load = async () => {
        // A hidden page needs no live indicator: stop polling entirely and let
        // `visibilitychange` resume it, instead of waking up every interval.
        if (stopped || inFlight || (typeof document !== "undefined" && document.hidden)) return;
        inFlight = true;
        controller = typeof AbortController === "function" ? new AbortController() : undefined;
        if (controller !== undefined) {
          timeoutTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        }
        try {
          const response = await fetch(ROUTE, {
            cache: "no-store",
            ...(controller === undefined ? {} : { signal: controller.signal }),
          });
          if (!response.ok) {
            // The route is gone or refused (plugin disabled, authentication
            // lost): clear the marker rather than leaving a stale one until the
            // next success, and back off like any other failure.
            bound = new Set();
            sync();
            throw new Error("HTTP " + response.status);
          }
          bound = boundSessionIds(await response.json());
          delay = POLL_MS;
          sync();
        } catch (error) {
          if (stopped) return;
          delay = Math.min(Math.round(delay * 2), MAX_MS);
        } finally {
          if (timeoutTimer !== undefined) {
            clearTimeout(timeoutTimer);
            timeoutTimer = undefined;
          }
          controller = undefined;
          inFlight = false;
          if (!stopped) arm(delay);
        }
      };

      // The session list is React-rendered: rows appear, disappear, and are
      // recreated on key changes. Watch structure only (`data-row-key` is the
      // row's own identity attribute), never ATTR itself — that would loop.
      const observer = typeof MutationObserver === "function" ? new MutationObserver(scheduleSync) : undefined;
      const root = typeof document === "undefined" ? undefined : document.body ?? document.documentElement;
      if (observer !== undefined && root !== undefined && root !== null) {
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-row-key"],
        });
      }

      const onVisibility = () => {
        if (typeof document === "undefined" || document.hidden) return;
        if (timer !== undefined) clearTimeout(timer);
        delay = POLL_MS;
        sync();
        void load();
      };
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

      void load();

      return () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
        if (syncTimer !== undefined) clearTimeout(syncTimer);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (controller !== undefined) controller.abort();
        if (observer !== undefined) observer.disconnect();
        if (typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", onVisibility);
          for (const row of document.querySelectorAll("[" + ATTR + "]")) row.removeAttribute(ATTR);
        }
      };
    }

    exports.apply = apply;
    return module.exports;
  },
});
