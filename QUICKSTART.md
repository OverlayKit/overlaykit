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

Create a Show. Its **Production** workspace contains the editor, live panel, and current output.

## 4. OBS Setup

Open **Show → Output**, rotate the output token, and copy the complete one-time browser-source URL into OBS. The URL has this shape:

```text
http://localhost:5183/production?channel=<show-id>&transparent=true&token=<output-token>
```

The output credential is read-only. Rotating it invalidates every previously issued OBS URL.

Use a 1920x1080 source for landscape scenes or 1080x1920 for portrait scenes.
