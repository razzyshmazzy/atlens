# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Vite dev server with HMR
npm run build     # Production build (outputs to dist/)
npm run lint      # Run ESLint
npm run preview   # Preview the production build locally
```

No test runner is configured.

## Architecture

React 19 + Vite 7 project using JavaScript (JSX), not TypeScript.

**Entry point chain:** `index.html` → `src/main.jsx` → `src/App.jsx`

- `src/main.jsx` — mounts `<App>` inside React StrictMode on `#root`
- `src/App.jsx` — root component
- `src/index.css` — global styles (CSS custom properties, dark/light theme via `prefers-color-scheme`)
- `src/App.css` — component-scoped styles

## ESLint

Uses the flat config format (`eslint.config.js`). Targets `.js` and `.jsx` files. Unused variables are allowed if they match `^[A-Z_]` (uppercase or underscore-prefixed).
