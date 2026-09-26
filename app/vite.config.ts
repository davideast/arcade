import { defineConfig, type Plugin } from 'vite';
import { pyric } from '@pyric/cli/vite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const appRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * Pyric's dev server resolves `2+modules` rules in memory, which supports
 * stdlib imports but not imports of the game rules files beside each game.
 * This plugin resolves firestore.modules.rules with the pyric CLI, which reads
 * those files from disk, and rewrites firestore.rules whenever any .rules file
 * changes. pyric() serves and hot-reloads firestore.rules.
 */
function resolveRulesModules(): Plugin {
  const resolve = () => {
    execFileSync('bun', ['run', 'rules:resolve'], { cwd: appRoot, stdio: 'inherit' });
  };
  return {
    name: 'resolve-rules-modules',
    apply: 'serve',
    enforce: 'pre',
    config() {
      resolve();
    },
    configureServer(server) {
      server.watcher.add(`${repoRoot}games/*/*.rules`);
      server.watcher.on('change', (file) => {
        if (!file.endsWith('.rules') || file.endsWith('/app/firestore.rules')) return;
        try {
          resolve();
        } catch {
          server.config.logger.error(`Rules did not resolve after changing ${file}`);
        }
      });
    },
  };
}

// During `vite dev`, pyric() resolves firebase/* to the local sandbox. A
// production build uses Firebase.
export default defineConfig({
  plugins: [resolveRulesModules(), pyric({ rules: 'firestore.rules' })],
  server: {
    // Sprite sheets live in the repository's MASFunPack directory.
    fs: { allow: [repoRoot] },
  },
});
