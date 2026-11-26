import assert from 'node:assert/strict';
import {test} from 'node:test';
import {worldClockAt,worldMinutes,worldTimeText} from '../src/world-clock.ts';
import {bubbleLift,popupMs,speakNow,speakingClock,speakingNow} from '../src/dialogue-speaking.ts';

const chunk=(start:number,iso:string)=>({fromTick:start,toTick:start+20,take:{startTick:start,ticks:20,finalState:{env:{datetime:iso}}}});

test('world time comes from the streamed clock, placed at the shown tick at the stream\'s own rate', () => {
  // Live Eden: 20 ticks per chunk, 24 world seconds per chunk (one world day per real hour).
  const chunks=[chunk(3655988,'2026-11-23T00:40:09.600Z'),chunk(3656008,'2026-11-23T00:40:33.600Z'),chunk(3656028,'2026-11-23T00:40:57.600Z')];
  assert.equal(worldClockAt(chunks,3656048),'2026-11-23T00:40:57.600Z');
  // Replay delay / history: earlier ticks read earlier times on the same scale (60 s real = 24 world min).
  assert.equal(worldClockAt(chunks,3656048-1200),'2026-11-23T00:16:57.600Z');
  assert.equal(worldTimeText(worldClockAt(chunks,3656048)),'Mon · 12:40 am');
  assert.equal(worldTimeText('2026-10-03T19:42:00'),'Sat · 7:42 pm');
  assert.equal(worldTimeText('2026-10-06T12:05:00Z'),'Tue · 12:05 pm');
  // One chunk: nearest mark, no scale. No clock or no tick: nothing.
  assert.equal(worldClockAt([chunk(100,'2026-10-03T06:00:00Z')],120),'2026-10-03T06:00:00.000Z');
  assert.equal(worldClockAt([{take:{startTick:1,ticks:1,finalState:{}}}],5),null);
  assert.equal(worldClockAt(chunks,null),null);
  assert.equal(worldTimeText(null),'');
});

test('#3377 the time slider starts at the world\'s time, to its 15-minute step, morning and late evening', () => {
  assert.equal(worldMinutes('2026-11-23T07:20:00Z'),435);     // 7:20 am → 7:15
  assert.equal(worldMinutes('2026-11-23T07:23:00Z'),450);     // 7:23 am → 7:30
  assert.equal(worldMinutes('2026-11-23T22:47:30'),1365);     // 10:47 pm → 10:45 pm (no zone: read as written)
  assert.equal(worldMinutes('2026-11-23T23:55:00Z'),1425);    // never past the slider's last stop
  assert.equal(worldMinutes(null),null);
  assert.equal(worldMinutes('not a time'),null);
});

test('a pop-up stays at least 9 s, longer for long lines (reading time), never past 16 s', () => {
  assert.equal(popupMs('Hello there.'),9000);
  assert.equal(popupMs('Hello Moss, lovely night by the fountain.'),9000);   // trial of 0.137: it faded at about 7 s
  assert.ok(popupMs('x'.repeat(150))>9000&&popupMs('x'.repeat(150))<16000);
  assert.equal(popupMs('x'.repeat(400)),16000);
});

test('trial of 0.137: a speech bubble sits just over the head the body is drawn with, lower seated or lying', () => {
  assert.equal(bubbleLift('idle'),1.9);
  assert.equal(bubbleLift(undefined),1.9);
  assert.equal(bubbleLift('sit'),1.35);
  assert.equal(bubbleLift('mars:sit'),1.35);
  assert.equal(bubbleLift('stargaze'),0.9);
  assert.equal(bubbleLift('lie'),0.9);
});

test('trial of 0.137: a new line tells the page to paint its bubble on the next frame', () => {
  const before=speakingClock.version;
  speakNow('s_a',{colour:'#fff',since:0,thread:'c1',text:'hello'});
  assert.equal(speakingClock.version,before+1);
  assert.equal(speakingNow.get('s_a')?.text,'hello');
  speakingNow.clear();
});
