# DSL Offline

Windows desktop launcher for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A launcher built around **modpacks**: each pack is a complete, isolated DSH environment that carries its own kernel. Import a `.zip`, press start, done — no Node.js or DSH preinstall required, works offline.

Full documentation (Chinese): [README.md](README.md)

## Build

```bash
npm install
npm run dev
npm run build
npm run package:inno
```

If electron-builder stalls while fetching the Electron binary, set `ELECTRON_MIRROR` before packaging.
