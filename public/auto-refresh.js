/**
 * public/auto-refresh.js
 *
 * Drop this file into your public/ folder and add ONE line to the bottom of
 * every display page, live.html, medals.html and result-booklet.html:
 *
 *     <script src="/auto-refresh.js"></script>
 *
 * It polls /api/version (a tiny endpoint that returns a single number) every
 * 3 seconds. That number only changes when something is actually written to
 * the data files, so 99% of polls cost almost nothing. When it does change,
 * your page's own refresh function is called.
 *
 * If your page already has a function called loadResults(), loadData(),
 * refresh() or render(), this will find and call it automatically. If not,
 * it falls back to reloading the page.
 */
(function () {
    'use strict';

    var POLL_MS = 3000;
    var lastVersion = null;
    var failures = 0;

    function findRefreshFunction() {
        var names = ['loadResults', 'refreshData', 'loadData', 'refresh', 'render', 'init', 'load'];
        for (var i = 0; i < names.length; i++) {
            if (typeof window[names[i]] === 'function') return window[names[i]];
        }
        return null;
    }

    function onChange() {
        var fn = findRefreshFunction();
        if (fn) {
            try {
                fn();
                return;
            } catch (err) {
                console.error('[auto-refresh] refresh function threw, reloading instead', err);
            }
        }
        window.location.reload();
    }

    function poll() {
        fetch('/api/version', { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                failures = 0;
                if (lastVersion === null) {
                    lastVersion = data.version;
                    return;
                }
                if (data.version !== lastVersion) {
                    lastVersion = data.version;
                    onChange();
                }
            })
            .catch(function (err) {
                failures++;
                if (failures === 1) console.warn('[auto-refresh] poll failed:', err.message);
            });
    }

    // Don't poll while the scoreboard tab is hidden - saves the free-tier
    // instance from pointless wake-ups.
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) poll();
    });

    poll();
    setInterval(function () {
        if (!document.hidden) poll();
    }, POLL_MS);
})();
