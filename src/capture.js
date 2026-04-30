'use strict';

// Tracker Lens - request capture.
//
// Subscribes to webRequest + tabs.onUpdated and feeds events into the archive.
// Two pipelines:
//   1. webRequest.onResponseStarted → recordThirdPartyLink(initiator, target)
//   2. tabs.onUpdated (status: complete) → recordFirstParty(host)
//                                       → snapshot Performance/Cookie state

const SKIP_PROTOCOLS = new Set([
	'about:', 'chrome:', 'chrome-extension:', 'chrome-search:'
]);

function safeUrl(raw) {
	if (!raw) return null;
	try { return new URL(raw); } catch (e) { return null; }
}

function paramsFrom(url) {
	const queryStart = url.indexOf('?');
	const raw = queryStart === -1 ? url : url.slice(queryStart + 1);
	const parts = raw.split('&').map((s) => {
		try { return decodeURIComponent(s); } catch (e) { return s; }
	});
	return parts.length > 1 ? parts : undefined;
}

function uniqueSorted(arr) {
	return Array.from(new Set(arr)).sort();
}

function reachableTab(tabId) {
	return tabId !== chrome.tabs.TAB_ID_NONE;
}

const capture = {
	queue: [],
	running: false,
	// tabId -> Set<thirdPartyHostname>. In-memory; survives the SW lifetime
	// only, which is fine - badges are a transient UX hint, not state.
	tabTrackers: new Map(),

	start() {
		chrome.webRequest.onResponseStarted.addListener(
			(response) => this._onResponse(response),
			{ urls: ['<all_urls>'] }
		);

		chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
			if (changeInfo.status === 'loading') {
				// Page is navigating away; reset the tracker count for this tab.
				this.tabTrackers.delete(tabId);
				chrome.action.setBadgeText({ tabId, text: '' });
			}
			if (changeInfo.status === 'complete' && tab && tab.url) {
				this._snapshotCookies(tabId, tab.url);
			}
			const documentUrl = safeUrl(tab && tab.url);
			if (!documentUrl || SKIP_PROTOCOLS.has(documentUrl.protocol)) return;
			this.queue.push({ kind: 'firstParty', tabId, changeInfo, tab });
			this._drain();
		});

		chrome.tabs.onRemoved.addListener((tabId) => {
			this.tabTrackers.delete(tabId);
		});
	},

	_noteTracker(tabId, hostname) {
		if (tabId === chrome.tabs.TAB_ID_NONE || !hostname) return;
		let set = this.tabTrackers.get(tabId);
		if (!set) {
			set = new Set();
			this.tabTrackers.set(tabId, set);
		}
		if (set.has(hostname)) return;
		set.add(hostname);
		chrome.action.setBadgeText({ tabId, text: String(set.size) });
		chrome.action.setBadgeBackgroundColor({ tabId, color: '#fbbf24' });
	},

	_onResponse(response) {
		const initiator = safeUrl(response.initiator);
		if (!initiator) return;
		if (SKIP_PROTOCOLS.has(initiator.protocol)) return;
		this.queue.push({ kind: 'thirdParty', response });
		this._drain();
	},

	async _drain() {
		if (this.running) return;
		this.running = true;
		try {
			while (this.queue.length) {
				const event = this.queue.shift();
				try {
					if (event.kind === 'firstParty') {
						await this._handleFirstParty(event);
					} else if (event.kind === 'thirdParty') {
						await this._handleThirdParty(event);
					}
				} catch (err) {
					console.warn('capture: queue item failed -', err);
				}
			}
		} finally {
			this.running = false;
		}
	},

	async _handleFirstParty({ tab }) {
		const documentUrl = safeUrl(tab && tab.url);
		if (!documentUrl || !documentUrl.hostname) return;
		if (tab.status !== 'complete') return;
		await archive.recordFirstParty(documentUrl.hostname, {
			firstParty: true,
			requestTime: Date.now()
		});
	},

	async _handleThirdParty({ response }) {
		if (!reachableTab(response.tabId)) return;
		const initiator = safeUrl(response.initiator);
		const target = safeUrl(response.url);
		if (!initiator || !target) return;
		if (!initiator.hostname || target.hostname === initiator.hostname) return;
		await archive.recordThirdPartyLink(
			initiator.hostname,
			target.hostname,
			{
				info: paramsFrom(response.url),
				target: target.hostname,
				origin: initiator.hostname,
				requestTime: response.timeStamp,
				firstParty: false
			}
		);
		this._noteTracker(response.tabId, target.hostname);
	},

	// --------------------------------------- cookie snapshot --------------

	_snapshotCookies(tabId, pageUrl) {
		const documentUrl = safeUrl(pageUrl);
		if (!documentUrl || SKIP_PROTOCOLS.has(documentUrl.protocol)) return;

		chrome.scripting.executeScript({
			target: { tabId },
			func: () => performance.getEntriesByType('resource').map((e) => e.name)
		}, async (results) => {
			if (chrome.runtime.lastError) return;
			if (!results || !results[0] || !Array.isArray(results[0].result)) return;

			const urls = uniqueSorted(
				results[0].result.map((u) => u.split(/[#?]/)[0]).filter(Boolean)
			);

			const cookieGroups = await Promise.all(urls.map((url) =>
				new Promise((resolve) => chrome.cookies.getAll({ url }, resolve))
			));

			const flat = [].concat(...cookieGroups);
			const dedup = Array.from(
				new Map(flat.map((c) => [JSON.stringify(c), c])).values()
			);

			const pageRoot = archive.registrableDomain(documentUrl.hostname);
			const thirdParties = uniqueSorted(
				dedup.map((c) => archive.registrableDomain(c.domain || ''))
					.filter((host) => host && host.split('.')[0] !== pageRoot.split('.')[0])
			);

			const snapshot = {
				hostname: pageRoot,
				CookiesInTab: dedup,
				uThirdParties: thirdParties
			};

			try {
				await archive.recordCookieSnapshot(snapshot, pageUrl);
			} catch (err) {
				console.warn('capture: cookie snapshot failed -', err);
			}
		});
	}
};

if (typeof self !== 'undefined') self.capture = capture;

archive.ready.then(() => capture.start());
