/** @type {import('tailwindcss').Config} */
export default {
  // Use OS preference for dark mode — consistent with the existing CSS
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,jsx}',
  ],
  // Don't override existing browser/custom resets — only apply utilities
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        // Map to shadcn CSS variables so components work correctly
        border: 'var(--tw-border)',
        background: 'var(--tw-background)',
        foreground: 'var(--tw-foreground)',
        accent: {
          DEFAULT: 'var(--tw-accent)',
          foreground: 'var(--tw-accent-foreground)',
        },
        ring: 'var(--tw-ring)',
      },
    },
  },
  plugins: [],
}
