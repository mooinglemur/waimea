# Spike 6: the page, driven like a person

`check.mjs` uses the real page (`web/index.html` and `web/app.mjs`) against a running `server/main.mjs` in
headless Chrome or Firefox. It acts only through the page's own controls:
1. upload an apworld through the file input and wait for the options form;
2. pick the Quick preset, then keep only the given variants at the given run counts and set the worker
   count;
3. press Start, and snapshot the section lines once the unit tests finish;
4. wait for the summary, open failing groups and a run's log, and take screenshots in the light and dark
   themes;
5. press **Save report**, with the browser's downloads directed to a folder, and confirm the zip arrived.

```sh
WAIMEA_PORT=8235 WAIMEA_HOST=127.0.0.1 node server/main.mjs &
node spikes/06-page/check.mjs chrome 8235 librarian.apworld 'default=6,check-ut=6,check-collect-accessibility=4' out/chrome 2
```

Arguments are the browser, the server port, the apworld, the variants with run counts, an output folder for
screenshots and downloads, and an optional worker count (default 2). It prints what the page showed at
each step and lists any page errors or console warnings.

## Results

Run on 2026-09-15 with Librarian 2.0.3 on 2 workers: `default` × 6, `check-collect-accessibility` × 4
and `check-ut` × 6.

| | Chrome | Firefox |
|---|---|---|
| Inspection | 4.1 s: game, module, version, authors, minimum Archipelago | 4.2 s, the same |
| Quick preset | set 500, 500, then 50 for each check variant | the same |
| Unit tests | 1 of 205 failed, in 7 s | 1 of 205 failed, in 6 s |
| Calibrated timeout | 24 s (0.80×) | 29 s (0.95×) |
| `default` | 6 passed, in 9 s | 6 passed, in 6 s |
| `check-collect-accessibility` | 4 passed, in 28 s | 4 passed, in 16 s |
| `check-ut` | 1 of 6 failed (Librarian's real Universal Tracker bug), in 17 s | 6 passed, in 19 s |
| Whole session | 1 min 6 s | 52 s |
| Save report | an 84 KB zip | an 83 KB zip |
| Page errors or console warnings | none | none |

Screenshots in both themes were checked by eye:
- the options form, and the live view with the failing test's group and subtests open;
- the finished page with the `check-ut` failure's run log and YAML open;
- the summary.

They showed four problems, since fixed:
- a stray "null" in the options form;
- a misaligned Runs column, from a CSS class shared with the fuzz run list;
- Stop left visible after the run;
- unit-test counts that didn't mention failing subtests.

A Chrome rerun showed "1 of 205 failed (2 subtests)" and no page errors.
