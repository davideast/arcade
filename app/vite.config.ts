import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';
import { fileURLToPath } from 'node:url';

// During `vite dev`, pyric() resolves firebase/* to the local sandbox, hosted in
// the Vite server process so every browser shares one sandbox, and
// serves firestore.modules.rules, including the game rules files it imports,
// hot-reloading when any of them changes. A production build uses Firebase.
export default defineConfig({
  plugins: [pyric({ hosted: true })],
  // main.ts awaits sign-in at the top level, which needs an ES2022 target.
  build: { target: 'es2022' },
  server: {
    // Sprite sheets live in the repository's MASFunPack directory.
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
});
