# CHG-0046 Evidence

This retained evidence covers the proxy-safe Output transport defined by ADR-0037. The focused
proof uses the real auth routes, production routes, WebSocket handler, compiler target, unmodified
production client and shared renderer through an ephemeral HTTPS terminator and WebSocket upgrade
proxy in branded Chrome.

Observed results:

- the Output page loaded over HTTPS and derived same-origin WSS at `/ws`;
- the page and WebSocket upgrade request targets contained no Output bearer;
- the `authenticate.output` frame preceded the Program subscription;
- cross-Show Program and same-Show Preview subscriptions remained denied;
- Program contained 0 visible pixels before Take;
- Program contained 49,560 visible pixels after Take while 2,024,040 pixels remained transparent;
- rotation closed the established credential with policy code 1008;
- the old credential could not reconnect or receive the second Program snapshot; and
- the replacement same-Show credential received current Program.

[`report.json`](report.json) binds the observations to program, bundle, compilation receipt and PNG
hashes. The report, PNGs and request-target assertions retain no Output token, session cookie,
credential digest, TLS private key or WebSocket payload. The test certificate and key are generated
ephemerally under the system temporary directory and removed after the proof.

Run the proof with:

```bash
npm run proof:output-transport
```

The hostile unit boundary separately covers legacy query rejection; missing, malformed, oversized,
late and repeated authentication; exact-Show scope; Preview and mutation denial; and rotation.

This evidence establishes a standards-based browser and local TLS proxy boundary only. OBS is not
installed in the evidence environment, so real OBS loading, refresh, capture and compositing remain
unproven. Public PKI, DNS, external proxy products, network loss and human broadcast acceptance also
remain outside this claim.
