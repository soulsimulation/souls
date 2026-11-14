import {clockAt} from '@souls/brain';
import type {WorldHost} from '../../world.ts';
import {PAUSED_DAY_TICKS} from '../../god/world-clock.ts';
/** The host frame and native durations use 50ms ticks. Calendar minutes are
 * separate: a 72,000-tick day has 50 ticks = 2.5 native seconds per world minute.
 * Wall-time conversion uses the current effective rate and is null while paused.
 * A god pauses time with a 2^40-tick day (PAUSED_DAY_TICKS), so that day reads as paused too. */
export function freshBootClock(host:Pick<WorldHost,'engine'|'living'|'clockRate'|'paused'>,sampledAtRealMs=Date.now()){
 const tick=host.engine.world.tick,day=host.living,rate=host.clockRate,paused=host.paused||!(rate>0)||(day?.dayTicks??0)>=PAUSED_DAY_TICKS,nativeTicksPerSecond=20;
 const time=day&&day.dayTicks>0?clockAt(tick,day.origin,day.dayTicks):null;
 const epochDate=day&&time?clockAt(day.origin,day.origin,day.dayTicks).datetime.slice(0,10):null;
 const absoluteWorldMinutes=time&&epochDate?Math.floor((Date.parse(time.datetime)-Date.parse(epochDate+'T00:00:00Z'))/60000):null;
 return {tick,sampledAtRealMs,day:time?.day??null,engineDayIndex:time?.day??null,time:time?.datetime.slice(11,16)??null,
  worldDateTime:time?.datetime??null,worldDayIndex:absoluteWorldMinutes===null?null:Math.floor(absoluteWorldMinutes/1440),absoluteWorldMinutes,
  minuteOfDay:time?time.hour*60+time.minute:null,weekdayUTC:time?new Date(time.datetime).getUTCDay():null,
  dayTicks:day?.dayTicks??null,ticksPerWorldMinute:day?day.dayTicks/1440:null,nativeTicksPerSecond,
  nativeSecondsPerWorldMinute:day?day.dayTicks/1440/nativeTicksPerSecond:null,secondsUnit:'native-tick-seconds' as const,
  clockRate:rate,paused,realMsPerWorldMinute:day&&!paused?day.dayTicks*50/rate/1440:null,
  dayNightBoundaries:null,dayNightBoundariesSource:'not-declared' as const};
}
