'use strict';

// Tracker Lens - local data archive.
//
// Backed by native IndexedDB (no Dexie). Two object stores:
//   sites   - one row per hostname; first/third party state and the set of
//             third parties each first party loads.
//   cookies - one row per top-level page; the cookies the page exposed plus
//             the unique third-party hostnames seen in those cookies.
//
// Public surface (all async):
//   archive.ready                         - resolves once DB is open
//   archive.recordFirstParty(host, info)
//   archive.recordThirdPartyLink(initiator, target, info)
//   archive.recordCookieSnapshot(snapshot)
//   archive.isFirstRun()
//   archive.getNetwork()                  - { hostname: { firstParty, thirdParties, ... } }
//   archive.tallyCategories()
//   archive.clear()

(() => {

const DB_NAME = 'tracker-lens';
const DB_VERSION = 1;
const STORE_SITES = 'sites';
const STORE_COOKIES = 'cookies';

const ALLOWLIST_PATH = '/vendor/disconnect-entitylist.json';
const FIRST_PARTY_CATEGORIES_PATH = '/src/categories-first-party.json';
const THIRD_PARTY_CATEGORIES_PATH = '/src/categories-third-party.json';

// -----------------------------------------------------------------------------
// Tiny native IndexedDB helpers. Promise-wrapped, no third-party wrapper.
// -----------------------------------------------------------------------------

function openDatabase() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = (event) => {
			const db = event.target.result;
			if (!db.objectStoreNames.contains(STORE_SITES)) {
				const sites = db.createObjectStore(STORE_SITES, { keyPath: 'hostname' });
				sites.createIndex('isVisible', 'isVisible');
				sites.createIndex('firstParty', 'firstParty');
			}
			if (!db.objectStoreNames.contains(STORE_COOKIES)) {
				db.createObjectStore(STORE_COOKIES, { keyPath: 'hostname' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function tx(db, storeName, mode = 'readonly') {
	return db.transaction(storeName, mode).objectStore(storeName);
}

function reqToPromise(req) {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function dbGet(db, store, key) {
	return reqToPromise(tx(db, store).get(key));
}

async function dbPut(db, store, value) {
	return reqToPromise(tx(db, store, 'readwrite').put(value));
}

async function dbAll(db, store) {
	return reqToPromise(tx(db, store).getAll());
}

async function dbClear(db, store) {
	return reqToPromise(tx(db, store, 'readwrite').clear());
}

async function dbCount(db, store, indexName, value) {
	const objStore = tx(db, store);
	const range = IDBKeyRange.only(value);
	return reqToPromise(objStore.index(indexName).count(range));
}

// IndexedDB indexes don't accept booleans; coerce to 0/1 on the way in/out.
function packBool(value) {
	if (value === true) return 1;
	if (value === false) return 0;
	return value;
}
function unpackBool(value) {
	if (value === 1) return true;
	if (value === 0) return false;
	return value;
}

// -----------------------------------------------------------------------------
// Hostname helpers (registrable-domain extraction). Replaces the obfuscated
// upstream `url('domain', x)` helper with a small, readable version.
// -----------------------------------------------------------------------------

const COMPOUND_TLDS = new Set([
	'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk',
	'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
	'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
	'com.br', 'net.br', 'org.br', 'gov.br',
	'co.in', 'net.in', 'org.in', 'gov.in',
	'co.nz', 'net.nz', 'org.nz',
	'com.cn', 'net.cn', 'org.cn', 'edu.cn', 'gov.cn',
	'com.hk', 'org.hk',
	'co.za', 'co.kr',
]);

function registrableDomain(hostname) {
	if (!hostname) return hostname;
	const parts = hostname.split('.').filter(Boolean);
	if (parts.length < 2) return hostname;
	const tail = parts.slice(-2).join('.');
	if (parts.length >= 3 && COMPOUND_TLDS.has(tail)) {
		return parts.slice(-3).join('.');
	}
	return tail;
}

function hostnameVariants(hostname) {
	const variants = [hostname];
	const parts = hostname.split('.');
	for (let i = 1; i < parts.length - 1; i++) {
		variants.push(parts.slice(i).join('.'));
	}
	return variants;
}

function rootDomain(rawUrl) {
	const host = String(rawUrl || '').split('://').pop().split('/')[0].split(':')[0];
	const parts = host.split('.');
	if (parts.length <= 2) return host;
	const last = parts[parts.length - 1];
	const second = parts[parts.length - 2];
	if (last.length === 2 && second.length === 2 && parts.length >= 3) {
		return parts.slice(-3).join('.');
	}
	return parts.slice(-2).join('.');
}

// -----------------------------------------------------------------------------
// chrome.storage.local promise wrappers - usable from popup and SW alike.
// -----------------------------------------------------------------------------

function settingGet(key) {
	return new Promise((resolve) => {
		chrome.storage.local.get([key], (items) => resolve((items || {})[key]));
	});
}

function settingSet(key, value) {
	return new Promise((resolve) => {
		chrome.storage.local.set({ [key]: value }, () => resolve());
	});
}

// -----------------------------------------------------------------------------
// archive
// -----------------------------------------------------------------------------

const ALLOWED_METHODS = new Set([
	'getNetwork', 'clear', 'countFirstParties', 'countThirdParties',
	'isFirstRun', 'tallyCategories'
]);

const archive = {
	categoriesFirst: [
		'adults', 'arts', 'business', 'computers', 'games', 'health', 'homes',
		'kidsteen', 'news', 'recreation', 'reference', 'regional', 'science',
		'shopping', 'society', 'sports', 'topsites'
	],
	categoriesThird: [
		'essential', 'analysis', 'advertising', 'redirect', 'tracking',
		'malware', 'optimization', 'social'
	],

	_db: null,
	_firstPartyOwners: null,   // host → owner-id
	_thirdPartyOwners: null,   // owner-id → [resource hosts]
	_categoryFirst: null,
	_categoryThird: null,

	async _init() {
		this._db = await openDatabase();
		await this._loadAllowList();
	},

	async _loadAllowList() {
		try {
			const raw = await fetch(ALLOWLIST_PATH).then((r) => r.json());
			// Disconnect ships two shapes: legacy flat dict, and the current
			// { license, entities: {...} } wrapper. Accept both.
			const list = (raw && typeof raw === 'object' && raw.entities) ? raw.entities : raw;
			const owners = {};
			const resources = {};
			let i = 0;
			for (const owner in list) {
				const props = list[owner] && list[owner].properties;
				if (!Array.isArray(props)) continue;
				for (const host of props) owners[host] = i;
				resources[i] = list[owner].resources || [];
				i++;
			}
			this._firstPartyOwners = owners;
			this._thirdPartyOwners = resources;
		} catch (err) {
			console.warn('archive: allow-list missing -', err.message);
			this._firstPartyOwners = {};
			this._thirdPartyOwners = {};
		}
	},

	_handleMessage(msg) {
		const allowed = ALLOWED_METHODS;
		if (!allowed.has(msg.method)) {
			return Promise.resolve({ error: `unsupported: ${msg.method}` });
		}
		// Returned promise's rejection is caught by the top-level listener.
		return Promise.resolve().then(() => this[msg.method](...(msg.args || [])));
	},

	_pushPanelUpdate(payload) {
		// Best-effort - popup may not be listening.
		return chrome.runtime.sendMessage({ type: 'panelPush', payload }).catch(() => {});
	},

	// ----------------------------------------- first-run ------------------

	async isFirstRun() {
		const flag = await settingGet('hasRun');
		if (flag) return false;
		await settingSet('hasRun', true);
		return true;
	},

	// ----------------------------------------- allow-list -----------------

	_isOwnedThirdParty(firstHost, thirdHost) {
		if (!thirdHost || !this._firstPartyOwners) return false;
		for (const host of hostnameVariants(firstHost)) {
			const ownerId = this._firstPartyOwners[host];
			if (ownerId == null) continue;
			const owned = this._thirdPartyOwners[ownerId] || [];
			for (const variant of hostnameVariants(thirdHost)) {
				if (owned.includes(variant)) return true;
			}
			return false;
		}
		return false;
	},

	// ----------------------------------------- site CRUD ------------------

	async _readSite(hostname) {
		const row = await dbGet(this._db, STORE_SITES, hostname);
		if (!row) return {};
		const out = {};
		for (const k of Object.keys(row)) {
			out[k] = (k === 'isVisible' || k === 'firstParty') ? unpackBool(row[k]) : row[k];
		}
		return out;
	},

	async _writeSite(site) {
		const row = { ...site };
		row.isVisible = packBool(row.isVisible);
		row.firstParty = packBool(row.firstParty);
		return dbPut(this._db, STORE_SITES, row);
	},

	async _hasSite(hostname) {
		return Boolean(await dbGet(this._db, STORE_SITES, hostname));
	},

	async _mergeSite(hostname, patch) {
		const existing = await this._readSite(hostname);
		if (!existing.hostname) existing.hostname = hostname;
		for (const k in patch) {
			const v = patch[k];
			if (k === 'isVisible') {
				if (existing.isVisible === true) continue;
				existing.isVisible = v;
			} else if (k === 'firstParty') {
				if (existing.firstParty === true) continue;
				existing.firstParty = v;
				if (v) existing.isVisible = v;
			} else {
				existing[k] = v;
			}
		}
		await this._writeSite(existing);
		return existing;
	},

	async _addLink(firstHost, thirdHost) {
		const first = await this._readSite(firstHost);
		if (!first.firstParty) first.firstParty = true;
		first.thirdPartyHostnames = first.thirdPartyHostnames || [];
		if (!first.thirdPartyHostnames.includes(thirdHost)) {
			first.thirdPartyHostnames.push(thirdHost);
			await this.recordFirstParty(firstHost, first);
		}
	},

	// ----------------------------------------- public writes --------------

	async recordFirstParty(hostname, info) {
		if (!hostname) throw new Error('recordFirstParty: hostname required');
		const isNew = !(await this._hasSite(hostname));
		const merged = await this._mergeSite(hostname, info);
		if (isNew) this._pushPanelUpdate(this._project(hostname, merged));
	},

	async recordThirdPartyLink(initiator, target, info) {
		if (!initiator) throw new Error('recordThirdPartyLink: initiator required');

		const first = await this._readSite(initiator);
		const third = await this._readSite(target);

		third.firstPartyHostnames = third.firstPartyHostnames || [];
		if (!third.firstPartyHostnames.includes(initiator)) {
			third.firstPartyHostnames.push(initiator);
		}

		let isNew = false;
		let shouldNotify = false;

		const alreadyLinked = (first.thirdPartyHostnames || []).includes(target);
		if (!alreadyLinked) {
			if (!third.isVisible) {
				if (this._isOwnedThirdParty(initiator, target)) {
					third.isVisible = false;
				} else {
					third.isVisible = true;
					isNew = true;
					for (const fph of third.firstPartyHostnames) {
						await this._addLink(fph, target);
					}
					shouldNotify = true;
				}
			}
			if (third.isVisible && !isNew) {
				await this._addLink(initiator, target);
				shouldNotify = true;
			}
		}

		Object.assign(third, info);
		const merged = await this._mergeSite(target, third);

		if (shouldNotify) this._pushPanelUpdate(this._project(target, merged));
	},

	async recordCookieSnapshot(snapshot, _pageUrl) {
		return dbPut(this._db, STORE_COOKIES, snapshot);
	},

	// ----------------------------------------- public reads ---------------

	_project(hostname, site) {
		return {
			hostname,
			firstPartyHostnames: site.firstPartyHostnames || false,
			firstParty: Boolean(site.firstParty),
			cookies: {},
			info: site.info,
			thirdParties: site.thirdPartyHostnames || []
		};
	},

	async getNetwork() {
		const rows = await dbAll(this._db, STORE_SITES);
		const out = {};
		for (const row of rows) {
			const visible = unpackBool(row.isVisible);
			const isFp = unpackBool(row.firstParty);
			if (!visible && !isFp) continue;
			out[row.hostname] = this._project(row.hostname, {
				...row,
				isVisible: visible,
				firstParty: isFp
			});
		}
		return out;
	},

	async clear() {
		// Drop the request-processing queue if the capture module is loaded.
		if (typeof self !== 'undefined' && self.capture) self.capture.queue = [];
		await dbClear(this._db, STORE_SITES);
		await dbClear(this._db, STORE_COOKIES);
	},

	async pruneOlderThan(days = 30) {
		// Walk sites; delete those whose last requestTime is older than cutoff.
		const cutoff = Date.now() - days * 86400000;
		const rows = await dbAll(this._db, STORE_SITES);
		let removed = 0;
		for (const row of rows) {
			if (row.requestTime && row.requestTime < cutoff) {
				await reqToPromise(tx(this._db, STORE_SITES, 'readwrite').delete(row.hostname));
				removed++;
			}
		}
		return removed;
	},

	async countFirstParties() {
		return dbCount(this._db, STORE_SITES, 'firstParty', 1);
	},

	async countThirdParties() {
		const all = await dbAll(this._db, STORE_SITES);
		return all.filter((r) => unpackBool(r.firstParty) === false && unpackBool(r.isVisible)).length;
	},

	// ----------------------------------------- categorisation -------------

	async _ensureCategoryDb() {
		if (!this._categoryFirst) {
			this._categoryFirst = await fetch(FIRST_PARTY_CATEGORIES_PATH).then((r) => r.json());
		}
		if (!this._categoryThird) {
			this._categoryThird = await fetch(THIRD_PARTY_CATEGORIES_PATH).then((r) => r.json());
		}
	},

	lookupCategoryFirst(host) {
		return this._categoryFirst ? this._categoryFirst[host] : undefined;
	},

	lookupCategoryThird(host) {
		return this._categoryThird ? this._categoryThird[host] : undefined;
	},

	async tallyCategories() {
		await this._ensureCategoryDb();
		const network = await this.getNetwork();
		const tallyFirst = Object.fromEntries(this.categoriesFirst.map((c) => [c, 0]));
		const tallyThird = Object.fromEntries(this.categoriesThird.map((c) => [c, 0]));
		let countFirst = 0;
		let countThird = 0;

		for (const host in network) {
			const site = network[host];
			const root = rootDomain(host);
			if (site.firstParty) {
				countFirst++;
				const cats = this.lookupCategoryFirst(root) || [];
				for (const c of cats) {
					if (c in tallyFirst) tallyFirst[c]++;
				}
			} else {
				countThird++;
				const cats = this.lookupCategoryThird(root) || [];
				for (const c of cats) {
					if (c in tallyThird) tallyThird[c]++;
				}
			}
		}

		return {
			countCat_first: tallyFirst,
			countCat_third: tallyThird,
			num_first: countFirst,
			num_third: countThird
		};
	},

	// ----------------------------------------- helpers exposed for graph --

	rootDomain,
	registrableDomain
};

archive.ready = archive._init();

// Register the message listener synchronously at module load (before any
// awaited work). Handlers wait on `archive.ready` so messages that arrive
// during cold start aren't lost.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (!msg || msg.type !== 'archiveCall') return false;
	archive.ready
		.then(() => archive._handleMessage(msg))
		.then((value) => sendResponse(value))
		.catch((err) => sendResponse({ error: String(err) }));
	return true;
});

if (typeof self !== 'undefined') self.archive = archive;
if (typeof window !== 'undefined') window.archive = archive;

})();
