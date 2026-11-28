import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {bodyCompanion,resources,type Imported} from './import-body.ts';

test('body companion exports the same admitted resource tuples and canonical kind hash without rewriting native bytes',()=>{
  const admitted={kind:'body:declared',text:'canonical-native-kind-bytes',resources:resources('biped/1'),clips:['Idle'],full:{format:undefined},profile:'biped/1'} as unknown as Imported;
  const before=JSON.stringify(admitted),out=bodyCompanion(admitted,'models/full.glb','models/simple.mesh');
  assert.deepEqual(out.resources,admitted.resources);
  assert.equal(out.kindHash,createHash('sha256').update(admitted.text).digest('hex'));
  out.resources[2][2]=77;
  assert.equal(JSON.stringify(admitted),before,'metadata export does not mutate native source/model input');
  assert.deepEqual(bodyCompanion({...admitted,resources:[['souls:gripper',2,17]]},'full','simple').resources,[['souls:gripper',2,17]],'no humanoid slot constants in metadata forwarding');
});
