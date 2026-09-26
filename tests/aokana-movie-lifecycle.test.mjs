import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBitmapStorage, allocateAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaMovieImage, AokanaMovieImageConfiguration} from '../dist/engines/buriko/games/aokana/native/movie-image.js';
import {AokanaMovieMediaGraph, AokanaMovieRenderer} from '../dist/engines/buriko/games/aokana/native/movie-renderer.js';
import {AokanaMovieRegistry} from '../dist/engines/buriko/games/aokana/native/movie-registry.js';
import {AokanaNativeNotifications} from '../dist/engines/buriko/games/aokana/native/notification-queue.js';
function type(kind = 0, width = 2, height = -2) {
  const format = new Uint8Array(88), v = new DataView(format.buffer);
  v.setBigInt64(40, 400000n, true); v.setInt32(52, width, true); v.setInt32(56, height, true);
  return {majorType:'73646976-0000-0010-8000-00aa00389b71', subtype: ['e436eb7e','e436eb7d','e436eb7c','e436eb7b'][kind]+'-524f-11ce-9f53-0020af0ba770', formatType:'05589f80-c356-11ce-bf01-00aa0055595a', format};
}
function image(kind, width, height) {
  const image = new AokanaMovieImage(new AokanaMovieImageConfiguration()), media = type(kind, width, height);
  assert.equal(image.checkMediaType(media), 0); image.setMediaType(media); return image;
}
const sample = (bytes) => ({storage:new AokanaBitmapStorage(Uint8Array.from(bytes), true), offset:0});
const words = (bitmap) => Array.from(new Uint32Array(bitmap.storage.bytes.buffer));
test('movie media negotiation preserves native HRESULT precedence and signed requested geometry', () => {
  const configuration = new AokanaMovieImageConfiguration(), decoder = new AokanaMovieImage(configuration), media = type();
  assert.equal(decoder.checkMediaType(null), 0x80004003);
  assert.equal(decoder.checkMediaType({...media,majorType:'wrong',subtype:'wrong'}), 0x80040200);
  assert.equal(decoder.checkMediaType({...media,subtype:'wrong',formatType:'wrong'}), 0x80040201);
  assert.equal(decoder.checkMediaType({...media,formatType:'wrong'}), 0x80040206);
  assert.equal(decoder.checkMediaType(media), 0); decoder.setMediaType(media);
  assert.equal(decoder.height, 2); configuration.dimensionMode=1; assert.equal(decoder.height,-2);
  assert.equal(decoder.averageFrameTime,400000n);
});
test('movie RGB32/24 conversion clears X, preserves row padding and uses native bottom-up destination', () => {
  const bgra = image(0,2,2), target=allocateAokanaBitmap(2,2,1);
  bgra.copySample(bgra.orientDestination(target),sample([1,2,3,255,4,5,6,255,7,8,9,255,10,11,12,255]));
  assert.deepEqual(words(target),[0x090807,0x0c0b0a,0x030201,0x060504]);
  const bgr=image(1,5,-1), converted=allocateAokanaBitmap(5,1,1);
  bgr.copySample(converted,sample(Array.from({length:16},(_,i)=>i+1)));
  assert.deepEqual(words(converted),[0x030201,0x060504,0x090807,0x0c0b0a,0x0f0e0d]);
  assert.equal(bgr.sourceStride,16);
});
test('movie RGB555/565 really collapse nonzero color to boolean pixels', () => {
  for (const [kind,expected] of [[2,[0,0,1]],[3,[0,1,1]]]) {
    const decoder=image(kind,3,-1), output=allocateAokanaBitmap(3,1,1);
    decoder.copySample(output,sample([0,0,0,128,31,0]));
    assert.deepEqual(words(output),expected);
  }
});
class Video extends EventTarget {
  currentTime=0; duration=2; volume=1; ended=false; paused=true; calls=[];
  async play(){this.calls.push('play');this.paused=false;}
  pause(){this.calls.push('pause');this.paused=true;}
  removeAttribute(name){this.calls.push('remove:'+name);}
  load(){this.calls.push('load');}
}
function controller(){
  const video=new Video(), graph=new AokanaMovieMediaGraph(video,URL.createObjectURL(new Blob())), decoder=image(0,2,-2);
  const renderer=new AokanaMovieRenderer(null,3,decoder,new AokanaNativeNotifications());
  renderer.attachGraph(graph,0,7);return {renderer,video,graph};
}
test('movie controller keeps stop, script pause and engine suspension as separate native states',async()=>{
  const {renderer,video}=controller();
  assert.equal(renderer.isPlaying(),0);assert.equal((await renderer.start()).remainingMilliseconds,2000);
  assert.equal(renderer.isPlaying(),1);assert.equal(await renderer.pause(1),0);assert.equal(renderer.isPlaying(),1);
  assert.equal(renderer.suspend(),0);assert.equal(await renderer.pause(0),0);assert.equal(video.paused,true);
  await renderer.resume();assert.equal(video.paused,false);
  renderer.stop();assert.equal(renderer.isPlaying(),0);
  assert.equal(renderer.started,1);video.currentTime=.4;assert.deepEqual(renderer.framePosition(),{status:0,value:10});
  assert.equal(renderer.volume(128),0);assert.equal(video.volume,1);assert.equal(renderer.volume(129),0x80000003);
  renderer.dispose();assert.equal(renderer.started,0);assert.equal(renderer.initialized,false);
  assert.deepEqual(video.calls.slice(-3),['pause','remove:src','load']);
});
test('movie registry unlinks before synchronous graph teardown and retains monotonically advancing IDs',()=>{
  const registry=new AokanaMovieRegistry(),first=controller(),second=controller();
  assert.equal(registry.append(first.renderer),0);assert.equal(registry.append(second.renderer),1);
  const pause=first.video.pause.bind(first.video);first.video.pause=()=>{assert.equal(registry.find(0),null);pause();};
  assert.equal(registry.remove(0),1);assert.equal(registry.remove(0),0);assert.equal(registry.find(1),second.renderer);
  registry.clear();const next=controller();assert.equal(registry.append(next.renderer),2);registry.clear();
});
test('native notifications retain all three DWORD values in FIFO order through a drain/refill',()=>{
  const queue=new AokanaNativeNotifications();queue.push(0x10000,3,0);queue.push(-1,-2,-3);
  assert.deepEqual(queue.take(),{type:0x10000,value1:3,value2:0});
  assert.deepEqual(queue.take(),{type:0xffffffff,value1:0xfffffffe,value2:0xfffffffd});assert.equal(queue.take(),null);
  queue.push(1,2,3);queue.clear();assert.equal(queue.take(),null);queue.push(4,5,6);assert.deepEqual(queue.take(),{type:4,value1:5,value2:6});
});

import {readAokanaIsoMovieTracks} from '../dist/engines/buriko/games/aokana/native/movie-media-timing.js';
const atom=(name,...parts)=>{const payload=Uint8Array.from(parts.flatMap(p=>Array.from(p))),out=new Uint8Array(8+payload.length),v=new DataView(out.buffer);v.setUint32(0,out.length);out.set(new TextEncoder().encode(name),4);out.set(payload,8);return out;};
const u32=(...values)=>{const out=new Uint8Array(values.length*4),v=new DataView(out.buffer);values.forEach((n,i)=>v.setUint32(i*4,n));return out;};
function track(id,enabled,timeRuns){
  return atom('trak',atom('tkhd',u32(enabled,0,0,id)),atom('mdia',atom('mdhd',u32(0,0,0,1000)),
    atom('hdlr',u32(0,0),new TextEncoder().encode('vide')),atom('minf',atom('stbl',atom('stts',u32(0,timeRuns.length,...timeRuns.flat()))))));
}
test('ISO video timing retains multiple tracks and exact variable-duration totals',()=>{
  const source=atom('moov',track(7,1,[[10,40],[20,41]]),track(8,0,[[2,50]]));
  const result=readAokanaIsoMovieTracks(source);
  assert.deepEqual(result,[{id:7,enabled:true,timescale:1000,sampleCount:30n,sampleDuration:1220n,averageFrameTime:406666n},
    {id:8,enabled:false,timescale:1000,sampleCount:2n,sampleDuration:100n,averageFrameTime:500000n}]);
});
test('fragmented ISO timing handles trex defaults, tfhd overrides and per-sample trun durations',()=>{
  const movie=atom('moov',track(7,1,[]),atom('mvex',atom('trex',u32(0,7,1,40,0,0))));
  const first=atom('moof',atom('traf',atom('tfhd',u32(0,7)),atom('trun',u32(0,3))));
  const second=atom('moof',atom('traf',atom('tfhd',u32(8,7,50)),atom('trun',u32(0,2)),atom('trun',u32(0x100,2,60,70))));
  const data=Uint8Array.from([...movie,...first,...second]);
  assert.deepEqual(readAokanaIsoMovieTracks(data),[{id:7,enabled:true,timescale:1000,sampleCount:7n,sampleDuration:350n,averageFrameTime:500000n}]);
  assert.throws(()=>readAokanaIsoMovieTracks(data.subarray(0,data.length-1)),/invalid size/);
});
