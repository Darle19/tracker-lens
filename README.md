# Tracker Lens

A Chrome extension that visualises the relationships between the sites you
visit and the third-party trackers they pull in. Hover any node in the graph
to see which first parties loaded it and which other third parties it
cookie-syncs with.

![icon](assets/lightbeam-96.png)

## Why

Most "trackers" tools answer the wrong question. They tell you *that* you're
being tracked. Tracker Lens shows you the *graph* - which trackers piggyback
on which sites, and which trackers gossip with each other behind your back
via cookie syncing. Once you see the graph for the sites you actually use, the
shape of the surveillance economy becomes obvious.

## Features

- **Live request graph** - every third-party request your browser makes,
  attributed to the first-party page that triggered it.
- **Cookie-sync detection** - surfaces third parties that share identifiers
  across the sites you visit.
- **Force-directed visualisation** (D3) - pan, zoom, hover for details.
- **100% local** - IndexedDB on your machine. No telemetry, no remote
  logging, no ads, no opt-in sharing - the data never leaves your browser.
- **Export** - dump your local capture as JSON whenever you want.

## Install (unpacked)

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and pick the project folder.
4. Click the toolbar icon to open the panel.

## Layout

```
manifest.json          MV3 manifest
sw.js                  service-worker entry (importScripts the src/ files)
popup.html             panel UI
welcome.html           first-run page
src/
  archive.js           native IndexedDB layer + allow-list + categories
  capture.js           webRequest + tabs.onUpdated listeners
  background.js        action handler + first-run trigger
  bridge.js            popup → SW message proxy
  graph.js             D3 force-directed graph (canvas)
  panel.js             popup UI orchestration
  categories-first-party.json
  categories-third-party.json
vendor/                third-party libraries (D3, allow-list)
assets/                icons and logos
css/                   styles
fonts/                 Open Sans
```

## Permissions

| Permission        | Why                                                          |
| ----------------- | ------------------------------------------------------------ |
| `webRequest`      | Observe outgoing requests to identify third parties          |
| `tabs`            | Map requests back to the page that triggered them            |
| `cookies`         | Read cookies to detect cross-site cookie syncing             |
| `scripting`       | Inject a one-liner reading `performance.getEntriesByType`    |
| `storage`         | Persist first-run flag and weekly diff state                 |
| `downloads`       | Save your local data as JSON                                 |
| `<all_urls>`      | Required for `webRequest` and `scripting` to work everywhere |

The extension never reads page contents - only request metadata.

## Privacy

See [PRIVACY.md](PRIVACY.md). Short version: data lives in IndexedDB on your
machine and never leaves it. There is no sharing toggle, no telemetry, no
remote endpoint.

## Roadmap

- Cleaner panel UI - the current one carries some legacy from the prior art.
- Per-site drill-down view.
- Configurable retention window (auto-prune older than N days).
- Export to graph formats (GEXF/GraphML) for analysis in Gephi etc.

## Credits

Tracker Lens stands on the shoulders of two earlier projects whose
functionality we set out to replicate from the user-facing behaviour:

- [Mozilla Lightbeam](https://github.com/mozilla/lightbeam-we) - the
  Firefox extension that pioneered third-party tracker visualisation
  (discontinued 2019).
- [Thunderbeam-Lightbeam for Chrome](https://github.com/rachelkcl/Lightbeam_Chrome)
  by Rachel Hu / King's College London - the Chrome port and cookie-sync
  research extension. Related research: [Tracking the Trackers](https://nms.kcl.ac.uk/netsys/datasets/tracking-the-trackers-papers/).

Vendor libraries:

- [D3.js](https://d3js.org/) - visualisation (BSD-3-Clause)
- [DuckDuckGo / Disconnect entity list](https://github.com/disconnectme/disconnect-tracking-protection) - first-party allow-list

## License

[MPL-2.0](LICENSE), matching the upstream prior art.
