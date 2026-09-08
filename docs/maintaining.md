# Maintaining the documentation site

The public documentation at <https://aasis21.github.io/weft/> is a static handbook:
`index.html` contains the readable content, `docs.css` contains responsive styling,
`docs-theme.js` applies the saved appearance before paint, and `docs.js`
progressively enhances navigation. The product homepage and phone app
are at <https://useweft.netlify.app>.

No build step, remote Markdown renderer, CDN, or new dependency is required. Serve
this directory as static files. GitHub Pages serves the documentation separately
from Netlify's `mobile/dist` app deployment.

## Content changes

- Keep primary tasks complete in the handbook. The sidebar and guide directory
  should lead to real sections, not raw Markdown downloads.
- Markdown files remain detailed repository references, rendered by GitHub.
  Update the corresponding reference when changing a command or behavior in the
  handbook, and link references with explicit "on GitHub" labels.
- Keep section IDs stable: they are public deep links. The prior `install`,
  `advanced`, `what`, `action`, and `architecture` anchors have been retained.
- Add new major sections to the sidebar and guide directory. Headings should have
  self-links; tables need column headers and an accessible scroll region.
- Keep examples consistent with installed CLI help. Shell command blocks belong
  to the laptop; `/weft` belongs inside a Copilot session.
- Keep site scripts and styles local. No session state or pairing payload should
  be read or stored by the documentation. Only the documentation theme preference
  is stored locally. The moon/sun button switches light and dark; until a preference
  is chosen, the site follows the browser's color scheme, including without
  JavaScript. Print output stays light.

## Focused checks

From the repository root:

```sh
node --test scripts/docs.test.mjs
```

The existing root `npm test` also discovers this structural test. For a visual
review, serve `docs/` under a `/weft/` path and use the repository's existing
Playwright tooling. Check phone and desktop widths, long command blocks, sidebar
keyboard navigation, direct anchors and browser back, and the no-JavaScript
fallback. Keep screenshots and browser output outside the checkout.
