'use strict';

// Tracker Lens - popup ↔ service-worker bridge.
//
// `bridge` is a Proxy. Calling `bridge.foo(args…)` from the popup posts
// `{ type: 'archiveCall', method: 'foo', args }` to the service worker, which
// dispatches to `archive[foo]`.
//
// `bridge.onUpdate(cb)` registers a callback for live `panelPush` events
// that the service worker fires when a new third party becomes visible.

const bridge = (() => {
	const subscribers = new Set();

	chrome.runtime.onMessage.addListener((msg) => {
		if (!msg || msg.type !== 'panelPush') return;
		for (const cb of subscribers) cb(msg.payload);
	});

	const handler = {
		get(_target, prop) {
			if (prop === 'onUpdate') {
				return (cb) => subscribers.add(cb);
			}
			if (prop === 'offUpdate') {
				return (cb) => subscribers.delete(cb);
			}
			return (...args) => chrome.runtime.sendMessage({
				type: 'archiveCall',
				method: prop,
				args
			});
		}
	};

	return new Proxy({}, handler);
})();

if (typeof window !== 'undefined') window.bridge = bridge;
