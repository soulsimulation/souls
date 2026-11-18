import {test} from 'node:test';
import assert from 'node:assert/strict';
import {freshBootClock} from './clock.ts';
import {PAUSED_DAY_TICKS} from '../../god/world-clock.ts';

const host=(dayTicks:number)=>({engine:{world:{tick:5000}},living:{origin:0,dayTicks},clockRate:1,paused:false}) as never;

test('a world whose clock the god paused (a 2^40-tick day) reports paused', () => {
 const c=freshBootClock(host(PAUSED_DAY_TICKS),0);
 assert.equal(c.paused,true);
 assert.equal(c.realMsPerWorldMinute,null);
 const running=freshBootClock(host(72000),0);
 assert.equal(running.paused,false);
 assert.equal(running.realMsPerWorldMinute,2500);
});
