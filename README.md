# Home Ground

A daily geography + sport guessing game. You get an athlete or a team; drop a pin on the city they're
from (an athlete's birthplace, or the city a team plays its home games in). Five rounds a day,
the same five for everyone.

## Running it

It's a static site: plain HTML, CSS and JavaScript with no build step. Browsers won't load the data files
from a page opened straight from disk, so serve the folder:

```sh
cd home-ground
python3 -m http.server 8000
# open http://localhost:8000
```

Any static host works for publishing: GitHub Pages, Netlify, Cloudflare Pages, itch.io.

Handy URL switches: add `?flat` for a flat map instead of the globe.

The claude.ai artifact preview can't load outside images, so there the game falls back to plain
country shapes instead of satellite imagery. GitHub Pages and other normal hosts show the imagery.

## Project layout

```
index.html              page structure
css/style.css           all styling
js/config.js            settings: Esri key, globe/flat, rounds, difficulty per round, satellite tiles
js/game.js              game flow, scoring, scorecard, share text
js/map.js               the MapLibre map: satellite, country highlight, pins, result line
js/daily.js             picks the same players for everyone each day
js/geo.js               distance and great-circle maths
js/units.js             km / miles display (everything is stored in km)
js/tiers.js             result tiers, colours and reaction lines
js/effects.js           the short celebration effects
data/players.json       the player/team list the game loads (generated, see below)
data/players.manual.json  your hand-written entries (merged into players.json)
data/countries.geojson  country shapes for "Reveal country" and the no-imagery fallback (generated)
scripts/                data scripts (Python 3, no extra packages)
vendor/                 MapLibre GL JS 5.6.0
```

## Player data

Every entry in `data/players.json` has this shape:

```json
{
  "id": "wd-Q615",
  "name": "Lionel Messi",
  "sport": "Football",
  "type": "athlete",
  "city": "Rosario",
  "country": "Argentina",
  "lat": -32.947,
  "lng": -60.639,
  "difficulty": 1,
  "hint": "optional extra detail, shown on the result card (e.g. \"Home ground: Old Trafford\")",
  "image": "https://commons.wikimedia.org/wiki/Special:FilePath/Lionel_Messi_2018.jpg?width=400",
  "imageAuthor": "Jane Doe",
  "imageLicense": "CC BY-SA 3.0",
  "imagePage": "https://commons.wikimedia.org/wiki/File:Lionel_Messi_2018.jpg"
}
```

The four `image…` fields are optional and come as a set. The build script fills them from Wikidata
(P18 photo for athletes, P154 logo for teams) and Wikimedia Commons (author and licence). Without them
the game shows an initials badge. To give a hand-written entry a picture, find the file on Commons and fill in all four.

- `type` is `"athlete"` (placed at their birthplace) or `"team"` (placed at their home stadium).
- `difficulty` is 1 (household name), 2 or 3 (deep cut). Each day uses two 1s, two 2s and a 3
  (change `ROUND_DIFFICULTY` in `js/config.js`).
- `id` must be unique and must never change once the game is live. The daily order is built from ids.
- `country` must match a shape in `data/countries.geojson` (directly or via the aliases in
  `scripts/validate_players.py`), or "Reveal country" has nothing to highlight.
  `python3 scripts/build_countries.py` lists any entry that doesn't match.

### Adding players by hand

1. Add the entry to `data/players.manual.json` (not `players.json`, which gets regenerated).
   Give it an id like `"hand-sam-kerr"`. Get coordinates by right-clicking the spot in Google Maps.
2. Check it: `python3 scripts/validate_players.py data/players.manual.json`
3. Rebuild `players.json`: `python3 scripts/build_players.py`.
   If you can't reach Wikidata, copy your entry into `players.json` by hand too.

Hand entries always win: if Wikidata has the same id or the same name, the hand version is kept.

### Rebuilding from Wikidata

```sh
python3 scripts/build_players.py --dry-run   # fetch + validate, write nothing
python3 scripts/build_players.py             # fetch + validate + write data/players.json
python3 scripts/build_players.py --fresh     # ignore the cache and fetch everything again
```

Wikidata's query service is often busy and times out on the big sports (football especially). The script
retries, skips a sport that keeps failing, and caches every sport that succeeds in `scripts/.cache/`.
So if the summary says something was skipped, just run it again: only the missing sports are asked for.

First, put your own contact (an email or a project URL) in `USER_AGENT` at the top of the script,
because Wikidata asks scripts to identify themselves. A run takes a few minutes. To change which
sports and leagues are included, or how many of each, edit the lists at the top of the script. Each
line has the Wikidata ID, its expected label (checked at the start of every run, so a wrong ID gets
skipped instead of pulling in junk), a quota and a minimum popularity.

How popularity works: "sitelinks" is the number of Wikipedia language editions with an article on that
person or team. Messi has 200+, a journeyman defender maybe 10. Within each sport, the top 35% become
difficulty 1, the next 35% difficulty 2, and the rest difficulty 3.

### Validation

`python3 scripts/validate_players.py` checks every entry:

- **Errors** (dropped by the build): missing fields, bad `type`/`difficulty`, coordinates at 0,0 or out of range.
- **Warnings** (kept, worth a look): the point lands in a different country from the one named (coastal
  towns get 30 km of slack), the country name isn't recognised, or the same name appears twice.

Wikidata sometimes has odd birthplaces (a hospital, a district, an old country). The warnings are the place
to catch them. Fix them by adding a corrected copy to `players.manual.json`.

### How the daily pick works

Each difficulty group is put in a fixed shuffled order, sorted by a hash of each entry's `id`. Day 1 takes
the first slots, day 2 the next, and so on, so nothing repeats until the whole group has been used. Then a
new order starts. Everyone computes the same order, so everyone gets the same five. Adding players slots
them into the order without reshuffling the others, though days that haven't happened yet can shift.

### Pictures and anti-cheat

Pictures are left out automatically when the file name mentions the answer city (e.g. "Old Trafford
Manchester.jpg"). The script can't read text inside a picture, though, so it prints a list of team
logos whose team name doesn't already include the city. Glance through those for crests that
spell out the city ("Ajax Amsterdam" style) and remove the `image…` fields from any that do,
by adding a corrected copy to `players.manual.json`.

### Licences

- Photos on Wikimedia Commons are free to reuse, but most licences (CC BY, CC BY-SA) require credit.
  The game shows the author and licence behind the (i) on each picture and on the scorecard.
- Team logos are trademarks even when Commons hosts them as public domain (simple text logos) or under
  a free licence. Showing them in a small, free, non-commercial game is low-risk, but check with the
  clubs' and leagues' rules (or drop logos) before any commercial or large public launch.
- Images are loaded straight from Wikimedia ("hotlinking"), which Wikimedia allows. For a big audience,
  download and serve them yourself to be polite to their servers.

## Credits

- Map rendering: [MapLibre GL JS](https://maplibre.org) (BSD-3)
- Basemap: Esri World Imagery. Attribution is shown on the map. Esri's terms
  allow development use without a key; for a public launch get an ArcGIS Location Platform key and put it in `js/config.js`.
- Country shapes: [Natural Earth](https://www.naturalearthdata.com) (public domain), via world-atlas (ISC).
- Player and team data: [Wikidata](https://www.wikidata.org) (CC0).
- Player photos and team logos: [Wikimedia Commons](https://commons.wikimedia.org); each picture's author and licence are shown in the game.
