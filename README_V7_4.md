# Ride Trainer V7.4

Changes:

- Polish translation is forced to high-contrast white on mobile.
- Sentence card vertical spacing is reduced; mobile landscape is more compact.
- The timer/line/minus section inside the sentence card is no longer displayed.
- New rating playback filters: Easy, Hard and None; any combination can be selected.
- The progress header now shows difficulty counts in the order None / Easy / Hard.
- Existing Easy/Hard ratings and Cloudflare D1 data remain compatible. No SQL migration is required.

Replace these files in the existing repository:

- public/index.html
- public/app.js
- public/styles.css
- public/sw.js
- public/manifest.webmanifest
- src/worker.js

Do not replace wrangler.jsonc and do not change the Sync Key.
