import test from 'node:test';
import assert from 'node:assert/strict';
import {timeline, sortedRecords, fitBounds, zoomAt, afterBlankClick} from '../web/core.js';

test('same-time order, backdating and deleted/topic isolation', () => {
  const records = [
    {id:'a',topicId:'one',time:'2026-10-13T00:00Z',seq:2},
    {id:'b',topicId:'one',time:'2026-10-13T00:00Z',seq:1},
    {id:'c',topicId:'two',time:'2026-10-12T00:00Z',seq:3},
    {id:'d',topicId:'one',time:'2026-10-12T00:00Z',seq:4,deleted:true}
  ];
  assert.deepEqual(sortedRecords(records,'one').map(r=>r.id), ['b','a']);
  records[0].time = '2026-10-10T00:00Z';
  assert.deepEqual(sortedRecords(records,'one').map(r=>r.id), ['a','b']);
  assert.deepEqual(sortedRecords(records,'one',new Map([['a','2026-10-14T00:00Z']])).map(r=>r.id), ['b','a']);
});

test('continuous S curve changes direction and grows beyond fixed reference canvas', () => {
  const {points,path} = timeline(60);
  assert.equal(points.length,60);
  assert.ok(points[1].x > points[0].x);
  assert.ok(points[13].x < points[12].x);
  assert.ok(points[25].x > points[24].x);
  assert.ok(points[59].y > 2500);
  assert.ok(path.includes('A 380 380'));
  for(let i=1;i<points.length;i++) {
    const distance = Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);
    assert.ok(distance > 395 && distance <= 431);
  }
});

test('zoom keeps cursor world point and fit includes displaced pinned notes', () => {
  const view={scale:.5,x:20,y:-50}, cursor={x:500,y:400};
  const next=zoomAt(view,1.2,cursor.x,cursor.y);
  assert.ok(Math.abs((cursor.x-next.x)/next.scale-(cursor.x-view.x)/view.scale)<1e-9);
  const rects=[{x:0,y:0,width:260,height:180},{x:3000,y:2000,width:800,height:700}];
  const fit=fitBounds(rects,1200,800);
  for(const r of rects) {
    assert.ok(r.x*fit.scale+fit.x>=0);
    assert.ok((r.y+r.height)*fit.scale+fit.y<=800);
  }
});

test('blank click rolls unpinned notes, preserves pinned notes and failed edits', () => {
  assert.deepEqual(afterBlankClick({editing:true,pinned:false,saved:true}), {editing:false,expanded:false});
  assert.deepEqual(afterBlankClick({editing:true,pinned:true,saved:true}), {editing:false,expanded:true});
  assert.deepEqual(afterBlankClick({editing:false,pinned:false,saved:true}), {editing:false,expanded:false});
  assert.deepEqual(afterBlankClick({editing:true,pinned:false,saved:false}), {editing:true,expanded:true});
});
