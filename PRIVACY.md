# Privacy

## Where the data lives

Tracker Lens stores everything it captures in a local IndexedDB database
inside your browser profile. **The data never leaves your machine.** There
is no sharing toggle, no opt-in upload, no telemetry endpoint, and no
remote logging.

What's captured:

- The hostname of every first-party page you visit
- The hostname of every third-party request triggered by those pages
- Cookies the browser exposed to those pages (so cookie syncing can be
  detected)
- Timestamps for the requests

Page contents (HTML, form fields, passwords, etc.) are never read.

## How to wipe your data

- **Reset** button in the panel clears the local IndexedDB.
- Removing the extension from `chrome://extensions` also clears it.

## Export

The **Export** button writes a JSON file (`tracker-lens-data.json`) to your
downloads folder containing the local capture. This is for your own
inspection. It is downloaded directly to your machine; nothing is uploaded.
