// What the person does and what they expect to SEE: the first-day playbook's steps 1-8 (.claude/skills/first-day/SKILL.md)
// and the explore phase, plain requests a newcomer makes in Eden. Places are Eden's (worlds/templates/eden-2026.json),
// in metres on the ground (x, z), for the explicit "it went there" check; the vision judge decides by eye.

export const PLAYBOOK = [
  { id: 'S1', title: 'Home page', expect: 'The home page explains what Souls is and shows Eden (a picture or a link to enter it).', limitSec: 10, severity: 'blocker' },
  { id: 'S2', title: 'Open Eden', expect: 'A 3D world is drawn, the time pill says Live, Souls are standing or moving in it, and there is no error banner.', limitSec: 15, severity: 'blocker' },
  { id: 'S3a', title: 'New Soul, signed out', expect: 'Signed out, New Soul gives either a clear sign-in step or a prompt to copy: no dead end.', limitSec: 10, severity: 'major' },
  { id: 'S3b', title: 'New Soul, signed in', expect: 'Signed in, New Soul shows a prompt to copy, in plain words, with a Copy button.', limitSec: 10, severity: 'blocker' },
  { id: 'S4', title: 'Agent gets to approval', expect: 'Given only the prompt (and plain answers), the agent reaches "approve your Soul" with a link and a code, without the person running any command.', limitSec: 600, severity: 'blocker' },
  { id: 'S5', title: 'Approval card on the page', expect: 'An approval card appears on the Eden page that is already open, showing the same code the agent printed.', limitSec: 10, severity: 'major' },
  { id: 'S6', title: 'Approve: the Soul arrives', expect: 'After approval the Soul stands in the world, the camera goes to it, it has a name, it is under your Souls in the navbar, and its card shows it connected.', limitSec: 30, severity: 'blocker' },
  { id: 'S6b', title: 'Soul link in a new tab', expect: 'Opening the Soul\'s #soul/<id> link in a new tab puts the camera on that Soul with its card open.', limitSec: 15, severity: 'major' },
  { id: 'S7a', title: 'Walk to the fountain', ask: 'Walk to the fountain.', expect: 'The Soul walks over to the stone fountain and stands beside it.', near: [-12, -97], checks: ['moved', 'near'], limitSec: 15, severity: 'major' },
  { id: 'S7b', title: 'Say hello', ask: 'Say hello to whoever is near.', expect: 'Words such as "hello" appear in a speech bubble above the Soul.', checks: ['spoke'], limitSec: 15, severity: 'major' },
  { id: 'S7c', title: 'Sit on a bench', ask: 'Sit on a bench.', expect: 'The Soul is sitting on a bench (seated posture, on the seat, not standing or floating).', checks: ['seated'], limitSec: 15, severity: 'major' },
  { id: 'S8', title: 'Reload and come back', expect: 'After a reload the Soul is still yours, still named, and still where it was.', limitSec: 20, severity: 'blocker' },
];

export const EXPLORE = [
  { id: 'E1', ask: 'Walk to the fountain.', expect: 'The Soul walks to the stone fountain in the campus quad and stands next to it, facing it.', near: [-12, -97], checks: ['moved', 'near', 'facing'] },
  { id: 'E2', ask: 'Go to the fire and sit by it.', expect: 'The Soul walks to the campfire and sits on a bench or log beside it.', near: [24, -7], checks: ['moved', 'near', 'seated'] },
  { id: 'E3', ask: 'Put out the campfire.', expect: 'The campfire\'s flames go out: no fire, only the ring of stones or embers.', near: [24, -7], checks: ['near'] },
  { id: 'E4', ask: 'Ride a hot air balloon.', expect: 'The Soul gets into a hot air balloon basket and the balloon rises with it.', checks: ['moved', 'rose'] },
  { id: 'E5', ask: 'Take a book and read it.', expect: 'The Soul holds a book in its hand and reads it (looking at the open book).', checks: ['held'] },
  { id: 'E6', ask: 'Sit in an armchair.', expect: 'The Soul is sitting in an armchair (seated, in the chair).', checks: ['moved', 'seated'] },
  { id: 'E7', ask: 'Dance for a minute.', expect: 'The Soul dances (moving its body to a rhythm) and keeps dancing for about a minute.', checks: ['activity'], watchSec: 70 },
  { id: 'E8', ask: 'Exercise.', expect: 'The Soul exercises: at the outdoor gym (pull-up bar, dumbbells, mat) or doing a visible workout.', checks: ['activity'] },
  { id: 'E9', ask: 'Say hello to someone.', expect: 'The Soul greets another Soul nearby: a speech bubble with a greeting, ideally facing them.', checks: ['spoke'] },
  { id: 'E10', ask: 'Go explore the town.', expect: 'The Soul walks off through the town, clearly a long way from where it started.', checks: ['moved', 'far'] },
  { id: 'E11', ask: 'Look around a building.', expect: 'The Soul walks to a building and goes inside or around it.', checks: ['moved'] },
];

/** The name a newcomer gives their Soul when the agent asks. */
export const SOUL_NAME = 'Juniper';
/** The local test person (a dev sign-in name; never the world's creator, Ada). */
export const TEST_PERSON = 'Newcomer';
