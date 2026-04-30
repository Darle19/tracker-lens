'use strict';

// Tracker Lens - force-directed graph (D3 + canvas).
//
// Public surface:
//   graph.render(nodes, links)   - first paint
//   graph.update(nodes, links)   - repaint after data changes
//
// Visual language:
//   • First parties - solid filled circle (radius scales with #third parties)
//   • Third parties - outlined triangle (constant size)
//   • Page → tracker edges - light grey
//   • Cookie-sync edges (shared query parameters) - coral
//   • Hover for tooltip; drag to pin; scroll to zoom.

const graph = (() => {

	const PALETTE = {
		bg: '#0f1418',
		firstParty: '#7dd3fc',
		thirdParty: '#fbbf24',
		thirdPartyOutline: '#fde68a',
		edge: 'rgba(170, 180, 200, 0.35)',
		syncEdge: 'rgba(244, 114, 182, 0.85)',
		shadow: 'rgba(125, 211, 252, 0.6)'
	};

	const PHYSICS = {
		charge: -120,
		collisionPad: 18,
		linkDistance: 60,
		warmTicks: 90,
		alphaWarm: 0.25,
		alphaCool: 0
	};

	const VIEW = {
		baseRadius: 6,
		maxBoost: 18,
		minZoom: 0.4,
		maxZoom: 2.0,
		dpr: window.devicePixelRatio || 1
	};

	const RESIZE_DEBOUNCE_MS = 200;

	let canvas, ctx;
	let host, tooltip;
	let width = 0, height = 0;
	let transform = null;
	let simulation = null;
	let nodes = [], links = [];
	let resizeTimer = null;
	let initialised = false;

	function ensureD3Transform() {
		if (!transform) transform = d3.zoomIdentity;
	}

	function measure() {
		const rect = document.body.getBoundingClientRect();
		return { w: rect.width, h: rect.height };
	}

	function buildCanvas() {
		host = document.getElementById('visualization');
		canvas = document.createElement('canvas');
		ctx = canvas.getContext('2d');
		host.appendChild(canvas);
		tooltip = document.getElementById('tooltip');
	}

	function applyDimensions(w, h) {
		width = w; height = h;
		canvas.width = w * VIEW.dpr;
		canvas.height = h * VIEW.dpr;
		canvas.style.width = `${w}px`;
		canvas.style.height = `${h}px`;
		ctx.setTransform(VIEW.dpr, 0, 0, VIEW.dpr, 0, 0);
	}

	// ----------------------- physics --------------------------------------

	function nodeRadius(node) {
		if (!node.firstParty) return VIEW.baseRadius;
		const fanOut = (node.thirdParties && node.thirdParties.length) || 0;
		return VIEW.baseRadius + Math.min(fanOut, VIEW.maxBoost);
	}

	function forgeSimulation() {
		const sim = d3.forceSimulation(nodes)
			.force('charge', d3.forceManyBody().strength(PHYSICS.charge))
			.force('center', d3.forceCenter(width / 2, height / 2))
			.force('x', d3.forceX(width / 2).strength(0.04))
			.force('y', d3.forceY(height / 2).strength(0.04))
			.force('collide', d3.forceCollide()
				.radius((d) => nodeRadius(d) + PHYSICS.collisionPad / 2));
		sim.on('tick', repaint);
		return sim;
	}

	function attachLinkForce() {
		const link = d3.forceLink(links).id((d) => d.hostname).distance(PHYSICS.linkDistance);
		simulation.force('link', link);
	}

	function warmStart() {
		simulation.alpha(PHYSICS.alphaWarm);
		for (let i = 0; i < PHYSICS.warmTicks; i++) simulation.tick();
		simulation.alphaTarget(PHYSICS.alphaCool);
	}

	// ----------------------- drawing --------------------------------------

	function clearFrame() {
		ctx.fillStyle = PALETTE.bg;
		ctx.fillRect(0, 0, width, height);
	}

	function paintEdges() {
		ctx.beginPath();
		for (const l of links) {
			ctx.moveTo(coordX(l.source), coordY(l.source));
			ctx.lineTo(coordX(l.target), coordY(l.target));
		}
		ctx.strokeStyle = PALETTE.edge;
		ctx.lineWidth = 1;
		ctx.stroke();
	}

	function paintSyncEdges() {
		// "Cookie-sync" indicator: any pair of nodes whose request-URL params
		// share at least one decoded value. Cheap heuristic, not authoritative.
		ctx.beginPath();
		for (const l of links) {
			const a = l.source.info, b = l.target.info;
			if (!Array.isArray(a) || !Array.isArray(b)) continue;
			let shared = false;
			for (const v of a) {
				if (b.includes(v)) { shared = true; break; }
			}
			if (!shared) continue;
			ctx.moveTo(coordX(l.source), coordY(l.source));
			ctx.lineTo(coordX(l.target), coordY(l.target));
		}
		ctx.strokeStyle = PALETTE.syncEdge;
		ctx.lineWidth = 1.5;
		ctx.stroke();
	}

	function paintNodes() {
		for (const n of nodes) {
			const x = coordX(n), y = coordY(n);
			if (n.firstParty) {
				paintFirstParty(x, y, nodeRadius(n), n.shadow);
			} else {
				paintThirdParty(x, y);
			}
		}
	}

	function paintFirstParty(x, y, r, glow) {
		if (glow) {
			ctx.beginPath();
			ctx.fillStyle = PALETTE.shadow;
			ctx.arc(x, y, r + 6, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.beginPath();
		ctx.fillStyle = PALETTE.firstParty;
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
	}

	function paintThirdParty(x, y) {
		const r = VIEW.baseRadius;
		const dy = r * 0.85, dx = r * 0.95;
		ctx.beginPath();
		ctx.moveTo(x, y - r);
		ctx.lineTo(x + dx, y + dy);
		ctx.lineTo(x - dx, y + dy);
		ctx.closePath();
		ctx.fillStyle = PALETTE.thirdParty;
		ctx.fill();
		ctx.lineWidth = 1;
		ctx.strokeStyle = PALETTE.thirdPartyOutline;
		ctx.stroke();
	}

	function repaint() {
		clearFrame();
		ctx.save();
		ctx.translate(transform.x, transform.y);
		ctx.scale(transform.k, transform.k);
		paintEdges();
		paintSyncEdges();
		paintNodes();
		ctx.restore();
	}

	function coordX(n) { return n.fx != null ? n.fx : n.x; }
	function coordY(n) { return n.fy != null ? n.fy : n.y; }

	// ----------------------- interactions ---------------------------------

	function nodeAt(px, py) {
		const r2 = (VIEW.baseRadius + 4) * (VIEW.baseRadius + 4);
		for (const n of nodes) {
			const dx = px - coordX(n), dy = py - coordY(n);
			if (dx * dx + dy * dy <= r2) return n;
		}
		return null;
	}

	function showTooltip(node, px, py) {
		tooltip.textContent = node.category
			? `${node.hostname} · ${node.category}`
			: node.hostname;
		tooltip.style.display = 'block';
		const rect = tooltip.getBoundingClientRect();
		const canvasRect = canvas.getBoundingClientRect();
		const left = Math.min(px - rect.width / 2, canvasRect.right - rect.width - 4);
		const top = py - rect.height - 12;
		tooltip.style.left = `${Math.max(4, left)}px`;
		tooltip.style.top = `${Math.max(4, top)}px`;
	}

	function hideTooltip() {
		tooltip.style.display = 'none';
	}

	function bindHover() {
		canvas.addEventListener('mousemove', (event) => {
			const rect = canvas.getBoundingClientRect();
			const mx = event.clientX - rect.left;
			const my = event.clientY - rect.top;
			const [worldX, worldY] = transform.invert([mx, my]);
			const hit = nodeAt(worldX, worldY);
			if (hit) showTooltip(hit, mx, my);
			else hideTooltip();
		});
		canvas.addEventListener('mouseleave', hideTooltip);
	}

	function bindDrag() {
		// d3 v4 API: handler args come from d3.event, not the listener parameter.
		const drag = d3.drag()
			.subject(() => {
				const worldX = transform.invertX(d3.event.x);
				const worldY = transform.invertY(d3.event.y);
				return nodeAt(worldX, worldY);
			})
			.on('start', () => {
				if (!d3.event.active) simulation.alphaTarget(PHYSICS.alphaWarm).restart();
				d3.event.subject.shadow = true;
				d3.event.subject.fx = d3.event.subject.x;
				d3.event.subject.fy = d3.event.subject.y;
			})
			.on('drag', () => {
				d3.event.subject.fx = transform.invertX(d3.event.x);
				d3.event.subject.fy = transform.invertY(d3.event.y);
				hideTooltip();
			})
			.on('end', () => {
				if (!d3.event.active) simulation.alphaTarget(PHYSICS.alphaCool);
				d3.event.subject.shadow = false;
				d3.event.subject.fx = null;
				d3.event.subject.fy = null;
			});
		d3.select(canvas).call(drag);
	}

	function bindZoom() {
		// `d3.event` is unreliable in d3 v4 zoom handlers (it gets cleared during
		// the wheel-debounce timer). Read the transform from the node's `__zoom`
		// property via d3.zoomTransform(this) instead - that's always populated
		// for the duration of the zoom gesture.
		const zoom = d3.zoom()
			.scaleExtent([VIEW.minZoom, VIEW.maxZoom])
			.on('zoom', function () {
				transform = d3.zoomTransform(this);
				repaint();
			});
		d3.select(canvas).call(zoom);
	}

	function bindResize() {
		window.addEventListener('resize', () => {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				const { w, h } = measure();
				applyDimensions(w, h);
				if (simulation) {
					simulation.force('center', d3.forceCenter(w / 2, h / 2));
					simulation.alpha(0.2).restart();
				}
				repaint();
			}, RESIZE_DEBOUNCE_MS);
		});
	}

	// ----------------------- public API -----------------------------------

	function render(nextNodes, nextLinks) {
		nodes = nextNodes;
		links = nextLinks;
		ensureD3Transform();
		if (!initialised) {
			buildCanvas();
			const { w, h } = measure();
			applyDimensions(w, h);
			simulation = forgeSimulation();
			attachLinkForce();
			warmStart();
			bindHover();
			bindDrag();
			bindZoom();
			bindResize();
			initialised = true;
		} else {
			update(nodes, links);
		}
	}

	function update(nextNodes, nextLinks) {
		nodes = nextNodes;
		links = nextLinks;
		simulation.nodes(nodes);
		attachLinkForce();
		simulation.alpha(0.4).restart();
	}

	return { render, update };

})();

if (typeof window !== 'undefined') window.graph = graph;
