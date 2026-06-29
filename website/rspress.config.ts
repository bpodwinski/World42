import { defineConfig } from '@rspress/core';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sidebar = [
  { text: 'Getting Started', link: '/getting-started' },
  { text: 'Architecture', link: '/architecture' },
  {
    text: 'Core Systems',
    items: [
      { text: 'Coordinate Spaces', link: '/coordinate-spaces' },
      { text: 'LOD System (OCBT)', link: '/lod-system' },
      { text: 'Terrain & WASM', link: '/terrain-wasm' },
      { text: 'Render Pipeline', link: '/render-pipeline' },
      { text: 'Stellar Catalog', link: '/stellar-catalog' }
    ]
  },
  { text: 'Contributing', link: '/contributing' }
];

export default defineConfig({
  root: path.join(__dirname, 'docs'),
  base: '/World42/docs/',
  outDir: 'doc_build',
  title: 'World42',
  description:
    'Real-time 1:1 scale planetary rendering engine — TypeScript · WebGPU · BabylonJS · Rust/WASM',
  lang: 'en',
  themeConfig: {
    darkMode: true,
    nav: [
      { text: 'Docs', link: '/getting-started' },
      {
        text: 'Live Demo',
        link: 'https://bpodwinski.github.io/World42/',
        target: '_blank'
      },
      {
        text: 'GitHub',
        link: 'https://github.com/bpodwinski/World42',
        target: '_blank'
      }
    ],
    sidebar: {
      '/': sidebar
    },
    socialLinks: [
      {
        icon: 'github',
        mode: 'link',
        content: 'https://github.com/bpodwinski/World42'
      }
    ],
    footer: {
      message: 'World42 — open source planetary rendering engine.'
    }
  },
  globalStyles: path.join(__dirname, 'theme', 'index.css')
});
