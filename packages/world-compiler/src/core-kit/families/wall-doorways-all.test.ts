// #2434 (as #2383's review): the 40 every-doorway building revisions are pinned. Each keeps its ref and its bytes (the
// library's def hash) whatever def revision lands later; a change here is a new revision and a new supplement, never an edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coreLibrary } from '../../library.ts';
import { ALL_DOORS_BUILDINGS, ALL_DOORS_FROM, ALL_DOORS_VERSIONS } from './wall-doorways-all.family.ts';

const PINNED: [string, string][] = [
  ["core/cottage@3", "30eb54b2e12a78eaf6ab66a0e9a242aa912c0b611ac3b78c96527786855ba12e"],
  ["core/roundhouse@3", "205f399f2487242871a6b2af31dc79fbfd9012ea78d4f1209edb66001d816417"],
  ["core/townhouse@3", "29ce1b56ea8c444baf784b1846e5e2157d587b19b572abb1bff41072d7b7ad92"],
  ["core/shop@3", "7d2cbe6d2a0da919d00ead850a02728e4c8eb9d9d302c4f3c28e8ea8c21597fc"],
  ["core/hall@4", "fd036f0f52f440a06ba442ee3dd74422fe8e357cdd4c488515637b8d4baf0cd1"],
  ["core/chapel@3", "b40728150cfd68509d4017e729453279438b24ff08b9f6c88d3d16fb2c18cef2"],
  ["core/barn@3", "cae744009f5f2b61003182ad7ce064041a5ea3faf051e14a7acb5a1fa3c0943d"],
  ["core/shed@3", "3137ef18698078a2916390ccaa6beef28661065707af8598be9d04755535ea04"],
  ["core/greenhouse@3", "0578f58ee6f6c6ef6afa3be657f3c42caba8cc9b6fbf769d5a43506f2246e796"],
  ["core/pavilion@3", "77090b2f81d411a216d4dc9fe7bbdf5756074e79fd20714a06153416229b5248"],
  ["core/tower@3", "f5f2c1a6e8674ebd6ac33ce8046be8d4ed910604a5a6b600bbbd3b5f798ba125"],
  ["core/lighthouse@3", "e4c444ea01fdf11cf62817942727a7fccff99f07b312ac956ec30367383641d6"],
  ["core/house@3", "a4973e7bbdb51d8fed5deafc0cf706b5a497eb5e3b76994cbfba98f75f94b854"],
  ["core/apartment-block@3", "78aa01901a67fb45de6199f82d5dc3be87f34dea061061c3ea267c5fd30c3aa2"],
  ["core/townhouse-row@3", "b32f6fdecb54420ba87e17fa06a1701df5efda26cf5a32cc5a9cd35bea1dd0e0"],
  ["core/cabin@3", "97ccc80b02308ef50959e25841171e59f26ae79a6fd2e7d5a602920204bdc557"],
  ["core/mansion@3", "86a1c20e3107a3cd7cf8b1c9fe26a529b88b0934ec817368c414f2f0b3b89fe6"],
  ["core/dormitory@3", "603e485b5b361307c61de7b91b84b68e18963a90f698b057edd7d40cb0c3d012"],
  ["core/hotel@3", "586940099f0c990660d69a61e678879188f30235225e3889b6e5b170ae630bd0"],
  ["core/mobile-home@3", "914637f099432277b9fa2d8cb24f26f76e5d7fa7ee0eac3684dc5b915a4440f3"],
  ["core/corner-shop@3", "bc9036f4d7ef339d36215ea7ee811b8579477bda475fb7e3410244e833be1d26"],
  ["core/supermarket@3", "a28118eaaaf0bfb536bf243aa22fb2da9d9177aad70a5eb3fb4b59bb5b179a74"],
  ["core/restaurant@3", "9d8cb9c3956c807fb65a8c4c6ef5e948c4f105da1a34271e481fde6cd2a596f0"],
  ["core/cafe@3", "1202a24d4da43d0bcc9a1d8b5ec401861be369ec070f60207a1cbeb503b9e78c"],
  ["core/bar@3", "c3a5232f12aaf74c501a6547e983299c0b205cf7d4c924cb23d4ae67fcb4aabc"],
  ["core/bank@3", "4aa919596f2ccdb5b50c62f1f59d80676f64d150693b4d1a3e94e1145d8132c1"],
  ["core/office-block@3", "18f2d42ed4a2410568bccd77a2a9e68d1658b0c42155634c8bfad823e67743c0"],
  ["core/mall@3", "a887fff028b9f91dddcb737461ac1b998650260407c634378b6bb16e2e1bf7df"],
  ["core/garage@3", "2d839765b3ec550bc0ea4585799f529c291689463fff46d833a6c98761dccebb"],
  ["core/petrol-station@3", "72d4a3da3d19e6d278c1a41b952b8da8189c49a0534cb4b9fb8b2de87fb49dfc"],
  ["core/school@3", "e4f682290ff2971becdf4d2e21e5182dd7d530aaa980e9cb0e35c787800763b0"],
  ["core/hospital@3", "32113525e2f8b6cf1eb00f8992e70633c22cb81c8527bd2420ced9e869da76e2"],
  ["core/library@3", "6ef73ab42bc95a190fbf8ee7269f06dc32a3210ac38931ef69708dd9fa49697b"],
  ["core/town-hall@3", "7f17b0b1d71b731bcbab4be53b6a331c4876e89aaae661cfab91d5cc08690b70"],
  ["core/police-station@3", "157e3db3f27852f3dfb4b4986b331b12e2431fa1ec77b33e6b6ab9f295d027cf"],
  ["core/fire-station@3", "d492539909f30c8ac8b83a34cb989d81495d0924f8c840f47774170eac5c2769"],
  ["core/church@3", "7f0c45b55693752457316a983a3f4f5bbb0a1c4db388bd8b02e0692c9fb79ba0"],
  ["core/prison@3", "c5c51961f64c3c4a9dedec8188b2d4d8a4e655b38ff2a9144051f1b18814e89e"],
  ["core/theatre@3", "762554ef4d28a4b8b3127cba4dacb9acb96c972ef4911191479a7cd8d69d31bc"],
  ["core/museum@3", "bfd7844f4fb3c1443fa46cb133cd7e152d7351129dd41f2d980493389ae2976d"],
];

test('every-doorway revisions: each ref and its bytes are pinned', () => {
  const library = coreLibrary();
  const refs = ALL_DOORS_BUILDINGS.map((d) => `core/${(d as { name: string }).name.replace(/^core-/, '')}@${(d as { version: number }).version}`);
  assert.deepEqual(refs, PINNED.map(([ref]) => ref), 'the 40 refs');
  assert.equal(Object.keys(ALL_DOORS_VERSIONS).length, 40);
  for (const [ref, hash] of PINNED) assert.equal(library.get(ref)?.hash, hash, `${ref} keeps its bytes`);
  for (const [, to] of ALL_DOORS_FROM) assert.ok(PINNED.some(([ref]) => ref === to.ref), `${to.ref} is a pinned revision`);
});
