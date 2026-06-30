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

## 3. Open The Apps

- Editor: http://localhost:5174
- Panel: http://localhost:5181/?channel=main
- OBS: http://localhost:5173/production?channel=main&transparent=true

## 4. OBS Setup

Add a Browser Source and use:

```text
http://localhost:5173/production?channel=main&transparent=true&hideStatus=true&hideWatermark=true
```

Use a 1920x1080 source for landscape scenes or 1080x1920 for portrait scenes.
