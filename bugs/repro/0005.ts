// Repro 0005: the "Test in Node" guide's import, as written, against the modular import.
// The package is correct (modular admin SDK); the guide is wrong. Exit 1 while the
// guide's import fails.
//   bun bugs/repro/0005.ts
const asWrittenInGuide = await import('pyric-admin');
const modular = await import('pyric-admin/firestore');
console.log("guide: import { getFirestore } from 'pyric-admin' ->", 'getFirestore' in asWrittenInGuide ? 'ok' : 'missing');
console.log("modular: import { getFirestore } from 'pyric-admin/firestore' ->", 'getFirestore' in modular ? 'ok' : 'missing');
process.exit('getFirestore' in asWrittenInGuide ? 0 : 1);
