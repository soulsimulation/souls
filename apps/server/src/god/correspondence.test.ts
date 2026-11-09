import test from 'node:test';
import assert from 'node:assert/strict';
import {correspondenceAdmission} from './correspondence.ts';
const def={name:'core-sealed-correspondence',version:1};
test('correspondence effect cannot happen before a distant approach or with occupied hands',()=>{assert.equal(correspondenceAdmission(def,'seal',4,false,1.6)?.code,'object.out-of-reach');assert.equal(correspondenceAdmission(def,'write',1,true,1.6)?.code,'object.state');assert.equal(correspondenceAdmission(def,'open-seal',1,false,1.6),null);assert.equal(correspondenceAdmission(def,'seal',1,false,1.6,true)?.code,'object.state');assert.equal(correspondenceAdmission({name:'other',version:1},'seal',4,true,1.6),null);});
