# Real browser storage checks

No IndexedDB mock or packages are used. From `web-engine`, run:

```sh
npm run build
python3 -m http.server 8001 --bind 127.0.0.1
```

Open `/tests/browser/platform.html` on that server. Click **Run storage tests**
and expect PASS. Click **Write reload fixture**, reload the page, then click
**Check reload fixture** and expect PASS. Tests use isolated database namespaces
and delete their own fixtures; they do not touch game/profile user data.

The normal asset server intentionally serves only app assets, so use this
separate development server for the test harness. The app at `/index.html` on
this static server can also exercise **User data** without any game API endpoint.

`/tests/browser/input.html` runs DOM input checks automatically, including
letterboxing, edge consumption, wheel events, selectable text, focus loss, touch taps,
long-press and two-finger right clicks, dragging, secondary contacts, capture loss, and mouse regression.
Touch events are synthetic and capture is stubbed; physical device testing is still needed.
`/tests/browser/noah-paths.html` checks native Windows path persistence and
stable achievement identifiers across a real IndexedDB close/reopen. Both use
the same built modules as the app. The path test creates and removes only its
own randomly named test database.

`draw-list.html` exercises the reusable Canvas sprite backend: seven pixel checks for RGB modulation, opacity, source cropping, invalidation and clearing. Copy it to `dist/draw-list-test.html` and open that page through the existing development server.

`scene-graphics.html` renders captured first-scene frames and checks triangle
interpolation, tint, additive blending and painter order. Generate its fixtures
with `NOAH_SCENE_CAPTURE=1 npm run verify:scene`, copy the HTML to
`dist/scene-graphics-test.html`, then open that path on the asset server.
