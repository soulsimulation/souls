// The Eden tour's stops (C2, #3674): today's Explore views of Eden (apps/web/src/WorldPlaces.ts `WORLD_PLACE_VIEWS`,
// copied, not imported), each an eye and the point it looks at, in world metres. The three views inside rooms (the
// gallery, the library's reading room and the courtyard home) are left out, so the flights between stops stay in the
// open air; the rest run as one loop from the panorama, round the town and the outskirts, and back to the library.
export type Stop = { id: string; label: string; p: readonly [number, number, number]; target: readonly [number, number, number] };

export const EDEN_STOPS: readonly Stop[] = Object.freeze([
  { id: 'overview', label: 'All of Eden', p: [112, 76, 115], target: [7, 0, 5] },
  { id: 'commons', label: 'Commons', p: [35, 20, 35], target: [8, 1, 0] },
  { id: 'homes', label: 'Homes', p: [68, 23, 48], target: [44, 2, 23] },
  { id: 'rooftops', label: 'Roof gardens', p: [66, 18, 42], target: [45, 4, 30] },
  { id: 'roofseating', label: 'Front roof table', p: [43, 8.5, 40], target: [34, 3.5, 31.4] },
  { id: 'market', label: 'Market', p: [83, 12, 42], target: [70, 1, 29] },
  { id: 'windmill', label: 'Windmill and greenhouse', p: [74, 12, 18], target: [80, 3, 32] },
  { id: 'towerhouse', label: 'Tower house', p: [81, 7, 25], target: [69, 4, 20] },
  { id: 'domequarter', label: 'Dome quarter', p: [104, 9, 57], target: [99.2, 2, 37] },
  { id: 'farm', label: 'Farm and gardens', p: [95, 24, 77], target: [72, 1, 51] },
  { id: 'amphitheatre', label: 'Amphitheatre', p: [76, 10, 70], target: [76, 0.8, 82] },
  { id: 'observatory', label: 'Observatory', p: [46, 9, 72], target: [36.5, 2.4, 82] },
  { id: 'rural', label: 'Southern village', p: [38, 23, 71], target: [0, 2, 48] },
  { id: 'courtyard', label: 'Stone courtyard', p: [15, 10, 67], target: [0, 1, 59] },
  { id: 'lake', label: 'Lake and river', p: [-49, 30, 25], target: [-80, -1, 1] },
  { id: 'dock', label: 'Lake pier', p: [-84, 8, 10], target: [-94, -1, 2] },
  { id: 'bridge', label: 'River crossing', p: [-57, 12, -11], target: [-74, -1, -22] },
  { id: 'forest', label: 'Forest', p: [30, 25, -22], target: [7, 1, -44] },
  { id: 'lookout', label: 'Northern lookout', p: [22, 14, -45], target: [3, 1, -57] },
  { id: 'bandstand', label: 'Bandstand', p: [45.5, 4.5, -18.5], target: [38.5, 1.6, -26] },
  { id: 'kiosks', label: 'Market kiosks', p: [57.5, 4, -18.5], target: [57.5, 1.3, -26.5] },
  { id: 'classroom', label: 'Classroom', p: [42, 5, 7], target: [42, 1.7, -10] },
  { id: 'presentation', label: 'Presentation screen', p: [42, 3, -2], target: [42, 2, -14] },
  { id: 'stonegarden', label: 'Stone garden gate', p: [65, 5, -1], target: [57, 1.4, -10] },
  { id: 'cabins', label: 'A-frame cabin and yurt', p: [85, 8, -11], target: [72, 1.6, -22] },
  { id: 'performance', label: 'Outdoor performance', p: [106, 13, -17], target: [92, 1, -30] },
  { id: 'craft', label: 'Craft courtyard', p: [105, 12, 2], target: [92, 1, -11] },
  { id: 'teahouse', label: 'Tea house', p: [92.5, 4.2, 13.5], target: [92.5, 1.8, 4.5] },
  { id: 'muralwall', label: 'Mural wall', p: [73.5, 2.4, 11.5], target: [73.5, 1.2, 4.5] },
  { id: 'fountain', label: 'Library fountain', p: [85, 5, 9], target: [79, 1, 0] },
  { id: 'library', label: 'Library', p: [82, 16, 8], target: [75, 3, -4] },
] satisfies Stop[]);
