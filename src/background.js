'use strict';

// Tracker Lens - service-worker entry point.
//
// 1. On install / start, surface the welcome page once.
// 2. Schedule a daily prune so IndexedDB doesn't grow forever.
// 3. Provide a click handler for the toolbar icon as a fall-back if the
//    panel popup is ever removed.

const PRUNE_ALARM = 'tracker-lens-prune';
const PRUNE_DAYS = 30;

archive.ready.then(async () => {
	if (await archive.isFirstRun()) {
		chrome.tabs.create({ url: 'welcome.html' });
	}
	chrome.alarms.create(PRUNE_ALARM, {
		delayInMinutes: 60,
		periodInMinutes: 24 * 60
	});
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name !== PRUNE_ALARM) return;
	archive.ready.then(() => archive.pruneOlderThan(PRUNE_DAYS));
});

async function focusOrOpenPanel() {
	const panelUrl = chrome.runtime.getURL('popup.html');
	const tabs = await chrome.tabs.query({});
	const open = tabs.find((t) => t.url === panelUrl) || null;
	if (!open) {
		chrome.tabs.create({ url: 'popup.html' });
	} else if (!open.active) {
		chrome.tabs.update(open.id, { active: true });
	}
}

chrome.action.onClicked.addListener(focusOrOpenPanel);
