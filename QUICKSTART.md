# OverlayKit Quickstart

## 1. Install

```bash
git clone https://github.com/OverlayKit/overlaykit.git
cd overlaykit
npm install
```

## 2. Run The Local Stack

```bash
npm run dev:core
```

## 3. Secure The Instance

Open http://localhost:5173 and create the single local owner account. Studio redirects to this first-run setup until it is complete.

Create a Show, open **Scenes**, and save a Scene. Then open **Production**:

1. Select a Scene in the rundown to load it into Preview.
2. Inspect the Preview monitor. Program remains unchanged.
3. Press **Take** to atomically promote Preview to Program.

Editor **Send to Preview** follows the same boundary. Runtime operations do not overwrite the saved Scene.

## 4. OBS Setup

Open **Show → Output**, rotate the output token, and copy the complete one-time browser-source URL into OBS. The URL has this shape:

```text
http://localhost:5183/production?show=<show-id>&bus=program&transparent=true&token=<output-token>
```

The output credential is read-only. Rotating it invalidates every previously issued OBS URL.

Preview and Program are currently ephemeral across a server-process restart. Reconnecting clients recover the current in-process snapshot.

Use a 1920x1080 source for landscape scenes or 1080x1920 for portrait scenes.
