# site/ — the landing page

Static, no build step. `style.css` is shared by both pages (`index.html` and
`ko/index.html`); IBM Plex from Google Fonts and GSAP from jsDelivr are the only
external requests. `demos/` holds only the seven self-contained scenario players the
tabs iframe in (`v2-*.html`); the rest of the original motion kit is not shipped.

## Local preview

```bash
python3 -m http.server 8899 --directory site
# http://127.0.0.1:8899/
```

Open it over HTTP, not `file://` — the page reads into the demo iframe to sync the
theme, which the file protocol blocks (it degrades gracefully, the demo just stays
light while the page is dark).

## Deploying to GitHub Pages

`.github/workflows/pages.yml` publishes this folder on every push to `main` that
touches `site/`. One-time setup in the repo:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**
2. Push to `main`. The workflow uploads `site/` and deploys it.
3. The page lands at `https://greekr4.github.io/rever-browser/`

You can also run it by hand from **Actions → Deploy landing page → Run workflow**.

`.nojekyll` is required so Jekyll doesn't touch the static files.

### Custom domain

Add a `CNAME` file next to `index.html` containing the domain, point a `CNAME` DNS
record at `greekr4.github.io`, then set the domain under Settings → Pages.

### A user site instead (`greekr4.github.io`)

The project-page URL above needs no extra repo. If you want the bare domain, copy
the contents of `site/` into a repo named `greekr4.github.io` — every link on the
page is relative, so nothing needs rewriting.

## Editing

- Scenario list: the `.tab` buttons in `index.html`. `data-src` is the demo filename
  under `demos/`, `data-cap` is the caption shown under the frame.
- Tool counts: the `TOOLS` array near the bottom of `index.html`. Regenerate with

  ```bash
  grep -cE 'mcp\.(registerTool|tool)\(' src/main/mcp/tools/*.ts
  ```
- The frame sizes itself to whatever the demo measures (`.rv-app` height), so demos
  of different heights need no per-demo tweaking.
