'use strict';

// Tracker Lens - popup panel orchestration.
//
// Wires the static HTML up to:
//   bridge -> service-worker archive (read network, reset, etc.)
//   graph  -> D3 visualisation
//
// Sections:
//   boot()        - initial paint
//   loadGraph()   - pull network from SW, transform, hand to graph
//   bindActions() - button handlers
//   liveUpdate()  - handle pushed updates from the SW

// Local mirror of the network so we can patch incrementally without a full
// re-query on every push.
const network = { sites: {} };

// Lazy-loaded category map: registrable-domain -> [category, ...].
let categoryMap = null;

async function boot() {
	loadCategoryMap(); // fire-and-forget; tooltip waits if needed
	await loadGraph();
	bindActions();
}

async function loadCategoryMap() {
	if (categoryMap) return categoryMap;
	try {
		const res = await fetch('/src/categories-third-party.json');
		categoryMap = await res.json();
	} catch (e) {
		categoryMap = {};
	}
	return categoryMap;
}

async function loadGraph() {
	network.sites = (await bridge.getNetwork()) || {};
	tagCategories(network.sites);
	const { nodes, links } = projectForGraph(network.sites);
	graph.render(nodes, links);
}

function tagCategories(sites) {
	if (!categoryMap) return;
	for (const host in sites) {
		const site = sites[host];
		if (site.firstParty) continue;
		const cats = categoryMap[rootDomain(host)];
		if (Array.isArray(cats) && cats.length) site.category = cats[0];
	}
}

function rootDomain(host) {
	const parts = host.split('.');
	if (parts.length <= 2) return host;
	const last = parts[parts.length - 1];
	const second = parts[parts.length - 2];
	if (last.length === 2 && second.length === 2 && parts.length >= 3) {
		return parts.slice(-3).join('.');
	}
	return parts.slice(-2).join('.');
}

function projectForGraph(sites) {
	const nodes = [];
	const links = [];
	const present = new Set(Object.keys(sites));
	for (const host in sites) {
		const site = sites[host];
		nodes.push(site);
		if (Array.isArray(site.thirdParties)) {
			for (const t of site.thirdParties) {
				// Skip dangling links - d3.forceLink throws on string IDs that
				// don't resolve to a node in the current set.
				if (present.has(t)) links.push({ source: host, target: t });
			}
		}
	}
	return { nodes, links };
}

// action bindings

function bindActions() {
	bindSaveData();
	bindCategoryCount();
	bindReset();
	bindContact();
	bridge.onUpdate(liveUpdate);
}

function bindSaveData() {
	document.getElementById('save-data-button').addEventListener('click', () => {
		const trimmed = trimNetworkForExport(network.sites);
		const blob = new Blob(
			[JSON.stringify(trimmed, null, 2)],
			{ type: 'application/json' }
		);
		chrome.downloads.download({
			url: URL.createObjectURL(blob),
			filename: 'tracker-lens-data.json',
			conflictAction: 'uniquify'
		});
	});
}

function trimNetworkForExport(sites) {
	const keep = ['hostname', 'firstParty', 'firstPartyHostnames', 'thirdParties'];
	const out = {};
	for (const host in sites) {
		const o = {};
		for (const k of keep) if (k in sites[host]) o[k] = sites[host][k];
		out[host] = o;
	}
	return out;
}

function bindCategoryCount() {
	document.getElementById('hash-button').addEventListener('click', async () => {
		const tally = await bridge.tallyCategories();
		alert(`Category counts:\n${JSON.stringify(tally, null, 2)}`);
	});
}

function bindReset() {
	document.getElementById('reset-data-button').addEventListener('click', async () => {
		if (!confirm('Pressing OK will delete all data. Are you sure?')) return;
		await bridge.clear();
		window.location.reload();
	});
}

function bindContact() {
	document.getElementById('mailsome-button').addEventListener('click', () => {
		const subject = prompt('Subject:', 'Tracker Lens feedback') || 'Tracker Lens feedback';
		const url = `mailto:xuehui.hu@kcl.ac.uk?subject=${encodeURIComponent(subject)}`;
		window.open(url, '_blank');
	});
}

// live updates

function liveUpdate(payload) {
	if (!payload || !payload.hostname) return;
	const sites = network.sites;
	if (!sites[payload.hostname]) sites[payload.hostname] = payload;

	if (Array.isArray(payload.firstPartyHostnames)) {
		for (const fp of payload.firstPartyHostnames) {
			if (!sites[fp]) continue;
			sites[fp].thirdParties = sites[fp].thirdParties || [];
			sites[fp].firstParty = true;
			if (!sites[fp].thirdParties.includes(payload.hostname)) {
				sites[fp].thirdParties.push(payload.hostname);
			}
		}
	}
	tagCategories(sites);
	const { nodes, links } = projectForGraph(sites);
	graph.update(nodes, links);
}

window.addEventListener('DOMContentLoaded', boot);
