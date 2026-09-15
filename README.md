# FindIt

FindIt is a browser-only campus lost-and-found system. It lets students report lost or found items, search reports, compare likely matches, and gives a coordinator a small status workflow.

## Run it

No Python, Flask, npm, database server, or internet connection is needed.

1. Open `index.html` in a modern browser.
2. Use the navigation buttons to report, search, compare, and review items.

The browser stores demo data in `localStorage`. Use **Reset demo data** to restore the sample reports.

## Test the matching logic

From this folder, run:

```text
node algorithms.test.mjs
```

The matching score is intentionally explainable: category (25), colour (20), location (20), date (up to 15), and shared description terms (up to 20). The app uses a small cosine-style token similarity function in JavaScript, so it stays dependency-free and matches the project's HTML/CSS/JavaScript-only constraint.

## Project structure

- `index.html` - accessible single-page interface
- `styles.css` - responsive visual design
- `app.js` - navigation, forms, storage, rendering, and status workflow
- `algorithms.js` - matching and text-similarity logic
- `algorithms.test.mjs` - lightweight runnable checks
