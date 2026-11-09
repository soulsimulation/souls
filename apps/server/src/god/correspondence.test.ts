import test from 'node:test';
import assert from 'node:assert/strict';
import {correspondenceAdmission,correspondenceSameFloor} from './correspondence.ts';
const def={name:'core-sealed-correspondence',version:1};
test('correspondence effect cannot happen before a distant approach or with occupied hands',()=>{assert.equal(correspondenceAdmission(def,'seal',4,false,1.6)?.code,'object.out-of-reach');assert.equal(correspondenceAdmission(def,'write',1,true,1.6,false,true)?.code,'object.state');assert.equal(correspondenceAdmission(def,'open-seal',1,false,1.6,false,true),null);assert.equal(correspondenceAdmission(def,'seal',1,false,1.6,true)?.code,'object.state');assert.equal(correspondenceAdmission({name:'other',version:1},'seal',4,true,1.6),null);});

test('same planar position on another native floor cannot operate the letter; missing observation fails closed',()=>{const floor=(x:number,z:number,y:number)=>y>=2?1:0;assert.equal(correspondenceSameFloor([0,3,0],[0,0,0],floor),false);assert.equal(correspondenceSameFloor([0,0,0],[0,0,0],floor),true);assert.equal(correspondenceSameFloor(undefined,[0,0,0],floor),false);assert.equal(correspondenceAdmission(def,'seal',0,false,1.6,false,false)?.code,'object.out-of-reach');});
