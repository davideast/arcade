// Repro 0005: the "Test in Node" guide imports getFirestore from 'pyric-admin',
// which does not export it. Exit 1 while the guide's import fails.
//   bun bugs/repro/0005.ts
const root = await import('pyric-admin');
const firestore = await import('pyric-admin/firestore');
console.log("'pyric-admin' exports getFirestore:", 'getFirestore' in root);
console.log("'pyric-admin/firestore' exports getFirestore:", 'getFirestore' in firestore);
process.exit('getFirestore' in root ? 0 : 1);
