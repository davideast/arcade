# Pyric Games

Two-player browser games built with Phaser 4, using the sprite sheets in `MASFunPack/`. Firestore Security Rules act as the referee, and Pyric runs Firebase locally during development.

## Run it

```bash
bun install
bun run dev        # http://localhost:5173
```

Open a second tab to play the other seat. Each tab signs in as its own anonymous user.

```bash
bun run test       # resolve the rules, then run the rules harness
bun run typecheck
```

## Layout

| Path | What it holds |
|---|---|
| `app/` | The Vite app: `pyric()` plugin, the lobby page, and `firestore.modules.rules`, which imports each game's rules |
| `packages/kit/` | Phaser helpers: a 128x128 pixel canvas rendered at 4x, sheet frames, grid boards, crisp text |
| `packages/turn-net/` | The Firebase layer: sign-in, lobby, joining, moves in transactions, resign |
| `packages/harness/` | Plays seeded random games through Pyric's rules simulator: every real transition must be allowed, every cheat denied |
| `games/<name>/` | One game: `logic.ts` (pure rules of play), `scene.ts` (Phaser), `<name>.rules` (Security Rules), `rules.test.ts` |
| `tools/` | TypeScript tools: find sprites on a sheet, dump a sheet's pixels, run a removal probe on a rules check |
| `vendor/pyric/` | Pyric packed from a local checkout |

## Add a game

1. Write `games/<name>/src/logic.ts` with a `GameDefinition`: initial state, legal moves, apply, outcome, and document fields.
2. Write `games/<name>/<name>.rules` and import its functions in `app/firestore.modules.rules`. Local rules modules can't import, so stdlib imports go in the main file.
3. Add `rules.test.ts` that calls `runHarness`, plus cheats specific to the game.
4. Probe each rules check with `bun tools/removal-probe.ts` and confirm the harness catches its removal.
5. Write the Phaser scene with `@games/kit`, and add it to the app.

## Rules workflow

`app/vite.config.ts` resolves `firestore.modules.rules` with the Pyric CLI whenever any `.rules` file changes, and Pyric serves the generated `firestore.rules`. Edit the module files, not `firestore.rules`.
