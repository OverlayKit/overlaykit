# CHG-0047 Evidence — Real OBS acceptance (local review sample)

This evidence covers the real-consumer acceptance defined by ADR-0038. An operator-run OBS Studio
process loaded the fragment-credential Output URL in an `obs-browser` (Chromium Embedded
Framework) source that the proof created through obs-websocket. The proof boots the real auth
routes, production routes, WebSocket handler, Vite client and shared renderer, and observes OBS's
own render of the source and of the scene that contains it.

**This is a local review sample, not a Constitution gate.** GitHub-hosted runners do not run OBS,
so `npm run proof:obs-acceptance` skips there and writes no evidence; the report below was
produced on the maintainer workstation and is classified `local-review-sample`. It observes one
OBS build over loopback HTTP only.

## Environment (fingerprint)

- OBS Studio 32.2.2, obs-websocket 5.7.4 (RPC version 1), `obs-browser` on CEF 127.0.6533.120.
- Platform: Freedesktop SDK 25.08 Flatpak runtime, Wayland/EGL, NVIDIA driver with obs-browser
  hardware acceleration disabled (software rendering).
- Browser-source user agent: `… Chrome/127.0.6533.120 OBS/32.2.2 …`.
- Canvas 1920x1080. Loopback HTTP page origin; obs-browser exposes no certificate-trust override,
  so OBS-over-TLS is out of scope.

## Observed results

- OBS's embedded browser opened a WebSocket whose upgrade target was `/ws` with **no** Output
  bearer, whose `Origin` equalled the page origin, and whose first application frame was
  `authenticate.output`, with `authentication.confirmed` **before** `production.subscription.confirmed`.
- The document request line named `/production` and carried no bearer (the credential stayed in
  the URL fragment).
- OBS render of the source before Take: **0** visible pixels (fully transparent).
- OBS render of the source after Take: **49,560** visible pixels, 97.6% transparent — identical to
  the branded-Chrome CHG-0046 proof.
- OBS render of the **scene** containing the source after Take: **49,560** visible pixels (OBS
  compositing).
- An OBS-initiated `refreshnocache` reload re-authenticated with the page-held credential
  (`authenticate.output` first, before subscription), closed the previous connection, and
  re-presented the Program (**49,560** visible pixels).
- Rotation closed the established OBS connection with policy code **1008**, and the browser
  source's reconnect with the old credential was **denied**.

## Hash binding

- Program: `f9bbb90baf7f81e60434578bc36749477bf473fa73326d746493dd59463f20df`
- Bundle: `21c1fa0a743570d3feaee21b76a2e3a4f6fcf5b89422e0e365c8f72b6a690454`
- Compilation receipt: `b7b90586b56f7adf5fa8bb09f566ab8c2bd4464f10ca3b67b4f4ff8781a56c1e`
- `report.json`: `8d81736ebc8f325e74270833c4347157c7f037b5a4a6c1b72297bdfb8a78ece6`
- `program-before-take.png`: `673b1f8dc4985bdb24b1ebfd9591d49ef40efb12de1a8336e0a7b91e1d15bf87`
- `program-after-take.png`: `8a9775fb7764fd29d90e64bd75c78e12eab49c2bef8a52e0094fabc72c7f0add`
- `scene-after-take.png`: `8a9775fb7764fd29d90e64bd75c78e12eab49c2bef8a52e0094fabc72c7f0add`
- `program-after-refresh.png`: `8a9775fb7764fd29d90e64bd75c78e12eab49c2bef8a52e0094fabc72c7f0add`

The report and PNGs retain no Output token, password, session cookie or WebSocket payload.

## Reproduce

Attach to an OBS you already run (not streaming or recording) with obs-websocket enabled, then:

```bash
OVERLAYKIT_OBS_WEBSOCKET_PASSWORD=<obs-websocket password> \
OVERLAYKIT_REQUIRE_OBS=1 \
OVERLAYKIT_OBS_PROOF_DIR=docs/evidence/CHG-0047 \
npm run proof:obs-acceptance
```

The proof attaches only: it creates one dedicated scene and one browser source, switches Program to
that scene, restores the previous Program scene and removes both on teardown. Without a reachable,
authenticated obs-websocket endpoint it skips with a visible reason and writes nothing (set
`OVERLAYKIT_REQUIRE_OBS=1` to fail instead). OBS persists the browser-source URL — including the
fragment credential — in its scene collection, so rotate the Output credential after exporting or
sharing a collection.

## Boundary

This proves standards-based real-OBS loading, authentication, compositing and OBS-initiated
refresh over loopback HTTP on one workstation and one OBS build. It does not prove OBS over TLS or
WSS, public PKI or DNS, external proxy products, stream/record/virtual-camera output truth,
hardware-accelerated CEF, other GPUs, drivers, platforms or OBS/CEF versions, long-running
stability, network loss, portrait or arbitrary source dimensions, or perceptual broadcast quality.
`GetSourceScreenshot` renders the source and scene, not the encoded program output.
