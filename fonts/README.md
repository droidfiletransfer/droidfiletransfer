# Fonts

- `Figtree-VariableFont_wght.woff2`: [Figtree](https://fonts.google.com/specimen/Figtree),
  weights 300 to 900, Latin only. Other scripts fall back to the system font.
- `MaterialSymbolsOutlined-subset.woff2`: [Material Symbols](https://fonts.google.com/icons),
  cut down to the glyphs the app uses. A glyph outside the subset renders as
  its literal name.

## Regenerating the icon subset

Google subsets server-side. Add the new glyph name to `ICONS` and run this from
the project root:

```sh
ICONS="android,arrow_back,arrow_forward,audiotrack,autorenew,cable,check,close,computer,create_new_folder,delete,description,edit,error,folder,image,keyboard_arrow_down,keyboard_arrow_up,movie,refresh,schedule"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"

URL=$(curl -sS -A "$UA" \
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:FILL,wght,GRAD,opsz@0..1,200..400,0,24&icon_names=$ICONS&display=block" \
  | sed -n 's/.*src: url(\([^)]*\)).*/\1/p')

curl -sS -o fonts/MaterialSymbolsOutlined-subset.woff2 "$URL"
```

The `-A` User-Agent is required: without it Google returns TTF. The returned
URL has no `.woff2` extension, so the `sed` takes whatever is inside `url()`.
Keep the axis string as it is: `FILL` must stay variable (`0..1`) or the
`fill` class in `style.css` stops working.
