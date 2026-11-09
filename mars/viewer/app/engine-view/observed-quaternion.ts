type Q={x:number;y:number;z:number;w:number};
/** Local interpolation retains the captured native quaternion's magnitude continuously at zero weight. */
export function observedQuaternionBlend(base:Q,solved:Q,weight:number):{kind:'sampled';q:[number,number,number,number]}|{kind:'fallback';reason:string} {
  const a=[base.x,base.y,base.z,base.w],b=[solved.x,solved.y,solved.z,solved.w];
  if(!Number.isFinite(weight)||weight<0||weight>1||!a.every(Number.isFinite)||!b.every(Number.isFinite))return {kind:'fallback',reason:'invalid-quaternion-blend'};
  const n0=Math.hypot(...a),n1=Math.hypot(...b);
  if(!Number.isFinite(n0)||!Number.isFinite(n1))return {kind:'fallback',reason:'invalid-quaternion-norm'};
  if(n0===0||n1===0)return {kind:'fallback',reason:'zero-quaternion'};
  if(weight===0)return {kind:'sampled',q:a as [number,number,number,number]};
  if(weight===1)return {kind:'sampled',q:b as [number,number,number,number]};
  const x=a.map(v=>v/n0),y=b.map(v=>v/n1);
  let dot=x.reduce((n,v,i)=>n+v*y[i],0);
  if(dot<0){dot=-dot;for(let i=0;i<4;i++)y[i]=-y[i];}
  dot=Math.min(1,dot);let left:number,right:number;
  if(1-dot<Number.EPSILON){left=1-weight;right=weight;}
  else {const angle=Math.acos(dot),sin=Math.sin(angle);left=Math.sin((1-weight)*angle)/sin;right=Math.sin(weight*angle)/sin;}
  const q=x.map((v,i)=>v*left+y[i]*right),scale=(n0+(n1-n0)*weight)/Math.hypot(...q);
  return {kind:'sampled',q:q.map(v=>v*scale) as [number,number,number,number]};
}
