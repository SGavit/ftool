# Freight Workflow Tools (Chrome Extension)

This extension combines the two original scripts from `auto_filler.txt` and `click open tab.txt`.

## Logic preservation

The workflow rules, DOM selectors, status mapping, Numpad Enter behavior, amount parsing, dropdown selection, amount filling, acknowledgement, expiry, serialized processing, legacy-panel removal, and Work Order click-to-open behavior were kept. The Tampermonkey GM storage bridge was adapted to Chrome's `chrome.storage.local` / `chrome.storage.onChanged` API because Chrome extensions do not provide the GM APIs.

## Install (Chrome / Edge)

1. Download or clone this repository.
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `extension` folder.
6. Reload the relevant web pages.

## Permissions

- `storage`: carries the transfer payload and acknowledgement between source and target tabs.
- `<all_urls>`: the original Shipment Workflow Bridge detects its source/target pages by DOM structure and has empty host allowlists. The click-to-open script is limited by its original WFE Freightcom DOM selector. This broad host permission is retained to avoid changing the original matching logic.

## Source files

- `content.js`: combined extension script
- `manifest.json`: Manifest V3 extension configuration
