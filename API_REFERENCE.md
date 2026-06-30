# OverlayKit OSS API Reference

Base URL: http://localhost:3000
WebSocket: ws://localhost:8080

## REST

- GET /health
- POST /api/elements
- PUT /api/elements/:id
- DELETE /api/elements/:id
- POST /api/variables
- POST /api/scenes
- POST /api/scenes/:sceneId/activate
- GET /api/collections
- GET /api/collections/:id
- POST /api/collections
- DELETE /api/collections/:id
- POST /api/collections/:id/activate
- GET /api/actions
- POST /api/actions
- POST /api/actions/:id/run
- GET /api/sounds
- POST /api/sounds/play

All state is local to the self-hosted server process and persisted to the local data directory when supported by the route.

## WebSocket Client Messages

```json
{ "type": "subscribe", "channelId": "main" }
{ "type": "unsubscribe", "channelId": "main" }
{ "type": "ping" }
```

## OBS URL

```text
http://localhost:5173/production?channel=main&transparent=true
```
