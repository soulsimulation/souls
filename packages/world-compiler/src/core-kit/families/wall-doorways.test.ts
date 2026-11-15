// #2383 review: the 40 door-fitted building revisions are pinned. Each derived def keeps its ref and its bytes (the library's
// def hash), whatever def revision lands later; a change here is a new revision and a new supplement, never an edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coreLibrary } from '../../library.ts';
import { DOOR_FIT_FROM, DOOR_FITTED_BUILDINGS, DOOR_FITTED_VERSIONS } from './wall-doorways.family.ts';

const PINNED: [string, string][] = [
  ["core/cottage@2", "aeb09ddb7a10fbe06d8d78d67b6ec6a1b7f753afa9d3aaa3319cc043be63ff5e"],
  ["core/roundhouse@2", "e4ff57c2505a1bf15a502e1a7f1443dc05423bd1f84c1e41132d6ebdf19e8a3f"],
  ["core/townhouse@2", "261535a8758be862b35b8a17f794bd30188ceb49816d69c92c3234a143cc1377"],
  ["core/shop@2", "96e7964a197fabfa150a3633a06eca74a62b1e16307822b8834b7a8a8c4fe9db"],
  ["core/hall@3", "edc4fc1be00d8310d7eea56bf4bf3d5e311a0cd048d18127a92ddfa45c4445bc"],
  ["core/chapel@2", "3056ef139ea4123979c62793a2279aaf18265e5e5b15950176455cdf3bfb6e76"],
  ["core/barn@2", "df46399386ce5fc39f48d48292e442a865000beb5f41a13ec0c376683ed46dab"],
  ["core/shed@2", "137fb8b334392527f08feb3f3ee4fc14783c819bb751b160e1aec87325a7698d"],
  ["core/greenhouse@2", "5e9cd22647358b65b6fdf589f6923a30e9bb84cfe6ab88f05db140a1f3a1b28f"],
  ["core/pavilion@2", "b4a1ab49583f84414c34c3cc32bdc571f9b8b69c22be4856e6754a1d73656e99"],
  ["core/tower@2", "802b00bc171f1faf474d2645cb4c3171a107fd3872e558a2068873fe3f567e99"],
  ["core/lighthouse@2", "f5465193ef557681f709528a0a99981e1f2acfabb0263d5af9b3b6b94e52989e"],
  ["core/house@2", "bcbc7d313046faf63903aab6669db597162f51786eb579e337f829fefcc8f26d"],
  ["core/apartment-block@2", "1a1f9b3ea74a354b2d12674e0eb6be4ce17a6444c53de51b3244b594f2bac0c6"],
  ["core/townhouse-row@2", "18a884c734d82eb0bd815c5fb0818df5e1a02c4bdab573ac9bfdfbc3e3381b4d"],
  ["core/cabin@2", "fe0e3814e9d204e771a62986bda2b49987b7fb6fb66e1690405947f5a3591ce2"],
  ["core/mansion@2", "e73aedecc949e23c1465328169c05fd49bbcee727054da2ff199a5aec3495d22"],
  ["core/dormitory@2", "64d30cf173507884ab4696d3a84d1ca7063893741129fce04c6cc90cd8f1323b"],
  ["core/hotel@2", "f8e93f0d53f7face204dd7e37c76a13304a9a11396223b3b6f3935ab5060fe7a"],
  ["core/mobile-home@2", "00dab0cade4804d1906bbf6a558a0195b8b3fa0ae2a33efa9d40ee0835cd1000"],
  ["core/corner-shop@2", "b926df0ab379cdfca69dd3c1d8af2a734b37aa36b73917cfd4693b4f177978bf"],
  ["core/supermarket@2", "36a53796267f659dbbc7b40f644c00108b5393f0a930188a9f0a43769654f5af"],
  ["core/restaurant@2", "724f8e82ee4023b4eb8e2759132c5918f181f0905a8914f3cb5652b6729fb326"],
  ["core/cafe@2", "144ed13cfef76a9319a65cf968825f9a31224315736e450f168cc701d957ffeb"],
  ["core/bar@2", "02a69cfa9c67e42168e18b5cd8026ea830ab73de2a04daa43983eb3b30590974"],
  ["core/bank@2", "88374e38053de5d525bac4f71e798ce2fbbb583b25248353ee7167934a8a2e31"],
  ["core/office-block@2", "f857d0985109240292bcf45d80959ea8a27c8b80d0bfe2f544ebaa7fb1c6470d"],
  ["core/mall@2", "2eea2f27ab7604df2957cff441fc59c05d780ae1822d41740c91c51670f2a1e5"],
  ["core/garage@2", "fe9aef005b285f3bb6044d10ecf7b76659d706f451098ca81dc07d5bca6e0759"],
  ["core/petrol-station@2", "8939ad00b11f88bd73d9b4bf785e8da4282f7e4ff7802b7fd2a0ece6405a58d3"],
  ["core/school@2", "05346d6d9197eeca50c1329ec50c76d982335cd02367de66dfac8a8001a0cf90"],
  ["core/hospital@2", "ebe28e0c24b55df21572b561256e1fa39378decd3f866c183bc014d3b4cf88dc"],
  ["core/library@2", "a2d8714a7c8e7141b99f7727a7170e69c111057eea9e7d0b12a84b18634b7379"],
  ["core/town-hall@2", "9fa87f07c1a89081e7b9e05503e2c3cad1a8dd5ec28743c7ef72ac520d733f0c"],
  ["core/police-station@2", "10f353bdd7752167ec606896da06cc10691126e2d209d32e3cd8bd806659bdcb"],
  ["core/fire-station@2", "9435801bb4dec4aa31c02a24f492b8f7ec35bd451fe6fcfdb252855041060df6"],
  ["core/church@2", "87d221005a902344ac87df0667d4c064ff356d5e8ae8aeaeef8324d4825c7be8"],
  ["core/prison@2", "f0b5052ae38125d1131bc4f00626b15c5f2250a37b587db4eda97d7eb0a082c3"],
  ["core/theatre@2", "344d6906e1beeee5df2f7f8bd552ed4651bf50bddab556b0537e69216ccbdcbd"],
  ["core/museum@2", "9e23b56fbb016410044d650522851810a40af1724df284cfcd8264c19a9aa1b4"],
];

test('door-fitted revisions: each ref and its bytes are pinned', () => {
  const library = coreLibrary();
  const refs = DOOR_FITTED_BUILDINGS.map((d) => `core/${(d as { name: string }).name.replace(/^core-/, '')}@${(d as { version: number }).version}`);
  assert.deepEqual(refs, PINNED.map(([ref]) => ref), 'the 40 refs');
  assert.deepEqual(Object.keys(DOOR_FITTED_VERSIONS).length, 40);
  for (const [ref, hash] of PINNED) assert.equal(library.get(ref)?.hash, hash, `${ref} keeps its bytes`);
  for (const [, to] of DOOR_FIT_FROM) assert.ok(PINNED.some(([ref]) => ref === to.ref), `${to.ref} is a pinned revision`);
});
