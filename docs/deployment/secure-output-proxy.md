# Secure Output Proxy

OverlayKit listens on loopback by default and does not terminate public TLS. Keep the REST and
WebSocket listeners private, and publish the built Output client through a reverse proxy on one
verified HTTPS origin.

## Build

Do not set `VITE_WS_URL` for the Output build. The client will derive `/ws` from its page origin,
using `wss:` whenever the page uses `https:`.

Set the public Output origin when building Studio so newly issued browser-source URLs point to the
public client:

```bash
npm run build --workspace @overlaykit/overlay
VITE_OVERLAY_URL=https://output.example.com npm run build --workspace @overlaykit/studio
```

The Output bearer is stored in the URL fragment as `#output=...`. URI fragments are removed before
HTTP dereference, so the generated page request does not send that value to the proxy. The client
sends it only as the first WebSocket application frame after the WSS connection opens. Do not
enable WebSocket frame or payload capture in the proxy or another intermediary.

Previously issued URLs containing `?token=...` no longer authenticate. Rotate the Output credential
and replace the browser-source URL after upgrading.

## Server

Keep both listeners on loopback and allow the exact public Output origin:

```dotenv
HOST=127.0.0.1
WS_HOST=127.0.0.1
REST_PORT=3000
WS_PORT=8080
CORS_ORIGIN=https://studio.example.com,https://output.example.com
COOKIE_SECURE=always
TRUST_PROXY=1
```

`TRUST_PROXY` must match the actual number of trusted proxy hops. Do not expose ports 3000 or 8080
directly to the LAN or Internet.

## Caddy Example

This example serves the built Output client, proxies browser WebSocket upgrades to the loopback
server, and preserves access to bundled sounds:

```caddyfile
output.example.com {
  encode zstd gzip

  handle /ws {
    reverse_proxy 127.0.0.1:8080
  }

  handle /sounds/* {
    reverse_proxy 127.0.0.1:3000
  }

  handle {
    root * /srv/overlaykit/client
    try_files {path} /index.html
    file_server
  }
}
```

Copy `client/dist/` to `/srv/overlaykit/client/` or change the root to the deployed directory.
Caddy supports WebSocket upgrade tunneling through `reverse_proxy`; no credential belongs in the
proxy route or query.

References: [RFC 3986 fragment handling](https://www.rfc-editor.org/rfc/rfc3986.html#section-3.5),
[RFC 6455 WebSocket protocol](https://www.rfc-editor.org/rfc/rfc6455.html), and
[Caddy WebSocket proxying](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming).

## Consumer Configuration

OBS stores the browser-source URL, including the `#output=...` fragment, inside its scene
collection on disk. Treat exported, backed-up or shared OBS scene collections as credential
disclosure: rotate the Output credential afterwards and replace the browser-source URL. The same
applies to any other consumer that persists the URL it was given.

The real-OBS acceptance proof (`npm run proof:obs-acceptance`, CHG-0047) attaches to an OBS that
you already run, through obs-websocket on loopback, and creates only a dedicated scene and input
that it removes afterwards. It refuses to run while OBS is streaming or recording and skips
without writing evidence when obs-websocket is unreachable. Its evidence is a local review sample
over loopback HTTP; it is not a Constitution gate and does not prove OBS over TLS.

## Evidence Boundary

CHG-0046 exercises the real Output client through local TLS termination and a WebSocket upgrade
proxy in branded Chrome. CHG-0047 observes the same Output URL in a real OBS browser source over
loopback HTTP on one workstation. Neither proves that a public CA or DNS path is correct, that a
particular external proxy preserves long-lived sockets, that OBS trusts a given certificate, or
that the rendered result is perceptually acceptable on air.
