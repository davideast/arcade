/**
 * Air hockey's Realtime Database rules, written with Pyric's constraint
 * builders. `bun tools/rtdb-rules.ts` writes app/database.rules.json from
 * `airHockeyRtdbRules.toJSON()`; the rules tests fail when that file drifts
 * from this source.
 *
 * The live match is `airhockey/$matchId/$host` (see logic.ts for the
 * layout). The rules check who writes what and the shape of each value;
 * they can't run the physics:
 *   - Only the host ($host) creates meta, and only once. Meta names the
 *     guest, who can't be the host, and starts 'playing' with no winner.
 *   - Only the two players read the match; a stranger reads nothing.
 *   - Every live write needs meta's stored status to be 'playing', so
 *     nothing changes once the match has ended. No write deletes a node.
 *   - Only the host writes the frame (the puck and both mallets as it
 *     simulates them) and the score; only the guest writes guestMallet;
 *     each player writes only its own presence.
 *   - Positions are numbers inside the table, and each mallet inside its own
 *     half; the puck's speed is at most MAX_SPEED, and its tick only grows.
 *   - The score starts at 0 to 0 and changes by one goal for one side per
 *     write, up to WIN_SCORE, and a score that reaches WIN_SCORE closes meta.
 *   - Meta ends once: 'over' by the host with the winner's score at
 *     WIN_SCORE, 'forfeit' by a player while the other's presence is false,
 *     or 'resigned' naming the other player the winner.
 *
 * Where the checks live: each node's `.write` holds its access check and
 * every check on its value (bounds, transitions, cross-field checks), and
 * each field's `.validate` holds only its type, with `$other` rejecting any
 * other field. Nothing above these nodes grants a write, so a `.write` here
 * is always evaluated, on the merged value at its node, for a write at the
 * node or below it. Keeping the value checks out of `.validate` keeps them
 * off writes to other nodes: Pyric's sandbox evaluates the `.validate`
 * rules of unchanged sibling nodes on every write (bugs/0012) and re-parses
 * each expression it evaluates (bugs/0013), which made a host frame cost
 * about 48 ms with the value checks in `.validate`. For the same reason the
 * host's frame is one node, written with one path.
 */
import {
  AUTH_UID,
  all,
  any,
  authenticated,
  dataParentVal,
  dataVal,
  defineRtdbRules,
  deny,
  eq,
  expr,
  immutable,
  isNew,
  lte,
  neq,
  newDataExists,
  newDataIs,
  newDataParentVal,
  newDataVal,
  not,
  ownPath,
  required,
  rtdbRules,
  type Expr,
  type PathDef,
} from 'pyric/rules';
import { MAX_SPEED, TABLE, WIN_SCORE, malletBox, type Side } from './physics.ts';

type FieldType = 'Number' | 'String' | 'Boolean';

/** Child `field` of the written value is from `lo` to `hi`. */
function between(field: string, lo: number, hi: number): Expr {
  return all(expr(`${newDataVal(field)} >= ${lo}`), lte(newDataVal(field), hi));
}

/** Child `field` of the written value is one of `values`. */
function oneOf(field: string, values: string[]): Expr {
  return any(...values.map((v) => eq(newDataVal(field), v)));
}

/** Typed children, and no others. */
function only(fields: Record<string, FieldType>): Record<string, PathDef> {
  const children: Record<string, PathDef> = {};
  for (const [name, type] of Object.entries(fields)) children[`/${name}`] = { validate: newDataIs(type) };
  children['/$other'] = { validate: deny() };
  return children;
}

/** A mallet position, at child `prefix` of the written value, inside `side`'s box. */
function malletIn(side: Side, prefix = ''): Expr {
  const b = malletBox(side);
  return all(
    required(`${prefix}x`, `${prefix}y`),
    between(`${prefix}x`, b.minX, b.maxX),
    between(`${prefix}y`, b.minY, b.maxY),
  );
}

const xy = only({ x: 'Number', y: 'Number' });

const isHost = all(authenticated(), ownPath('$host'));

/** At a node `depth` levels below the match: the writer is the guest meta names. */
const isGuestAt = (depth: number) => all(authenticated(), eq(dataParentVal(depth, 'meta/guest'), AUTH_UID));

/** At a node `depth` levels below the match: the stored match is in play. */
const liveAt = (depth: number) => eq(dataParentVal(depth, 'meta/status'), 'playing');

/** A host-only live node one level below the match. */
const hostLive = all(isHost, newDataExists(), liveAt(1));

const metaShape = all(
  required('guest', 'status', 'winner'),
  neq(newDataVal('guest'), ''),
  neq(newDataVal('guest'), { $: '$host' }),
  oneOf('status', ['playing', 'over', 'forfeit', 'resigned']),
  oneOf('winner', ['', 'host', 'guest']),
);

const metaCreate = all(
  isNew(),
  ownPath('$host'),
  eq(newDataVal('status'), 'playing'),
  eq(newDataVal('winner'), ''),
);

const metaOver = all(
  ownPath('$host'),
  eq(newDataVal('status'), 'over'),
  any(
    all(eq(newDataVal('winner'), 'host'), eq(newDataParentVal(1, 'score/host'), WIN_SCORE)),
    all(eq(newDataVal('winner'), 'guest'), eq(newDataParentVal(1, 'score/guest'), WIN_SCORE)),
  ),
);

const metaForfeit = all(
  eq(newDataVal('status'), 'forfeit'),
  any(
    all(ownPath('$host'), eq(newDataVal('winner'), 'host'), eq(dataParentVal(1, 'presence/guest'), false)),
    all(not(ownPath('$host')), eq(newDataVal('winner'), 'guest'), eq(dataParentVal(1, 'presence/host'), false)),
  ),
);

const metaResigned = all(
  eq(newDataVal('status'), 'resigned'),
  any(
    all(ownPath('$host'), eq(newDataVal('winner'), 'guest')),
    all(not(ownPath('$host')), eq(newDataVal('winner'), 'host')),
  ),
);

/** A player ends the match in play, once. */
const metaEnd = all(
  eq(dataVal('status'), 'playing'),
  any(ownPath('$host'), eq(dataVal('guest'), AUTH_UID)),
  immutable('guest'),
  any(metaOver, metaForfeit, metaResigned),
);

const frameValue = all(
  required('puck/x', 'puck/y', 'puck/vx', 'puck/vy', 'puck/t'),
  between('puck/x', 0, TABLE.width),
  between('puck/y', 0, TABLE.height),
  between('puck/vx', -MAX_SPEED, MAX_SPEED),
  between('puck/vy', -MAX_SPEED, MAX_SPEED),
  expr(`${newDataVal('puck/vx')} * ${newDataVal('puck/vx')} + ${newDataVal('puck/vy')} * ${newDataVal('puck/vy')} <= ${MAX_SPEED * MAX_SPEED}`),
  any(isNew(), expr(`${newDataVal('puck/t')} > ${dataVal('puck/t')}`)),
  malletIn('host', 'host/'),
  malletIn('guest', 'guest/'),
);

const scoreStep = all(
  required('host', 'guest'),
  between('host', 0, WIN_SCORE),
  between('guest', 0, WIN_SCORE),
  any(
    all(isNew(), eq(newDataVal('host'), 0), eq(newDataVal('guest'), 0)),
    all(expr(`${newDataVal('host')} == ${dataVal('host')} + 1`), expr(`${newDataVal('guest')} == ${dataVal('guest')}`)),
    all(expr(`${newDataVal('guest')} == ${dataVal('guest')} + 1`), expr(`${newDataVal('host')} == ${dataVal('host')}`)),
  ),
  any(
    all(expr(`${newDataVal('host')} < ${WIN_SCORE}`), expr(`${newDataVal('guest')} < ${WIN_SCORE}`)),
    eq(newDataParentVal(1, 'meta/status'), 'over'),
  ),
);

export const airHockeyRtdbDefinition = defineRtdbRules({
  paths: {
    '/': { read: deny(), write: deny() },
    '/airhockey/$matchId/$host': {
      read: all(authenticated(), any(ownPath('$host'), eq(dataVal('meta/guest'), AUTH_UID))),
      children: {
        '/meta': {
          write: all(authenticated(), newDataExists(), metaShape, any(metaCreate, metaEnd)),
          children: only({ guest: 'String', status: 'String', winner: 'String' }),
        },
        '/frame': {
          write: all(hostLive, frameValue),
          children: {
            '/puck': { children: only({ x: 'Number', y: 'Number', vx: 'Number', vy: 'Number', t: 'Number' }) },
            '/host': { children: xy },
            '/guest': { children: xy },
            '/$other': { validate: deny() },
          },
        },
        '/guestMallet': { write: all(isGuestAt(1), newDataExists(), liveAt(1), malletIn('guest')), children: xy },
        '/score': {
          write: all(hostLive, scoreStep),
          children: only({ host: 'Number', guest: 'Number' }),
        },
        '/presence/$side': {
          write: all(
            newDataExists(),
            liveAt(2),
            any(all(expr('$side == "host"'), isHost), all(expr('$side == "guest"'), isGuestAt(2))),
          ),
          validate: newDataIs('Boolean'),
        },
      },
    },
  },
});

export const airHockeyRtdbRules = rtdbRules(airHockeyRtdbDefinition);
