# CHG-0045 authenticated Output evidence

This evidence exercises the real local authentication, production HTTP routes, production
WebSocket handler, compiled visual target, unmodified production client, and shared renderer in
branded Chrome at 1920 by 1080.

## Result

- The Output credential was issued for `output-authority-show` and denied both another Show's
  Program and its own Show's Preview.
- Program contained zero visible pixels before authenticated `Take`.
- `Take` promoted Preview revision 1 to Program revision 1 and produced 49,560 visible pixels while
  preserving 2,024,040 transparent pixels.
- Rotation closed an established Output connection with WebSocket policy code 1008, denied the old
  token on reconnect, and prevented the retired client from receiving the second Program snapshot.
- A replacement credential for the same Show received the second Program snapshot.

## Artifacts

- `program-before-take.png`: fully transparent Program before Take, SHA-256
  `0f919687ec4cc34670b2c0e7c0dfe85748582612a9b1d953662fad9fcb3f8cb6`.
- `program-after-take.png`: exact-Show Program after Take, SHA-256
  `e0ded7dc955865f67013c96f5f381fe35bc7c1d2025559a50b5d71ccdd929808`.
- `report.json`: non-secret authority, compilation, revision, pixel, and screenshot evidence,
  SHA-256 `3af349389bf65c89ea573de50743559b480116984b74cfb9b70568397e14a3d1`.

Regenerate the evidence from the repository root:

```bash
OVERLAYKIT_OUTPUT_TRANSPORT_PROOF_DIR=docs/evidence/CHG-0045 npm run proof:output-authority
```

## Boundary

This local proof does not establish real OBS behavior, TLS or proxy behavior, network-loss
recovery, multi-destination credential semantics, or human on-air acceptance. No bearer token,
session cookie, or credential digest is retained in the report, screenshots, or committed logs.
